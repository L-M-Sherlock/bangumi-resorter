import "fake-indexeddb/auto";
import Dexie from "dexie";
import { beforeEach, describe, expect, it } from "vitest";
import { createDemoItems } from "../lib/demo";
import { fitModel, toModelState } from "../lib/ranking/engine";
import {
  commitComparisonDeletion, commitComparisonImport, commitResponse, commitSessionBudgetMode, commitSessionDistribution, createSession, db, deleteSession, deriveSessionWithTagFilter, exportProject, getSessionBundle, importProject,
  initializeModel, lastActiveResponse, previewComparisonImport, previewSessionTagDerivation, previewSessionUpgrade, saveSnapshot, upgradeSessionToSnapshot,
  ResorterDatabase,
} from "../lib/db";
import type { ComparisonRecord, DistributionConfig, ExportV1, ModelState, SessionItem, SortingSession } from "../lib/types";

function legacyProjectFixture(prefix: string) {
  const profileId = `${prefix}-profile`;
  const snapshotId = `${prefix}-snapshot`;
  const timestamp = new Date(0).toISOString();
  const items = createDemoItems(snapshotId).slice(0, 3).map((entry) => ({ ...entry, snapshotId }));
  const profile = {
    id: profileId, username: profileId, nickname: "Legacy",
    createdAt: timestamp, updatedAt: timestamp,
  };
  const snapshot = {
    id: snapshotId, profileId, username: profileId, syncedAt: timestamp,
    itemCount: items.length, containsPrivate: false,
  };
  const sessions: SortingSession[] = ["a", "b", "c"].map((suffix, index) => ({
    id: `${prefix}-session-${suffix}`,
    profileId,
    snapshotId,
    subjectType: 2,
    collectionTypes: [2],
    title: `Legacy ${suffix}`,
    status: "complete",
    distribution: { preset: "uniform", levelCount: 10, weights: Array(10).fill(10) },
    randomSeed: index + 1,
    modelVersion: 3,
    budgetMode: "quick",
    comparisonReusePolicy: "profile",
    createdAt: timestamp,
    updatedAt: timestamp,
  }));
  const sessionItems: SessionItem[] = sessions.flatMap((session) => items.map((entry) => ({
    id: `${session.id}:${entry.subjectId}`,
    sessionId: session.id,
    subjectId: entry.subjectId,
  })));
  const pairs = [
    [items[0].subjectId, items[1].subjectId, "left"],
    [items[1].subjectId, items[2].subjectId, "right"],
    [items[0].subjectId, items[2].subjectId, "tie"],
  ] as const;
  const comparisons: ComparisonRecord[] = sessions.map((session, index) => ({
    id: `${prefix}-comparison-${index}`,
    profileId,
    sessionId: session.id,
    subjectType: 2,
    leftSubjectId: pairs[index][0],
    rightSubjectId: pairs[index][1],
    outcome: pairs[index][2],
    queryKind: "adaptive",
    acceptedCountAtAnswer: 1,
    active: true,
    createdAt: new Date(index + 1).toISOString(),
  }));
  comparisons.push({
    ...comparisons[0],
    id: `${prefix}-skip`,
    outcome: "skip",
    acceptedCountAtAnswer: 1,
    createdAt: new Date(4).toISOString(),
  });
  const models: ModelState[] = sessions.map((session) => ({
    sessionId: session.id,
    version: session.modelVersion,
    abilities: {},
    uncertainty: {},
    acceptedComparisons: 1,
    initialMeanUncertainty: 1,
    currentMeanUncertainty: 1,
    converged: true,
    iterations: 1,
    updatedAt: timestamp,
  }));
  return { profile, snapshot, items, sessions, sessionItems, comparisons, models };
}

beforeEach(async () => {
  db.close();
  await db.delete();
  await db.open();
});

