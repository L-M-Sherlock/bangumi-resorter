import {
  DISTRIBUTIONS,
  DistributionConfig,
  DistributionPreset,
} from "./types";

export const MIN_SCORE_LEVELS = 3;
export const MAX_SCORE_LEVELS = 20;
export const DEFAULT_SCORE_LEVELS = 10;

export interface ScoreDistributionStats {
  mean: number;
  standardDeviation: number;
}

/** Calculate population statistics for score buckets whose values are 1..K. */
export function scoreDistributionStats(counts: number[]): ScoreDistributionStats | undefined {
  const normalizedCounts = counts.map((count) => Number.isFinite(count) ? Math.max(0, count) : 0);
  const total = normalizedCounts.reduce((sum, count) => sum + count, 0);
  if (total <= 0) return undefined;
  const mean = normalizedCounts.reduce((sum, count, index) => sum + count * (index + 1), 0) / total;
  const variance = normalizedCounts.reduce((sum, count, index) => {
    const difference = index + 1 - mean;
    return sum + count * difference * difference;
  }, 0) / total;
  return { mean, standardDeviation: Math.sqrt(variance) };
}

export function normalizeScoreLevelCount(value: unknown) {
  if (value === undefined || value === null || value === "") return DEFAULT_SCORE_LEVELS;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return DEFAULT_SCORE_LEVELS;
  return Math.min(MAX_SCORE_LEVELS, Math.max(MIN_SCORE_LEVELS, Math.round(numeric)));
}

function safeWeights(weights: number[]) {
  return weights.map((value) => Number.isFinite(value) ? Math.max(0, value) : 0);
}

/**
 * Resample a piecewise-constant probability mass function onto a new number of
 * equally wide score buckets. Total mass and low-to-high orientation are kept.
 */
export function resampleDistributionWeights(source: number[], targetLevelCount: number) {
  const targetCount = normalizeScoreLevelCount(targetLevelCount);
  if (source.length === 0) return Array(targetCount).fill(1);
  const weights = safeWeights(source);
  if (weights.length === targetCount) return [...weights];
  const result = Array(targetCount).fill(0) as number[];
  for (let targetIndex = 0; targetIndex < targetCount; targetIndex += 1) {
    const targetStart = targetIndex / targetCount;
    const targetEnd = (targetIndex + 1) / targetCount;
    for (let sourceIndex = 0; sourceIndex < weights.length; sourceIndex += 1) {
      const sourceStart = sourceIndex / weights.length;
      const sourceEnd = (sourceIndex + 1) / weights.length;
      const overlap = Math.max(0, Math.min(targetEnd, sourceEnd) - Math.max(targetStart, sourceStart));
      if (overlap > 0) result[targetIndex] += weights[sourceIndex] * weights.length * overlap;
    }
  }
  return result.map((value) => Number(value.toFixed(6)));
}

export function distributionConfig(
  preset: DistributionPreset,
  levelCount: number,
  customWeights: number[] = [],
): DistributionConfig {
  const normalizedLevelCount = normalizeScoreLevelCount(levelCount);
  const source = preset === "custom"
    ? customWeights
    : preset === "preserve"
      ? Array(DEFAULT_SCORE_LEVELS).fill(1)
      : DISTRIBUTIONS[preset];
  return {
    preset,
    levelCount: normalizedLevelCount,
    weights: resampleDistributionWeights(source, normalizedLevelCount),
  };
}

export function normalizeDistributionConfig(config: Partial<DistributionConfig> | undefined): DistributionConfig {
  const preset: DistributionPreset = config?.preset && ["uniform", "preserve", "high-tail", "reverse-j", "custom"].includes(config.preset)
    ? config.preset
    : "high-tail";
  const levelCount = normalizeScoreLevelCount(config?.levelCount);
  return distributionConfig(preset, levelCount, Array.isArray(config?.weights) ? config.weights : []);
}

export function distributionWithLevelCount(config: DistributionConfig, levelCount: number) {
  return distributionConfig(config.preset, levelCount, config.weights);
}

export function effectiveDistributionWeights<T extends { rate: number }>(items: T[], config: DistributionConfig) {
  const levelCount = normalizeScoreLevelCount(config.levelCount);
  const source = config.preset === "preserve"
    ? Array.from({ length: DEFAULT_SCORE_LEVELS }, (_, index) =>
      items.filter((item) => item.rate === index + 1).length)
    : config.weights;
  let weights = resampleDistributionWeights(source, levelCount);
  if (weights.reduce((sum, value) => sum + value, 0) <= 0) weights = Array(levelCount).fill(1);
  return weights;
}
