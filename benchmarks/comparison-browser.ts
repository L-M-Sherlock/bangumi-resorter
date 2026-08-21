import { RankingWorkerClient } from "../lib/ranking/worker-client";
import { forecastWorkerCount } from "../lib/ranking/parallel-forecast";
import type { ModelState } from "../lib/types";
import { createComparisonBenchmarkScenario } from "./comparison-fixture";

interface BrowserBenchmarkResult {
  status: "complete" | "error";
  environment?: {
    userAgent: string;
    hardwareConcurrency: number;
    forecastWorkers: number;
  };
  fixture?: {
    items: number;
    existingHistory: number;
    historyWithNewAnswer: number;
  };
  warmupMs?: number;
  samplesMs?: number[];
  medianMs?: number;
  diagnostics?: {
    posteriorSamples: number;
    effectiveEvidence: number;
    rawEvidence: number;
    forecastRollouts: number;
    forecastHorizon: number;
    forecastStatus: string;
  };
  error?: string;
}

declare global {
  interface Window {
    comparisonBenchmarkResult?: BrowserBenchmarkResult;
  }
}

function median(values: number[]) {
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 0
    ? (ordered[middle - 1] + ordered[middle]) / 2
    : ordered[middle];
}

async function timedRun(
  client: RankingWorkerClient,
  request: Parameters<RankingWorkerClient["run"]>[0],
) {
  const startedAt = performance.now();
  const result = await client.run(request);
  return { elapsed: performance.now() - startedAt, result };
}

async function run() {
  const output = document.querySelector<HTMLPreElement>("#result");
  const scenario = createComparisonBenchmarkScenario();
  const { requestId, ...request } = scenario.request;
  void requestId;
  const requestedIterations = Number(new URLSearchParams(location.search).get("iterations"));
  const iterations = Number.isFinite(requestedIterations)
    ? Math.min(10, Math.max(1, Math.round(requestedIterations)))
    : 3;
  const client = new RankingWorkerClient();
  try {
    const warmup = await timedRun(client, request);
    let previousModel: ModelState | undefined = warmup.result.model;
    const samplesMs: number[] = [];
    let lastResult = warmup.result;
    for (let index = 0; index < iterations; index += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const sample = await timedRun(client, {
        ...request,
        version: request.version + index + 1,
        previousModel,
      });
      samplesMs.push(sample.elapsed);
      previousModel = sample.result.model;
      lastResult = sample.result;
    }
    const forecast = lastResult.model.diagnostics?.forecast;
    window.comparisonBenchmarkResult = {
      status: "complete",
      environment: {
        userAgent: navigator.userAgent,
        hardwareConcurrency: navigator.hardwareConcurrency,
        forecastWorkers: forecastWorkerCount(
          navigator.hardwareConcurrency,
          request.items.length,
          64,
          false,
        ),
      },
      fixture: {
        items: request.items.length,
        existingHistory: scenario.existingHistory.length,
        historyWithNewAnswer: request.history.length,
      },
      warmupMs: warmup.elapsed,
      samplesMs,
      medianMs: median(samplesMs),
      diagnostics: {
        posteriorSamples: lastResult.model.diagnostics?.sampleCount ?? 0,
        effectiveEvidence: lastResult.model.effectiveComparisons ?? 0,
        rawEvidence: lastResult.model.acceptedComparisons,
        forecastRollouts: forecast?.rolloutCount ?? 0,
        forecastHorizon: forecast?.projectionHorizon ?? 0,
        forecastStatus: forecast?.status ?? "missing",
      },
    };
    if (output) output.textContent = JSON.stringify(window.comparisonBenchmarkResult, null, 2);
  } catch (cause) {
    window.comparisonBenchmarkResult = {
      status: "error",
      error: cause instanceof Error ? cause.stack ?? cause.message : String(cause),
    };
    if (output) output.textContent = window.comparisonBenchmarkResult.error ?? "Unknown error";
  } finally {
    client.terminate();
  }
}

window.comparisonBenchmarkResult = undefined;
void run();
