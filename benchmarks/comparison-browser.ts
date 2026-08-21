import { RankingForecastWorkerClient } from "../lib/ranking/forecast-client";
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
  timing?: {
    quickWarmupMs: number;
    backgroundWarmupMs: number;
    answerToForecastWarmupMs: number;
    quickSamplesMs: number[];
    backgroundSamplesMs: number[];
    answerToForecastSamplesMs: number[];
    quickMedianMs: number;
    backgroundMedianMs: number;
    answerToForecastMedianMs: number;
  };
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
  client: Pick<RankingWorkerClient, "run">,
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
  const quickClient = new RankingWorkerClient();
  const forecastClient = new RankingForecastWorkerClient();
  try {
    const quickWarmup = await timedRun(quickClient, request);
    const backgroundWarmup = await timedRun(forecastClient, request);
    let previousModel: ModelState | undefined = backgroundWarmup.result.model;
    const quickSamplesMs: number[] = [];
    const backgroundSamplesMs: number[] = [];
    const answerToForecastSamplesMs: number[] = [];
    let lastQuickResult = quickWarmup.result;
    let lastForecastResult = backgroundWarmup.result;
    for (let index = 0; index < iterations; index += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const sampleRequest = {
        ...request,
        version: request.version + index + 1,
        previousModel,
      };
      const quickSample = await timedRun(quickClient, sampleRequest);
      const backgroundSample = await timedRun(forecastClient, sampleRequest);
      quickSamplesMs.push(quickSample.elapsed);
      backgroundSamplesMs.push(backgroundSample.elapsed);
      answerToForecastSamplesMs.push(quickSample.elapsed + backgroundSample.elapsed);
      previousModel = backgroundSample.result.model;
      lastQuickResult = quickSample.result;
      lastForecastResult = backgroundSample.result;
    }
    const forecast = lastForecastResult.model.diagnostics?.forecast;
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
      timing: {
        quickWarmupMs: quickWarmup.elapsed,
        backgroundWarmupMs: backgroundWarmup.elapsed,
        answerToForecastWarmupMs: quickWarmup.elapsed + backgroundWarmup.elapsed,
        quickSamplesMs,
        backgroundSamplesMs,
        answerToForecastSamplesMs,
        quickMedianMs: median(quickSamplesMs),
        backgroundMedianMs: median(backgroundSamplesMs),
        answerToForecastMedianMs: median(answerToForecastSamplesMs),
      },
      diagnostics: {
        posteriorSamples: lastQuickResult.model.diagnostics?.sampleCount ?? 0,
        effectiveEvidence: lastQuickResult.model.effectiveComparisons ?? 0,
        rawEvidence: lastQuickResult.model.acceptedComparisons,
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
    quickClient.terminate();
    forecastClient.terminate();
  }
}

window.comparisonBenchmarkResult = undefined;
void run();
