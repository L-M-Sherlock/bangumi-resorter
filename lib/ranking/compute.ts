import type { ComparisonBudgetMode, ModelState, RankingDiagnostics, RankingHistoryInput } from "../types";
import {
  analyzeRanking,
  chooseNextPair,
  fitModel,
  forecastStoppingTimeSimulation,
  toModelState,
  type FitResult,
  type StoppingForecastOptions,
  type StoppingForecastSimulation,
} from "./engine";
import type { RankingRequest, RankingSuccess } from "./protocol";
import {
  legacyPriorMode,
  rankingTuning,
  STOPPING_MODE_ORDER,
  STOPPING_PROBABILITY_TARGET,
} from "./strategy";

const BASE_POSTERIOR_SAMPLES = 64;
const ESTABLISHED_POSTERIOR_SAMPLES = 128;
const REFINED_POSTERIOR_SAMPLES = 2048;
const POSTERIOR_SEED_SALT = 0x9e3779b9;

function currentSessionAnswerCount(history: RankingHistoryInput[], sessionId: string) {
  return history.filter((entry) => entry.sessionId === sessionId && entry.outcome !== "skip").length;
}

/** The sampling budget is a function of current evidence, never of a previously cached model. */
export function basePosteriorSampleCount(request: Pick<RankingRequest, "history" | "sessionId">) {
  return currentSessionAnswerCount(request.history, request.sessionId) >= 20
    ? ESTABLISHED_POSTERIOR_SAMPLES
    : BASE_POSTERIOR_SAMPLES;
}

/** Use common random numbers across versions and modes so recomputation order cannot move the estimate. */
export function posteriorRandomSeed(sessionSeed: number) {
  return (sessionSeed ^ POSTERIOR_SEED_SALT) >>> 0;
}

export function needsPosteriorRefinement(
  diagnostics: Pick<RankingDiagnostics,
    "evidenceCount" | "evidenceRequired" | "coverageTargetStabilityLow" | "coverageTargetStabilityHigh" | "stoppingChecks">,
) {
  const intervals = diagnostics.stoppingChecks?.length
    ? diagnostics.stoppingChecks
    : [{ low: diagnostics.coverageTargetStabilityLow, high: diagnostics.coverageTargetStabilityHigh }];
  return diagnostics.evidenceCount >= diagnostics.evidenceRequired
    && intervals.some((interval) =>
      interval.low < STOPPING_PROBABILITY_TARGET
      && interval.high >= STOPPING_PROBABILITY_TARGET);
}

/**
 * Select another coverage target without refitting the shared posterior or
 * rerunning its shared future paths. Returns undefined for legacy caches that
 * do not yet contain all three forecasts, allowing callers to recompute once.
 */
export function retargetStoppingMode(
  model: ModelState,
  mode: ComparisonBudgetMode,
  version = model.version,
): ModelState | undefined {
  const diagnostics = model.diagnostics;
  if (!diagnostics
    || !STOPPING_MODE_ORDER.every((entry) =>
      diagnostics.forecasts?.[entry]?.method === "posterior-contraction-mc-v10")
    || !STOPPING_MODE_ORDER.every((entry) =>
      diagnostics.stoppingChecks?.some((check) => check.mode === entry))) {
    return undefined;
  }
  const stoppingChecks = diagnostics.stoppingChecks!;
  const activeCheck = stoppingChecks.find((entry) => entry.mode === mode)!;
  return {
    ...model,
    version,
    diagnostics: {
      ...diagnostics,
      stoppingChecks,
      stoppingBottleneckMode: mode,
      ready: activeCheck.ready,
      decisionRiskRatio: (1 - activeCheck.low)
        / Math.max(1e-12, 1 - (activeCheck.probabilityTarget ?? STOPPING_PROBABILITY_TARGET)),
      forecast: diagnostics.forecasts![mode],
    },
    updatedAt: new Date().toISOString(),
  };
}

export interface PreparedStoppingForecast {
  fit: FitResult;
  diagnostics: RankingDiagnostics;
  options: StoppingForecastOptions;
}

export interface PreparedRanking {
  request: RankingRequest;
  active: PreparedStoppingForecast;
  forecasts: PreparedStoppingForecast[];
  modes: ComparisonBudgetMode[];
  activeTuning: ReturnType<typeof rankingTuning>;
}

