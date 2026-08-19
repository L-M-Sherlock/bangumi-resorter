/// <reference lib="webworker" />

import {
  runForecastWorkerTask,
  type ForecastWorkerResponse,
  type ForecastWorkerTask,
} from "./parallel-forecast";

self.onmessage = (event: MessageEvent<ForecastWorkerTask>) => {
  const request = event.data;
  try {
    const response = runForecastWorkerTask(request);
    self.postMessage(response);
  } catch (error) {
    const response: ForecastWorkerResponse = {
      taskId: request.taskId,
      error: error instanceof Error ? error.message : "停止预测 Worker 发生错误。",
    };
    self.postMessage(response);
  }
};

export {};
