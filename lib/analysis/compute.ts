import { finalizeRanking, finalizeRankingWithoutForecast, prepareRanking } from "../ranking/compute";
import { computePreparedForecasts, type ForecastWorkerPool } from "../ranking/parallel-forecast";
import { rankingTuning } from "../ranking/strategy";
import {
  analysisPointFromModel,
  analysisPointWithAvailabilityForecast,
  analysisPrefixDigest,
  sortAnalysisHistoryByAvailability,
} from "./index";
import type { AnalysisWorkerRequest } from "./protocol";
import { ANALYSIS_ROLLOUT_COUNT, type SessionAnalysisPoint } from "./types";

export async function computeAnalysisCheckpoint(
  request: AnalysisWorkerRequest,
  checkpoint: number,
  forecastPool?: ForecastWorkerPool,
) {
  const sourceHistory = request.history.slice(0, checkpoint);
  const availabilityHistory = sortAnalysisHistoryByAvailability(request.history).slice(0, checkpoint);
  const tuning = rankingTuning(request.priorMode);
  // Historical checkpoints deliberately use a stable standard-mode alias.
  // prepareRanking still creates the three ordered checks and the forecast
  // simulator emits all three modes over the same fixed 64 paths.
  const prepare = (history: typeof request.history) => prepareRanking({
    type: "RECOMPUTE",
    requestId: `${request.taskId}:${checkpoint}`,
    sessionId: request.identity.sessionId,
    version: checkpoint,
    randomSeed: request.randomSeed,
    items: request.items,
    history,
    distribution: request.distribution,
    budgetMode: "standard",
    priorMode: request.priorMode,
    ...tuning,
  });
  const availabilityIds = new Set(availabilityHistory.map((entry) => entry.recordId));
  const sameEvidenceSet = sourceHistory.length === availabilityHistory.length
    && sourceHistory.every((entry) => availabilityIds.has(entry.recordId));
  if (sameEvidenceSet) {
    const prepared = prepare(sourceHistory);
    const simulations = await computePreparedForecasts(prepared, {
      rolloutCount: ANALYSIS_ROLLOUT_COUNT,
      hardwareConcurrency: 2,
      workerPool: forecastPool,
    });
    const model = finalizeRanking(prepared, simulations).model;
    const point = analysisPointFromModel(sourceHistory, model);
    point.prefixDigest = analysisPrefixDigest(request.history, checkpoint);
    point.forecastPrefixDigest = analysisPrefixDigest(availabilityHistory);
    return point;
  }

  const sourcePrepared = prepare(sourceHistory);
  const sourceModel = finalizeRankingWithoutForecast(sourcePrepared).model;
  const sourcePoint = analysisPointFromModel(sourceHistory, sourceModel);
  const availabilityPrepared = prepare(availabilityHistory);
  const simulations = await computePreparedForecasts(availabilityPrepared, {
    rolloutCount: ANALYSIS_ROLLOUT_COUNT,
    hardwareConcurrency: 2,
    workerPool: forecastPool,
  });
  const availabilityModel = finalizeRanking(availabilityPrepared, simulations).model;
  const availabilityPoint = analysisPointFromModel(availabilityHistory, availabilityModel);
  const point = analysisPointWithAvailabilityForecast(sourcePoint, availabilityPoint);
  point.prefixDigest = analysisPrefixDigest(request.history, checkpoint);
  return point;
}

export interface ComputeAnalysisHistoryOptions {
  forecastPool?: ForecastWorkerPool;
  cancelled?: () => boolean;
  onProgress?: (point: SessionAnalysisPoint, completed: number, total: number) => void | Promise<void>;
  computeCheckpoint?: typeof computeAnalysisCheckpoint;
}

export async function computeAnalysisHistory(
  request: AnalysisWorkerRequest,
  options: ComputeAnalysisHistoryOptions = {},
) {
  const checkpoints = [...new Set(request.checkpoints)]
    .filter((checkpoint) => Number.isInteger(checkpoint) && checkpoint >= 0 && checkpoint <= request.history.length)
    .sort((left, right) => left - right);
  const points: SessionAnalysisPoint[] = [];
  const compute = options.computeCheckpoint ?? computeAnalysisCheckpoint;
  for (const checkpoint of checkpoints) {
    if (options.cancelled?.()) throw new Error("历史分析已取消。");
    const point = await compute(request, checkpoint, options.forecastPool);
    points.push(point);
    await options.onProgress?.(point, points.length, checkpoints.length);
  }
  return points;
}
