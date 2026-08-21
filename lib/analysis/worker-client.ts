"use client";

import AnalysisWorker from "./analysis.worker?worker";
import type {
  AnalysisWorkerProgress,
  AnalysisWorkerRequest,
  AnalysisWorkerResponse,
} from "./protocol";

interface PendingTask {
  resolve: () => void;
  reject: (error: Error) => void;
  onProgress: (progress: AnalysisWorkerProgress) => void | Promise<void>;
  writes: Promise<void>;
}

export class AnalysisWorkerClient {
  private worker: Worker | null = null;
  private pending = new Map<string, PendingTask>();
  private closed = false;

  private createWorker() {
    const worker = new AnalysisWorker({ name: "bangumi-session-analysis" });
    this.worker = worker;
    worker.onmessage = (event: MessageEvent<AnalysisWorkerResponse>) => {
      const response = event.data;
      const task = this.pending.get(response.taskId);
      if (!task) return;
      if (response.type === "ANALYSIS_PROGRESS") {
        task.writes = task.writes.then(() => task.onProgress(response));
        return;
      }
      this.pending.delete(response.taskId);
      if (response.type === "ANALYSIS_ERROR") {
        void task.writes.then(() => task.reject(new Error(response.message)), task.reject);
      } else {
        void task.writes.then(task.resolve, task.reject);
      }
    };
    worker.onerror = (event) => {
      const error = new Error(event.message || "分析 Worker 发生错误。");
      for (const task of this.pending.values()) task.reject(error);
      this.pending.clear();
      worker.terminate();
      if (this.worker === worker) this.worker = null;
    };
  }

  run(
    request: Omit<AnalysisWorkerRequest, "taskId">,
    onProgress: PendingTask["onProgress"],
  ) {
    if (this.pending.size > 0) return Promise.reject(new Error("已有历史分析任务正在运行。"));
    if (this.closed) return Promise.reject(new Error("分析 Worker 已经关闭。"));
    if (!this.worker) this.createWorker();
    const taskId = crypto.randomUUID();
    return new Promise<void>((resolve, reject) => {
      this.pending.set(taskId, { resolve, reject, onProgress, writes: Promise.resolve() });
      this.worker!.postMessage({ ...request, taskId } satisfies AnalysisWorkerRequest);
    });
  }

  cancel(message = "历史分析已取消。") {
    this.worker?.terminate();
    this.worker = null;
    for (const task of this.pending.values()) task.reject(new Error(message));
    this.pending.clear();
  }

  terminate() {
    this.closed = true;
    this.worker?.terminate();
    this.worker = null;
    for (const task of this.pending.values()) task.reject(new Error("历史分析已取消。"));
    this.pending.clear();
  }
}
