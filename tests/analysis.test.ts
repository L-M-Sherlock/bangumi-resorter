import { describe, expect, it, vi } from "vitest";
import {
  analysisCheckpoints,
  analysisCheckpointsForHistory,
  analysisEvidenceBreakdown,
  analysisForecastBacktest,
  analysisInputDigest,
  analysisPointFromModel,
  analysisPrefixDigest,
  analysisSeriesIdentity,
  cleanCheckpointStep,
  reconcileAnalysisSeries,
  sessionAnalysisContext,
  sortAnalysisRecords,
  toAnalysisHistory,
} from "../lib/analysis";
import { computeAnalysisCheckpoint, computeAnalysisHistory } from "../lib/analysis/compute";
import type { AnalysisWorkerRequest } from "../lib/analysis/protocol";
import type { AnalysisHistoryEntry, SessionAnalysisPoint, SessionAnalysisSeries } from "../lib/analysis/types";
import type { CollectionItem, ComparisonRecord, ModelState, SortingSession } from "../lib/types";

const day = 24 * 60 * 60 * 1000;
const distribution = { preset: "uniform" as const, levelCount: 10, weights: Array(10).fill(10) };

function record(
  id: string,
  leftSubjectId: number,
  rightSubjectId: number,
  outcome: ComparisonRecord["outcome"],
  createdAt: string,
  overrides: Partial<ComparisonRecord> = {},
): ComparisonRecord {
  return {
    id,
    profileId: "profile",
    sessionId: "session",
    subjectType: 2,
    leftSubjectId,
    rightSubjectId,
    outcome,
    queryKind: "adaptive",
    acceptedCountAtAnswer: 1,
    active: true,
    createdAt,
    ...overrides,
  };
}

function point(history: AnalysisHistoryEntry[], checkpoint: number): SessionAnalysisPoint {
  return {
    checkpoint,
    prefixDigest: analysisPrefixDigest(history, checkpoint),
    rawEvidence: checkpoint,
    agedEvidence: checkpoint,
    effectiveEvidence: checkpoint,
    uniquePairCount: checkpoint,
    coveredItemCount: checkpoint,
    sourceAgeLoss: 0,
    repeatedPairLoss: 0,
    calibrationRaw: 0,
    calibrationEffective: 0,
    manualRaw: 0,
    importedRaw: 0,
    importedEffective: 0,
    meanUncertainty: 1,
    tieStrength: 1,
    posteriorSampleCount: 64,
    stoppingChecks: {},
    forecasts: {},
    computedAt: new Date(0).toISOString(),
  };
}

function item(subjectId: number, rate = 7): CollectionItem {
  return {
    snapshotId: "snapshot",
    subjectId,
    subjectType: 2,
    collectionType: 2,
    rate,
    name: `Item ${subjectId}`,
    nameCn: "",
    private: false,
    tags: [],
  };
}

function session(overrides: Partial<SortingSession> = {}): SortingSession {
  return {
    id: "session",
    profileId: "profile",
    snapshotId: "snapshot",
    subjectType: 2,
    collectionTypes: [2],
    title: "Analysis",
    status: "active",
    distribution,
    randomSeed: 42,
    modelVersion: 3,
    budgetMode: "standard",
    priorMode: "weak",
    comparisonHistoryMode: "local",
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    ...overrides,
  };
}

