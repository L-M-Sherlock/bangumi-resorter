import { describe, expect, it } from "vitest";
import { analyzeRanking, buildRankedItems, calibrationPosterior, chooseNextPair, fitModel, forecastStoppingTime } from "../lib/ranking/engine";
import { distributionConfig } from "../lib/distribution";
import {
  allowedCrossTwoBucketCount,
  comparisonBudget,
  forecastProjectionHorizon,
  rankingTuning,
  recommendedDistribution,
  requiredAdjacentStableItemCount,
} from "../lib/ranking/strategy";
import type { CollectionItem, DistributionConfig, RankingComparisonInput, RankingHistoryInput } from "../lib/types";

const inputs = [
  { subjectId: 1, rate: 7 },
  { subjectId: 2, rate: 7 },
  { subjectId: 3, rate: 7 },
];

function comparison(leftSubjectId: number, rightSubjectId: number, outcome: "left" | "tie" | "right"): RankingComparisonInput {
  return { leftSubjectId, rightSubjectId, outcome };
}

function item(subjectId: number, rate: number): CollectionItem {
  return { snapshotId: "s", subjectId, subjectType: 2, collectionType: 2, rate, name: `Item ${subjectId}`, nameCn: "", private: false, tags: [] };
}

const uniform: DistributionConfig = { preset: "uniform", levelCount: 10, weights: Array(10).fill(10) };

function history(
  recordId: string,
  leftSubjectId: number,
  rightSubjectId: number,
  outcome: "left" | "tie" | "right" | "skip",
  index = 0,
  queryKind: RankingHistoryInput["queryKind"] = "adaptive",
): RankingHistoryInput {
  return {
    recordId, sessionId: "session", leftSubjectId, rightSubjectId, outcome,
    acceptedCountAtAnswer: index + (outcome === "skip" ? 0 : 1), queryKind,
    createdAt: new Date(index * 1000).toISOString(),
  };
}

function nextPairFor(
  rated: Array<{ subjectId: number; rate: number }>,
  entries: RankingHistoryInput[],
  seed = 42,
  version = 4,
  distribution = uniform,
  options = {},
) {
  const comparisons = entries.filter((entry) => entry.outcome !== "skip").map((entry) => ({
    leftSubjectId: entry.leftSubjectId,
    rightSubjectId: entry.rightSubjectId,
    outcome: entry.outcome as "left" | "tie" | "right",
  }));
  const fit = fitModel(rated, comparisons, undefined, { randomSeed: seed });
  const diagnostics = analyzeRanking(rated, fit, distribution, entries, "session");
  return chooseNextPair(rated, entries, fit, diagnostics, distribution, "session", version, seed, options);
}

