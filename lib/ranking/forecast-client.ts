"use client";

import { RankingRequest, RankingResponse, RankingSuccess } from "./protocol";
import RankingForecastWorker from "./ranking-forecast.worker?worker";

export class RankingForecastWorkerClient {
  private worker!: Worker;
  private pending = new Map<string, { resolve: (value: RankingSuccess) => void; reject: (error: Error) => void }>();
  private terminated = false;

  constructor() {
    this.createWorker();
  }

  private createWorker() {
    const worker = new RankingForecastWorker({ name: "bangumi-ranking-forecast" });
    worker.onmessage = (event: MessageEvent<RankingResponse>) => {
      const response = event.data;
      const pending = this.pending.get(response.requestId);
      if (!pending) return;
      this.pending.delete(response.requestId);
      if (response.type === "ERROR") pending.reject(new Error(response.message));
      else pending.resolve(response);
    };
    worker.onerror = (event) => {
      if (this.worker !== worker) return;
      const error = new Error(event.message || "动态剩余预测 Worker 发生错误。");
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
      worker.terminate();
      if (!this.terminated) this.createWorker();
    };
    this.worker = worker;
  }

  run(request: Omit<RankingRequest, "requestId">): Promise<RankingSuccess> {
    if (this.terminated) return Promise.reject(new Error("动态剩余预测 Worker 已停止。"));
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
      this.worker.postMessage({ ...request, requestId } satisfies RankingRequest);
    });
  }

  cancel(message = "动态剩余预测已由更新的模型替换。") {
    if (this.terminated || this.pending.size === 0) return;
    this.worker.terminate();
    for (const pending of this.pending.values()) pending.reject(new Error(message));
    this.pending.clear();
    this.createWorker();
  }

  terminate() {
    if (this.terminated) return;
    this.terminated = true;
    this.worker.terminate();
    for (const pending of this.pending.values()) pending.reject(new Error("动态剩余预测已取消。"));
    this.pending.clear();
  }
}