describe("session analysis checkpoints and evidence", () => {
  it("uses a neat item-derived step and always includes zero and the current endpoint", () => {
    expect(cleanCheckpointStep(284)).toBe(50);
    expect(analysisCheckpoints(284, 1202)).toEqual([
      0, 50, 100, 150, 200, 250, 300, 350, 400, 450, 500, 550, 600,
      650, 700, 750, 800, 850, 900, 950, 1000, 1050, 1100, 1150, 1200, 1202,
    ]);
    const capped = analysisCheckpoints(2, 10_000, 60);
    expect(capped).toHaveLength(60);
    expect(capped[0]).toBe(0);
    expect(capped.at(-1)).toBe(10_000);
  });

  it("sorts by arrival time, excludes skip/inactive, and splits both decay losses", () => {
    const epoch = new Date(0).toISOString();
    const oneYear = new Date(365 * day).toISOString();
    const records = [
      record("ordinary-a", 1, 2, "left", new Date(10 * day).toISOString()),
      record("ordinary-b", 2, 1, "right", new Date(20 * day).toISOString(), { queryKind: "calibration", calibrationOfComparisonId: "ordinary-a" }),
      record("imported", 2, 3, "tie", oneYear, { sourceCreatedAt: epoch, importBatchId: "batch", importedFromSessionId: "source" }),
      record("skip", 1, 3, "skip", new Date(5 * day).toISOString()),
      record("inactive", 1, 3, "right", new Date(6 * day).toISOString(), { active: false }),
    ];
    expect(sortAnalysisRecords(records).map((entry) => entry.id)).toEqual(["imported", "ordinary-a", "ordinary-b"]);
    const history = toAnalysisHistory(records);
    const evidence = analysisEvidenceBreakdown(history);
    expect(evidence.rawEvidence).toBe(3);
    expect(evidence.agedEvidence).toBeCloseTo(2.5, 8);
    expect(evidence.effectiveEvidence).toBeCloseTo(2 / 1.5 + 0.5, 8);
    expect(evidence.sourceAgeLoss).toBeCloseTo(0.5, 8);
    expect(evidence.repeatedPairLoss).toBeCloseTo(2.5 - (2 / 1.5 + 0.5), 8);
    expect(evidence.calibrationRaw).toBe(1);
    expect(evidence.calibrationEffective).toBeCloseTo(2 / 3, 8);
    expect(evidence.importedRaw).toBe(1);
    expect(evidence.importedEffective).toBeCloseTo(0.5, 8);
    expect(evidence.uniquePairCount).toBe(2);
    expect(evidence.coveredItemCount).toBe(3);
  });

  it("keeps fixed-step checkpoints even when records came from one import batch", () => {
    const records = Array.from({ length: 120 }, (_, index) => record(
      `record-${String(index).padStart(3, "0")}`,
      1,
      2,
      "left",
      new Date(index).toISOString(),
      index >= 10 && index < 110 ? { importBatchId: "atomic-batch" } : {},
    ));
    const history = toAnalysisHistory(records);
    expect(analysisCheckpointsForHistory(284, history)).toEqual([0, 50, 100, 120]);
  });

  it("orders imported rows by their actual source time, not copy time", () => {
    const records = [
      record("before", 1, 2, "left", new Date(99).toISOString()),
      record("batch-a", 1, 3, "left", new Date(0).toISOString(), { importBatchId: "batch", sourceCreatedAt: new Date(100).toISOString() }),
      record("batch-b", 2, 3, "right", new Date(1).toISOString(), { importBatchId: "batch", sourceCreatedAt: new Date(102).toISOString() }),
      record("after", 1, 2, "right", new Date(101).toISOString()),
    ];
    expect(sortAnalysisRecords(records).map((entry) => entry.id)).toEqual([
      "before", "batch-a", "after", "batch-b",
    ]);
  });
});

