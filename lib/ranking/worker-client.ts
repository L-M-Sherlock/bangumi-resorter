"use client";

import { RankingRequest, RankingResponse, RankingSuccess } from "./protocol";
import RankingWorker from "./ranking.worker?worker";

/**
 * Ranking is deliberately kept on a dedicated Worker, but a browser can
 * suspend a Worker or fail to load a stale hashed chunk without delivering an
 * `error` event.  Never leave the UI waiting forever in that case.
 */
export const RANKING_WORKER_TIMEOUT_MS = 15_000;

export type RankingWorkerFactory = (options: WorkerOptions) => Worker;

interface PendingRequest {
  resolve: (value: RankingSuccess) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface RankingWorkerClientOptions {
  timeoutMs?: number;
  createWorker?: RankingWorkerFactory;
}

export class RankingWorkerClient {
  private worker: Worker | null = null;
  private pending = new Map<string, PendingRequest>();
  private closed = false;
  private readonly timeoutMs: number;
  private readonly createWorker: RankingWorkerFactory;

  constructor(options: RankingWorkerClientOptions = {}) {
    this.timeoutMs = Math.max(1, options.timeoutMs ?? RANKING_WORKER_TIMEOUT_MS);
    this.createWorker = options.createWorker ?? ((workerOptions) => new RankingWorker(workerOptions));
  }

  private ensureWorker() {
    if (this.closed) throw new Error("排序 Worker 已经关闭。");
    if (this.worker) return this.worker;

    const worker = this.createWorker({ name: "bangumi-ranking" });
    worker.onmessage = (event: MessageEvent<RankingResponse>) => {
      if (this.worker !== worker) return;
      const response = event.data;
      if (!response || typeof response.requestId !== "string") {
        this.restart(new Error("排序 Worker 返回了无效结果。"));
        return;
      }
      const pending = this.pending.get(response.requestId);
      if (!pending) return;
      this.pending.delete(response.requestId);
      clearTimeout(pending.timer);
      if (response.type === "ERROR") pending.reject(new Error(response.message));
      else if (response.type === "MODEL_READY") pending.resolve(response);
      else {
        pending.reject(new Error("排序 Worker 返回了未知结果类型。"));
        this.restart(new Error("排序 Worker 返回了未知结果类型."), worker);
      }
    };
    worker.onerror = (event) => {
      if (this.worker !== worker) return;
      const error = new Error(event.message || "排序 Worker 发生错误。");
      this.restart(error, worker);
    };
    worker.onmessageerror = () => {
      if (this.worker !== worker) return;
      this.restart(new Error("排序 Worker 返回了无法读取的结果。"), worker);
    };
    this.worker = worker;
    return worker;
  }

  private rejectPending(error: Error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  /** Stop a suspect Worker and lazily create a clean replacement. */
  private restart(error: Error, expectedWorker = this.worker) {
    if (expectedWorker && this.worker !== expectedWorker) return;
    const worker = this.worker;
    this.worker = null;
    worker?.terminate();
    this.rejectPending(error);
    if (!this.closed) {
      // Worker construction can itself fail while a deployment is settling;
      // leave it lazy so the next user action gets another clean attempt.
      try { this.ensureWorker(); } catch { /* run() reports the next failure. */ }
    }
  }

  run(request: Omit<RankingRequest, "requestId">): Promise<RankingSuccess> {
    if (this.closed) return Promise.reject(new Error("排序 Worker 已经关闭。"));
    let worker: Worker;
    try {
      worker = this.ensureWorker();
    } catch (cause) {
      return Promise.reject(cause instanceof Error ? cause : new Error("排序 Worker 无法启动。"));
    }
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.has(requestId)) return;
        this.restart(new Error(`排序模型计算超时（超过 ${Math.ceil(this.timeoutMs / 1000)} 秒）。已重置 Worker，请重试；如果持续发生，请刷新页面。`), worker);
      }, this.timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
      try {
        worker.postMessage({ ...request, requestId } satisfies RankingRequest);
      } catch (cause) {
        const error = cause instanceof Error ? cause : new Error("排序请求无法发送到 Worker。");
        this.restart(error, worker);
      }
    });
  }

  terminate() {
    if (this.closed) return;
    this.closed = true;
    const worker = this.worker;
    this.worker = null;
    worker?.terminate();
    this.rejectPending(new Error("排序计算已取消。"));
  }
}
