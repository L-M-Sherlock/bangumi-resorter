import type { ComparisonBudgetMode, RankingDiagnostics, RankingHistoryInput } from "../types";
import {
  analyzeRanking,
  chooseNextPair,
  combineStoppingForecastSimulations,
  fitModel,
  forecastStoppingTimeSimulation,
  toModelState,
} from "./engine";
import type { RankingRequest, RankingSuccess } from "./protocol";
import { rankingTuning, STOPPING_PROBABILITY_TARGET } from "./strategy";

const BASE_POSTERIOR_SAMPLES = 64;
const ESTABLISHED_POSTERIOR_SAMPLES = 128;
const REFINED_POSTERIOR_SAMPLES = 2048;
const POSTERIOR_SEED_SALT = 0x9e3779b9;
const MODE_ORDER: ComparisonBudgetMode[] = ["quick", "standard", "thorough"];

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
    "evidenceCount" | "evidenceRequired" | "coverageTargetStabilityLow" | "coverageTargetStabilityHigh">,
) {
  return diagnostics.evidenceCount >= diagnostics.evidenceRequired
    && diagnostics.coverageTargetStabilityLow < STOPPING_PROBABILITY_TARGET
    && diagnostics.coverageTargetStabilityHigh >= STOPPING_PROBABILITY_TARGET;
}

function requiredStoppingModes(mode: ComparisonBudgetMode) {
  return MODE_ORDER.slice(0, MODE_ORDER.indexOf(mode) + 1);
}

export function computeRanking(request: RankingRequest): RankingSuccess {
  const comparisons = request.history
    .filter((entry) => entry.outcome !== "skip")
    .map((entry) => ({
      leftSubjectId: entry.leftSubjectId,
      rightSubjectId: entry.rightSubjectId,
      outcome: entry.outcome as "left" | "tie" | "right",
    }));
  const activeMode = request.budgetMode ?? "standard";
  const activeDefaults = rankingTuning(activeMode);
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
  const evaluations = requiredStoppingModes(activeMode).map((mode) => {
    const defaults = rankingTuning(mode);
    const tuning = mode === activeMode ? activeTuning : defaults;
    const fitOptions = {
      priorStrength: tuning.priorStrength,
      priorScale: tuning.priorScale,
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
    );
    // A larger, deterministic sample resolves Monte Carlo ambiguity only when
    // the first interval actually crosses the stopping boundary.
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
      );
    }
    return { mode, result, diagnostics };
  });
  const active = evaluations[evaluations.length - 1];
  const simulations = evaluations.map((evaluation) => forecastStoppingTimeSimulation(
    request.items,
    evaluation.result,
    request.distribution,
    request.history,
    request.sessionId,
    evaluation.diagnostics,
    { randomSeed: request.randomSeed, forecastEfficiency: activeTuning.forecastEfficiency },
  ));
  const stoppingChecks = evaluations.map(({ mode, diagnostics }) => ({
    mode,
    sampleCount: diagnostics.sampleCount,
    stableSamples: diagnostics.coverageTargetStableSamples,
    probability: diagnostics.coverageTargetStability,
    low: diagnostics.coverageTargetStabilityLow,
    high: diagnostics.coverageTargetStabilityHigh,
    ready: diagnostics.ready,
  }));
  const bottleneck = stoppingChecks.reduce((worst, check) => check.low < worst.low ? check : worst);
  const diagnostics = active.diagnostics;
  diagnostics.stoppingChecks = stoppingChecks;
  diagnostics.stoppingBottleneckMode = bottleneck.mode;
  diagnostics.ready = stoppingChecks.every((check) => check.ready);
  diagnostics.decisionRiskRatio = Math.max(...evaluations.map((evaluation) => evaluation.diagnostics.decisionRiskRatio));
  diagnostics.forecast = combineStoppingForecastSimulations(simulations, diagnostics);
  const model = toModelState(
    request.sessionId,
    request.version,
    active.result,
    request.previousModel?.initialMeanUncertainty,
    diagnostics,
  );
  const nextPair = chooseNextPair(
    request.items,
    request.history,
    active.result,
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
