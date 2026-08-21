import { finalizeRanking, prepareRanking } from "../ranking/compute";
import { computePreparedForecasts, type ForecastWorkerPool } from "../ranking/parallel-forecast";
import { rankingTuning } from "../ranking/strategy";
import { analysisPointFromModel, analysisPrefixDigest } from "./index";
import type { AnalysisWorkerRequest } from "./protocol";
import { ANALYSIS_ROLLOUT_COUNT, type SessionAnalysisPoint } from "./types";

export async function computeAnalysisCheckpoint(
  request: AnalysisWorkerRequest,
  checkpoint: number,
  forecastPool?: ForecastWorkerPool,
) {
  const history = request.history.slice(0, checkpoint);
  const tuning = rankingTuning(request.priorMode);
  // Historical checkpoints deliberately use a stable standard-mode alias.
  // prepareRanking still creates the three ordered checks and the forecast
  // simulator emits all three modes over the same 64 paths.
  const prepared = prepareRanking({
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
  const simulations = await computePreparedForecasts(prepared, {
    rolloutCount: ANALYSIS_ROLLOUT_COUNT,
    hardwareConcurrency: 2,
    workerPool: forecastPool,
  });
  const model = finalizeRanking(prepared, simulations).model;
  const point = analysisPointFromModel(history, model);
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
