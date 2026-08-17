import type { ComparisonBudgetMode, SortingSession } from "../types";

export const BUDGET_MODE_COPY: Record<ComparisonBudgetMode, { label: string; description: string }> = {
  quick: {
    label: "快速",
    description: "强使用原评分先验，重点比较同分作品和相邻分档",
  },
  standard: {
    label: "标准",
    description: "中等使用原评分先验，建议次数约等于条目数",
  },
  thorough: {
    label: "精细",
    description: "只保留弱先验，用更多判断细化完整顺序",
  },
};

export function comparisonBudget(itemCount: number, mode: ComparisonBudgetMode) {
  if (itemCount < 2) return 0;
  const quick = Math.min(80, Math.max(6, Math.round(4 * Math.sqrt(itemCount))));
  if (mode === "quick") return quick;
  const standard = Math.min(400, Math.max(quick, itemCount));
  if (mode === "standard") return standard;
  return Math.min(1000, Math.max(standard, itemCount * 2));
}

export function sessionBudgetMode(session: Pick<SortingSession, "budgetMode">): ComparisonBudgetMode {
  return session.budgetMode ?? "standard";
}

export function rankingTuning(mode: ComparisonBudgetMode) {
  if (mode === "quick") {
    return { priorStrength: 0.8, priorScale: 0.65, maxRateGap: 1, maxRankDistance: 2 };
  }
  if (mode === "thorough") {
    return { priorStrength: 0.15, priorScale: 0.3, maxRateGap: 10, maxRankDistance: 5 };
  }
  return { priorStrength: 0.35, priorScale: 0.45, maxRateGap: 2, maxRankDistance: 3 };
}
