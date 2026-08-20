import { describe, expect, it } from "vitest";
import { analyzeRanking, buildRankedItems, calibrationPosterior, chooseNextPair, davidsonProbabilities, fitModel, forecastStoppingTime, prepareStoppingForecastRollouts, summarizeRankingEvidence, updateForecastPosterior } from "../lib/ranking/engine";
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
  const comparisons = summarizeRankingEvidence(entries, "session").comparisons;
  const fit = fitModel(rated, comparisons, undefined, { randomSeed: seed });
  const diagnostics = analyzeRanking(rated, fit, distribution, entries, "session");
  return chooseNextPair(rated, entries, fit, diagnostics, distribution, "session", version, seed, options);
}

describe("weighted Davidson ranking engine", () => {
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

  it("fits one Davidson tie parameter and reuses its three-result probabilities", () => {
    const rated = inputs.slice(0, 2);
    const decisive = fitModel(rated, Array.from({ length: 8 }, () => comparison(1, 2, "left")));
    const tied = fitModel(rated, Array.from({ length: 8 }, () => comparison(1, 2, "tie")));
    expect(decisive.converged).toBe(true);
    expect(tied.converged).toBe(true);
    expect(tied.tieStrength!).toBeGreaterThan(decisive.tieStrength!);
    const probabilities = davidsonProbabilities(0, tied.tieStrength);
    expect(probabilities.left + probabilities.tie + probabilities.right).toBeCloseTo(1, 12);
    expect(probabilities.tie).toBeGreaterThan(probabilities.left);
  });

  it("selects pairs deterministically and honors skip cooldown", () => {
    const first = nextPairFor(inputs, []);
    expect(nextPairFor(inputs, [])).toEqual(first);
    expect(first).toBeDefined();
    const cooled = nextPairFor(inputs, [history("skip", first!.leftSubjectId, first!.rightSubjectId, "skip")]);
    expect(new Set([cooled!.leftSubjectId, cooled!.rightSubjectId])).not.toEqual(new Set([first!.leftSubjectId, first!.rightSubjectId]));
  });

  it("uses a strong score prior with the shared question-selection policy", () => {
    const rated = [{ subjectId: 1, rate: 9 }, { subjectId: 2, rate: 9 }, { subjectId: 3, rate: 6 }];
    const tuning = rankingTuning("strong");
    const fit = fitModel(rated, [], undefined, { ...tuning, randomSeed: 9 });
    expect(fit.abilities[1] - fit.abilities[3]).toBeCloseTo(2.1, 8);
    const pair = nextPairFor(rated, [], 9, 0, uniform, tuning);
    expect(pair).toBeDefined();
    expect([pair?.leftSubjectId, pair?.rightSubjectId]).toContain(1);
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
    const evidence = Array.from({ length: 20 }, (_, index) =>
      history(`k-${index}`, index + 1, index + 21, "left", index));
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
    const strongPair = nextPairFor(rated, four, 5, 4, uniform, rankingTuning("strong"));
    const weakPair = nextPairFor(rated, four, 5, 4, uniform, rankingTuning("weak"));
    expect(strongPair?.queryKind).toBe("exploration");
    expect(weakPair).toEqual(strongPair);
  });

  it("separates prior strength while keeping question selection identical", () => {
    expect(rankingTuning("strong")).toMatchObject({
      priorStrength: 1.2, priorScale: 0.7, maxRankDistance: 10,
      boundaryWindow: 6, explorationInterval: 5, explorationRadius: 12,
    });
    expect(rankingTuning("weak")).toMatchObject({
      priorStrength: 0.05, priorScale: 0, maxRankDistance: 10,
      boundaryWindow: 6, explorationInterval: 5, explorationRadius: 12,
    });
    const selectionOnly = (mode: "strong" | "weak") => Object.fromEntries(
      Object.entries(rankingTuning(mode)).filter(([key]) => key !== "priorStrength" && key !== "priorScale"),
    );
    expect(selectionOnly("strong")).toEqual(selectionOnly("weak"));
  });

  it("never uses the original rating to break weak-prior ability ties", () => {
    const rated = [{ subjectId: 1, rate: 1 }, { subjectId: 2, rate: 10 }, { subjectId: 3, rate: 6 }];
    const fit = fitModel(rated, [], undefined, { ...rankingTuning("weak"), randomSeed: 4 });
    expect(new Set(Object.values(fit.abilities))).toEqual(new Set([0]));
    const collection = rated.map((entry) => item(entry.subjectId, entry.rate));
    const ranked = buildRankedItems(collection, fit, [], uniform);
    expect(ranked.map((entry) => entry.subjectId)).toEqual([1, 2, 3]);
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
    expect(diagnostics.rawEvidenceCount).toBe(3);
    expect(diagnostics.evidenceCount).toBeCloseTo(1.5, 10);
    expect(diagnostics.evidenceRequired).toBe(1);
    expect(diagnostics.uniquePairCount).toBe(1);
    expect(diagnostics.coveredItemCount).toBe(2);
    expect(diagnostics.expectedBucketChangeRate).toBeLessThan(0.5);
    expect(Object.values(diagnostics.bucketStability).every((value) => value >= 0 && value <= 1)).toBe(true);
  });

  it("incorporates calibration repeats with pair-cluster correlation instead of independent weight", () => {
    const original = history("original", 1, 2, "left", 0);
    const calibration = history("calibration", 2, 1, "right", 1, "calibration");
    calibration.calibrationOfComparisonId = original.recordId;
    const summary = summarizeRankingEvidence([original, calibration], "session");
    expect(summary.rawEvidenceCount).toBe(2);
    expect(summary.evidenceCount).toBeCloseTo(4 / 3, 10);
    const single = fitModel(inputs.slice(0, 2), summarizeRankingEvidence([original], "session").comparisons, undefined, {
      priorStrength: 0.2, priorScale: 0, randomSeed: 1,
    });
    const correlated = fitModel(inputs.slice(0, 2), summary.comparisons, undefined, {
      priorStrength: 0.2, priorScale: 0, randomSeed: 1,
    });
    const independent = fitModel(inputs.slice(0, 2), [comparison(1, 2, "left"), comparison(2, 1, "right")], undefined, {
      priorStrength: 0.2, priorScale: 0, randomSeed: 1,
    });
    expect(correlated.abilities[1] - correlated.abilities[2])
      .toBeGreaterThan(single.abilities[1] - single.abilities[2]);
    expect(correlated.abilities[1] - correlated.abilities[2])
      .toBeLessThan(independent.abilities[1] - independent.abilities[2]);
  });

  it("decays old imported duplicates before applying the repeated-pair design effect", () => {
    const current = history("current", 1, 2, "right", 10);
    current.createdAt = "2024-01-01T00:00:00.000Z";
    const imported = Array.from({ length: 10 }, (_, index) => {
      const entry = history(`old-${index}`, 1, 2, "left", index);
      entry.createdAt = "2024-01-01T00:00:00.000Z";
      entry.sourceCreatedAt = "2020-01-02T00:00:00.000Z";
      entry.importBatchId = "batch";
      entry.inheritedFromComparisonId = `root-${index}`;
      return entry;
    });
    const summary = summarizeRankingEvidence([current, ...imported], "session");
    expect(summary.rawEvidenceCount).toBe(11);
    expect(summary.evidenceCount).toBeLessThan(1.3);
    const weighted = fitModel(inputs.slice(0, 2), summary.comparisons, undefined, {
      priorStrength: 0.05, priorScale: 0, randomSeed: 2,
    });
    const independent = fitModel(inputs.slice(0, 2), [
      comparison(1, 2, "right"),
      ...Array.from({ length: 10 }, () => comparison(1, 2, "left")),
    ], undefined, { priorStrength: 0.05, priorScale: 0, randomSeed: 2 });
    expect(weighted.abilities[1] - weighted.abilities[2]).toBeLessThan(0);
    expect(independent.abilities[1] - independent.abilities[2]).toBeGreaterThan(0);
  });

  it("does not stop after repeatedly judging one pair while other items are uncovered", () => {
    const rated = Array.from({ length: 4 }, (_, index) => ({ subjectId: index + 1, rate: 7 }));
    const stable = new Float64Array([4, 3, 2, 1]);
    const entries = Array.from({ length: 3 }, (_, index) => history(`repeat-gate-${index}`, 1, 2, "left", index));
    const fit = {
      abilities: Object.fromEntries(rated.map((entry, index) => [entry.subjectId, stable[index]])),
      uncertainty: Object.fromEntries(rated.map((entry) => [entry.subjectId, 0])),
      meanUncertainty: 0,
      converged: true,
      iterations: 1,
      acceptedComparisons: entries.length,
      posteriorSamples: Array.from({ length: 64 }, () => stable.slice()),
    };
    const diagnostics = analyzeRanking(rated, fit, uniform, entries, "session", "quick");
    expect(diagnostics.evidenceCount).toBeCloseTo(1.5, 10);
    expect(diagnostics.uniquePairCount).toBe(1);
    expect(diagnostics.coveredItemCount).toBe(2);
    expect(diagnostics.ready).toBe(false);
    expect(diagnostics.stoppingChecks?.find((check) => check.mode === "quick")).toMatchObject({
      evidenceSatisfied: false,
      uniquePairsSatisfied: false,
      itemCoverageSatisfied: false,
    });
  });

  it("stops when 90% of items stay within one bucket while retaining stricter diagnostics", () => {
    const rated = Array.from({ length: 100 }, (_, index) => ({ subjectId: index + 1, rate: 10 - Math.floor(index / 10) }));
    const abilities = Object.fromEntries(rated.map((entry, index) => [entry.subjectId, 100 - index]));
    const stable = new Float64Array(rated.map((_, index) => 100 - index));
    const evidence = Array.from({ length: 50 }, (_, index) =>
      history(`e${index}`, index + 1, index + 51, "left", index));
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
    expect(marginallyStable.stoppingChecks?.map((check) => [check.mode, check.target, check.allowedCrossTwoBucketCount])).toEqual([
      ["quick", 0.8, 20], ["standard", 0.9, 10], ["thorough", 0.95, 5],
    ]);
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
    expect(overTolerance.stoppingChecks?.find((check) => check.mode === "quick")?.ready).toBe(true);
    expect(overTolerance.stoppingChecks?.find((check) => check.mode === "standard")?.ready).toBe(false);
    expect(overTolerance.stoppingChecks?.find((check) => check.mode === "thorough")?.ready).toBe(false);

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

    const coverageLimitedHistory = evidence.slice(0, 44);
    const evidenceLimited = analyzeRanking(rated, adjacentFit, uniform, coverageLimitedHistory, "session");
    expect(evidenceLimited.ready).toBe(false);
    expect(evidenceLimited.stoppingChecks?.find((check) => check.mode === "standard")?.itemCoverageSatisfied).toBe(false);
    const evidenceLimitedForecast = forecastStoppingTime(rated, adjacentFit, uniform, coverageLimitedHistory, "session", evidenceLimited, {
      projectionHorizon: 100, randomSeed: 12, forecastEfficiency: 16,
    });
    expect(evidenceLimitedForecast.method).toBe("posterior-contraction-mc-v11");
    expect(evidenceLimitedForecast.medianAdditional ?? Number.POSITIVE_INFINITY).toBeGreaterThanOrEqual(1);

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
    const changed = Array.from({ length: 12 }, (_, offset) => offset + 1).some((selectionSeed) => {
      const uniformPair = nextPairFor(rated, entries, selectionSeed, 1, uniform, { maxRateGap: 2, maxRankDistance: 3 });
      const reversePair = nextPairFor(rated, entries, selectionSeed, 1, reverseJ, { maxRateGap: 2, maxRankDistance: 3 });
      return [uniformPair?.leftSubjectId, uniformPair?.rightSubjectId].sort().join(":")
        !== [reversePair?.leftSubjectId, reversePair?.rightSubjectId].sort().join(":");
    });
    expect(changed).toBe(true);
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
    entries.push(
      history("coverage-23", 2, 3, "left", entries.length),
      history("coverage-34", 3, 4, "left", entries.length + 1),
    );
    const diagnostics = analyzeRanking(rated, fit, uniform, entries, "session");
    expect(diagnostics.calibration.consistencyRate).toBe(0);
    expect(diagnostics.jointBucketStability).toBe(1);
    expect(diagnostics.calibration.acceptable).toBe(false);
    expect(diagnostics.ready).toBe(true);
    expect(diagnostics.rawEvidenceCount).toBe(8);
    expect(diagnostics.evidenceCount).toBeLessThan(diagnostics.rawEvidenceCount!);
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

  it("recenters every finite forecast ensemble exactly on the current MAP", () => {
    const rated = Array.from({ length: 100 }, (_, index) => ({ subjectId: index + 1, rate: 1 + index % 10 }));
    const fit = fitModel(rated, [], undefined, {
      priorStrength: 0.05, priorScale: 0, posteriorSampleCount: 128, randomSeed: 99,
    });
    const diagnostics = analyzeRanking(rated, fit, uniform, [], "session");
    const input = prepareStoppingForecastRollouts(
      rated, fit, uniform, [], "session", diagnostics, { randomSeed: 99 }, 16,
    );
    let maximumDrift = 0;
    for (let itemIndex = 0; itemIndex < rated.length; itemIndex += 1) {
      const mean = input.forecastSamples.reduce((sum, sample) => sum + sample[itemIndex], 0)
        / input.forecastSamples.length;
      maximumDrift = Math.max(maximumDrift, Math.abs(mean - input.currentAbilities[itemIndex]));
    }
    expect(maximumDrift).toBeLessThan(1e-12);
    expect(input.currentAbilities.every((ability) => ability === 0)).toBe(true);
  });

  it("fails closed when optimization has not converged", () => {
    const rated = Array.from({ length: 4 }, (_, index) => ({ subjectId: index + 1, rate: 7 }));
    const entries = [
      history("fail-12", 1, 2, "left", 0),
      history("fail-23", 2, 3, "left", 1),
      history("fail-34", 3, 4, "left", 2),
    ];
    const failed = fitModel(rated, summarizeRankingEvidence(entries, "session").comparisons, undefined, {
      priorStrength: 0.05, priorScale: 0, posteriorSampleCount: 64, randomSeed: 5, maxIterations: 0,
    });
    expect(failed.converged).toBe(false);
    expect(failed.optimizationStatus).toBe("iteration-limit");
    const stable = new Float64Array([4, 3, 2, 1]);
    const diagnosticFit = {
      ...failed,
      abilities: Object.fromEntries(rated.map((entry, index) => [entry.subjectId, stable[index]])),
      posteriorSamples: Array.from({ length: 64 }, () => stable.slice()),
    };
    const diagnostics = analyzeRanking(rated, diagnosticFit, uniform, entries, "session");
    expect(diagnostics.coverageTargetStabilityLow).toBeGreaterThan(0.9);
    expect(diagnostics.optimizerConverged).toBe(false);
    expect(diagnostics.ready).toBe(false);
    expect(diagnostics.stoppingChecks?.every((check) => check.optimizerSatisfied === false)).toBe(true);
    const forecast = forecastStoppingTime(rated, diagnosticFit, uniform, entries, "session", diagnostics, {
      projectionHorizon: 20, randomSeed: 5,
    });
    expect(forecast.status).toBe("uncertain");
    expect(forecast.medianAdditional).toBeUndefined();
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
    expect(forecast.method).toBe("posterior-contraction-mc-v11");
    expect(forecast.rolloutCount).toBe(64);
    expect(forecast.withinProjectionSuccesses).toBeLessThanOrEqual(forecast.rolloutCount);
  });

  it("propagates a forecast answer through posterior covariance", () => {
    const samples = Array.from({ length: 64 }, (_, index) => {
      const direction = (Math.floor(index / 2) - 15.5) / 5;
      const orthogonal = index % 2 === 0 ? -0.5 : 0.5;
      return new Float64Array([
        direction / 2,
        -direction / 2,
        direction * 0.75 + orthogonal,
        orthogonal,
      ]);
    });
    const before = samples.map((sample) => sample.slice());
    const meanShifts = updateForecastPosterior(samples, 0, 1, "left");

    expect(Math.abs(meanShifts[2])).toBeGreaterThan(1e-4);
    expect(meanShifts[3]).toBeCloseTo(0, 10);
    expect(samples.some((sample, index) => Math.abs(sample[2] - before[index][2]) > 1e-4)).toBe(true);
    for (let index = 0; index < samples.length; index += 1) {
      const oldDifference = before[index][0] - before[index][1];
      const newDifference = samples[index][0] - samples[index][1];
      const propagatedDifference = (samples[index][0] - before[index][0])
        - (samples[index][1] - before[index][1]);
      expect(propagatedDifference).toBeCloseTo(newDifference - oldDifference, 10);
    }
  });

  it("does not move posterior directions uncorrelated with the compared pair", () => {
    const samples = Array.from({ length: 64 }, (_, index) => {
      const direction = (Math.floor(index / 2) - 15.5) / 5;
      const orthogonal = index % 2 === 0 ? -0.5 : 0.5;
      return new Float64Array([direction / 2, -direction / 2, orthogonal]);
    });
    const before = samples.map((sample) => sample.slice());
    updateForecastPosterior(samples, 0, 1, "right");
    for (let index = 0; index < samples.length; index += 1) {
      expect(samples[index][2]).toBeCloseTo(before[index][2], 10);
    }
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