export function prepareRanking(request: RankingRequest): PreparedRanking {
  const comparisons = request.history
    .filter((entry) => entry.outcome !== "skip")
    .map((entry) => ({
      leftSubjectId: entry.leftSubjectId,
      rightSubjectId: entry.rightSubjectId,
      outcome: entry.outcome as "left" | "tie" | "right",
    }));
  const activeMode = request.budgetMode ?? "standard";
  const priorMode = request.priorMode ?? legacyPriorMode(activeMode);
  const activeDefaults = rankingTuning(priorMode);
  const activeTuning = {
    ...activeDefaults,
    priorStrength: request.priorStrength ?? activeDefaults.priorStrength,
    priorScale: request.priorScale ?? activeDefaults.priorScale,
    maxRateGap: request.maxRateGap ?? activeDefaults.maxRateGap,
    maxRankDistance: request.maxRankDistance ?? activeDefaults.maxRankDistance,
    boundaryWindow: request.boundaryWindow ?? activeDefaults.boundaryWindow,
    explorationInterval: request.explorationInterval ?? activeDefaults.explorationInterval,
    explorationRadius: request.explorationRadius ?? activeDefaults.explorationRadius,
    forecastEfficiency: request.forecastEfficiency ?? activeDefaults.forecastEfficiency,
  };
  const fitOptions = {
    priorStrength: activeTuning.priorStrength,
    priorScale: activeTuning.priorScale,
    randomSeed: posteriorRandomSeed(request.randomSeed),
  };
  let result = fitModel(request.items, comparisons, undefined, {
    ...fitOptions,
    posteriorSampleCount: basePosteriorSampleCount(request),
  });
  let diagnostics = analyzeRanking(
    request.items,
    result,
    request.distribution,
    request.history,
    request.sessionId,
    activeMode,
  );
  // Refine when the interval crosses any of the three ordered thresholds, so
  // sampling precision is independent from the currently selected strictness.
  if (needsPosteriorRefinement(diagnostics)) {
    result = fitModel(request.items, comparisons, result.abilities, {
      ...fitOptions,
      posteriorSampleCount: REFINED_POSTERIOR_SAMPLES,
    });
    diagnostics = analyzeRanking(
      request.items,
      result,
      request.distribution,
      request.history,
      request.sessionId,
      activeMode,
    );
  }
  const forecastOptions: StoppingForecastOptions = {
    randomSeed: request.randomSeed,
    stoppingMode: activeMode,
    forecastEfficiency: activeTuning.forecastEfficiency,
    modelVersion: request.version,
    pairSelection: {
      maxRateGap: activeTuning.maxRateGap,
      maxRankDistance: activeTuning.maxRankDistance,
      boundaryWindow: activeTuning.boundaryWindow,
      explorationInterval: activeTuning.explorationInterval,
      explorationRadius: activeTuning.explorationRadius,
      allowCalibration: false,
    },
  };
  const active = { fit: result, diagnostics, options: forecastOptions };
  return {
    request,
    active,
    forecasts: [active],
    modes: [...STOPPING_MODE_ORDER],
    activeTuning,
  };
}

export function finalizeRanking(
  prepared: PreparedRanking,
  simulations: StoppingForecastSimulation[],
): RankingSuccess {
  const { request, active, activeTuning } = prepared;
  if (simulations.length !== 1) throw new Error("停止预测结果数量不匹配。");
  const activeMode = request.budgetMode ?? "standard";
  const stoppingChecks = active.diagnostics.stoppingChecks;
  if (!stoppingChecks || !STOPPING_MODE_ORDER.every((mode) =>
    stoppingChecks.some((check) => check.mode === mode))) {
    throw new Error("停止覆盖检查结果不完整。");
  }
  const activeCheck = stoppingChecks.find((check) => check.mode === activeMode)!;
  const diagnostics = active.diagnostics;
  diagnostics.stoppingChecks = stoppingChecks;
  diagnostics.stoppingBottleneckMode = activeMode;
  diagnostics.ready = activeCheck.ready;
  diagnostics.decisionRiskRatio = (1 - activeCheck.low)
    / Math.max(1e-12, 1 - (activeCheck.probabilityTarget ?? STOPPING_PROBABILITY_TARGET));
  diagnostics.forecasts = simulations[0].forecasts;
  diagnostics.forecast = simulations[0].forecasts[activeMode];
  const model = toModelState(
    request.sessionId,
    request.version,
    active.fit,
    request.previousModel?.initialMeanUncertainty,
    diagnostics,
  );
  const nextPair = chooseNextPair(
    request.items,
    request.history,
    active.fit,
    diagnostics,
    request.distribution,
    request.sessionId,
    request.version,
    request.randomSeed,
    {
      maxRateGap: activeTuning.maxRateGap,
      maxRankDistance: activeTuning.maxRankDistance,
      boundaryWindow: activeTuning.boundaryWindow,
      explorationInterval: activeTuning.explorationInterval,
      explorationRadius: activeTuning.explorationRadius,
    },
  );
  return { type: "MODEL_READY", requestId: request.requestId, model, nextPair };
}

export function computeRanking(request: RankingRequest): RankingSuccess {
  const prepared = prepareRanking(request);
  const { fit, diagnostics, options } = prepared.active;
  const simulations = [forecastStoppingTimeSimulation(
    request.items,
    fit,
    request.distribution,
    request.history,
    request.sessionId,
    diagnostics,
    options,
  )];
  return finalizeRanking(prepared, simulations);
}
