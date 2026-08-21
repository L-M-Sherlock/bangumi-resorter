import "fake-indexeddb/auto";
import Dexie from "dexie";
import { beforeEach, describe, expect, it } from "vitest";
import {
  analysisPointFromModel,
  analysisSeriesIdentity,
  reconcileAnalysisSeries,
  sessionAnalysisContext,
} from "../lib/analysis";
import {
  commitBackupImport,
  commitModelForecast,
  commitSessionBudgetMode,
  commitSessionDistribution,
  commitSessionPriorMode,
  commitSnapshotDeletion,
  createSession,
  db,
  deleteSession,
  exportProject,
  getSessionBundle,
  initializeModel,
  persistSessionAnalysisPoint,
  previewBackupImport,
  previewSnapshotDeletion,
  ResorterDatabase,
  saveSnapshot,
} from "../lib/db";
import { validateBackupPayload } from "../lib/export";
import { computeRankingWithoutForecast } from "../lib/ranking/compute";
import { sessionBudgetMode, sessionPriorMode } from "../lib/ranking/strategy";
import type { CollectionItem, ModelState, StoppingForecast } from "../lib/types";

const distribution = { preset: "uniform" as const, levelCount: 10, weights: Array(10).fill(10) };

function items(snapshotId: string): CollectionItem[] {
  return [1, 2, 3].map((subjectId) => ({
    snapshotId,
    subjectId,
    subjectType: 2 as const,
    collectionType: 2 as const,
    rate: 8 - subjectId,
    name: `Item ${subjectId}`,
    nameCn: "",
    private: false,
    tags: [],
  }));
}

function model(sessionId: string, version: number, acceptedComparisons = 0): ModelState {
  return {
    sessionId,
    version,
    abilities: { 1: 1, 2: 0, 3: -1 },
    uncertainty: { 1: 1, 2: 1, 3: 1 },
    acceptedComparisons,
    initialMeanUncertainty: 1,
    currentMeanUncertainty: 1,
    converged: true,
    iterations: 1,
    updatedAt: new Date(0).toISOString(),
  };
}

async function fixture(username = `analysis-${crypto.randomUUID()}`) {
  const snapshotId = crypto.randomUUID();
  const snapshot = await saveSnapshot({ username }, snapshotId, items(snapshotId));
  const session = await createSession(snapshot, 2, [2], distribution, { budgetMode: "standard", priorMode: "weak" });
  const bundle = await getSessionBundle(session.id);
  if (!bundle) throw new Error("missing fixture");
  return { snapshot, session, bundle };
}

beforeEach(async () => {
  db.close();
  await db.delete();
  await db.open();
});

