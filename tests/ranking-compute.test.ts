import { describe, expect, it } from "vitest";
import { computeRanking, needsPosteriorRefinement, posteriorRandomSeed, retargetStoppingMode } from "../lib/ranking/compute";
import type { RankingRequest } from "../lib/ranking/protocol";
import { rankingTuning } from "../lib/ranking/strategy";
import type { ComparisonBudgetMode, ModelState, PriorMode, RankingHistoryInput, StoppingForecast } from "../lib/types";

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

function request(
  mode: ComparisonBudgetMode,
  version: number,
  previousModel?: ModelState,
  priorMode: PriorMode = "weak",
): RankingRequest {
  return {
    type: "RECOMPUTE",
    requestId: `${mode}-${version}`,
    sessionId: "session",
    version,
    randomSeed: 20260817,
    items,
    history,
    distribution: { preset: "uniform", levelCount: 10, weights: Array(10).fill(10) },
    budgetMode: mode,
    priorMode,
    previousModel,
    ...rankingTuning(priorMode),
  };
}

function forecastValue(forecast: StoppingForecast | undefined, field: "lowerAdditional" | "medianAdditional" | "upperAdditional") {
  return forecast?.[field] ?? Number.POSITIVE_INFINITY;
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

  it("restores the same posterior and forecasts after switching prior strength away and back", () => {
    const firstStrong = computeRanking(request("standard", 1, undefined, "strong"));
    const weak = computeRanking(request("standard", 2, firstStrong.model, "weak"));
    const restoredStrong = computeRanking(request("standard", 3, weak.model, "strong"));

    expect(weak.model.abilities).not.toEqual(firstStrong.model.abilities);
    expect(restoredStrong.model.abilities).toEqual(firstStrong.model.abilities);
    expect(restoredStrong.model.uncertainty).toEqual(firstStrong.model.uncertainty);
    expect(restoredStrong.model.currentMeanUncertainty).toBe(firstStrong.model.currentMeanUncertainty);
    expect(restoredStrong.model.diagnostics).toEqual(firstStrong.model.diagnostics);
  });

  it("shares one posterior and ordered forecasts across all stopping strictness levels", () => {
    const quick = computeRanking(request("quick", 1));
    const standard = computeRanking(request("standard", 2));
    const thorough = computeRanking(request("thorough", 3));
    const quickDiagnostics = quick.model.diagnostics!;
    const standardDiagnostics = standard.model.diagnostics!;
    const thoroughDiagnostics = thorough.model.diagnostics!;

    expect(quick.model.abilities).toEqual(standard.model.abilities);
    expect(standard.model.abilities).toEqual(thorough.model.abilities);
    expect(quick.model.uncertainty).toEqual(standard.model.uncertainty);
    expect(quick.nextPair && new Set([quick.nextPair.leftSubjectId, quick.nextPair.rightSubjectId]))
      .toEqual(standard.nextPair && new Set([standard.nextPair.leftSubjectId, standard.nextPair.rightSubjectId]));
    expect(quickDiagnostics.stoppingChecks?.map((check) => [check.mode, check.target])).toEqual([
      ["quick", 0.8], ["standard", 0.9], ["thorough", 0.95],
    ]);
    expect(standardDiagnostics.stoppingChecks).toEqual(quickDiagnostics.stoppingChecks);
    expect(thoroughDiagnostics.stoppingChecks?.map((check) => check.mode)).toEqual(["quick", "standard", "thorough"]);
    const checks = quickDiagnostics.stoppingChecks!;
    expect(Number(checks[0].ready)).toBeGreaterThanOrEqual(Number(checks[1].ready));
    expect(Number(checks[1].ready)).toBeGreaterThanOrEqual(Number(checks[2].ready));
    for (const field of ["lowerAdditional", "medianAdditional", "upperAdditional"] as const) {
      expect(forecastValue(quickDiagnostics.forecasts?.standard, field))
        .toBeGreaterThanOrEqual(forecastValue(quickDiagnostics.forecasts?.quick, field));
      expect(forecastValue(quickDiagnostics.forecasts?.thorough, field))
        .toBeGreaterThanOrEqual(forecastValue(quickDiagnostics.forecasts?.standard, field));
    }

    const retargeted = retargetStoppingMode(quick.model, "thorough", 99)!;
    expect(retargeted.abilities).toEqual(quick.model.abilities);
    expect(retargeted.uncertainty).toEqual(quick.model.uncertainty);
    expect(retargeted.diagnostics?.forecast).toEqual(quickDiagnostics.forecasts?.thorough);
    expect(retargeted.diagnostics?.ready).toBe(checks[2].ready);
    expect(retargeted.version).toBe(99);
  });
});