describe("Bradley–Terry ranking engine", () => {
  it("recovers a known preference order", () => {
    const result = fitModel(inputs, [
      comparison(1, 2, "left"), comparison(1, 2, "left"),
      comparison(2, 3, "left"), comparison(2, 3, "left"),
      comparison(1, 3, "left"),
    ]);
    expect(result.abilities[1]).toBeGreaterThan(result.abilities[2]);
    expect(result.abilities[2]).toBeGreaterThan(result.abilities[3]);
    expect(result.acceptedComparisons).toBe(5);
    expect(Number.isFinite(result.meanUncertainty)).toBe(true);
  });

  it("keeps ties symmetric and contradictory data finite", () => {
    const tied = fitModel(inputs.slice(0, 2), [comparison(1, 2, "tie")]);
    expect(tied.abilities[1]).toBeCloseTo(tied.abilities[2], 8);
    const contradictory = fitModel(inputs.slice(0, 2), [comparison(1, 2, "left"), comparison(1, 2, "right")]);
    expect(contradictory.abilities[1]).toBeCloseTo(contradictory.abilities[2], 8);
    expect(Object.values(contradictory.uncertainty).every(Number.isFinite)).toBe(true);
  });

  it("selects pairs deterministically and honors skip cooldown", () => {
    const first = nextPairFor(inputs, []);
    expect(nextPairFor(inputs, [])).toEqual(first);
    expect(first).toBeDefined();
    const cooled = nextPairFor(inputs, [history("skip", first!.leftSubjectId, first!.rightSubjectId, "skip")]);
    expect(new Set([cooled!.leftSubjectId, cooled!.rightSubjectId])).not.toEqual(new Set([first!.leftSubjectId, first!.rightSubjectId]));
  });

  it("uses a strong score prior and focuses quick questions within score buckets", () => {
    const rated = [{ subjectId: 1, rate: 9 }, { subjectId: 2, rate: 9 }, { subjectId: 3, rate: 6 }];
    const tuning = rankingTuning("quick");
    const fit = fitModel(rated, [], undefined, { ...tuning, randomSeed: 9 });
    expect(fit.abilities[1] - fit.abilities[3]).toBeCloseTo(2.1, 8);
    const pair = nextPairFor(rated, [], 9, 0, uniform, tuning);
    expect(new Set([pair?.leftSubjectId, pair?.rightSubjectId])).toEqual(new Set([1, 2]));
    expect(nextPairFor([{ subjectId: 1, rate: 10 }, { subjectId: 2, rate: 1 }], [], 9, 0, uniform, tuning)).toBeDefined();
  });

  it("retains legacy budget hints while using a non-blocking forecast horizon", () => {
    expect(comparisonBudget(1, "quick")).toBe(0);
    expect(comparisonBudget(16, "quick")).toBe(16);
    expect(comparisonBudget(400, "quick")).toBe(80);
    expect(comparisonBudget(400, "standard")).toBe(400);
    expect(comparisonBudget(400, "thorough")).toBe(800);
    expect(forecastProjectionHorizon(16)).toBe(1000);
    expect(forecastProjectionHorizon(400)).toBe(4000);
    expect(forecastProjectionHorizon(1000)).toBe(5000);
  });

  it("uses a Beta posterior instead of a raw calibration cutoff", () => {
    const sparse = calibrationPosterior(2, 2);
    expect(sparse.acceptable).toBe(true);
    const twoOfThree = calibrationPosterior(3, 2);
    expect(twoOfThree.probabilityAboveChance).toBeCloseTo(0.6875, 8);
    expect(twoOfThree.acceptable).toBe(false);
    const threeOfFour = calibrationPosterior(4, 3);
    expect(threeOfFour.probabilityAboveChance).toBeCloseTo(0.8125, 8);
    expect(threeOfFour.acceptable).toBe(true);
    expect(threeOfFour.credibleLow).toBeLessThan(threeOfFour.posteriorMean);
    expect(threeOfFour.credibleHigh).toBeGreaterThan(threeOfFour.posteriorMean);
  });

  it("maps scores to uniform, reverse-J, preserved, and zero-safe custom distributions", () => {
    const items = Array.from({ length: 20 }, (_, index) => item(index + 1, index < 5 ? 10 : index < 12 ? 7 : 4));
    const fit = fitModel(items, []);
    const uniform = buildRankedItems(items, fit, [], { preset: "uniform", levelCount: 10, weights: Array(10).fill(10) });
    expect(new Set(uniform.map((entry) => entry.newRate))).toEqual(new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]));
    const reverseItems = Array.from({ length: 100 }, (_, index) => item(index + 1, 7));
    const reverseFit = fitModel(reverseItems, []);
    const reverseJ = buildRankedItems(reverseItems, reverseFit, [], { preset: "reverse-j", levelCount: 10, weights: [50, 25, 14, 4, 2, 1, 1, 1, 1, 1] });
    expect(Array.from({ length: 10 }, (_, index) => reverseJ.filter((entry) => entry.newRate === index + 1).length)).toEqual([50, 25, 14, 4, 2, 1, 1, 1, 1, 1]);
    const preserved = buildRankedItems(items, fit, [], { preset: "preserve", levelCount: 10, weights: Array(10).fill(10) });
    for (let score = 1; score <= 10; score += 1) {
      expect(preserved.filter((entry) => entry.newRate === score)).toHaveLength(items.filter((entry) => entry.rate === score).length);
    }
    const zeroSafe = buildRankedItems(items, fit, [], { preset: "custom", levelCount: 10, weights: Array(10).fill(0) });
    expect(new Set(zeroSafe.map((entry) => entry.newRate)).size).toBeGreaterThan(1);
  });

  it("maps the same latent order to any supported K without using ability magnitude as a score", () => {
    const items = Array.from({ length: 60 }, (_, index) => item(index + 1, 7));
    const abilities = Object.fromEntries(items.map((entry, index) => [entry.subjectId, 60 - index]));
    const scaledAbilities = Object.fromEntries(items.map((entry, index) => [entry.subjectId, (60 - index) * 100]));
    const uncertainty = Object.fromEntries(items.map((entry) => [entry.subjectId, 0.5]));
    for (const levelCount of [3, 5, 10, 20]) {
      const distribution = distributionConfig("uniform", levelCount);
      const rates = buildRankedItems(items, { abilities, uncertainty }, [], distribution).map((entry) => entry.newRate);
      const scaledRates = buildRankedItems(items, { abilities: scaledAbilities, uncertainty }, [], distribution).map((entry) => entry.newRate);
      expect(Math.min(...rates)).toBe(1);
      expect(Math.max(...rates)).toBe(levelCount);
      expect(new Set(rates).size).toBe(levelCount);
      expect(scaledRates).toEqual(rates);
    }
  });

  it("uses the active K buckets for the stopping event", () => {
    const rated = Array.from({ length: 40 }, (_, index) => ({ subjectId: index + 1, rate: 7 }));
    const abilities = Object.fromEntries(rated.map((entry, index) => [entry.subjectId, 40 - index]));
    const shiftedOrder = [...rated.slice(4), ...rated.slice(0, 4)];
    const shifted = new Float64Array(rated.length);
    shiftedOrder.forEach((entry, index) => { shifted[entry.subjectId - 1] = rated.length - index; });
    const evidence = Array.from({ length: 7 }, (_, index) => history(`k-${index}`, index + 1, index + 8, "left", index));
    const fit = {
      abilities,
      uncertainty: Object.fromEntries(rated.map((entry) => [entry.subjectId, 0])),
      meanUncertainty: 0,
      converged: true,
      iterations: 1,
      acceptedComparisons: evidence.length,
      posteriorSamples: Array.from({ length: 64 }, () => shifted.slice()),
    };
    const coarse = analyzeRanking(rated, fit, distributionConfig("uniform", 3), evidence, "session");
    const fine = analyzeRanking(rated, fit, distributionConfig("uniform", 20), evidence, "session");
    expect(coarse.crossTwoBucketCountMedian).toBeLessThanOrEqual(coarse.allowedCrossTwoBucketCount);
    expect(coarse.ready).toBe(true);
    expect(fine.crossTwoBucketCountMedian).toBeGreaterThan(fine.allowedCrossTwoBucketCount);
    expect(fine.ready).toBe(false);
  });

  it("uses the high-resolution tail distribution by default", () => {
    expect(recommendedDistribution()).toBe("high-tail");
  });

  it("draws deterministic Laplace samples with posterior marginal uncertainty", () => {
    const rated = [{ subjectId: 1, rate: 7 }, { subjectId: 2, rate: 7 }];
    const first = fitModel(rated, [], undefined, { priorStrength: 0.35, posteriorSampleCount: 4096, randomSeed: 123 });
    const second = fitModel(rated, [], undefined, { priorStrength: 0.35, posteriorSampleCount: 4096, randomSeed: 123 });
    expect(first.uncertainty).toEqual(second.uncertainty);
    expect(first.uncertainty[1]).toBeCloseTo(Math.sqrt(1 / 0.35), 1);
  });

  it("schedules global exploration and reversed calibration probes", () => {
    const rated = Array.from({ length: 12 }, (_, index) => ({ subjectId: index + 1, rate: index < 6 ? 9 : 5 }));
    const nine = Array.from({ length: 9 }, (_, index) => history(`r${index}`, index % 6 + 1, index % 6 + 7, "left", index));
    const exploration = nextPairFor(rated, nine, 5, 9);
    expect(exploration?.queryKind).toBe("exploration");
    const nineteen = Array.from({ length: 19 }, (_, index) => history(`c${index}`, index % 6 + 1, index % 6 + 7, "left", index));
    const calibration = nextPairFor(rated, nineteen, 5, 19);
    expect(calibration?.queryKind).toBe("calibration");
    const original = nineteen.find((entry) => entry.recordId === calibration?.calibrationOfComparisonId)!;
    expect(calibration?.leftSubjectId).toBe(original.rightSubjectId);
    expect(calibration?.rightSubjectId).toBe(original.leftSubjectId);

    const four = Array.from({ length: 4 }, (_, index) => history(`m${index}`, index + 1, index + 2, "left", index));
    expect(nextPairFor(rated, four, 5, 4, uniform, rankingTuning("quick"))?.queryKind).toBe("adaptive");
    expect(nextPairFor(rated, four, 5, 4, uniform, rankingTuning("thorough"))?.queryKind).toBe("exploration");
  });

  it("uses materially separated inference-mode tuning", () => {
    expect(rankingTuning("quick")).toMatchObject({
      priorStrength: 1.2, priorScale: 0.7, maxRankDistance: 1,
      boundaryWindow: 1, explorationInterval: 25, explorationRadius: 2,
    });
    expect(rankingTuning("standard")).toMatchObject({
      priorStrength: 0.3, priorScale: 0.45, maxRankDistance: 4,
      boundaryWindow: 3, explorationInterval: 10, explorationRadius: 5,
    });
    expect(rankingTuning("thorough")).toMatchObject({
      priorStrength: 0.05, priorScale: 0, maxRankDistance: 10,
      boundaryWindow: 6, explorationInterval: 5, explorationRadius: 12,
    });
  });

  it("uses global exploration to cover low-count unstable items", () => {
    const rated = Array.from({ length: 12 }, (_, index) => ({ subjectId: index + 1, rate: 7 }));
    const nine = Array.from({ length: 9 }, (_, index) => history(`repeat${index}`, 1, 2, index % 2 ? "left" : "right", index));
    const exploration = nextPairFor(rated, nine, 17, 9, uniform, {
      maxRateGap: 2, maxRankDistance: 3,
    });
    expect(exploration?.queryKind).toBe("exploration");
    expect([exploration?.leftSubjectId, exploration?.rightSubjectId]).not.toContain(1);
    expect([exploration?.leftSubjectId, exploration?.rightSubjectId]).not.toContain(2);
  });

  it("reports distribution-specific bucket stability and evidence gates", () => {
    const rated = [{ subjectId: 1, rate: 7 }, { subjectId: 2, rate: 7 }];
    const entries = [history("a", 1, 2, "left", 0), history("b", 1, 2, "left", 1), history("c", 1, 2, "left", 2)];
    const fit = fitModel(rated, entries.map((entry) => ({ leftSubjectId: entry.leftSubjectId, rightSubjectId: entry.rightSubjectId, outcome: "left" as const })), undefined, { posteriorSampleCount: 512, randomSeed: 8 });
    const diagnostics = analyzeRanking(rated, fit, uniform, entries, "session");
    expect(diagnostics.evidenceCount).toBe(3);
    expect(diagnostics.evidenceRequired).toBe(3);
    expect(diagnostics.expectedBucketChangeRate).toBeLessThan(0.5);
    expect(Object.values(diagnostics.bucketStability).every((value) => value >= 0 && value <= 1)).toBe(true);
  });

  it("stops when 90% of items stay within one bucket while retaining stricter diagnostics", () => {
    const rated = Array.from({ length: 100 }, (_, index) => ({ subjectId: index + 1, rate: 10 - Math.floor(index / 10) }));
    const abilities = Object.fromEntries(rated.map((entry, index) => [entry.subjectId, 100 - index]));
    const stable = new Float64Array(rated.map((_, index) => 100 - index));
    const evidence = Array.from({ length: 10 }, (_, index) => history(`e${index}`, index + 1, index + 11, "left", index));
    const misplacedSamples = Array.from({ length: 64 }, (_, sampleIndex) => {
      const sample = stable.slice();
      const first = sampleIndex % 50;
      [sample[first], sample[first + 50]] = [sample[first + 50], sample[first]];
      return sample;
    });
    const fit = {
      abilities,
      uncertainty: Object.fromEntries(rated.map((entry) => [entry.subjectId, 0])),
      meanUncertainty: 0,
      converged: true,
      iterations: 1,
      acceptedComparisons: evidence.length,
      posteriorSamples: misplacedSamples,
    };
    const marginallyStable = analyzeRanking(rated, fit, uniform, evidence, "session");
    expect(marginallyStable.minBucketStability).toBeGreaterThan(0.9);
    expect(marginallyStable.jointBucketStability).toBe(0);
    expect(marginallyStable.jointBucketStableSamples).toBe(0);
    expect(marginallyStable.adjacentBucketStability).toBe(0);
    expect(marginallyStable.coverageTargetStability).toBe(1);
    expect(marginallyStable.coverageTargetStabilityLow).toBeGreaterThan(0.9);
    expect(marginallyStable.requiredAdjacentStableItemCount).toBe(90);
    expect(marginallyStable.allowedCrossTwoBucketCount).toBe(10);
    expect(Object.values(marginallyStable.adjacentBucketStabilityByItem)
      .every((value) => value >= 0 && value <= 1)).toBe(true);
    expect(marginallyStable.expectedCrossTwoBucketCount).toBe(2);
    expect(marginallyStable.crossTwoBucketCountMedian).toBe(2);
    expect(marginallyStable.crossTwoBucketCountLow).toBe(2);
    expect(marginallyStable.crossTwoBucketCountHigh).toBe(2);
    expect(marginallyStable.maxBucketDisplacementMedian).toBe(5);
    expect(marginallyStable.maxBucketDisplacementHigh).toBe(5);
    expect(marginallyStable.ready).toBe(true);

    const twelveMisplacements = stable.slice();
    for (let index = 0; index < 6; index += 1) {
      [twelveMisplacements[index], twelveMisplacements[index + 50]] = [
        twelveMisplacements[index + 50],
        twelveMisplacements[index],
      ];
    }
    const overTolerance = analyzeRanking(rated, {
      ...fit,
      posteriorSamples: Array.from({ length: 64 }, () => twelveMisplacements.slice()),
    }, uniform, evidence, "session");
    expect(overTolerance.expectedCrossTwoBucketCount).toBe(12);
    expect(overTolerance.coverageTargetStability).toBe(0);
    expect(overTolerance.ready).toBe(false);

    const oneMisplacement = stable.slice();
    [oneMisplacement[9], oneMisplacement[10]] = [oneMisplacement[10], oneMisplacement[9]];
    const finiteSampleDiagnostics = analyzeRanking(rated, {
      ...fit,
      posteriorSamples: Array.from({ length: 64 }, (_, index) =>
        (index < 60 ? stable : oneMisplacement).slice()),
    }, uniform, evidence, "session");
    expect(finiteSampleDiagnostics.jointBucketStability).toBe(60 / 64);
    expect(finiteSampleDiagnostics.jointBucketStabilityLow).toBeLessThan(0.9);
    expect(finiteSampleDiagnostics.adjacentBucketStability).toBe(1);
    expect(finiteSampleDiagnostics.adjacentBucketStabilityLow).toBeGreaterThan(0.9);
    expect(finiteSampleDiagnostics.coverageTargetStability).toBe(1);
    expect(finiteSampleDiagnostics.ready).toBe(true);

    const adjacentFit = {
      ...fit,
      posteriorSamples: Array.from({ length: 64 }, () => oneMisplacement.slice()),
    };
    const adjacentOnly = analyzeRanking(rated, adjacentFit, uniform, evidence, "session");
    expect(adjacentOnly.jointBucketStability).toBe(0);
    expect(adjacentOnly.adjacentBucketStability).toBe(1);
    expect(adjacentOnly.coverageTargetStability).toBe(1);
    expect(Object.values(adjacentOnly.adjacentBucketStabilityByItem)
      .every((value) => value === 1)).toBe(true);
    expect(adjacentOnly.expectedCrossTwoBucketCount).toBe(0);
    expect(adjacentOnly.crossTwoBucketCountMedian).toBe(0);
    expect(adjacentOnly.crossTwoBucketCountLow).toBe(0);
    expect(adjacentOnly.crossTwoBucketCountHigh).toBe(0);
    expect(adjacentOnly.maxBucketDisplacementMedian).toBe(1);
    expect(adjacentOnly.maxBucketDisplacementHigh).toBe(1);
    expect(adjacentOnly.decisionRiskRatio).toBeLessThanOrEqual(1);
    expect(adjacentOnly.ready).toBe(true);

    const evidenceLimited = analyzeRanking(rated, adjacentFit, uniform, evidence.slice(0, 9), "session");
    expect(evidenceLimited.ready).toBe(false);
    const evidenceLimitedForecast = forecastStoppingTime(rated, adjacentFit, uniform, evidence.slice(0, 9), "session", evidenceLimited, {
      projectionHorizon: 100, randomSeed: 12, forecastEfficiency: 16,
    });
    expect(evidenceLimitedForecast.method).toBe("posterior-contraction-mc-v6");
    expect(evidenceLimitedForecast.medianAdditional).toBe(1);

    const globallyStable = analyzeRanking(rated, {
      ...fit,
      posteriorSamples: Array.from({ length: 64 }, () => stable.slice()),
    }, uniform, evidence, "session");
    expect(globallyStable.jointBucketStability).toBe(1);
    expect(globallyStable.jointBucketStabilityLow).toBeGreaterThan(0.9);
    expect(globallyStable.adjacentBucketStability).toBe(1);
    expect(globallyStable.coverageTargetStability).toBe(1);
    expect(globallyStable.expectedCrossTwoBucketCount).toBe(0);
    expect(globallyStable.maxBucketDisplacementMedian).toBe(0);
    expect(globallyStable.maxBucketDisplacementHigh).toBe(0);
    expect(globallyStable.decisionRiskRatio).toBeLessThanOrEqual(1);
    expect(globallyStable.ready).toBe(true);
  });

  it("rounds the 90% item-coverage threshold conservatively", () => {
    expect(requiredAdjacentStableItemCount(58)).toBe(53);
    expect(allowedCrossTwoBucketCount(58)).toBe(5);
    expect(requiredAdjacentStableItemCount(283)).toBe(255);
    expect(allowedCrossTwoBucketCount(283)).toBe(28);
  });

  it("changes adaptive questions when the target distribution changes", () => {
    const seed = 2;
    const rated = Array.from({ length: 40 }, (_, index) => ({ subjectId: index + 1, rate: 1 + ((index * 7 + seed * 3) % 10) }));
    const comparisons = Array.from({ length: 30 }, (_, index) => ({
      leftSubjectId: 1 + ((index * 3 + seed) % 40),
      rightSubjectId: 1 + ((index * 11 + 7) % 40),
      outcome: (index % 2 ? "left" : "right") as "left" | "right",
    })).filter((entry) => entry.leftSubjectId !== entry.rightSubjectId);
    const entries = comparisons.map((entry, index) => history(String(index), entry.leftSubjectId, entry.rightSubjectId, entry.outcome, index));
    const reverseJ: DistributionConfig = { preset: "reverse-j", levelCount: 10, weights: [50, 25, 14, 4, 2, 1, 1, 1, 1, 1] };
    const uniformPair = nextPairFor(rated, entries, seed, 1, uniform, { maxRateGap: 2, maxRankDistance: 3 });
    const reversePair = nextPairFor(rated, entries, seed, 1, reverseJ, { maxRateGap: 2, maxRankDistance: 3 });
    expect(new Set([uniformPair?.leftSubjectId, uniformPair?.rightSubjectId])).not.toEqual(new Set([reversePair?.leftSubjectId, reversePair?.rightSubjectId]));
  });

  it("keeps calibration diagnostic without blocking stable completion", () => {
    const rated = Array.from({ length: 4 }, (_, index) => ({ subjectId: index + 1, rate: 10 - index }));
    const abilities = Object.fromEntries(rated.map((entry, index) => [entry.subjectId, 3 - index]));
    const stableSample = new Float64Array([3, 2, 1, 0]);
    const fit = {
      abilities,
      uncertainty: Object.fromEntries(rated.map((entry) => [entry.subjectId, 0])),
      meanUncertainty: 0,
      converged: true,
      iterations: 1,
      acceptedComparisons: 9,
      posteriorSamples: Array.from({ length: 64 }, () => stableSample.slice()),
    };
    const entries: RankingHistoryInput[] = [];
    for (let index = 0; index < 3; index += 1) {
      const original = history(`o${index}`, 1, 2, "left", index * 2);
      const calibration = history(`p${index}`, 2, 1, "left", index * 2 + 1, "calibration");
      calibration.calibrationOfComparisonId = original.recordId;
      entries.push(original, calibration);
    }
    const diagnostics = analyzeRanking(rated, fit, uniform, entries, "session");
    expect(diagnostics.calibration.consistencyRate).toBe(0);
    expect(diagnostics.jointBucketStability).toBe(1);
    expect(diagnostics.calibration.acceptable).toBe(false);
    expect(diagnostics.ready).toBe(true);
    expect(forecastStoppingTime(rated, fit, uniform, entries, "session", diagnostics, {
      projectionHorizon: 100, randomSeed: 4,
    }).status).toBe("ready");
  });

  it("returns a ready forecast without blocking further comparisons", () => {
    const rated = Array.from({ length: 4 }, (_, index) => ({ subjectId: index + 1, rate: 10 - index }));
    const abilities = Object.fromEntries(rated.map((entry, index) => [entry.subjectId, 3 - index]));
    const stableSample = new Float64Array([3, 2, 1, 0]);
    const fit = {
      abilities,
      uncertainty: Object.fromEntries(rated.map((entry) => [entry.subjectId, 0])),
      meanUncertainty: 0,
      converged: true,
      iterations: 1,
      acceptedComparisons: 3,
      posteriorSamples: Array.from({ length: 64 }, () => stableSample.slice()),
    };
    const entries = [
      history("a", 1, 2, "left", 0),
      history("b", 2, 3, "left", 1),
      history("c", 3, 4, "left", 2),
    ];
    const diagnostics = analyzeRanking(rated, fit, uniform, entries, "session");
    expect(diagnostics.ready).toBe(true);
    expect(diagnostics.fatigueReached).toBeUndefined();
    expect(chooseNextPair(rated, entries, fit, { ...diagnostics, fatigueReached: true }, uniform, "session", 3, 9)).toBeDefined();
    expect(forecastStoppingTime(rated, fit, uniform, entries, "session", diagnostics, {
      projectionHorizon: 5, randomSeed: 9,
    })).toMatchObject({ status: "ready", medianAdditional: 0, probabilityWithin20: 1, projectionHorizon: 5 });
  });

  it("does not inflate a favorable forecast subsample to the full posterior sample count", () => {
    const rated = Array.from({ length: 20 }, (_, index) => ({ subjectId: index + 1, rate: 7 }));
    const stable = new Float64Array(rated.map((_, index) => rated.length - index));
    const unstable = new Float64Array(stable).reverse();
    const formerlySelected = new Set(Array.from({ length: 12 }, (_, index) =>
      Math.floor(index * 128 / 12)));
    const posteriorSamples = Array.from({ length: 128 }, (_, index) =>
      (formerlySelected.has(index) ? stable : unstable).slice());
    const fit = {
      abilities: Object.fromEntries(rated.map((entry, index) => [entry.subjectId, stable[index]])),
      uncertainty: Object.fromEntries(rated.map((entry) => [entry.subjectId, 1])),
      meanUncertainty: 1,
      converged: true,
      iterations: 1,
      acceptedComparisons: 20,
      posteriorSamples,
    };
    const entries = Array.from({ length: 20 }, (_, index) =>
      history(`forecast-${index}`, 1 + index % 19, 2 + index % 19, "left", index));
    const diagnostics = analyzeRanking(rated, fit, uniform, entries, "session");
    expect(diagnostics.ready).toBe(false);
    const forecast = forecastStoppingTime(rated, fit, uniform, entries, "session", diagnostics, {
      projectionHorizon: 100, randomSeed: 17, forecastEfficiency: 16,
    });
    expect(forecast.method).toBe("posterior-contraction-mc-v6");
    expect(forecast.lowerAdditional).not.toBe(1);
    expect(forecast.medianAdditional).not.toBe(1);
  });

  it("keeps an early stopping forecast explicitly uncertain", () => {
    const rated = Array.from({ length: 8 }, (_, index) => ({ subjectId: index + 1, rate: 7 }));
    const fit = fitModel(rated, [], undefined, { posteriorSampleCount: 64, randomSeed: 7 });
    const diagnostics = analyzeRanking(rated, fit, uniform, [], "session");
    const first = forecastStoppingTime(rated, fit, uniform, [], "session", diagnostics, {
      projectionHorizon: 240, randomSeed: 7,
    });
    const second = forecastStoppingTime(rated, fit, uniform, [], "session", diagnostics, {
      projectionHorizon: 240, randomSeed: 7,
    });
    expect(first).toEqual(second);
    expect(first.status).toBe("uncertain");
    expect(first.nextCheckpoint).toBe(10);
    expect(first.rolloutCount).toBe(64);
    expect(first.probabilityWithin20).toBeGreaterThanOrEqual(0);
    expect(first.probabilityWithin20).toBeLessThanOrEqual(1);
    expect(first.within20Successes).toBeGreaterThanOrEqual(0);
    expect(first.probabilityWithin20Low).toBeGreaterThanOrEqual(0);
    expect(first.probabilityWithin20High).toBeGreaterThanOrEqual(first.probabilityWithin20);
  });

  it("does not turn zero successful rollouts into an impossibility claim", () => {
    const rated = Array.from({ length: 12 }, (_, index) => ({ subjectId: index + 1, rate: 7 }));
    const fit = fitModel(rated, [], undefined, { posteriorSampleCount: 64, randomSeed: 19 });
    const diagnostics = analyzeRanking(rated, fit, uniform, [], "session");
    const forecast = forecastStoppingTime(rated, fit, uniform, [], "session", diagnostics, {
      projectionHorizon: 5, randomSeed: 19,
    });
    expect(forecast.status).toBe("uncertain");
    expect(forecast.withinProjectionSuccesses).toBe(0);
    expect(forecast.probabilityWithinProjection).toBe(0);
    expect(forecast.probabilityWithinProjectionHigh).toBeGreaterThan(0);
    expect(forecast.projectionHorizon).toBe(5);
  });
});