describe("analysis cache database lifecycle", () => {
  it("merges only a same-version background forecast and rejects stale results", async () => {
    const { session, bundle } = await fixture();
    const quick = computeRankingWithoutForecast({
      type: "INIT_SESSION",
      requestId: "quick-model",
      sessionId: session.id,
      version: session.modelVersion,
      randomSeed: session.randomSeed,
      items: bundle.items.map((entry) => ({ subjectId: entry.subjectId, rate: entry.rate })),
      history: [],
      distribution: session.distribution,
      budgetMode: "standard",
      priorMode: "weak",
    }).model;
    const forecast: StoppingForecast = {
      method: "posterior-contraction-mc-v12",
      status: "forecast",
      rolloutCount: 64,
      lowerAdditional: 16,
      medianAdditional: 32,
      upperAdditional: 48,
      nextCheckpoint: 16,
      probabilityWithin20: 0.25,
      projectionHorizon: 64,
      probabilityWithinProjection: 1,
      within20Successes: 16,
      withinProjectionSuccesses: 64,
    };
    const completed: ModelState = {
      ...quick,
      diagnostics: {
        ...quick.diagnostics!,
        forecast,
        forecasts: { quick: forecast, standard: forecast, thorough: forecast },
      },
    };
    await initializeModel(session.id, quick);
    const before = await db.models.get(session.id);

    const merged = await commitModelForecast(session.id, session.modelVersion, completed);
    const currentSession = await db.sessions.get(session.id);
    expect(merged?.abilities).toEqual(before?.abilities);
    expect(merged?.uncertainty).toEqual(before?.uncertainty);
    expect(merged?.acceptedComparisons).toBe(before?.acceptedComparisons);
    expect(merged?.diagnostics?.stoppingChecks).toEqual(before?.diagnostics?.stoppingChecks);
    expect(merged?.diagnostics?.forecasts).toEqual(completed.diagnostics?.forecasts);
    expect(currentSession?.modelVersion).toBe(session.modelVersion);

    expect(await commitModelForecast(session.id, session.modelVersion, {
      ...completed,
      abilities: { 1: 999 },
    })).toBeUndefined();
    expect((await db.models.get(session.id))?.abilities).toEqual(before?.abilities);

    await commitSessionBudgetMode(session.id, session.modelVersion, "thorough", {
      ...quick,
      version: session.modelVersion + 1,
    });
    expect(await commitModelForecast(session.id, session.modelVersion, completed)).toBeUndefined();
    expect((await db.models.get(session.id))?.version).toBe(session.modelVersion + 1);
  });

  it("upgrades an existing v7 database without touching user rows", async () => {
    const name = `analysis-v7-${crypto.randomUUID()}`;
    const legacy = new Dexie(name);
    legacy.version(7).stores({
      profiles: "id, username, updatedAt",
      snapshots: "id, profileId, syncedAt",
      items: "[snapshotId+subjectId], snapshotId, subjectId, subjectType, collectionType, rate",
      sessions: "id, profileId, snapshotId, subjectType, status, updatedAt",
      sessionItems: "id, sessionId, subjectId, [sessionId+subjectId]",
      comparisons: "id, profileId, sessionId, subjectType, active, createdAt, importBatchId, importedFromSessionId",
      models: "sessionId, version, updatedAt",
      importBatches: "id, profileId, targetSessionId, sourceSessionId, createdAt, type",
      backupImports: "id, profileId, mode, createdAt, backupDigest",
      meta: "key",
    });
    await legacy.open();
    await legacy.table("profiles").put({ id: "p", username: "p", createdAt: "0", updatedAt: "0" });
    legacy.close();

    const upgraded = new ResorterDatabase(name);
    await upgraded.open();
    expect(await upgraded.profiles.get("p")).toMatchObject({ username: "p" });
    expect(await upgraded.analysisSeries.count()).toBe(0);
    upgraded.close();
    await Dexie.delete(name);
  });

  it("keeps analysis derived-only, rejects stale writes, and excludes it from ExportV1", async () => {
    const { session, bundle } = await fixture();
    const context = sessionAnalysisContext(bundle.session, bundle.items, bundle.history, "weak", "standard");
    const point = analysisPointFromModel(context.history, model(session.id, 0));
    await db.analysisSeries.put({
      ...reconcileAnalysisSeries(undefined, context.identity, context.history, context.inputDigest),
      id: "obsolete-analysis-algorithm",
      algorithmVersion: "obsolete",
    });
    await persistSessionAnalysisPoint(context, point, true);
    expect(await db.analysisSeries.count()).toBe(1);
    expect(await db.analysisSeries.get("obsolete-analysis-algorithm")).toBeUndefined();

    const exported = await exportProject(session.profileId) as unknown as Record<string, unknown>;
    expect(exported.analysisSeries).toBeUndefined();
    expect(exported.schemaVersion).toBe(1);

    await db.comparisons.add({
      id: crypto.randomUUID(), profileId: session.profileId, sessionId: session.id, subjectType: 2,
      leftSubjectId: 1, rightSubjectId: 2, outcome: "left", queryKind: "manual",
      acceptedCountAtAnswer: 1, active: true, createdAt: new Date().toISOString(),
    });
    await expect(persistSessionAnalysisPoint(context, point)).rejects.toThrow(/陈旧检查点/);
  });

  it("retains prior scenarios and stop-mode caches, but distribution change clears them", async () => {
    const { session, bundle } = await fixture();
    const context = sessionAnalysisContext(bundle.session, bundle.items, bundle.history, "weak", "standard");
    const weakSeries = reconcileAnalysisSeries(undefined, context.identity, context.history, context.inputDigest);
    const strongIdentity = analysisSeriesIdentity(session.id, "strong", distribution, bundle.items.length);
    const strongSeries = reconcileAnalysisSeries(undefined, strongIdentity, context.history, "strong-input");
    await db.analysisSeries.bulkPut([weakSeries, strongSeries]);

    const budgetSession = await commitSessionBudgetMode(session.id, session.modelVersion, "thorough", model(session.id, 1));
    expect(await db.analysisSeries.count()).toBe(2);
    const priorSession = await commitSessionPriorMode(budgetSession.id, budgetSession.modelVersion, "strong", model(session.id, 2));
    expect(await db.analysisSeries.count()).toBe(2);
    await commitSessionDistribution(priorSession.id, priorSession.modelVersion, { ...distribution, preset: "high-tail" }, model(session.id, 3));
    expect(await db.analysisSeries.count()).toBe(0);
  });

  it("cleans cache rows when deleting a session or its snapshot", async () => {
    const first = await fixture();
    const firstContext = sessionAnalysisContext(first.bundle.session, first.bundle.items, first.bundle.history, sessionPriorMode(first.session), sessionBudgetMode(first.session));
    await db.analysisSeries.put(reconcileAnalysisSeries(undefined, firstContext.identity, firstContext.history, firstContext.inputDigest));
    await deleteSession(first.session.id);
    expect(await db.analysisSeries.where("sessionId").equals(first.session.id).count()).toBe(0);

    const second = await fixture("snapshot-cleanup");
    const secondContext = sessionAnalysisContext(second.bundle.session, second.bundle.items, second.bundle.history, "weak", "standard");
    await db.analysisSeries.put(reconcileAnalysisSeries(undefined, secondContext.identity, secondContext.history, secondContext.inputDigest));
    const replacementId = crypto.randomUUID();
    await saveSnapshot({ username: second.snapshot.username }, replacementId, items(replacementId));
    const preview = await previewSnapshotDeletion(second.snapshot.id);
    await commitSnapshotDeletion({
      snapshotId: second.snapshot.id,
      confirmationUsername: second.snapshot.username,
      targetRevision: preview.targetRevision,
    });
    expect(await db.analysisSeries.where("sessionId").equals(second.session.id).count()).toBe(0);
  });

  it("drops derived analysis rows during an overwrite restore", async () => {
    const { session, bundle } = await fixture("replace-analysis");
    const context = sessionAnalysisContext(bundle.session, bundle.items, bundle.history, "weak", "standard");
    await db.analysisSeries.put(reconcileAnalysisSeries(undefined, context.identity, context.history, context.inputDigest));
    const payload = await exportProject(session.profileId);
    const validated = validateBackupPayload(structuredClone(payload));
    const backup = {
      ...validated,
      digest: crypto.randomUUID(),
      fileName: "analysis-backup.json",
      byteSize: JSON.stringify(payload).length,
    };
    const preview = await previewBackupImport(backup);
    await commitBackupImport(backup, {
      mode: "replace",
      confirmationUsername: payload.profile.username,
      targetRevision: preview.targetRevision,
    });
    expect(await db.analysisSeries.where("sessionId").equals(session.id).count()).toBe(0);
  });
});
