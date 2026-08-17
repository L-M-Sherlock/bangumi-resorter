import { describe, expect, it } from "vitest";
import { computeRanking, needsPosteriorRefinement, posteriorRandomSeed } from "../lib/ranking/compute";
import type { RankingRequest } from "../lib/ranking/protocol";
import { rankingTuning } from "../lib/ranking/strategy";
import type { ComparisonBudgetMode, ModelState, RankingHistoryInput } from "../lib/types";

const items = Array.from({ length: 8 }, (_, index) => ({
  subjectId: index + 1,
  rate: 3 + index,
}));
const history: RankingHistoryInput[] = Array.from({ length: 20 }, (_, index) => {
  const leftSubjectId = 1 + (index % 7);
  return {
    recordId: `record-${index}`,
    sessionId: "session",
    leftSubjectId,
    rightSubjectId: leftSubjectId + 1,
    outcome: "right",
    acceptedCountAtAnswer: index + 1,
    queryKind: "adaptive",
    createdAt: new Date(index * 1000).toISOString(),
  };
});

function request(mode: ComparisonBudgetMode, version: number, previousModel?: ModelState): RankingRequest {
  return {
    type: "RECOMPUTE",
    requestId: `${mode}-${version}`,
    sessionId: "session",
    version,
    randomSeed: 20260817,
    items,
    history,
    distribution: { preset: "uniform", weights: Array(10).fill(10) },
    previousModel,
    ...rankingTuning(mode),
  };
}

describe("ranking computation", () => {
  it("keeps posterior sampling independent of the model version", () => {
    expect(posteriorRandomSeed(42)).toBe(posteriorRandomSeed(42));
    expect(posteriorRandomSeed(42)).not.toBe(posteriorRandomSeed(43));
  });

  it("refines only an evidence-qualified interval that crosses the stopping boundary", () => {
    expect(needsPosteriorRefinement({
      evidenceCount: 20, evidenceRequired: 8,
      coverageTargetStabilityLow: 0.88, coverageTargetStabilityHigh: 0.93,
    })).toBe(true);
    expect(needsPosteriorRefinement({
      evidenceCount: 20, evidenceRequired: 8,
      coverageTargetStabilityLow: 0.84, coverageTargetStabilityHigh: 0.89,
    })).toBe(false);
    expect(needsPosteriorRefinement({
      evidenceCount: 7, evidenceRequired: 8,
      coverageTargetStabilityLow: 0.88, coverageTargetStabilityHigh: 0.93,
    })).toBe(false);
  });

  it("returns identical quick diagnostics after switching through other modes", () => {
    const firstQuick = computeRanking(request("quick", 1));
    const standard = computeRanking(request("standard", 2, firstQuick.model));
    const thorough = computeRanking(request("thorough", 3, standard.model));
    const restoredQuick = computeRanking(request("quick", 4, thorough.model));

    expect(restoredQuick.model.abilities).toEqual(firstQuick.model.abilities);
    expect(restoredQuick.model.uncertainty).toEqual(firstQuick.model.uncertainty);
    expect(restoredQuick.model.currentMeanUncertainty).toBe(firstQuick.model.currentMeanUncertainty);
    expect(restoredQuick.model.diagnostics).toEqual(firstQuick.model.diagnostics);
  });
});
