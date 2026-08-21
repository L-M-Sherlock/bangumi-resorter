/// <reference lib="webworker" />

import { finalizeRanking, prepareRanking } from "./compute";
import {
  computePreparedForecasts,
  ForecastWorkerPool,
  forecastRolloutCount,
  forecastWorkerCount,
} from "./parallel-forecast";
import { RankingRequest, RankingResponse } from "./protocol";
import ForecastWorker from "./forecast.worker?worker";

const mobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
const forecastPoolSize = forecastWorkerCount(
  navigator.hardwareConcurrency,
  80,
  forecastRolloutCount({ mobile }),
  mobile,
);
const forecastPool = typeof Worker === "undefined" || forecastPoolSize === 0
  ? undefined
  : new ForecastWorkerPool(
    forecastPoolSize,
    () => new ForecastWorker({ name: "bangumi-forecast-path" }),
  );

self.onmessage = async (event: MessageEvent<RankingRequest>) => {
  const request = event.data;
  try {
    const prepared = prepareRanking(request);
    const simulations = await computePreparedForecasts(prepared, {
      hardwareConcurrency: navigator.hardwareConcurrency,
      mobile,
      workerPool: forecastPool,
    });
    const response: RankingResponse = finalizeRanking(prepared, simulations);
    self.postMessage(response);
  } catch (error) {
    const response: RankingResponse = {
      type: "ERROR",
      requestId: request.requestId,
      message: error instanceof Error ? error.message : "动态剩余预测失败。",
    };
    self.postMessage(response);
  }
};

export {};
