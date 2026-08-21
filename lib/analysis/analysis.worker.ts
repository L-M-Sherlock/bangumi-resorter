/// <reference lib="webworker" />

import ForecastWorker from "../ranking/forecast.worker?worker";
import { ForecastWorkerPool } from "../ranking/parallel-forecast";
import { computeAnalysisHistory } from "./compute";
import type { AnalysisWorkerRequest, AnalysisWorkerResponse } from "./protocol";

const workerScope = self as DedicatedWorkerGlobalScope;

workerScope.onmessage = async (event: MessageEvent<AnalysisWorkerRequest>) => {
  const request = event.data;
  if (request.type !== "CALCULATE_HISTORY") return;
  const pool = new ForecastWorkerPool(
    request.forecastWorkerCount,
    () => new ForecastWorker({ name: "bangumi-analysis-forecast" }),
  );
  let completed = 0;
  try {
    const points = await computeAnalysisHistory(request, {
      forecastPool: pool,
      onProgress: (point, progress, total) => {
        completed = progress;
        workerScope.postMessage({
          type: "ANALYSIS_PROGRESS",
          taskId: request.taskId,
          seriesId: request.identity.id,
          inputDigest: request.inputDigest,
          completed: progress,
          total,
          point,
        } satisfies AnalysisWorkerResponse);
      },
    });
    workerScope.postMessage({
      type: "ANALYSIS_COMPLETE",
      taskId: request.taskId,
      seriesId: request.identity.id,
      inputDigest: request.inputDigest,
      completed,
      total: points.length,
    } satisfies AnalysisWorkerResponse);
  } catch (cause) {
    workerScope.postMessage({
      type: "ANALYSIS_ERROR",
      taskId: request.taskId,
      seriesId: request.identity.id,
      inputDigest: request.inputDigest,
      message: cause instanceof Error ? cause.message : "历史分析计算失败。",
    } satisfies AnalysisWorkerResponse);
  } finally {
    pool.terminate();
  }
};

export {};
