import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { expect, test } from "vitest";
import { prepareRanking } from "../lib/ranking/compute";
import {
  forecastStoppingTimeRolloutsByMode,
  prepareStoppingForecastRollouts,
  type StoppingTimesByMode,
} from "../lib/ranking/engine";
import { rankingTuning, STOPPING_MODE_ORDER } from "../lib/ranking/strategy";
import { createComparisonBenchmarkScenario } from "./comparison-fixture";

const EXPECTED_FINGERPRINT: string = "d59bb47d36bf36e27951eb120ef73a939808e3eb37134132486d9b71e912326f";
const CHECKPOINT = 450;

function encoded(values: number[]) {
  return values.map((value) => Number.isFinite(value) ? String(value) : "inf").join(",");
}

function fingerprint(result: StoppingTimesByMode) {
  return createHash("sha256")
    .update(STOPPING_MODE_ORDER.map((mode) => `${mode}:${encoded(result[mode])}`).join("|"))
    .digest("hex");
}

function quantile(values: number[], probability: number) {
  const ordered = [...values].sort((left, right) => left - right);
  const value = ordered[Math.floor(probability * Math.max(0, ordered.length - 1))];
  return Number.isFinite(value) ? value : null;
}

function summary(result: StoppingTimesByMode) {
  return Object.fromEntries(STOPPING_MODE_ORDER.map((mode) => {
    const values = result[mode];
    return [mode, {
      reached: values.filter(Number.isFinite).length,
      p10: quantile(values, 0.1),
      p50: quantile(values, 0.5),
      p90: quantile(values, 0.9),
    }];
  }));
}

test("forecast optimization preserves the exact 64-path stopping times", () => {
  const scenario = createComparisonBenchmarkScenario();
  const tuning = rankingTuning("weak");
  const request = {
    ...scenario.request,
    requestId: "forecast-optimization",
    version: CHECKPOINT,
    history: scenario.request.history.slice(0, CHECKPOINT),
    priorMode: "weak" as const,
    budgetMode: "standard" as const,
    ...tuning,
  };
  const prepared = prepareRanking(request);
  const input = prepareStoppingForecastRollouts(
    request.items,
    prepared.active.fit,
    request.distribution,
    request.history,
    request.sessionId,
    prepared.active.diagnostics,
    { ...prepared.active.options, rolloutCount: 64 },
    64,
  );
  const startedAt = performance.now();
  const result = forecastStoppingTimeRolloutsByMode(input, 0, 64);
  const elapsedMs = performance.now() - startedAt;
  const actual = fingerprint(result);
  const exactMatch = EXPECTED_FINGERPRINT === "baseline-pending"
    || actual === EXPECTED_FINGERPRINT;
  console.info(`FORECAST_OPTIMIZATION_RESULT ${JSON.stringify({
    fingerprint: actual,
    expectedFingerprint: EXPECTED_FINGERPRINT,
    exactMatch,
    elapsedMs,
    checkpoint: CHECKPOINT,
    horizon: input.projectionHorizon,
    rolloutCount: 64,
    modes: summary(result),
  })}`);
  expect(exactMatch).toBe(true);
}, 120_000);
