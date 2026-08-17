import type {
  ComparisonBudgetMode,
  ComparisonReusePolicy,
  DistributionPreset,
  SortingSession,
} from "../types";

export const BUDGET_MODE_COPY: Record<ComparisonBudgetMode, { label: string; description: string }> = {
  quick: {
    label: "快速",
    description: "强使用原评分先验，按后验信息增益选择相邻作品",
  },
  standard: {
    label: "标准",
    description: "中等使用原评分先验，按信息增益动态扩展比较范围",
  },
  thorough: {
    label: "精细",
    description: "只保留弱先验，并扩大候选范围以细化完整顺序",
  },
};

export const STOPPING_STABLE_ITEM_FRACTION = 0.9;

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

export function sessionReusePolicy(
  session: Pick<SortingSession, "comparisonReusePolicy">,
): ComparisonReusePolicy {
  return session.comparisonReusePolicy ?? "profile";
}

export function recommendedDistribution(itemCount: number): DistributionPreset {
  return itemCount >= 100 ? "reverse-j" : "high-tail";
}

export function minimumEvidence(itemCount: number) {
  if (itemCount < 2) return 0;
  return Math.min(20, Math.max(3, Math.ceil(Math.sqrt(itemCount))));
}

export function rankingTuning(mode: ComparisonBudgetMode) {
  if (mode === "quick") {
    return { priorStrength: 0.8, priorScale: 0.65, maxRateGap: 1, maxRankDistance: 2, forecastEfficiency: 16 };
  }
  if (mode === "thorough") {
    return { priorStrength: 0.15, priorScale: 0.3, maxRateGap: 10, maxRankDistance: 5, forecastEfficiency: 12 };
  }
  return { priorStrength: 0.35, priorScale: 0.45, maxRateGap: 2, maxRankDistance: 3, forecastEfficiency: 14 };
}