describe("IndexedDB project persistence", () => {
  it("atomically saves responses and rejects stale model versions", async () => {
    const snapshotId = crypto.randomUUID();
    const items = createDemoItems(snapshotId).slice(0, 3);
    const snapshot = await saveSnapshot({ username: "demo", nickname: "Demo" }, snapshotId, items);
    const session = await createSession(snapshot, 2, [2], { preset: "uniform", levelCount: 10, weights: Array(10).fill(10) });
    expect(session.budgetMode).toBe("quick");
    expect(session.comparisonReusePolicy).toBe("session");
    expect(session.comparisonHistoryMode).toBe("local");
    expect(session.stoppingTarget).toBeUndefined();
    expect(session.suggestedComparisons).toBeUndefined();
    expect(session.maxComparisons).toBeUndefined();
    const fitted = fitModel(items.map(({ subjectId, rate }) => ({ subjectId, rate })), []);
    const model = toModelState(session.id, 0, fitted);
    await initializeModel(session.id, model);
    const pair = { leftSubjectId: items[0].subjectId, rightSubjectId: items[1].subjectId };
    const nextFit = fitModel(items.map(({ subjectId, rate }) => ({ subjectId, rate })), [{ ...pair, outcome: "left" }]);
    const nextModel = toModelState(session.id, 1, nextFit, model.initialMeanUncertainty);
    await commitResponse(session.id, 0, pair, "left", nextModel);
    await expect(commitResponse(session.id, 0, pair, "right", nextModel)).rejects.toThrow(/其他页面更新/);
    const bundle = await getSessionBundle(session.id);
    expect(bundle?.history).toHaveLength(1);
    expect(bundle?.session.modelVersion).toBe(1);
    expect((await lastActiveResponse(session.id))?.outcome).toBe("left");
  });

  it("adds manual comparisons and permanently deletes one with a recomputed model", async () => {
    const snapshotId = crypto.randomUUID();
    const items = createDemoItems(snapshotId).slice(0, 3);
    const snapshot = await saveSnapshot({ username: "demo", nickname: "Demo" }, snapshotId, items);
    const session = await createSession(snapshot, 2, [2], { preset: "uniform", levelCount: 10, weights: Array(10).fill(10) });
    const inputs = items.map(({ subjectId, rate }) => ({ subjectId, rate }));
    const initialFit = fitModel(inputs, []);
    const initialModel = toModelState(session.id, 0, initialFit);
    await initializeModel(session.id, initialModel);

    const pair = { recordId: "manual-record", leftSubjectId: items[0].subjectId, rightSubjectId: items[2].subjectId, queryKind: "manual" as const };
    const answeredFit = fitModel(inputs, [{ ...pair, outcome: "tie" }]);
    const answeredModel = toModelState(session.id, 1, answeredFit, initialModel.initialMeanUncertainty);
    await commitResponse(session.id, 0, pair, "tie", answeredModel);
    expect((await db.comparisons.get("manual-record"))?.queryKind).toBe("manual");

    const recomputedModel = toModelState(session.id, 2, initialFit, initialModel.initialMeanUncertainty);
    await commitComparisonDeletion(session.id, 1, "manual-record", recomputedModel);
    expect(await db.comparisons.get("manual-record")).toBeUndefined();
    const bundle = await getSessionBundle(session.id);
    expect(bundle?.history).toHaveLength(0);
    expect(bundle?.session.modelVersion).toBe(2);
    expect(bundle?.model?.version).toBe(2);
    await expect(commitComparisonDeletion(session.id, 1, "manual-record", recomputedModel)).rejects.toThrow(/其他页面更新/);
  });

  it("deletes a session and its dependent data without deleting the collection snapshot", async () => {
    const snapshotId = crypto.randomUUID();
    const items = createDemoItems(snapshotId).slice(0, 2);
    const snapshot = await saveSnapshot({ username: "demo", nickname: "Demo" }, snapshotId, items);
    const session = await createSession(snapshot, 2, [2], { preset: "uniform", levelCount: 10, weights: Array(10).fill(10) });
    const fit = fitModel(items.map(({ subjectId, rate }) => ({ subjectId, rate })), []);
    const initial = toModelState(session.id, 0, fit);
    await initializeModel(session.id, initial);
    const pair = { recordId: "session-record", leftSubjectId: items[0].subjectId, rightSubjectId: items[1].subjectId };
    await commitResponse(session.id, 0, pair, "left", toModelState(session.id, 1, fit, initial.initialMeanUncertainty));

    await deleteSession(session.id);
    expect(await db.sessions.get(session.id)).toBeUndefined();
    expect(await db.sessionItems.where("sessionId").equals(session.id).count()).toBe(0);
    expect(await db.comparisons.where("sessionId").equals(session.id).count()).toBe(0);
    expect(await db.models.get(session.id)).toBeUndefined();
    expect(await db.snapshots.get(snapshot.id)).toBeDefined();
    expect(await db.items.where("snapshotId").equals(snapshot.id).count()).toBe(items.length);
  });

  it("round-trips a backup as a non-destructive new project", async () => {
    const snapshotId = crypto.randomUUID();
    const items = createDemoItems(snapshotId).slice(0, 4);
    const snapshot = await saveSnapshot({ username: "demo", nickname: "Demo" }, snapshotId, items);
    const source = await createSession(snapshot, 2, [2], { preset: "uniform", levelCount: 5, weights: Array(5).fill(20) });
    const upgraded = await createSession(snapshot, 2, [2], { preset: "uniform", levelCount: 10, weights: Array(10).fill(10) });
    const derived = await deriveSessionWithTagFilter(source.id, { source: "collection", match: "all", tags: ["经典"] });
    await db.sessions.update(upgraded.id, { upgradedFromSessionId: source.id });
    const payload = await exportProject("demo");
    payload.sessions.forEach((session) => {
      session.stoppingTarget = "top-tail";
      session.maxComparisons = 1000;
      session.status = "complete";
      delete (session.distribution as Partial<DistributionConfig>).levelCount;
    });
    const imported = await importProject(payload);
    expect(imported.id).not.toBe("demo");
    expect(imported.username).toContain("导入");
    expect(await db.profiles.count()).toBe(2);
    expect(await db.snapshots.count()).toBe(2);
    expect(await db.sessions.count()).toBe(6);
    const importedSessions = await db.sessions.where("profileId").equals(imported.id).toArray();
    expect(importedSessions.every((session) => session.stoppingTarget === undefined)).toBe(true);
    expect(importedSessions.every((session) => session.maxComparisons === undefined)).toBe(true);
    expect(importedSessions.every((session) => session.status === "active")).toBe(true);
    expect(importedSessions.every((session) => session.distribution.levelCount === 10)).toBe(true);
    const importedUpgrade = importedSessions.find((session) => session.upgradedFromSessionId);
    expect(importedUpgrade).toBeDefined();
    const importedSource = importedSessions.find((session) => session.id === importedUpgrade?.upgradedFromSessionId);
    expect(importedSource).toBeDefined();
    expect(importedUpgrade?.id).not.toBe(upgraded.id);
    expect(importedUpgrade?.upgradedFromSessionId).not.toBe(source.id);
    const importedDerived = importedSessions.find((session) => session.derivedFromSessionId);
    expect(importedDerived?.derivedFromSessionId).not.toBe(source.id);
    expect(importedSessions.some((session) => session.id === importedDerived?.derivedFromSessionId)).toBe(true);
    expect(importedDerived?.tagFilter).toEqual({ source: "collection", match: "all", tags: ["经典"] });
    expect(derived.session.tagFilter?.tags).toEqual(["经典"]);
  });

  it("upgrades a frozen v4 database into local histories without copy amplification", async () => {
    const databaseName = `bangumi-resorter-v4-${crypto.randomUUID()}`;
    const fixture = legacyProjectFixture("v4");
    const legacy = new Dexie(databaseName);
    legacy.version(4).stores({
      profiles: "id, username, updatedAt",
      snapshots: "id, profileId, syncedAt",
      items: "[snapshotId+subjectId], snapshotId, subjectId, subjectType, collectionType, rate",
      sessions: "id, profileId, snapshotId, subjectType, status, updatedAt",
      sessionItems: "id, sessionId, subjectId, [sessionId+subjectId]",
      comparisons: "id, profileId, sessionId, subjectType, active, createdAt",
      models: "sessionId, version, updatedAt",
      meta: "key",
    });
    await legacy.open();
    await legacy.table("profiles").add(fixture.profile);
    await legacy.table("snapshots").add(fixture.snapshot);
    await legacy.table("items").bulkAdd(fixture.items);
    await legacy.table("sessions").bulkAdd(fixture.sessions);
    await legacy.table("sessionItems").bulkAdd(fixture.sessionItems);
    await legacy.table("comparisons").bulkAdd(fixture.comparisons);
    await legacy.table("models").bulkAdd(fixture.models);
    legacy.close();

    const migrated = new ResorterDatabase(databaseName);
    try {
      await migrated.open();
      const [sessions, comparisons, batches, modelCount] = await Promise.all([
        migrated.sessions.toArray(),
        migrated.comparisons.toArray(),
        migrated.importBatches.toArray(),
        migrated.models.count(),
      ]);
      expect(sessions).toHaveLength(3);
      expect(sessions.every((session) => session.comparisonHistoryMode === "local"
        && session.comparisonReusePolicy === "session" && session.status === "active")).toBe(true);
      expect(modelCount).toBe(0);
      expect(comparisons).toHaveLength(10);
      expect(comparisons.filter((entry) => entry.importBatchId)).toHaveLength(6);
      expect(comparisons.filter((entry) => entry.outcome === "skip")).toHaveLength(1);
      expect(batches).toHaveLength(6);
      expect(batches.reduce((sum, batch) => sum + batch.importedCount, 0)).toBe(6);
      expect(batches.reduce((sum, batch) => sum + batch.skippedCount, 0)).toBe(2);
      for (const session of sessions) {
        expect(comparisons.filter((entry) => entry.sessionId === session.id
          && entry.active && entry.outcome !== "skip")).toHaveLength(3);
      }
    } finally {
      migrated.close();
      await migrated.delete();
    }
  });

  it("localizes a legacy ExportV1 once and remaps all import provenance", async () => {
    const fixture = legacyProjectFixture("backup-v1");
    const payload: ExportV1 = {
      schemaVersion: 1,
      appVersion: "0.14.0",
      exportedAt: new Date(10).toISOString(),
      profile: fixture.profile,
      snapshots: [fixture.snapshot],
      items: fixture.items,
      sessions: fixture.sessions,
      sessionItems: fixture.sessionItems,
      comparisons: fixture.comparisons,
      models: fixture.models,
    };
    const importedProfile = await importProject(payload);
    const importedSessions = await db.sessions.where("profileId").equals(importedProfile.id).toArray();
    const importedComparisons = await db.comparisons.where("profileId").equals(importedProfile.id).toArray();
    const importedBatches = (await db.importBatches.toArray())
      .filter((batch) => batch.profileId === importedProfile.id);
    const sessionIds = new Set(importedSessions.map((session) => session.id));
    const comparisonIds = new Set(importedComparisons.map((entry) => entry.id));
    const batchIds = new Set(importedBatches.map((batch) => batch.id));

    expect(importedSessions.every((session) => session.comparisonHistoryMode === "local"
      && session.comparisonReusePolicy === "session" && session.status === "active")).toBe(true);
    expect(importedComparisons).toHaveLength(10);
    expect(importedBatches).toHaveLength(6);
    expect(await db.models.where("sessionId").anyOf([...sessionIds]).count()).toBe(0);
    for (const entry of importedComparisons.filter((candidate) => candidate.importBatchId)) {
      expect(batchIds.has(entry.importBatchId!)).toBe(true);
      expect(sessionIds.has(entry.importedFromSessionId!)).toBe(true);
      expect(comparisonIds.has(entry.importedFromComparisonId!)).toBe(true);
      expect(comparisonIds.has(entry.inheritedFromComparisonId!)).toBe(true);
    }
  });

  it("honors legacy session, snapshot, and profile visibility while localizing", async () => {
    const fixture = legacyProjectFixture("backup-policies");
    const secondSnapshotId = "backup-policies-snapshot-two";
    fixture.sessions[0].comparisonReusePolicy = "session";
    fixture.sessions[1].comparisonReusePolicy = "snapshot";
    fixture.sessions[2].comparisonReusePolicy = "profile";
    fixture.sessions[2].snapshotId = secondSnapshotId;
    const secondSnapshot = { ...fixture.snapshot, id: secondSnapshotId };
    const secondItems = fixture.items.map((entry) => ({ ...entry, snapshotId: secondSnapshotId }));
    const importedProfile = await importProject({
      schemaVersion: 1,
      appVersion: "0.14.0",
      exportedAt: new Date(10).toISOString(),
      profile: fixture.profile,
      snapshots: [fixture.snapshot, secondSnapshot],
      items: [...fixture.items, ...secondItems],
      sessions: fixture.sessions,
      sessionItems: fixture.sessionItems,
      comparisons: fixture.comparisons,
      models: fixture.models,
    });
    const importedSessions = await db.sessions.where("profileId").equals(importedProfile.id).toArray();
    const importedComparisons = await db.comparisons.where("profileId").equals(importedProfile.id).toArray();
    const evidenceByTitle = Object.fromEntries(importedSessions.map((session) => [
      session.title,
      importedComparisons.filter((entry) => entry.sessionId === session.id
        && entry.active && entry.outcome !== "skip").length,
    ]));
    expect(evidenceByTitle).toEqual({ "Legacy a": 1, "Legacy b": 2, "Legacy c": 3 });
  });

  it("imports one source once and remains independent from later source changes", async () => {
    const snapshotOneId = crypto.randomUUID();
    const firstItems = createDemoItems(snapshotOneId).slice(0, 2);
    const snapshotOne = await saveSnapshot({ username: "demo", nickname: "Demo" }, snapshotOneId, firstItems);
    const first = await createSession(snapshotOne, 2, [2], { preset: "uniform", levelCount: 10, weights: Array(10).fill(10) });
    const pair = { leftSubjectId: firstItems[0].subjectId, rightSubjectId: firstItems[1].subjectId };
    const sourceRecord: ComparisonRecord = {
      id: "source-record", profileId: "demo", sessionId: first.id, subjectType: 2,
      ...pair, outcome: "left", queryKind: "adaptive", acceptedCountAtAnswer: 1,
      active: true, createdAt: new Date(1000).toISOString(),
    };
    await db.comparisons.add(sourceRecord);
    const second = await createSession(snapshotOne, 2, [2], { preset: "uniform", levelCount: 10, weights: Array(10).fill(10) }, {
      sourceSessionId: first.id,
      expectedSourceVersion: first.modelVersion,
    });

    const snapshotTwoId = crypto.randomUUID();
    const secondItems = firstItems.map((entry) => ({ ...entry, snapshotId: snapshotTwoId }));
    const snapshotTwo = await saveSnapshot({ username: "demo", nickname: "Demo" }, snapshotTwoId, secondItems);
    const crossSnapshotPreview = await previewComparisonImport(first.id, {
      profileId: "demo", snapshotId: snapshotTwo.id, subjectType: 2,
      allowedSubjectIds: secondItems.map((entry) => entry.subjectId), targetVersion: 0,
    });
    expect(crossSnapshotPreview).toMatchObject({ crossSnapshot: true, importableCount: 1 });
    const preview = await previewComparisonImport(first.id, {
      targetSessionId: second.id, profileId: "demo", snapshotId: snapshotOne.id,
      subjectType: 2, allowedSubjectIds: [], targetVersion: 0,
    });
    expect(preview).toMatchObject({ crossSnapshot: false, importableCount: 0, duplicateOriginalCount: 1 });
    const imported = (await getSessionBundle(second.id))!.history[0];
    expect(imported).toMatchObject({
      sessionId: second.id,
      importedFromSessionId: first.id,
      importedFromComparisonId: sourceRecord.id,
      inheritedFromComparisonId: sourceRecord.id,
    });
    expect(await lastActiveResponse(second.id)).toBeUndefined();

    await db.comparisons.delete(sourceRecord.id);
    expect((await getSessionBundle(second.id))?.history.map((entry) => entry.id)).toEqual([imported.id]);
    await deleteSession(first.id);
    expect((await getSessionBundle(second.id))?.history.map((entry) => entry.id)).toEqual([imported.id]);
  });

  it("incrementally imports into an existing session with root-id idempotency", async () => {
    const snapshotId = crypto.randomUUID();
    const items = createDemoItems(snapshotId).slice(0, 3);
    const snapshot = await saveSnapshot({ username: "demo", nickname: "Demo" }, snapshotId, items);
    const source = await createSession(snapshot, 2, [2], { preset: "uniform", levelCount: 10, weights: Array(10).fill(10) });
    const target = await createSession(snapshot, 2, [2], { preset: "uniform", levelCount: 10, weights: Array(10).fill(10) });
    const original: ComparisonRecord = {
      id: "incremental-original", profileId: "demo", sessionId: source.id, subjectType: 2,
      leftSubjectId: items[0].subjectId, rightSubjectId: items[1].subjectId,
      outcome: "left", queryKind: "adaptive", acceptedCountAtAnswer: 1, active: true,
      createdAt: new Date(1).toISOString(),
    };
    const calibration: ComparisonRecord = {
      ...original, id: "incremental-calibration", leftSubjectId: items[1].subjectId,
      rightSubjectId: items[0].subjectId, outcome: "right", queryKind: "calibration",
      calibrationOfComparisonId: original.id, acceptedCountAtAnswer: 2, createdAt: new Date(2).toISOString(),
    };
    const skipped: ComparisonRecord = {
      ...original, id: "incremental-skip", outcome: "skip", acceptedCountAtAnswer: 2,
      createdAt: new Date(3).toISOString(),
    };
    await db.comparisons.bulkAdd([original, calibration, skipped]);
    const preview = await previewComparisonImport(source.id, {
      targetSessionId: target.id, profileId: "demo", snapshotId, subjectType: 2,
      allowedSubjectIds: items.map((entry) => entry.subjectId), targetVersion: 0,
    });
    expect(preview).toMatchObject({ importableCount: 2, skippedCount: 1, invalidCalibrationCount: 0 });
    const fit = fitModel(items.map(({ subjectId, rate }) => ({ subjectId, rate })), [
      { leftSubjectId: original.leftSubjectId, rightSubjectId: original.rightSubjectId, outcome: "left" },
      { leftSubjectId: calibration.leftSubjectId, rightSubjectId: calibration.rightSubjectId, outcome: "right" },
    ]);
    const first = await commitComparisonImport(
      target.id, source.id, 0, 0, toModelState(target.id, 1, fit),
    );
    expect(first.records).toHaveLength(2);
    expect(first.records.map((entry) => entry.acceptedCountAtAnswer)).toEqual([1, 2]);
    const importedOriginal = first.records.find((entry) => entry.queryKind !== "calibration")!;
    expect(first.records.find((entry) => entry.queryKind === "calibration")?.calibrationOfComparisonId)
      .toBe(importedOriginal.id);

    const secondPreview = await previewComparisonImport(source.id, {
      targetSessionId: target.id, profileId: "demo", snapshotId, subjectType: 2,
      allowedSubjectIds: items.map((entry) => entry.subjectId), targetVersion: 1,
    });
    expect(secondPreview).toMatchObject({ importableCount: 0, duplicateOriginalCount: 2 });
    await expect(commitComparisonImport(target.id, source.id, 0, 0, toModelState(target.id, 1, fit)))
      .rejects.toThrow(/目标会话已经更新/);

    const added: ComparisonRecord = {
      ...original, id: "incremental-added", leftSubjectId: items[1].subjectId,
      rightSubjectId: items[2].subjectId, outcome: "right", acceptedCountAtAnswer: 3,
      createdAt: new Date(4).toISOString(),
    };
    await db.comparisons.add(added);
    await db.sessions.update(source.id, { modelVersion: 1 });
    const nextFit = fitModel(items.map(({ subjectId, rate }) => ({ subjectId, rate })), [
      { leftSubjectId: original.leftSubjectId, rightSubjectId: original.rightSubjectId, outcome: "left" },
      { leftSubjectId: calibration.leftSubjectId, rightSubjectId: calibration.rightSubjectId, outcome: "right" },
      { leftSubjectId: added.leftSubjectId, rightSubjectId: added.rightSubjectId, outcome: "right" },
    ]);
    const nextModel = toModelState(target.id, 2, nextFit);
    const countsBeforeFailure = {
      records: await db.comparisons.where("sessionId").equals(target.id).count(),
      batches: await db.importBatches.where("targetSessionId").equals(target.id).count(),
    };
    await expect(commitComparisonImport(target.id, source.id, 1, 0, nextModel))
      .rejects.toThrow(/来源会话已经更新/);
    await expect(commitComparisonImport(target.id, source.id, 1, 1, { ...nextModel, acceptedComparisons: 99 }))
      .rejects.toThrow(/重算模型.*不一致/);
    expect(await db.comparisons.where("sessionId").equals(target.id).count()).toBe(countsBeforeFailure.records);
    expect(await db.importBatches.where("targetSessionId").equals(target.id).count()).toBe(countsBeforeFailure.batches);
    expect((await db.sessions.get(target.id))?.modelVersion).toBe(1);
    const second = await commitComparisonImport(
      target.id, source.id, 1, 1, nextModel,
    );
    expect(second.records).toHaveLength(1);
    expect(second.records[0]).toMatchObject({ inheritedFromComparisonId: added.id, acceptedCountAtAnswer: 3 });
  });

  it("imports in source sequence, preserves repeated pairs, and rejects orphan calibrations", async () => {
    const snapshotId = crypto.randomUUID();
    const items = createDemoItems(snapshotId).slice(0, 3);
    const snapshot = await saveSnapshot({ username: "demo", nickname: "Demo" }, snapshotId, items);
    const source = await createSession(snapshot, 2, [2], { preset: "uniform", levelCount: 10, weights: Array(10).fill(10) });
    const original: ComparisonRecord = {
      id: "ordered-original", profileId: "demo", sessionId: source.id, subjectType: 2,
      leftSubjectId: items[0].subjectId, rightSubjectId: items[1].subjectId,
      outcome: "left", queryKind: "adaptive", acceptedCountAtAnswer: 1, active: true,
      createdAt: new Date(1000).toISOString(),
    };
    const repeated: ComparisonRecord = {
      ...original, id: "ordered-repeat", outcome: "right", queryKind: "manual",
      acceptedCountAtAnswer: 2, createdAt: new Date(2000).toISOString(),
    };
    const calibration: ComparisonRecord = {
      ...original, id: "ordered-calibration", leftSubjectId: items[1].subjectId,
      rightSubjectId: items[0].subjectId, outcome: "right", queryKind: "calibration",
      calibrationOfComparisonId: original.id, acceptedCountAtAnswer: 3,
      createdAt: new Date(3000).toISOString(),
    };
    const orphan: ComparisonRecord = {
      ...calibration, id: "ordered-orphan", calibrationOfComparisonId: "missing-original",
      acceptedCountAtAnswer: 4, createdAt: new Date(4000).toISOString(),
    };
    await db.comparisons.bulkAdd([calibration, orphan, repeated, original]);

    const preview = await previewComparisonImport(source.id, {
      profileId: "demo", snapshotId, subjectType: 2,
      allowedSubjectIds: items.map((entry) => entry.subjectId), targetVersion: 0,
    });
    expect(preview).toMatchObject({
      importableCount: 3,
      duplicatePairCount: 2,
      invalidCalibrationCount: 1,
    });
    const target = await createSession(snapshot, 2, [2], { preset: "uniform", levelCount: 10, weights: Array(10).fill(10) }, {
      sourceSessionId: source.id,
      expectedSourceVersion: source.modelVersion,
    });
    const imported = (await getSessionBundle(target.id))!.history;
    expect(imported.map((entry) => entry.importedFromComparisonId)).toEqual([
      original.id, repeated.id, calibration.id,
    ]);
    expect(imported.map((entry) => entry.acceptedCountAtAnswer)).toEqual([1, 2, 3]);
    expect(imported[2].calibrationOfComparisonId).toBe(imported[0].id);
    expect(imported.filter((entry) => entry.leftSubjectId === original.leftSubjectId
      && entry.rightSubjectId === original.rightSubjectId)).toHaveLength(2);
  });

  it("allows a deleted root to be imported again and appends after inactive local sequence", async () => {
    const snapshotId = crypto.randomUUID();
    const items = createDemoItems(snapshotId).slice(0, 2);
    const snapshot = await saveSnapshot({ username: "demo", nickname: "Demo" }, snapshotId, items);
    const source = await createSession(snapshot, 2, [2], { preset: "uniform", levelCount: 10, weights: Array(10).fill(10) });
    const target = await createSession(snapshot, 2, [2], { preset: "uniform", levelCount: 10, weights: Array(10).fill(10) });
    const original: ComparisonRecord = {
      id: "reimport-original", profileId: "demo", sessionId: source.id, subjectType: 2,
      leftSubjectId: items[0].subjectId, rightSubjectId: items[1].subjectId,
      outcome: "left", queryKind: "adaptive", acceptedCountAtAnswer: 1, active: true,
      createdAt: new Date(1000).toISOString(),
    };
    const inactiveCopy: ComparisonRecord = {
      ...original, id: "reimport-inactive", sessionId: target.id,
      inheritedFromComparisonId: original.id, importedFromComparisonId: original.id,
      importedFromSessionId: source.id, importBatchId: "old-batch",
      acceptedCountAtAnswer: 7, active: false,
    };
    await db.comparisons.bulkAdd([original, inactiveCopy]);
    const preview = await previewComparisonImport(source.id, {
      targetSessionId: target.id, profileId: "demo", snapshotId,
      subjectType: 2, allowedSubjectIds: [], targetVersion: 0,
    });
    expect(preview).toMatchObject({ importableCount: 1, duplicateOriginalCount: 0 });
    expect((await createSession(snapshot, 2, [2], { preset: "uniform", levelCount: 10, weights: Array(10).fill(10) }, {
      sourceSessionId: source.id,
    })).comparisonHistoryMode).toBe("local");

    const fit = fitModel(items.map(({ subjectId, rate }) => ({ subjectId, rate })), [
      { leftSubjectId: original.leftSubjectId, rightSubjectId: original.rightSubjectId, outcome: "left" },
    ]);
    const result = await commitComparisonImport(target.id, source.id, 0, 0, toModelState(target.id, 1, fit));
    expect(result.records).toHaveLength(1);
    expect(result.records[0].acceptedCountAtAnswer).toBe(8);
  });

  it("preserves direct and root provenance across multiple import generations", async () => {
    const snapshotId = crypto.randomUUID();
    const items = createDemoItems(snapshotId).slice(0, 2);
    const snapshot = await saveSnapshot({ username: "demo", nickname: "Demo" }, snapshotId, items);
    const root = await createSession(snapshot, 2, [2], { preset: "uniform", levelCount: 10, weights: Array(10).fill(10) });
    const original: ComparisonRecord = {
      id: "root-generation", profileId: "demo", sessionId: root.id, subjectType: 2,
      leftSubjectId: items[0].subjectId, rightSubjectId: items[1].subjectId,
      outcome: "left", queryKind: "adaptive", acceptedCountAtAnswer: 1, active: true,
      createdAt: new Date(1000).toISOString(),
    };
    await db.comparisons.add(original);
    const middle = await createSession(snapshot, 2, [2], { preset: "uniform", levelCount: 10, weights: Array(10).fill(10) }, {
      sourceSessionId: root.id,
    });
    const middleCopy = (await getSessionBundle(middle.id))!.history[0];
    const leaf = await createSession(snapshot, 2, [2], { preset: "uniform", levelCount: 10, weights: Array(10).fill(10) }, {
      sourceSessionId: middle.id,
    });
    const leafCopy = (await getSessionBundle(leaf.id))!.history[0];
    expect(leafCopy).toMatchObject({
      importedFromSessionId: middle.id,
      importedFromComparisonId: middleCopy.id,
      inheritedFromComparisonId: original.id,
      sourceCreatedAt: original.createdAt,
    });
  });

  it("round-trips local import batches without materializing the history again", async () => {
    const snapshotId = crypto.randomUUID();
    const items = createDemoItems(snapshotId).slice(0, 2);
    const snapshot = await saveSnapshot({ username: "demo", nickname: "Demo" }, snapshotId, items);
    const source = await createSession(snapshot, 2, [2], { preset: "uniform", levelCount: 10, weights: Array(10).fill(10) });
    const original: ComparisonRecord = {
      id: "backup-local-original", profileId: "demo", sessionId: source.id, subjectType: 2,
      leftSubjectId: items[0].subjectId, rightSubjectId: items[1].subjectId,
      outcome: "left", queryKind: "adaptive", acceptedCountAtAnswer: 1, active: true,
      createdAt: new Date(1000).toISOString(),
    };
    const calibration: ComparisonRecord = {
      ...original, id: "backup-local-calibration", leftSubjectId: items[1].subjectId,
      rightSubjectId: items[0].subjectId, outcome: "right", queryKind: "calibration",
      calibrationOfComparisonId: original.id, acceptedCountAtAnswer: 2,
      createdAt: new Date(2000).toISOString(),
    };
    await db.comparisons.bulkAdd([original, calibration]);
    await createSession(snapshot, 2, [2], { preset: "uniform", levelCount: 10, weights: Array(10).fill(10) }, {
      sourceSessionId: source.id,
    });

    const firstImportedProfile = await importProject(await exportProject("demo"));
    const firstSessions = await db.sessions.where("profileId").equals(firstImportedProfile.id).toArray();
    const firstComparisons = await db.comparisons.where("profileId").equals(firstImportedProfile.id).toArray();
    const firstBatches = (await db.importBatches.toArray())
      .filter((batch) => batch.profileId === firstImportedProfile.id);
    expect(firstSessions).toHaveLength(2);
    expect(firstComparisons).toHaveLength(4);
    expect(firstBatches).toHaveLength(1);
    const importedCopies = firstComparisons.filter((entry) => entry.importBatchId);
    const importedOriginal = importedCopies.find((entry) => entry.queryKind !== "calibration")!;
    const importedCalibration = importedCopies.find((entry) => entry.queryKind === "calibration")!;
    expect(importedCalibration.calibrationOfComparisonId).toBe(importedOriginal.id);
    expect(firstComparisons.some((entry) => entry.id === importedOriginal.importedFromComparisonId)).toBe(true);
    expect(firstComparisons.some((entry) => entry.id === importedOriginal.inheritedFromComparisonId)).toBe(true);

    const secondImportedProfile = await importProject(await exportProject(firstImportedProfile.id));
    expect(await db.sessions.where("profileId").equals(secondImportedProfile.id).count()).toBe(2);
    expect(await db.comparisons.where("profileId").equals(secondImportedProfile.id).count()).toBe(4);
    expect((await db.importBatches.toArray())
      .filter((batch) => batch.profileId === secondImportedProfile.id)).toHaveLength(1);
  });

  it("derives an immutable tag-scoped child and inherits only comparisons inside the new scope", async () => {
    const snapshotId = crypto.randomUUID();
    const items = createDemoItems(snapshotId).slice(0, 4);
    const snapshot = await saveSnapshot({ username: "demo", nickname: "Demo" }, snapshotId, items);
    const source = await createSession(snapshot, 2, [2], { preset: "uniform", levelCount: 5, weights: Array(5).fill(20) });
    const records: ComparisonRecord[] = [
      {
        id: "tag-kept", profileId: "demo", sessionId: source.id, subjectType: 2,
        leftSubjectId: items[0].subjectId, rightSubjectId: items[3].subjectId,
        outcome: "left", queryKind: "adaptive", acceptedCountAtAnswer: 1, active: true,
        createdAt: new Date(1).toISOString(),
      },
      {
        id: "tag-calibration", profileId: "demo", sessionId: source.id, subjectType: 2,
        leftSubjectId: items[3].subjectId, rightSubjectId: items[0].subjectId,
        outcome: "right", queryKind: "calibration", calibrationOfComparisonId: "tag-kept",
        acceptedCountAtAnswer: 2, active: true, createdAt: new Date(2).toISOString(),
      },
      {
        id: "tag-orphan-calibration", profileId: "demo", sessionId: source.id, subjectType: 2,
        leftSubjectId: items[3].subjectId, rightSubjectId: items[0].subjectId,
        outcome: "right", queryKind: "calibration", calibrationOfComparisonId: "missing-tag-original",
        acceptedCountAtAnswer: 3, active: true, createdAt: new Date(2.5).toISOString(),
      },
      {
        id: "tag-dropped", profileId: "demo", sessionId: source.id, subjectType: 2,
        leftSubjectId: items[0].subjectId, rightSubjectId: items[1].subjectId,
        outcome: "left", queryKind: "manual", acceptedCountAtAnswer: 3, active: true,
        createdAt: new Date(3).toISOString(),
      },
      {
        id: "tag-skip", profileId: "demo", sessionId: source.id, subjectType: 2,
        leftSubjectId: items[3].subjectId, rightSubjectId: items[2].subjectId,
        outcome: "skip", queryKind: "adaptive", acceptedCountAtAnswer: 3, active: true,
        createdAt: new Date(4).toISOString(),
      },
    ];
    await db.comparisons.bulkAdd(records);
    const tagFilter = { source: "collection" as const, match: "all" as const, tags: ["经典"] };

    const preview = await previewSessionTagDerivation(source.id, tagFilter);
    expect(preview).toMatchObject({
      previousItemCount: 4,
      currentItemCount: 2,
      addedSubjectIds: [],
      removedSubjectIds: [items[1].subjectId, items[2].subjectId],
      inheritedComparisonCount: 2,
      droppedComparisonCount: 2,
    });
    const derived = await deriveSessionWithTagFilter(source.id, tagFilter);
    expect(derived.preview).toEqual(preview);
    expect(derived.session).toMatchObject({
      snapshotId,
      derivedFromSessionId: source.id,
      comparisonReusePolicy: "session",
      modelVersion: 0,
      status: "active",
      tagFilter,
    });
    expect(derived.session.distribution.levelCount).toBe(5);
    expect((await getSessionBundle(source.id))?.items).toHaveLength(4);
    const bundle = await getSessionBundle(derived.session.id);
    expect(bundle?.items.map((entry) => entry.subjectId).sort((a, b) => a - b)).toEqual([items[0].subjectId, items[3].subjectId]);
    expect(bundle?.history).toHaveLength(2);
    const inheritedCalibration = bundle?.history.find((entry) => entry.queryKind === "calibration");
    const inheritedOriginal = bundle?.history.find((entry) => entry.queryKind === "adaptive");
    expect(inheritedCalibration?.calibrationOfComparisonId).toBe(inheritedOriginal?.id);
    expect(inheritedOriginal?.id).not.toBe("tag-kept");
    expect(inheritedOriginal?.inheritedFromComparisonId).toBe("tag-kept");
    expect(inheritedCalibration?.inheritedFromComparisonId).toBe("tag-calibration");

    // The source remains local and never observes materialized child copies.
    expect((await getSessionBundle(source.id))?.history.map((entry) => entry.id).sort())
      .toEqual(records.map((entry) => entry.id).sort());

    // Editing child provenance cannot make it flow back into the source.
    await db.comparisons.update(inheritedOriginal!.id, { inheritedFromComparisonId: undefined });
    expect((await getSessionBundle(source.id))?.history.map((entry) => entry.id).sort())
      .toEqual(records.map((entry) => entry.id).sort());

    // A genuinely new judgment made in the child is also isolated from source.
    const childOnly: ComparisonRecord = {
      id: "tag-child-new", profileId: "demo", sessionId: derived.session.id, subjectType: 2,
      leftSubjectId: items[3].subjectId, rightSubjectId: items[0].subjectId,
      outcome: "left", queryKind: "manual", acceptedCountAtAnswer: 3, active: true,
      createdAt: new Date(5).toISOString(),
    };
    await db.comparisons.add(childOnly);
    expect((await getSessionBundle(source.id))?.history.map((entry) => entry.id).sort())
      .toEqual(records.map((entry) => entry.id).sort());

    const broadened = await previewSessionTagDerivation(derived.session.id, undefined);
    expect(broadened).toMatchObject({ previousItemCount: 2, currentItemCount: 4, inheritedComparisonCount: 3, droppedComparisonCount: 0 });
    expect(broadened.addedSubjectIds).toEqual([items[1].subjectId, items[2].subjectId]);
    await expect(previewSessionTagDerivation(source.id, undefined)).rejects.toThrow(/没有变化/);
    await expect(previewSessionTagDerivation(source.id, { ...tagFilter, tags: ["不存在"] })).rejects.toThrow(/不足两个/);
  });

  it("forks a session onto a newer snapshot and inherits only valid comparisons", async () => {
    const firstSnapshotId = crypto.randomUUID();
    const firstItems = createDemoItems(firstSnapshotId).slice(0, 3);
    const firstSnapshot = await saveSnapshot({ username: "demo", nickname: "Demo" }, firstSnapshotId, firstItems);
    const source = await createSession(firstSnapshot, 2, [2], { preset: "preserve", levelCount: 5, weights: Array(5).fill(20) });
    const records: ComparisonRecord[] = [
      {
        id: "kept", profileId: "demo", sessionId: source.id, subjectType: 2,
        leftSubjectId: firstItems[0].subjectId, rightSubjectId: firstItems[1].subjectId,
        outcome: "left", queryKind: "adaptive", acceptedCountAtAnswer: 1, active: true,
        createdAt: new Date(1).toISOString(),
      },
      {
        id: "removed-item", profileId: "demo", sessionId: source.id, subjectType: 2,
        leftSubjectId: firstItems[1].subjectId, rightSubjectId: firstItems[2].subjectId,
        outcome: "right", queryKind: "manual", acceptedCountAtAnswer: 2, active: true,
        createdAt: new Date(2).toISOString(),
      },
      {
        id: "calibration", profileId: "demo", sessionId: source.id, subjectType: 2,
        leftSubjectId: firstItems[1].subjectId, rightSubjectId: firstItems[0].subjectId,
        outcome: "right", queryKind: "calibration", calibrationOfComparisonId: "kept",
        acceptedCountAtAnswer: 3, active: true, createdAt: new Date(3).toISOString(),
      },
      {
        id: "skipped", profileId: "demo", sessionId: source.id, subjectType: 2,
        leftSubjectId: firstItems[0].subjectId, rightSubjectId: firstItems[2].subjectId,
        outcome: "skip", queryKind: "adaptive", acceptedCountAtAnswer: 3, active: true,
        createdAt: new Date(4).toISOString(),
      },
    ];
    await db.comparisons.bulkAdd(records);

    const secondSnapshotId = crypto.randomUUID();
    const added = { ...firstItems[2], snapshotId: secondSnapshotId, subjectId: 999999, name: "New item", rate: 7 };
    const secondItems = [
      { ...firstItems[0], snapshotId: secondSnapshotId, rate: firstItems[0].rate - 1 },
      { ...firstItems[1], snapshotId: secondSnapshotId },
      added,
    ];
    const secondSnapshot = await saveSnapshot({ username: "demo", nickname: "Demo" }, secondSnapshotId, secondItems);

    const preview = await previewSessionUpgrade(source.id, secondSnapshot.id);
    expect(preview).toMatchObject({
      previousItemCount: 3,
      currentItemCount: 3,
      addedSubjectIds: [added.subjectId],
      removedSubjectIds: [firstItems[2].subjectId],
      ratingChangedSubjectIds: [firstItems[0].subjectId],
      inheritedComparisonCount: 2,
      droppedComparisonCount: 1,
    });

    const upgraded = await upgradeSessionToSnapshot(source.id, secondSnapshot.id);
    expect(upgraded.preview).toEqual(preview);
    expect(upgraded.session).toMatchObject({
      snapshotId: secondSnapshot.id,
      upgradedFromSessionId: source.id,
      comparisonReusePolicy: "session",
      modelVersion: 0,
      status: "active",
    });
    expect(upgraded.session.distribution.levelCount).toBe(5);
    expect(await db.sessions.get(source.id)).toBeDefined();
    const bundle = await getSessionBundle(upgraded.session.id);
    expect(bundle?.items.map((entry) => entry.subjectId).sort((a, b) => a - b))
      .toEqual([firstItems[0].subjectId, firstItems[1].subjectId, added.subjectId].sort((a, b) => a - b));
    expect(bundle?.history).toHaveLength(2);
    expect(bundle?.history.every((entry) => entry.sessionId === upgraded.session.id)).toBe(true);
    expect(bundle?.history.map((entry) => entry.acceptedCountAtAnswer).sort((a, b) => a - b)).toEqual([1, 2]);
    const inheritedCalibration = bundle?.history.find((entry) => entry.queryKind === "calibration");
    const inheritedOriginal = bundle?.history.find((entry) => entry.queryKind === "adaptive");
    expect(inheritedCalibration?.calibrationOfComparisonId).toBe(inheritedOriginal?.id);
    expect(inheritedOriginal?.id).not.toBe("kept");
    expect(inheritedOriginal?.inheritedFromComparisonId).toBe("kept");
    expect(inheritedCalibration?.inheritedFromComparisonId).toBe("calibration");
    await expect(previewSessionUpgrade(upgraded.session.id, secondSnapshot.id)).rejects.toThrow(/已经使用当前收藏/);
  });

  it("reapplies the stored personal-tag rule when upgrading to a newer snapshot", async () => {
    const firstSnapshotId = crypto.randomUUID();
    const firstItems = createDemoItems(firstSnapshotId).slice(0, 4);
    const firstSnapshot = await saveSnapshot({ username: "demo", nickname: "Demo" }, firstSnapshotId, firstItems);
    const tagFilter = { source: "collection" as const, match: "all" as const, tags: ["经典"] };
    const source = await createSession(
      firstSnapshot,
      2,
      [2],
      { preset: "uniform", levelCount: 10, weights: Array(10).fill(10) },
      "quick",
      "snapshot",
      tagFilter,
    );
    expect(source.comparisonReusePolicy).toBe("session");
    expect((await getSessionBundle(source.id))?.items.map((entry) => entry.subjectId)).toEqual([firstItems[0].subjectId, firstItems[3].subjectId]);

    const secondSnapshotId = crypto.randomUUID();
    const added = { ...firstItems[1], snapshotId: secondSnapshotId, subjectId: 999999, name: "New classic", tags: ["demo", "经典"] };
    const secondItems = [
      { ...firstItems[0], snapshotId: secondSnapshotId, tags: ["demo"] },
      { ...firstItems[1], snapshotId: secondSnapshotId },
      { ...firstItems[3], snapshotId: secondSnapshotId },
      added,
    ];
    const secondSnapshot = await saveSnapshot({ username: "demo", nickname: "Demo" }, secondSnapshotId, secondItems);
    const preview = await previewSessionUpgrade(source.id, secondSnapshot.id);
    expect(preview).toMatchObject({
      previousItemCount: 2,
      currentItemCount: 2,
      addedSubjectIds: [added.subjectId],
      removedSubjectIds: [firstItems[0].subjectId],
    });
    const upgraded = await upgradeSessionToSnapshot(source.id, secondSnapshot.id);
    expect(upgraded.session.tagFilter).toEqual(tagFilter);
    expect((await getSessionBundle(upgraded.session.id))?.items.map((entry) => entry.subjectId).sort((a, b) => a - b))
      .toEqual([firstItems[3].subjectId, added.subjectId].sort((a, b) => a - b));
  });

  it("remaps calibration and inheritance references when importing a backup", async () => {
    const snapshotId = crypto.randomUUID();
    const items = createDemoItems(snapshotId).slice(0, 2);
    const snapshot = await saveSnapshot({ username: "demo", nickname: "Demo" }, snapshotId, items);
    const session = await createSession(snapshot, 2, [2], { preset: "uniform", levelCount: 10, weights: Array(10).fill(10) });
    const original: ComparisonRecord = {
      id: "original", profileId: "demo", sessionId: session.id, subjectType: 2,
      leftSubjectId: items[0].subjectId, rightSubjectId: items[1].subjectId, outcome: "left",
      queryKind: "adaptive", acceptedCountAtAnswer: 1, active: true, createdAt: new Date(0).toISOString(),
    };
    const calibration: ComparisonRecord = {
      ...original, id: "calibration", leftSubjectId: original.rightSubjectId,
      rightSubjectId: original.leftSubjectId, outcome: "right", queryKind: "calibration",
      calibrationOfComparisonId: original.id, acceptedCountAtAnswer: 2, createdAt: new Date(1000).toISOString(),
    };
    const inherited: ComparisonRecord = {
      ...original, id: "inherited", inheritedFromComparisonId: original.id,
      acceptedCountAtAnswer: 3, createdAt: new Date(2000).toISOString(),
    };
    const orphanedInheritance: ComparisonRecord = {
      ...original, id: "orphaned-inherited", inheritedFromComparisonId: "deleted-source",
      acceptedCountAtAnswer: 4, createdAt: new Date(3000).toISOString(),
    };
    await db.comparisons.bulkAdd([original, calibration, inherited, orphanedInheritance]);
    await importProject(await exportProject("demo"));
    const imported = (await db.comparisons.toArray()).filter((entry) => entry.profileId !== "demo");
    const importedCalibration = imported.find((entry) => entry.queryKind === "calibration")!;
    const importedOriginal = imported.find((entry) =>
      entry.queryKind === "adaptive" && !entry.inheritedFromComparisonId)!;
    expect(importedCalibration.calibrationOfComparisonId).toBe(importedOriginal.id);
    expect(importedCalibration.calibrationOfComparisonId).not.toBe("original");
    const importedInherited = imported.find((entry) => entry.createdAt === inherited.createdAt)!;
    expect(importedInherited.inheritedFromComparisonId).toBe(importedOriginal.id);
    expect(importedInherited.inheritedFromComparisonId).not.toBe("original");
    expect(imported.find((entry) => entry.createdAt === orphanedInheritance.createdAt)
      ?.inheritedFromComparisonId).toBe("deleted-source");
  });

  it("atomically versions distribution-dependent model diagnostics", async () => {
    const snapshotId = crypto.randomUUID();
    const items = createDemoItems(snapshotId).slice(0, 2);
    const snapshot = await saveSnapshot({ username: "demo", nickname: "Demo" }, snapshotId, items);
    const session = await createSession(snapshot, 2, [2], { preset: "uniform", levelCount: 10, weights: Array(10).fill(10) });
    const fit = fitModel(items.map(({ subjectId, rate }) => ({ subjectId, rate })), []);
    const initial = toModelState(session.id, 0, fit);
    await initializeModel(session.id, initial);
    const pair = { leftSubjectId: items[0].subjectId, rightSubjectId: items[1].subjectId };
    const answeredFit = fitModel(items.map(({ subjectId, rate }) => ({ subjectId, rate })), [{ ...pair, outcome: "left" }]);
    const answered = toModelState(session.id, 1, answeredFit, initial.initialMeanUncertainty);
    await commitResponse(session.id, 0, pair, "left", answered);
    const next = toModelState(session.id, 2, answeredFit, initial.initialMeanUncertainty);
    const distribution = { preset: "reverse-j" as const, levelCount: 5, weights: [89, 6, 2, 1.5, 1.5] };
    await commitSessionDistribution(session.id, 1, distribution, next);
    await expect(commitSessionDistribution(session.id, 1, distribution, next)).rejects.toThrow(/其他页面更新/);
    const bundle = await getSessionBundle(session.id);
    expect(bundle?.session.modelVersion).toBe(2);
    expect(bundle?.session.distribution.preset).toBe("reverse-j");
    expect(bundle?.session.distribution.levelCount).toBe(5);
    expect(bundle?.history).toHaveLength(1);
    expect(bundle?.model?.version).toBe(2);
  });

  it("atomically changes inference mode without replacing session history", async () => {
    const snapshotId = crypto.randomUUID();
    const items = createDemoItems(snapshotId).slice(0, 2);
    const snapshot = await saveSnapshot({ username: "demo", nickname: "Demo" }, snapshotId, items);
    const session = await createSession(snapshot, 2, [2], { preset: "uniform", levelCount: 10, weights: Array(10).fill(10) });
    const fit = fitModel(items.map(({ subjectId, rate }) => ({ subjectId, rate })), []);
    const initial = toModelState(session.id, 0, fit);
    await initializeModel(session.id, initial);
    const next = toModelState(session.id, 1, fit, initial.initialMeanUncertainty);

    await commitSessionBudgetMode(session.id, 0, "thorough", next);
    await expect(commitSessionBudgetMode(session.id, 0, "standard", next)).rejects.toThrow(/其他页面更新/);

    const bundle = await getSessionBundle(session.id);
    expect(bundle?.session.id).toBe(session.id);
    expect(bundle?.session.budgetMode).toBe("thorough");
    expect(bundle?.session.modelVersion).toBe(1);
    expect(bundle?.history).toHaveLength(0);
    expect(bundle?.model?.version).toBe(1);
  });
});
