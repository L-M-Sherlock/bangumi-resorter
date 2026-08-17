"use client";

import { RankingRequest, RankingResponse, RankingSuccess } from "./protocol";
import RankingWorker from "./ranking.worker?worker";

export class RankingWorkerClient {
  private worker: Worker;
  private pending = new Map<string, { resolve: (value: RankingSuccess) => void; reject: (error: Error) => void }>();

  constructor() {
    this.worker = new RankingWorker({ name: "bangumi-ranking" });
    this.worker.onmessage = (event: MessageEvent<RankingResponse>) => {
      const response = event.data;
      const pending = this.pending.get(response.requestId);
      if (!pending) return;
      this.pending.delete(response.requestId);
      if (response.type === "ERROR") pending.reject(new Error(response.message));
      else pending.resolve(response);
    };
    this.worker.onerror = (event) => {
      const error = new Error(event.message || "排序 Worker 发生错误。");
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
    };
  }

  run(request: Omit<RankingRequest, "requestId">): Promise<RankingSuccess> {
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
      this.worker.postMessage({ ...request, requestId } satisfies RankingRequest);
    });
  }

  terminate() {
    this.worker.terminate();
    for (const pending of this.pending.values()) pending.reject(new Error("排序计算已取消。"));
    this.pending.clear();
  }
}
