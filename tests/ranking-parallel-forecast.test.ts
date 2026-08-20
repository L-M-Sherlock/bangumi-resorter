import { describe, expect, it } from "vitest";
import { prepareRanking } from "../lib/ranking/compute";
import {
  computePreparedForecasts,
  ForecastWorkerPool,
  forecastWorkerCount,
  runForecastWorkerTask,
  type ForecastWorkerLike,
  type ForecastWorkerTask,
} from "../lib/ranking/parallel-forecast";
import type { RankingRequest } from "../lib/ranking/protocol";
import type { RankingHistoryInput } from "../lib/types";

function request(): RankingRequest {
  const items = Array.from({ length: 80 }, (_, index) => ({
    subjectId: index + 1,
    rate: 1 + index % 10,
  }));
  const history: RankingHistoryInput[] = Array.from({ length: 40 }, (_, index) => ({
    recordId: `record-${index}`,
    sessionId: "session",
    leftSubjectId: 1 + index % 79,
    rightSubjectId: 2 + index % 79,
    outcome: index % 3 === 0 ? "left" : "right",
    acceptedCountAtAnswer: index + 1,
    queryKind: "adaptive",
    createdAt: new Date(index * 1000).toISOString(),
  }));
  return {
    type: "RECOMPUTE",
    requestId: "parallel",
    sessionId: "session",
    version: 1,
    randomSeed: 20260820,
    items,
    history,
    distribution: { preset: "uniform", levelCount: 10, weights: Array(10).fill(1) },
    budgetMode: "quick",
    priorMode: "weak",
  };
}

class InlineForecastWorker implements ForecastWorkerLike {
  onmessage: ((event: MessageEvent<ReturnType<typeof runForecastWorkerTask>>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  terminated = false;

  postMessage(task: ForecastWorkerTask) {
    queueMicrotask(() => this.onmessage?.({ data: runForecastWorkerTask(task) } as MessageEvent));
  }

  terminate() {
    this.terminated = true;
  }
}

describe("parallel stopping forecast", () => {
  it("caps forecast workers and skips parallel overhead for small jobs", () => {
    expect(forecastWorkerCount(16, 284, 64)).toBe(4);
    expect(forecastWorkerCount(2, 284, 64)).toBe(2);
    expect(forecastWorkerCount(16, 284, 64, true)).toBe(2);
    expect(forecastWorkerCount(1, 284, 64)).toBe(0);
    expect(forecastWorkerCount(8, 40, 64)).toBe(0);
    expect(forecastWorkerCount(8, 284, 16)).toBe(0);
  });

  it("produces identical rollouts when split across workers", async () => {
    const prepared = prepareRanking(request());
    const sequential = await computePreparedForecasts(prepared, {
      hardwareConcurrency: 1,
      rolloutCount: 32,
    });
    const workers: InlineForecastWorker[] = [];
    const parallel = await computePreparedForecasts(prepared, {
      hardwareConcurrency: 4,
      rolloutCount: 32,
      createWorker: () => {
        const worker = new InlineForecastWorker();
        workers.push(worker);
        return worker;
      },
    });

    expect(parallel).toEqual(sequential);
    for (const simulation of parallel) {
      for (let index = 0; index < simulation.stoppingTimesByMode.quick.length; index += 1) {
        expect(simulation.stoppingTimesByMode.quick[index])
          .toBeLessThanOrEqual(simulation.stoppingTimesByMode.standard[index]);
        expect(simulation.stoppingTimesByMode.standard[index])
          .toBeLessThanOrEqual(simulation.stoppingTimesByMode.thorough[index]);
      }
    }
    expect(workers).toHaveLength(4);
    expect(workers.every((worker) => worker.terminated)).toBe(true);
  });

  it("reuses the same child workers across forecasts", async () => {
    const prepared = prepareRanking(request());
    const workers: InlineForecastWorker[] = [];
    const pool = new ForecastWorkerPool(4, () => {
      const worker = new InlineForecastWorker();
      workers.push(worker);
      return worker;
    });
    const options = { hardwareConcurrency: 4, rolloutCount: 32, workerPool: pool };
    await computePreparedForecasts(prepared, options);
    await computePreparedForecasts(prepared, options);

    expect(workers).toHaveLength(4);
    expect(workers.every((worker) => !worker.terminated)).toBe(true);
    pool.terminate();
    expect(workers.every((worker) => worker.terminated)).toBe(true);
  });

  it("does not create child workers after the strictest threshold is ready", async () => {
    const prepared = prepareRanking(request());
    for (const forecast of prepared.forecasts) {
      forecast.diagnostics.evidenceCount = forecast.diagnostics.evidenceRequired;
      forecast.diagnostics.coverageTargetStabilityLow = 1;
      forecast.diagnostics.ready = true;
      forecast.diagnostics.stoppingChecks?.forEach((check) => {
        check.low = 1;
        check.high = 1;
        check.ready = true;
      });
    }
    let created = 0;
    const result = await computePreparedForecasts(prepared, {
      hardwareConcurrency: 4,
      rolloutCount: 32,
      createWorker: () => {
        created += 1;
        return new InlineForecastWorker();
      },
    });

    expect(created).toBe(0);
    expect(result.every((simulation) => Object.values(simulation.forecasts)
      .every((forecast) => forecast.status === "ready"))).toBe(true);
  });

  it("falls back to the single-worker calculation when a child worker fails", async () => {
    const prepared = prepareRanking(request());
    const sequential = await computePreparedForecasts(prepared, {
      hardwareConcurrency: 1,
      rolloutCount: 32,
    });
    const fallback = await computePreparedForecasts(prepared, {
      hardwareConcurrency: 4,
      rolloutCount: 32,
      createWorker: () => {
        throw new Error("nested workers unavailable");
      },
    });
    expect(fallback).toEqual(sequential);
  });
});
