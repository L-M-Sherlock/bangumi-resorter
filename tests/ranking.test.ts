import { describe, expect, it } from "vitest";
import { buildRankedItems, chooseNextPair, fitModel, toModelState } from "../lib/ranking/engine";
import type { CollectionItem, RankingComparisonInput } from "../lib/types";

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
    const fit = fitModel(inputs, []);
    const model = toModelState("session", 4, fit);
    const first = chooseNextPair(inputs, [], [], model, 42);
    expect(chooseNextPair(inputs, [], [], model, 42)).toEqual(first);
    expect(first).toBeDefined();
    const cooled = chooseNextPair(inputs, [], [{
      leftSubjectId: first!.leftSubjectId,
      rightSubjectId: first!.rightSubjectId,
      acceptedCountAtAnswer: model.acceptedComparisons,
    }], model, 42);
    expect(new Set([cooled!.leftSubjectId, cooled!.rightSubjectId])).not.toEqual(new Set([first!.leftSubjectId, first!.rightSubjectId]));
  });

  it("maps scores to uniform, preserved, and zero-safe custom distributions", () => {
    const items = Array.from({ length: 20 }, (_, index) => item(index + 1, index < 5 ? 10 : index < 12 ? 7 : 4));
    const fit = fitModel(items, []);
    const uniform = buildRankedItems(items, fit, [], { preset: "uniform", weights: Array(10).fill(10) });
    expect(new Set(uniform.map((entry) => entry.newRate))).toEqual(new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]));
    const preserved = buildRankedItems(items, fit, [], { preset: "preserve", weights: Array(10).fill(10) });
    for (let score = 1; score <= 10; score += 1) {
      expect(preserved.filter((entry) => entry.newRate === score)).toHaveLength(items.filter((entry) => entry.rate === score).length);
    }
    const zeroSafe = buildRankedItems(items, fit, [], { preset: "custom", weights: Array(10).fill(0) });
    expect(new Set(zeroSafe.map((entry) => entry.newRate)).size).toBeGreaterThan(1);
  });
});
