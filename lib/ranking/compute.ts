import type { RankingDiagnostics, RankingHistoryInput } from "../types";
import { analyzeRanking, chooseNextPair, fitModel, forecastStoppingTime, toModelState } from "./engine";
import type { RankingRequest, RankingSuccess } from "./protocol";
import { STOPPING_PROBABILITY_TARGET } from "./strategy";

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
    "evidenceCount" | "evidenceRequired" | "coverageTargetStabilityLow" | "coverageTargetStabilityHigh">,
) {
  return diagnostics.evidenceCount >= diagnostics.evidenceRequired
    && diagnostics.coverageTargetStabilityLow < STOPPING_PROBABILITY_TARGET
    && diagnostics.coverageTargetStabilityHigh >= STOPPING_PROBABILITY_TARGET;
}

export function computeRanking(request: RankingRequest): RankingSuccess {
  const comparisons = request.history
    .filter((entry) => entry.outcome !== "skip")
    .map((entry) => ({
      leftSubjectId: entry.leftSubjectId,
      rightSubjectId: entry.rightSubjectId,
      outcome: entry.outcome as "left" | "tie" | "right",
    }));
  const fitOptions = {
    priorStrength: request.priorStrength,
    priorScale: request.priorScale,
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

  // A larger, deterministic sample resolves Monte Carlo ambiguity only when the
  // first interval actually crosses the stopping boundary.
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

  diagnostics.forecast = forecastStoppingTime(
    request.items,
    result,
    request.distribution,
    request.history,
    request.sessionId,
    diagnostics,
    {
      randomSeed: request.randomSeed,
      forecastEfficiency: request.forecastEfficiency,
    },
  );
  const model = toModelState(
    request.sessionId,
    request.version,
    result,
    request.previousModel?.initialMeanUncertainty,
    diagnostics,
  );
  const nextPair = chooseNextPair(
    request.items,
    request.history,
    result,
    diagnostics,
    request.distribution,
    request.sessionId,
    request.version,
    request.randomSeed,
    {
      maxRateGap: request.maxRateGap,
      maxRankDistance: request.maxRankDistance,
    },
  );
  return { type: "MODEL_READY", requestId: request.requestId, model, nextPair };
}
