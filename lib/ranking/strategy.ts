import type {
  ComparisonBudgetMode,
  DistributionPreset,
  PriorMode,
  SortingSession,
} from "../types";

export const BUDGET_MODE_COPY: Record<ComparisonBudgetMode, { label: string; description: string }> = {
  quick: {
    label: "快速",
    description: "至少 80% 的作品保持在相邻一档内，且该事件的 90% MC 下界达到 90%",
  },
  standard: {
    label: "标准",
    description: "至少 90% 的作品保持在相邻一档内，且该事件的 90% MC 下界达到 90%",
  },
  thorough: {
    label: "精细",
    description: "至少 95% 的作品保持在相邻一档内，且该事件的 90% MC 下界达到 90%",
  },
};

export const PRIOR_MODE_COPY: Record<PriorMode, { label: string; description: string }> = {
  strong: {
    label: "强先验",
    description: "充分利用原评分建立初始顺序，适合当前偏好与旧评分大体一致时加速冷启动",
  },
  weak: {
    label: "弱先验",
    description: "只保留很弱的零均值正则，让两两判断主导排序结果",
  },
};

export const STOPPING_STABLE_ITEM_FRACTION = 0.9;
export const STOPPING_PROBABILITY_TARGET = 0.9;
/**
 * Working intraclass correlation for repeated answers about the same unordered
 * work pair.  A group of m answers contributes m / (1 + (m - 1) rho)
 * effective observations instead of m conditionally independent ones.
 */
export const REPEATED_PAIR_CORRELATION = 0.5;
export const STOPPING_MODE_ORDER: ComparisonBudgetMode[] = ["quick", "standard", "thorough"];
export const STOPPING_COVERAGE_TARGETS: Record<ComparisonBudgetMode, number> = {
  quick: 0.8,
  standard: STOPPING_STABLE_ITEM_FRACTION,
  thorough: 0.95,
};

/** @deprecated Legacy probability thresholds retained for old callers; new stopping logic uses a common 90% MC threshold. */
export const STOPPING_PROBABILITY_TARGETS: Record<ComparisonBudgetMode, number> = {
  quick: 0.8,
  standard: STOPPING_PROBABILITY_TARGET,
  thorough: 0.95,
};

export function stoppingCoverageTarget(mode: ComparisonBudgetMode) {
  return STOPPING_COVERAGE_TARGETS[mode];
}

/** @deprecated Use stoppingCoverageTarget and STOPPING_PROBABILITY_TARGET for new code. */
export function stoppingProbabilityTarget(mode: ComparisonBudgetMode) {
  return STOPPING_PROBABILITY_TARGETS[mode];
}

/** Minimum number of items that must remain within one score bucket in a posterior draw. */
export function requiredAdjacentStableItemCount(
  itemCount: number,
  coverageTarget = STOPPING_STABLE_ITEM_FRACTION,
) {
  return Math.ceil(Math.max(0, itemCount) * coverageTarget);
}

/** Maximum number of items allowed to move by two or more score buckets in a posterior draw. */
export function allowedCrossTwoBucketCount(
  itemCount: number,
  coverageTarget = STOPPING_STABLE_ITEM_FRACTION,
) {
  const count = Math.max(0, Math.floor(itemCount));
  return count - requiredAdjacentStableItemCount(count, coverageTarget);
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

export function legacyPriorMode(mode: ComparisonBudgetMode | undefined): PriorMode {
  return mode === "quick" ? "strong" : "weak";
}

export function sessionPriorMode(session: Pick<SortingSession, "budgetMode" | "priorMode">): PriorMode {
  return session.priorMode ?? legacyPriorMode(session.budgetMode);
}

export function recommendedDistribution(): DistributionPreset {
  return "high-tail";
}

export function minimumEvidence(itemCount: number) {
  if (itemCount < 2) return 0;
  return Math.min(20, Math.max(3, Math.ceil(Math.sqrt(itemCount))));
}

export function repeatedPairEffectiveSampleSize(
  count: number,
  correlation = REPEATED_PAIR_CORRELATION,
) {
  const safeCount = Math.max(0, count);
  if (safeCount === 0) return 0;
  const rho = Math.min(0.99, Math.max(0, correlation));
  return safeCount / (1 + (safeCount - 1) * rho);
}

/** Equal fractional-likelihood weight assigned to every answer in a pair cluster. */
export function repeatedPairObservationWeight(
  count: number,
  correlation = REPEATED_PAIR_CORRELATION,
) {
  const safeCount = Math.max(1, count);
  return repeatedPairEffectiveSampleSize(safeCount, correlation) / safeCount;
}

export function priorTuning(mode: PriorMode) {
  return mode === "strong"
    ? { priorStrength: 1.2, priorScale: 0.7 }
    : { priorStrength: 0.05, priorScale: 0 };
}

/** Question selection is deliberately independent from prior and stopping modes. */
export function selectionTuning() {
  return {
    maxRateGap: 10,
    maxRankDistance: 10,
    boundaryWindow: 6,
    explorationInterval: 5,
    explorationRadius: 12,
    // Retained only for older serialized request compatibility.
    forecastEfficiency: 12,
  };
}

export function rankingTuning(mode: PriorMode) {
  return { ...priorTuning(mode), ...selectionTuning() };
}
