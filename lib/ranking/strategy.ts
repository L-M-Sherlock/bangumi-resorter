import type {
  ComparisonBudgetMode,
  DistributionPreset,
  SortingSession,
} from "../types";

export const BUDGET_MODE_COPY: Record<ComparisonBudgetMode, { label: string; description: string }> = {
  quick: {
    label: "快速",
    description: "强依赖原评分，只校正局部顺序并低频探索全局",
  },
  standard: {
    label: "标准",
    description: "允许判断显著修正原评分，并保持均衡的边界与全局探索",
  },
  thorough: {
    label: "精细",
    description: "不采用原评分顺序，以高覆盖比较独立支撑完整排序",
  },
};

export const STOPPING_STABLE_ITEM_FRACTION = 0.9;
export const STOPPING_PROBABILITY_TARGET = 0.9;

/** Minimum number of items that must remain within one score bucket in a posterior draw. */
export function requiredAdjacentStableItemCount(itemCount: number) {
  return Math.ceil(Math.max(0, itemCount) * STOPPING_STABLE_ITEM_FRACTION);
}

/** Maximum number of items allowed to move by two or more score buckets in a posterior draw. */
export function allowedCrossTwoBucketCount(itemCount: number) {
  const count = Math.max(0, Math.floor(itemCount));
  return count - requiredAdjacentStableItemCount(count);
}

/** @deprecated Static comparison counts are retained only for legacy tests/backups. */
export function comparisonBudget(itemCount: number, mode: ComparisonBudgetMode) {
  if (itemCount < 2) return 0;
  const quick = Math.min(80, Math.max(6, Math.round(4 * Math.sqrt(itemCount))));
  if (mode === "quick") return quick;
  const standard = Math.min(400, Math.max(quick, itemCount));
  if (mode === "standard") return standard;
  return Math.min(1000, Math.max(standard, itemCount * 2));
}

/** Finite simulation window only; it never limits how many comparisons a user may answer. */
export function forecastProjectionHorizon(itemCount: number) {
  return Math.min(5000, Math.max(1000, Math.ceil(Math.max(0, itemCount)) * 10));
}

export function sessionBudgetMode(session: Pick<SortingSession, "budgetMode">): ComparisonBudgetMode {
  return session.budgetMode ?? "standard";
}

export function recommendedDistribution(): DistributionPreset {
  return "high-tail";
}

export function minimumEvidence(itemCount: number) {
  if (itemCount < 2) return 0;
  return Math.min(20, Math.max(3, Math.ceil(Math.sqrt(itemCount))));
}

export function rankingTuning(mode: ComparisonBudgetMode) {
  if (mode === "quick") {
    return {
      priorStrength: 1.2, priorScale: 0.7,
      maxRateGap: 1, maxRankDistance: 1, boundaryWindow: 1,
      explorationInterval: 25, explorationRadius: 2,
      forecastEfficiency: 16,
    };
  }
  if (mode === "thorough") {
    return {
      priorStrength: 0.05, priorScale: 0,
      maxRateGap: 10, maxRankDistance: 10, boundaryWindow: 6,
      explorationInterval: 5, explorationRadius: 12,
      forecastEfficiency: 12,
    };
  }
  return {
    priorStrength: 0.3, priorScale: 0.45,
    maxRateGap: 2, maxRankDistance: 4, boundaryWindow: 3,
    explorationInterval: 10, explorationRadius: 5,
    forecastEfficiency: 14,
  };
}