describe("session analysis mapping and cache identity", () => {
  it("maps all three stopping checks and shared-path forecasts without changing their order", () => {
    const history = toAnalysisHistory([record("a", 1, 2, "left", new Date(0).toISOString())]);
    const modes = ["quick", "standard", "thorough"] as const;
    const model = {
      sessionId: "session",
      version: 1,
      abilities: { 1: 1, 2: -1 },
      uncertainty: { 1: 0.4, 2: 0.4 },
      acceptedComparisons: 1,
      tieStrength: 0.7,
      initialMeanUncertainty: 1,
      currentMeanUncertainty: 0.4,
      converged: true,
      iterations: 2,
      updatedAt: new Date(0).toISOString(),
      diagnostics: {
        sampleCount: 128,
        expectedCrossTwoBucketCount: 1.2,
        crossTwoBucketCountLow: 0,
        crossTwoBucketCountHigh: 3,
        stoppingChecks: modes.map((mode, index) => ({ mode, sampleCount: 128, stableSamples: 100, probability: 0.8, low: 0.7 + index * 0.02, high: 0.9, ready: false })),
        forecasts: Object.fromEntries(modes.map((mode, index) => [mode, {
          status: "forecast", rolloutCount: 64, lowerAdditional: 2 + index * 4,
          medianAdditional: 5 + index * 5, upperAdditional: 12 + index * 8,
          projectionHorizon: 1000, probabilityWithinProjection: 1,
        }])),
      },
    } as unknown as ModelState;
    const mapped = analysisPointFromModel(history, model);
    expect(mapped.posteriorSampleCount).toBe(128);
    expect(mapped.stoppingChecks.quick?.low).toBeCloseTo(0.7);
    expect(mapped.forecasts.quick?.medianAdditional).toBe(5);
    expect(mapped.forecasts.standard?.medianAdditional).toBe(10);
    expect(mapped.forecasts.thorough?.medianAdditional).toBe(15);
    expect(mapped.forecasts.quick!.medianAdditional!).toBeLessThanOrEqual(mapped.forecasts.standard!.medianAdditional!);
    expect(mapped.forecasts.standard!.medianAdditional!).toBeLessThanOrEqual(mapped.forecasts.thorough!.medianAdditional!);
  });

  it("backtests only an observed stopping event and reports right censoring otherwise", () => {
    const mode = "standard" as const;
    const makePoint = (
      checkpoint: number,
      ready: boolean,
      forecast?: { lowerAdditional: number; medianAdditional: number; upperAdditional: number },
    ) => ({
      ...point([], 0),
      checkpoint,
      stoppingChecks: {
        [mode]: { mode, sampleCount: 128, stableSamples: ready ? 128 : 0, probability: Number(ready), low: Number(ready), high: 1, ready },
      },
      forecasts: forecast ? {
        [mode]: {
          mode, status: "forecast" as const, rolloutCount: 64,
          ...forecast, projectionHorizon: 497, probabilityWithinProjection: 1,
        },
      } : {},
    });
    const points = [
      makePoint(0, false, { lowerAdditional: 90, medianAdditional: 110, upperAdditional: 130 }),
      makePoint(50, false, { lowerAdditional: 50, medianAdditional: 70, upperAdditional: 90 }),
      makePoint(100, true),
    ];
    expect(analysisForecastBacktest(points, mode)).toMatchObject({
      status: "observed",
      observedStopCheckpoint: 100,
      forecastCount: 2,
      boundedIntervalCount: 2,
      boundedIntervalHits: 2,
      empiricalIntervalCoverage: 1,
      medianAbsoluteError: 15,
      medianBias: 15,
    });
    expect(analysisForecastBacktest(points.slice(0, 2), mode)).toMatchObject({
      status: "right-censored",
      forecastCount: 2,
    });
  });

  it("does not score forecasts whose future path was interrupted by imported or manual evidence", () => {
    const mode = "standard" as const;
    const makePoint = (checkpoint: number, importedRaw: number, manualRaw: number, ready: boolean) => ({
      ...point([], 0),
      checkpoint,
      importedRaw,
      manualRaw,
      stoppingChecks: {
        [mode]: { mode, sampleCount: 128, stableSamples: ready ? 128 : 0, probability: Number(ready), low: Number(ready), high: 1, ready },
      },
      forecasts: ready ? {} : {
        [mode]: {
          mode, status: "forecast" as const, rolloutCount: 64,
          lowerAdditional: 40, medianAdditional: 50, upperAdditional: 60,
          projectionHorizon: 497, probabilityWithinProjection: 1,
        },
      },
    });
    const result = analysisForecastBacktest([
      makePoint(0, 0, 0, false),
      makePoint(50, 1, 0, false),
      makePoint(100, 1, 1, false),
      makePoint(150, 1, 1, true),
    ], mode);
    expect(result).toMatchObject({
      status: "observed",
      forecastCount: 1,
      interruptedForecastCount: 2,
      medianAbsoluteError: 0,
      empiricalIntervalCoverage: 1,
    });
  });

  it("reuses valid prefixes, rejects changed prefixes, separates priors/distributions, and ignores stop mode", () => {
    const records = [
      record("a", 1, 2, "left", new Date(1).toISOString()),
      record("b", 2, 3, "right", new Date(2).toISOString()),
    ];
    const history = toAnalysisHistory(records);
    const identity = analysisSeriesIdentity("session", "weak", distribution, 2);
    const digest = analysisInputDigest({ sessionId: "session", randomSeed: 42, priorMode: "weak", distribution, items: [{ subjectId: 1, rate: 7 }], history });
    const stored: SessionAnalysisSeries = {
      ...identity,
      inputDigest: digest,
      milestones: [point(history, 0), point(history, 1)],
      latest: point(history, 2),
      updatedAt: new Date(0).toISOString(),
    };
    const appended = toAnalysisHistory([...records, record("c", 1, 3, "tie", new Date(3).toISOString())]);
    const reconciledAppend = reconcileAnalysisSeries(stored, identity, appended, "next");
    expect(reconciledAppend.milestones.map((entry) => entry.checkpoint)).toEqual([0, 1]);
    expect(reconciledAppend.latest).toBeUndefined();

    const deleted = toAnalysisHistory([records[1], record("c", 1, 3, "tie", new Date(3).toISOString())]);
    expect(reconcileAnalysisSeries(stored, identity, deleted, "deleted").milestones.map((entry) => entry.checkpoint)).toEqual([0]);
    const inserted = toAnalysisHistory([...records, record("old", 1, 3, "tie", new Date(0).toISOString())]);
    expect(reconcileAnalysisSeries(stored, identity, inserted, "inserted").milestones.map((entry) => entry.checkpoint)).toEqual([0]);

    expect(analysisSeriesIdentity("session", "strong", distribution, 2).id).not.toBe(identity.id);
    expect(analysisSeriesIdentity("session", "weak", { ...distribution, preset: "high-tail" }, 2).id).not.toBe(identity.id);
    const items = [item(1), item(2), item(3)];
    const quick = sessionAnalysisContext(session({ budgetMode: "quick" }), items, records, "weak", "quick");
    const thorough = sessionAnalysisContext(session({ budgetMode: "thorough" }), items, records, "weak", "thorough");
    expect(quick.identity.id).toBe(thorough.identity.id);
    expect(quick.inputDigest).toBe(thorough.inputDigest);
  });

  it("keeps no more than sixty valid milestones as very long histories grow", () => {
    const records = Array.from({ length: 100 }, (_, index) =>
      record(`record-${String(index).padStart(3, "0")}`, 1, 2, index % 2 ? "left" : "right", new Date(index).toISOString()));
    const history = toAnalysisHistory(records);
    const identity = analysisSeriesIdentity("session", "weak", distribution, 2);
    const stored: SessionAnalysisSeries = {
      ...identity,
      inputDigest: "old",
      milestones: Array.from({ length: 101 }, (_, checkpoint) => point(history, checkpoint)),
      latest: point(history, 100),
      updatedAt: new Date(0).toISOString(),
    };
    const reconciled = reconcileAnalysisSeries(stored, identity, history, "current");
    expect(reconciled.milestones.length).toBeLessThanOrEqual(60);
    expect(reconciled.milestones[0].checkpoint).toBe(0);
    expect(reconciled.milestones.at(-1)?.checkpoint).toBe(100);
  });
});

