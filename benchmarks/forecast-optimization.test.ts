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

const EXPECTED_FINGERPRINTS: Record<number, string> = {
  16: "4d379ab5608167a5e6adc85236a7c2a15a24481b703a3489c797dffb91d17236",
  32: "db70312673fc16d7e5942b770a4d5cdd93f4883234a1430e120a38959f778dd2",
  64: "3edcca6253a7b4ba522fe5dd0ca3e068ca34ddd6f54e374168636540c1be1fa5",
};
const CHECKPOINT = 450;
const requestedRolloutCount = Number(process.env.FORECAST_OPTIMIZATION_ROLLOUT_COUNT ?? 64);
const ROLLOUT_COUNT = [16, 32, 64].includes(requestedRolloutCount)
  ? requestedRolloutCount
  : 64;

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

function prefix(result: StoppingTimesByMode, rolloutCount: number): StoppingTimesByMode {
  return Object.fromEntries(STOPPING_MODE_ORDER.map((mode) => [
    mode,
    result[mode].slice(0, rolloutCount),
  ])) as StoppingTimesByMode;
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
    { ...prepared.active.options, rolloutCount: ROLLOUT_COUNT },
    ROLLOUT_COUNT,
  );
  const startedAt = performance.now();
  const result = forecastStoppingTimeRolloutsByMode(input, 0, ROLLOUT_COUNT);
  const elapsedMs = performance.now() - startedAt;
  const actual = fingerprint(result);
  const expectedFingerprint = EXPECTED_FINGERPRINTS[ROLLOUT_COUNT];
  const exactMatch = expectedFingerprint === "baseline-pending"
    || actual === expectedFingerprint;
  const modes = summary(result);
  const quick = modes.quick;
  console.info(`FORECAST_OPTIMIZATION_RESULT ${JSON.stringify({
    fingerprint: actual,
    expectedFingerprint,
    exactMatch,
    elapsedMs,
    checkpoint: CHECKPOINT,
    horizon: input.projectionHorizon,
    rolloutCount: ROLLOUT_COUNT,
    modes,
    quickQuantileDeltaFrom64: {
      p10: quick.p10 === null ? null : quick.p10 - 352,
      p50: quick.p50 === null ? null : quick.p50 - 384,
      p90: quick.p90 === null ? null : quick.p90 - 416,
    },
    prefixModes: Object.fromEntries([16, 32, 64].filter((count) => count <= ROLLOUT_COUNT).map((count) => [
      count,
      summary(prefix(result, count)),
    ])),
  })}`);
  expect(exactMatch).toBe(true);
}, 120_000);
