import { describe, expect, it } from "vitest";
import {
  DEFAULT_SCORE_LEVELS,
  distributionConfig,
  effectiveDistributionWeights,
  normalizeDistributionConfig,
  normalizeScoreLevelCount,
  resampleDistributionWeights,
  scoreDistributionStats,
} from "../lib/distribution";
import { DISTRIBUTIONS } from "../lib/types";

describe("score distributions", () => {
  it("calculates population statistics from score bucket counts", () => {
    expect(scoreDistributionStats([1, 1, 1])).toEqual({ mean: 2, standardDeviation: Math.sqrt(2 / 3) });
    expect(scoreDistributionStats([0, 0, 4])).toEqual({ mean: 3, standardDeviation: 0 });
  });

  it("returns no statistics for an empty distribution and ignores invalid negative mass", () => {
    expect(scoreDistributionStats([])).toBeUndefined();
    expect(scoreDistributionStats([0, 0, 0])).toBeUndefined();
    expect(scoreDistributionStats([Number.NaN, -2, 2])).toEqual({ mean: 3, standardDeviation: 0 });
  });

  it("normalizes score levels to the supported 3-20 range and defaults legacy data to 10", () => {
    expect(normalizeScoreLevelCount(undefined)).toBe(DEFAULT_SCORE_LEVELS);
    expect(normalizeScoreLevelCount(2)).toBe(3);
    expect(normalizeScoreLevelCount(12.4)).toBe(12);
    expect(normalizeScoreLevelCount(99)).toBe(20);
    expect(normalizeDistributionConfig({ preset: "uniform", weights: Array(10).fill(10) }).levelCount).toBe(10);
  });

  it("resamples cumulative probability mass without changing its total", () => {
    const source = [3, 5, 8, 14, 20, 20, 12, 8, 6, 4];
    for (const levelCount of [3, 5, 10, 12, 20]) {
      const result = resampleDistributionWeights(source, levelCount);
      expect(result).toHaveLength(levelCount);
      expect(result.reduce((sum, value) => sum + value, 0)).toBeCloseTo(100, 5);
    }
    expect(resampleDistributionWeights(source, 10)).toEqual(source);
  });

  it("keeps canonical 10-level presets exact and resizes custom weights", () => {
    expect(distributionConfig("high-tail", 10).weights).toEqual(DISTRIBUTIONS["high-tail"]);
    expect(distributionConfig("reverse-j", 10).weights).toEqual(DISTRIBUTIONS["reverse-j"]);
    expect(distributionConfig("custom", 5, Array(10).fill(10)).weights).toEqual(Array(5).fill(20));
  });

  it("derives preserve-mode mass from original 1-10 ratings at the active K", () => {
    const items = [
      ...Array.from({ length: 6 }, () => ({ rate: 10 })),
      ...Array.from({ length: 3 }, () => ({ rate: 8 })),
      { rate: 2 },
    ];
    const weights = effectiveDistributionWeights(items, distributionConfig("preserve", 5));
    expect(weights).toHaveLength(5);
    expect(weights.reduce((sum, value) => sum + value, 0)).toBeCloseTo(items.length, 5);
    expect(weights[4]).toBeGreaterThan(weights[0]);
  });

  it("preserves all-zero custom weights for the ranking fallback", () => {
    expect(distributionConfig("custom", 5, Array(10).fill(0)).weights).toEqual(Array(5).fill(0));
    expect(effectiveDistributionWeights([], distributionConfig("custom", 5, Array(5).fill(0)))).toEqual(Array(5).fill(1));
  });
});
