import { bench, describe } from "vitest";
import {
  basePosteriorSampleCount,
  computeRanking,
  posteriorRandomSeed,
  prepareRanking,
} from "../lib/ranking/compute";
import {
  analyzeRanking,
  chooseNextPair,
  fitModel,
  forecastStoppingTimeRolloutsByMode,
  prepareStoppingForecastRollouts,
  summarizeRankingEvidence,
} from "../lib/ranking/engine";
import { rankingTuning } from "../lib/ranking/strategy";
import { createComparisonBenchmarkScenario } from "./comparison-fixture";

const FAST = { time: 0, iterations: 20, warmupTime: 0, warmupIterations: 2 };
const MEDIUM = { time: 0, iterations: 5, warmupTime: 0, warmupIterations: 1 };
const HEAVY = { time: 0, iterations: 2, warmupTime: 0, warmupIterations: 0 };
const ONE_SHOT = { time: 0, iterations: 1, warmupTime: 0, warmupIterations: 0 };

const scenario = createComparisonBenchmarkScenario();
const request = scenario.request;
const tuning = rankingTuning(request.priorMode ?? "strong");
const evidence = summarizeRankingEvidence(request.history, request.sessionId);
const fitOptions = {
  priorStrength: tuning.priorStrength,
  priorScale: tuning.priorScale,
  randomSeed: posteriorRandomSeed(request.randomSeed),
};
const baseFit = fitModel(request.items, evidence.comparisons, undefined, {
  ...fitOptions,
  posteriorSampleCount: basePosteriorSampleCount(request),
});
const prepared = prepareRanking(request);
const rolloutInput = prepareStoppingForecastRollouts(
  request.items,
  prepared.active.fit,
  request.distribution,
  request.history,
  request.sessionId,
  prepared.active.diagnostics,
  { ...prepared.active.options, rolloutCount: 64 },
  64,
);
const forecastTask = {
  taskId: "comparison-benchmark:0",
  input: rolloutInput,
  rolloutStart: 0,
  rolloutCount: 16,
  forecastIndex: 0,
};
let sink: unknown;

console.info([
  "Comparison benchmark fixture",
  `  items: ${request.items.length}`,
  `  history sent to worker: ${request.history.length} (${scenario.existingHistory.length} existing + 1 new)`,
  `  local/imported/calibration: 722/491/59 after the new answer`,
  `  prior / stopping / score buckets: ${request.priorMode}/${request.budgetMode}/${request.distribution.levelCount}`,
  `  raw/effective evidence: ${evidence.rawEvidenceCount}/${evidence.evidenceCount.toFixed(1)}`,
  `  unique pairs / covered items: ${evidence.uniquePairCount}/${evidence.coveredItemCount}`,
  `  posterior samples used by production branch: ${prepared.active.fit.posteriorSamples.length}`,
  `  forecast horizon / paths: ${rolloutInput.projectionHorizon}/64`,
].join("\n"));

describe("one comparison · 284 items · 1,212 existing judgments", () => {
  bench("01 request structured clone (UI -> ranking Worker)", () => {
    sink = structuredClone(request);
  }, FAST);

  bench("02 correlation/time-decay evidence aggregation", () => {
    sink = summarizeRankingEvidence(request.history, request.sessionId);
  }, FAST);

  bench(`03 MAP fit + ${basePosteriorSampleCount(request)}-sample Laplace posterior`, () => {
    sink = fitModel(request.items, evidence.comparisons, undefined, {
      ...fitOptions,
      posteriorSampleCount: basePosteriorSampleCount(request),
    });
  }, MEDIUM);

  bench("04 posterior bucket/stopping diagnostics", () => {
    sink = analyzeRanking(
      request.items,
      baseFit,
      request.distribution,
      request.history,
      request.sessionId,
      request.budgetMode,
    );
  }, MEDIUM);

  bench("05 optional boundary refinement · 2,048-sample fit + diagnostics", () => {
    const refinedFit = fitModel(request.items, evidence.comparisons, baseFit.abilities, {
      ...fitOptions,
      posteriorSampleCount: 2_048,
    });
    sink = analyzeRanking(
      request.items,
      refinedFit,
      request.distribution,
      request.history,
      request.sessionId,
      request.budgetMode,
    );
  }, ONE_SHOT);

  bench("06 prepare 64 shared stopping-forecast paths", () => {
    sink = prepareStoppingForecastRollouts(
      request.items,
      prepared.active.fit,
      request.distribution,
      request.history,
      request.sessionId,
      prepared.active.diagnostics,
      { ...prepared.active.options, rolloutCount: 64 },
      64,
    );
  }, MEDIUM);

  bench("07 clone one forecast task into a child Worker", () => {
    sink = structuredClone(forecastTask);
  }, MEDIUM);

  bench("08 forecast one desktop child chunk · 16/64 paths", () => {
    sink = forecastStoppingTimeRolloutsByMode(rolloutInput, 0, 16);
  }, HEAVY);

  bench("09 choose the next comparison pair", () => {
    sink = chooseNextPair(
      request.items,
      request.history,
      prepared.active.fit,
      prepared.active.diagnostics,
      request.distribution,
      request.sessionId,
      request.version,
      request.randomSeed,
      {
        maxRateGap: tuning.maxRateGap,
        maxRankDistance: tuning.maxRankDistance,
        boundaryWindow: tuning.boundaryWindow,
        explorationInterval: tuning.explorationInterval,
        explorationRadius: tuning.explorationRadius,
      },
    );
  }, MEDIUM);

  bench("10 full ranking calculation · sequential 64-path fallback", () => {
    sink = computeRanking(request);
  }, ONE_SHOT);
});

void sink;
