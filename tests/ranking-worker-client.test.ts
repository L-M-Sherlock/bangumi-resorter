import { describe, expect, it } from "vitest";
import { RankingWorkerClient, type RankingWorkerFactory } from "../lib/ranking/worker-client";
import type { RankingRequest, RankingResponse } from "../lib/ranking/protocol";

type WorkerMessageHandler = ((event: MessageEvent<RankingResponse>) => void) | null;

class FakeRankingWorker {
  onmessage: WorkerMessageHandler = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  readonly messages: RankingRequest[] = [];
  terminated = false;

  postMessage(message: RankingRequest) {
    if (this.terminated) throw new Error("worker terminated");
    this.messages.push(message);
  }

  terminate() {
    this.terminated = true;
  }

  respond() {
    const request = this.messages.at(-1)!;
    this.onmessage?.({
      data: { type: "MODEL_READY", requestId: request.requestId, model: {} },
    } as MessageEvent<RankingResponse>);
  }

  fail(message = "worker failed") {
    this.onerror?.({ message } as ErrorEvent);
  }
}

function request(): Omit<RankingRequest, "requestId"> {
  return {
    type: "INIT_SESSION",
    sessionId: "session",
    version: 0,
    randomSeed: 1,
    items: [{ subjectId: 1, rate: 5 }, { subjectId: 2, rate: 6 }],
    history: [],
    distribution: { preset: "uniform", levelCount: 10, weights: Array(10).fill(1) },
  };
}

function factory(workers: FakeRankingWorker[]): RankingWorkerFactory {
  return () => {
    const worker = new FakeRankingWorker();
    workers.push(worker);
    return worker as unknown as Worker;
  };
}

describe("RankingWorkerClient", () => {
  it("resolves a response and does not restart a healthy worker", async () => {
    const workers: FakeRankingWorker[] = [];
    const client = new RankingWorkerClient({ timeoutMs: 20, createWorker: factory(workers) });
    const result = client.run(request());
    workers[0].respond();

    await expect(result).resolves.toMatchObject({ type: "MODEL_READY" });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(workers).toHaveLength(1);
    expect(workers[0].terminated).toBe(false);
    client.terminate();
  });

  it("rejects a stalled request, replaces the worker, and accepts a retry", async () => {
    const workers: FakeRankingWorker[] = [];
    const client = new RankingWorkerClient({ timeoutMs: 15, createWorker: factory(workers) });
    const stalled = client.run(request());

    await expect(stalled).rejects.toThrow(/超时/);
    expect(workers[0].terminated).toBe(true);
    expect(workers).toHaveLength(2);

    const retry = client.run(request());
    workers[1].respond();
    await expect(retry).resolves.toMatchObject({ type: "MODEL_READY" });
    client.terminate();
  });

  it("recovers after a Worker error instead of reusing the broken instance", async () => {
    const workers: FakeRankingWorker[] = [];
    const client = new RankingWorkerClient({ timeoutMs: 50, createWorker: factory(workers) });
    const failed = client.run(request());
    workers[0].fail();

    await expect(failed).rejects.toThrow("worker failed");
    expect(workers[0].terminated).toBe(true);
    expect(workers).toHaveLength(2);
    const retry = client.run(request());
    workers[1].respond();
    await expect(retry).resolves.toMatchObject({ type: "MODEL_READY" });
    client.terminate();
  });
});