describe("analysis history computation", () => {
  const entries = toAnalysisHistory([
    record("a", 1, 2, "left", new Date(1).toISOString()),
    record("b", 2, 3, "right", new Date(2).toISOString()),
  ]);
  const identity = analysisSeriesIdentity("session", "weak", distribution, 3);
  const request: AnalysisWorkerRequest = {
    type: "CALCULATE_HISTORY",
    taskId: "task",
    identity,
    inputDigest: "digest",
    randomSeed: 42,
    items: [{ subjectId: 1, rate: 8 }, { subjectId: 2, rate: 7 }, { subjectId: 3, rate: 6 }],
    history: entries,
    distribution,
    priorMode: "weak",
    budgetMode: "standard",
    checkpoints: [0, 1, 2],
    forecastWorkerCount: 1,
  };

  it("reports deterministic ascending progress and supports cancellation/resume", async () => {
    const progress: number[] = [];
    const fakeCompute = vi.fn(async (_request: AnalysisWorkerRequest, checkpoint: number) => point(entries, checkpoint));
    const points = await computeAnalysisHistory(request, {
      computeCheckpoint: fakeCompute,
      onProgress: (_point, completed) => { progress.push(completed); },
    });
    expect(points.map((entry) => entry.checkpoint)).toEqual([0, 1, 2]);
    expect(progress).toEqual([1, 2, 3]);

    let calls = 0;
    await expect(computeAnalysisHistory(request, {
      computeCheckpoint: async (_request, checkpoint) => { calls += 1; return point(entries, checkpoint); },
      cancelled: () => calls >= 1,
    })).rejects.toThrow(/取消/);
    const resumed = await computeAnalysisHistory({ ...request, checkpoints: [1, 2] }, { computeCheckpoint: fakeCompute });
    expect(resumed.map((entry) => entry.checkpoint)).toEqual([1, 2]);
  });

  it("is deterministic with the production 64-path forecast", async () => {
    const first = await computeAnalysisCheckpoint({ ...request, checkpoints: [1] }, 1);
    const second = await computeAnalysisCheckpoint({ ...request, checkpoints: [1] }, 1);
    expect({ ...second, computedAt: "" }).toEqual({ ...first, computedAt: "" });
    expect(first.forecasts.quick?.rolloutCount).toBe(64);
    expect(first.forecasts.standard?.rolloutCount).toBe(64);
    expect(first.forecasts.thorough?.rolloutCount).toBe(64);
  }, 20_000);
});
