import "fake-indexeddb/auto";
import Dexie from "dexie";
import { beforeEach, describe, expect, it } from "vitest";
import { createDemoItems } from "../lib/demo";
import { fitModel, toModelState } from "../lib/ranking/engine";
import {
  commitBackupImport, commitComparisonDeletion, commitComparisonImport, commitLegacyCloneDeletion, commitResponse, commitSessionBudgetMode, commitSessionDistribution, commitSnapshotDeletion, createSession, db, deleteSession, deriveSessionWithTagFilter, exportProject, getActiveSnapshot, getSessionBundle,
  initializeModel, lastActiveResponse, listBackupImportHistory, listLocalProjects, previewBackupImport, previewComparisonImport, previewLegacyCloneDeletion, previewSessionTagDerivation, previewSessionUpgrade, previewSnapshotDeletion, saveSnapshot, setActiveSnapshot, upgradeSessionToSnapshot,
  ResorterDatabase,
} from "../lib/db";
import { readBackup, validateBackupPayload } from "../lib/export";
import type { BackupImportAudit, ComparisonRecord, DistributionConfig, ExportV1, ModelState, SessionItem, SortingSession, ValidatedBackup } from "../lib/types";

function validatedBackup(payload: ExportV1, digest = crypto.randomUUID()): ValidatedBackup {
  const validated = validateBackupPayload(structuredClone(payload));
  return { ...validated, digest, fileName: "backup.json", byteSize: JSON.stringify(payload).length };
}

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

function exportFixturePayload(prefix: string): ExportV1 {
  const fixture = legacyProjectFixture(prefix);
  return {
    schemaVersion: 1,
    appVersion: "0.16.0",
    exportedAt: new Date(10).toISOString(),
    profile: fixture.profile,
    snapshots: [fixture.snapshot],
    items: fixture.items,
    sessions: fixture.sessions,
    sessionItems: fixture.sessionItems,
    comparisons: fixture.comparisons,
    models: fixture.models,
  };
}

function retargetBackupAccount(payload: ExportV1, username: string): ExportV1 {
  const copy = structuredClone(payload);
  const profileId = username.toLowerCase();
  copy.profile = { ...copy.profile, id: profileId, username };
  copy.snapshots = copy.snapshots.map((entry) => ({ ...entry, profileId, username }));
  copy.sessions = copy.sessions.map((entry) => ({ ...entry, profileId }));
  copy.comparisons = copy.comparisons.map((entry) => ({ ...entry, profileId }));
  copy.importBatches = copy.importBatches?.map((entry) => ({ ...entry, profileId }));
  return copy;
}

function legacyMigrationAudit(profileId: string, username: string, snapshotIds: string[], sessionIds: string[]): BackupImportAudit {
  return {
    id: crypto.randomUUID(), profileId, mode: "legacy-clone-migration", sourceUsername: username,
    createdAt: new Date().toISOString(), selectedSessionIds: [], dependencySessionIds: [],
    importedSnapshotIds: snapshotIds, importedSessionIds: sessionIds, importedComparisonIds: [],
    importedBatchIds: [], importedModelSessionIds: [], reusedSessionIds: [], conflictSessionIds: [],
    importedComparisonCount: 0, reusedSessionCount: 0, conflictSessionCount: 0,
    warnings: [], idMappings: [], sessionFingerprints: [], legacyCloneProfileIds: [],
    legacySnapshotIds: snapshotIds, legacySessionIds: sessionIds,
  };
}

describe("ExportV1 validation", () => {
  it("rejects malformed structure, duplicate IDs, and broken required references", () => {
    const payload = exportFixturePayload("validation");
    expect(() => validateBackupPayload({ ...payload, schemaVersion: 2 })).toThrow(/版本/);
    const missing = structuredClone(payload) as Partial<ExportV1>;
    delete (missing.profile as { username?: string }).username;
    expect(() => validateBackupPayload(missing)).toThrow(/profile\.username/);

    const duplicate = structuredClone(payload);
    duplicate.sessions.push({ ...duplicate.sessions[0] });
    expect(() => validateBackupPayload(duplicate)).toThrow(/重复/);

    const broken = structuredClone(payload);
    broken.comparisons[0].leftSubjectId = 999999999;
    expect(() => validateBackupPayload(broken)).toThrow(/作品范围/);
  });

  it("keeps explicitly permitted historical dangling references as warnings", () => {
    const payload = exportFixturePayload("dangling");
    payload.sessions[0].upgradedFromSessionId = "deleted-session";
    payload.comparisons[0].inheritedFromComparisonId = "deleted-comparison";
    const validated = validateBackupPayload(payload);
    expect(validated.warnings.join(" ")).toMatch(/已删除来源会话/);
    expect(validated.warnings.join(" ")).toMatch(/已删除或孤立判断/);
    expect(validated.payload.comparisons[0].inheritedFromComparisonId).toBe("deleted-comparison");
  });

  it("normalizes null legacy metadata fields without weakening relation validation", () => {
    const payload = exportFixturePayload("nullable-metadata");
    const legacy = payload as unknown as {
      profile: { nickname: null; avatar: null };
      items: Array<{ date: null; platform: null; image: null; updatedAt: null }>;
    };
    legacy.profile.nickname = null;
    legacy.profile.avatar = null;
    legacy.items[0].date = null;
    legacy.items[0].platform = null;
    legacy.items[0].image = null;
    legacy.items[0].updatedAt = null;

    const validated = validateBackupPayload(payload);
    expect(validated.payload.profile.nickname).toBeUndefined();
    expect(validated.payload.profile.avatar).toBeUndefined();
    expect(validated.payload.items[0]).toMatchObject({
      date: undefined, platform: undefined, image: undefined, updatedAt: undefined,
    });
    expect(validated.warnings.join(" ")).toMatch(/6 个旧版可选资料字段为 null/);

    const brokenRelation = structuredClone(payload) as unknown as { sessions: Array<{ upgradedFromSessionId: null }> };
    brokenRelation.sessions[0].upgradedFromSessionId = null;
    expect(() => validateBackupPayload(brokenRelation)).toThrow(/upgradedFromSessionId/);
  });

  it("exports legacy null metadata as absent fields", async () => {
    const payload = exportFixturePayload("nullable-export");
    const created = await commitBackupImport(validatedBackup(payload, "nullable-export-create"), { mode: "create" });
    await db.profiles.update(created.profile.id, { nickname: null as unknown as string, avatar: null as unknown as string });
    const firstItem = payload.items[0];
    await db.items.update([firstItem.snapshotId, firstItem.subjectId], {
      date: null as unknown as string,
      platform: null as unknown as string,
      image: null as unknown as string,
      updatedAt: null as unknown as string,
    });
    const exported = await exportProject(created.profile.id);
    expect(exported.profile.nickname).toBeUndefined();
    expect(exported.profile.avatar).toBeUndefined();
    expect(exported.items.find((entry) => entry.subjectId === firstItem.subjectId)).toMatchObject({
      date: undefined, platform: undefined, image: undefined, updatedAt: undefined,
    });
  });

  it("enforces the size limit before parsing and returns a digest for valid files", async () => {
    const payload = exportFixturePayload("file");
    const file = new File([JSON.stringify(payload)], "backup.json", { type: "application/json" });
    const validated = await readBackup(file);
    expect(validated.fileName).toBe("backup.json");
    expect(validated.digest).toMatch(/^[0-9a-f]{64}$/u);
    await expect(readBackup(new File(["not-json"], "broken.json"))).rejects.toThrow(/JSON/);
    const oversized = { size: 20 * 1024 * 1024 + 1, arrayBuffer: async () => new ArrayBuffer(0) } as unknown as File;
    await expect(readBackup(oversized)).rejects.toThrow(/20 MB/);
  });
});

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

  it("compatibly creates a separate account without the legacy clone naming scheme", async () => {
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
    const result = await commitBackupImport(validatedBackup(retargetBackupAccount(payload, "LegacyBackup")), { mode: "create" });
    const imported = result.profile;
    expect(imported).toMatchObject({ id: "legacybackup", username: "LegacyBackup" });
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

  it("creates a validated backup project, remembers its active snapshot, and records an audit", async () => {
    const fixture = legacyProjectFixture("alice");
    const backup = validatedBackup({
      schemaVersion: 1, appVersion: "0.16.0", exportedAt: new Date(10).toISOString(),
      profile: { ...fixture.profile, id: "Alice", username: " Alice " },
      snapshots: [{ ...fixture.snapshot, profileId: "Alice", username: " Alice " }],
      items: fixture.items,
      sessions: fixture.sessions.map((entry) => ({ ...entry, profileId: "Alice" })),
      sessionItems: fixture.sessionItems,
      comparisons: fixture.comparisons.map((entry) => ({ ...entry, profileId: "Alice" })),
      models: fixture.models,
    } as ExportV1, "create-alice");
    const preview = await previewBackupImport(backup);
    expect(preview).toMatchObject({ targetExists: false, suggestedMode: "create", targetProfileId: "alice" });
    const result = await commitBackupImport(backup, { mode: "create" });
    expect(result.profile).toMatchObject({ id: "alice", username: "Alice" });
    expect((await getActiveSnapshot())?.id).toBe(result.snapshot.id);
    expect((await listLocalProjects()).map((entry) => entry.profile.id)).toEqual(["alice"]);
    expect(await listBackupImportHistory("alice")).toHaveLength(1);
    expect((await exportProject("alice") as ExportV1 & { backupImports?: unknown }).backupImports).toBeUndefined();
    const repeated = await previewBackupImport(backup);
    expect(repeated.importableSessionCount).toBe(0);
    expect(repeated.sessions.every((entry) => entry.status === "duplicate")).toBe(true);
  });

  it("merges selected sessions with dependency closure and remains idempotent", async () => {
    const snapshotId = crypto.randomUUID();
    const items = createDemoItems(snapshotId).slice(0, 3);
    const snapshot = await saveSnapshot({ username: "demo", nickname: "Local" }, snapshotId, items);
    const source = await createSession(snapshot, 2, [2], { preset: "uniform", levelCount: 10, weights: Array(10).fill(10) });
    const child = await createSession(snapshot, 2, [2], { preset: "uniform", levelCount: 10, weights: Array(10).fill(10) });
    await db.sessions.update(child.id, { upgradedFromSessionId: source.id });
    const payload = await exportProject("demo");
    await db.sessions.delete(source.id);
    await db.sessions.delete(child.id);
    await db.sessionItems.where("sessionId").anyOf([source.id, child.id]).delete();
    const backup = validatedBackup(payload, "merge-demo");
    const preview = await previewBackupImport(backup, [child.id]);
    expect(preview.selectedSessionIds).toEqual(expect.arrayContaining([source.id, child.id]));
    expect(preview.dependencySessionIds).toContain(source.id);
    const result = await commitBackupImport(backup, {
      mode: "merge", selectedSessionIds: [child.id], targetRevision: preview.targetRevision,
    });
    expect(result.audit.importedSessionIds).toHaveLength(2);
    const repeated = await previewBackupImport(backup, [child.id]);
    expect(repeated.importableSessionCount).toBe(0);
    expect(repeated.reusedSessionCount).toBe(2);
  });

  it("stores a conflicting backup session under a new id and preserves the local session", async () => {
    const snapshotId = crypto.randomUUID();
    const items = createDemoItems(snapshotId).slice(0, 2);
    const snapshot = await saveSnapshot({ username: "demo", nickname: "Local" }, snapshotId, items);
    const session = await createSession(snapshot, 2, [2], { preset: "uniform", levelCount: 10, weights: Array(10).fill(10) });
    const payload = await exportProject("demo");
    payload.sessions[0].title = "Backup title";
    const backup = validatedBackup(payload, "conflict-demo");
    const preview = await previewBackupImport(backup, [session.id]);
    expect(preview.sessions[0].status).toBe("conflict");
    const result = await commitBackupImport(backup, {
      mode: "merge", selectedSessionIds: [session.id], targetRevision: preview.targetRevision,
    });
    expect(result.audit.conflictSessionCount).toBe(1);
    expect(result.audit.importedSessionIds[0]).not.toBe(session.id);
    expect(result.audit.importedSnapshotIds).toHaveLength(0);
    expect((await db.sessions.get(session.id))?.title).not.toBe("Backup title");
    expect((await db.sessions.get(result.audit.importedSessionIds[0]))?.title).toBe("Backup title");
    expect((await db.profiles.get("demo"))?.nickname).toBe("Local");
    const repeated = await previewBackupImport(backup, [session.id]);
    expect(repeated.importableSessionCount).toBe(0);
  });

  it("copies and remaps a same-id snapshot whose contents differ during merge", async () => {
    const payload = exportFixturePayload("snapshot-conflict");
    payload.sessions.forEach((session) => {
      session.comparisonHistoryMode = "local";
      session.comparisonReusePolicy = "session";
    });
    const snapshotId = payload.snapshots[0].id;
    await saveSnapshot(
      { username: payload.profile.username, nickname: "Local snapshot owner" },
      snapshotId,
      createDemoItems(snapshotId).slice(0, 2),
    );
    const backup = validatedBackup(payload, "snapshot-content-conflict");
    const preview = await previewBackupImport(backup, [payload.sessions[0].id]);
    const result = await commitBackupImport(backup, {
      mode: "merge", selectedSessionIds: [payload.sessions[0].id], targetRevision: preview.targetRevision,
    });

    expect(result.audit.importedSnapshotIds).toHaveLength(1);
    expect(result.audit.importedSnapshotIds[0]).not.toBe(snapshotId);
    expect(result.audit.idMappings).toContainEqual(expect.objectContaining({
      entity: "snapshot", sourceId: snapshotId, reason: "conflict",
    }));
    expect((await db.sessions.get(payload.sessions[0].id))?.snapshotId).toBe(result.audit.importedSnapshotIds[0]);
    expect((await db.snapshots.get(result.audit.importedSnapshotIds[0]))?.username).toBe(payload.profile.username);
    expect((await previewBackupImport(backup, [payload.sessions[0].id])).importableSessionCount).toBe(0);
  });

  it("imports only snapshots required by the selected merge sessions", async () => {
    const first = exportFixturePayload("selected-snapshot-a");
    const second = retargetBackupAccount(exportFixturePayload("selected-snapshot-b"), first.profile.username);
    const selectedSession = first.sessions[0];
    first.snapshots.push(...second.snapshots);
    first.items.push(...second.items);
    first.sessions.push(...second.sessions);
    first.sessionItems.push(...second.sessionItems);
    first.comparisons.push(...second.comparisons);
    first.models.push(...second.models);
    first.sessions.forEach((session) => {
      session.comparisonHistoryMode = "local";
      session.comparisonReusePolicy = "session";
    });

    const localSnapshotId = "selected-merge-local";
    await saveSnapshot({ username: first.profile.username }, localSnapshotId, createDemoItems(localSnapshotId).slice(0, 2));
    const backup = validatedBackup(first, "selected-snapshot-merge");
    const preview = await previewBackupImport(backup, [selectedSession.id]);
    const result = await commitBackupImport(backup, {
      mode: "merge", selectedSessionIds: [selectedSession.id], targetRevision: preview.targetRevision,
    });

    expect(result.audit.importedSnapshotIds).toHaveLength(1);
    expect(result.audit.importedSnapshotIds).toContain(first.snapshots[0].id);
    expect(await db.snapshots.get(second.snapshots[0].id)).toBeUndefined();
  });

  it("reuses dependencies from an earlier remapped import when merging a new child session", async () => {
    const payload = exportFixturePayload("remapped-dependency");
    const sourceSession = payload.sessions[0];
    payload.sessions = [sourceSession];
    payload.sessionItems = payload.sessionItems.filter((entry) => entry.sessionId === sourceSession.id);
    payload.comparisons = payload.comparisons.filter((entry) => entry.sessionId === sourceSession.id);
    payload.models = [];

    const localSnapshotId = "local-dependency-snapshot";
    const localSnapshot = await saveSnapshot(
      { username: payload.profile.username, nickname: "Local" },
      localSnapshotId,
      createDemoItems(localSnapshotId).slice(0, 2),
    );
    await db.sessions.add({ ...sourceSession, profileId: localSnapshot.profileId, snapshotId: localSnapshotId, title: "Local conflict" });

    const sourceBackup = validatedBackup(payload, "remapped-dependency-source");
    const sourcePreview = await previewBackupImport(sourceBackup, [sourceSession.id]);
    const sourceImport = await commitBackupImport(sourceBackup, {
      mode: "merge", selectedSessionIds: [sourceSession.id], targetRevision: sourcePreview.targetRevision,
    });
    const remappedSourceId = sourceImport.audit.importedSessionIds[0];
    expect(remappedSourceId).not.toBe(sourceSession.id);

    const childId = "remapped-dependency-child";
    const childPayload = structuredClone(payload);
    childPayload.sessions.push({
      ...sourceSession,
      id: childId,
      title: "Dependent child",
      upgradedFromSessionId: sourceSession.id,
    });
    childPayload.sessionItems.push(...payload.sessionItems.map((entry) => ({
      ...entry,
      id: `${childId}:${entry.subjectId}`,
      sessionId: childId,
    })));
    const childBackup = validatedBackup(childPayload, "remapped-dependency-child");
    const childPreview = await previewBackupImport(childBackup, [childId]);
    expect(childPreview.dependencySessionIds).toContain(sourceSession.id);
    expect(childPreview.sessions.find((entry) => entry.id === sourceSession.id)?.status).toBe("duplicate");

    const childImport = await commitBackupImport(childBackup, {
      mode: "merge", selectedSessionIds: [childId], targetRevision: childPreview.targetRevision,
    });
    expect(childImport.audit.importedSessionIds).toHaveLength(1);
    expect(childImport.audit.reusedSessionIds).toEqual([remappedSourceId]);
    expect((await db.sessions.get(childImport.audit.importedSessionIds[0]))?.upgradedFromSessionId).toBe(remappedSourceId);
    expect(await db.snapshots.count()).toBe(2);
    const repeated = await previewBackupImport(childBackup, [childId]);
    expect(repeated.importableSessionCount).toBe(0);
  });

  it("preserves valid models only when no IDs or relationships are rewritten", async () => {
    const payload = exportFixturePayload("models");
    payload.sessions.forEach((entry) => {
      entry.comparisonHistoryMode = "local";
      entry.comparisonReusePolicy = "session";
    });
    const sourceSession = payload.sessions[0];
    const allowedIds = payload.sessionItems.filter((entry) => entry.sessionId === sourceSession.id).map((entry) => entry.subjectId);
    payload.models = [{
      sessionId: sourceSession.id,
      version: sourceSession.modelVersion,
      abilities: Object.fromEntries(allowedIds.map((subjectId, index) => [subjectId, index])),
      uncertainty: Object.fromEntries(allowedIds.map((subjectId) => [subjectId, 1])),
      acceptedComparisons: 1,
      initialMeanUncertainty: 1,
      currentMeanUncertainty: 1,
      converged: true,
      iterations: 1,
      updatedAt: sourceSession.updatedAt,
    }];
    const backup = validatedBackup(payload, "models-valid");
    const created = await commitBackupImport(backup, { mode: "create" });
    expect(await db.models.get(created.audit.importedSessionIds[0])).toBeDefined();

    await db.sessions.delete(sourceSession.id);
    await db.sessionItems.where("sessionId").equals(sourceSession.id).delete();
    await db.models.delete(sourceSession.id);
    await db.sessions.add({ ...sourceSession, profileId: "models-profile", id: sourceSession.id, title: "local conflict" });
    const preview = await previewBackupImport(backup, [sourceSession.id]);
    const merged = await commitBackupImport(backup, {
      mode: "merge", selectedSessionIds: [sourceSession.id], targetRevision: preview.targetRevision,
    });
    const remappedId = merged.audit.importedSessionIds[0];
    expect(remappedId).not.toBe(sourceSession.id);
    expect(await db.models.get(remappedId)).toBeUndefined();
    expect((await db.sessions.get(remappedId))?.status).toBe("active");
  });

  it("resets a complete session without a model to active on import", async () => {
    const payload = exportFixturePayload("missing-model");
    payload.sessions = [payload.sessions[0]];
    payload.sessionItems = payload.sessionItems.filter((entry) => entry.sessionId === payload.sessions[0].id);
    payload.comparisons = payload.comparisons.filter((entry) => entry.sessionId === payload.sessions[0].id);
    payload.models = [];
    payload.sessions[0].status = "complete";
    payload.sessions[0].comparisonHistoryMode = "local";
    payload.sessions[0].comparisonReusePolicy = "session";

    const result = await commitBackupImport(validatedBackup(payload, "missing-model"), { mode: "create" });
    expect((await db.sessions.get(result.audit.importedSessionIds[0]))?.status).toBe("active");
    expect(result.audit.importedModelSessionIds).toHaveLength(0);
  });

  it("rolls back every target write when a backup import transaction fails", async () => {
    const payload = exportFixturePayload("rollback");
    const backup = validatedBackup(payload, "rollback-backup");
    const before = {
      profiles: await db.profiles.count(), snapshots: await db.snapshots.count(), sessions: await db.sessions.count(), audits: await db.backupImports.count(),
    };
    const failAudit = () => { throw new Error("injected audit failure"); };
    db.backupImports.hook("creating", failAudit);
    try {
      await expect(commitBackupImport(backup, { mode: "create" })).rejects.toThrow(/injected audit failure/);
    } finally {
      db.backupImports.hook.creating.unsubscribe(failAudit);
    }
    expect(await db.profiles.count()).toBe(before.profiles);
    expect(await db.snapshots.count()).toBe(before.snapshots);
    expect(await db.sessions.count()).toBe(before.sessions);
    expect(await db.backupImports.count()).toBe(before.audits);
  });

  it("replaces only the matching account after confirmation and rejects a stale preview", async () => {
    const demoId = crypto.randomUUID();
    const demoItems = createDemoItems(demoId).slice(0, 2);
    const demoSnapshot = await saveSnapshot({ username: "demo", nickname: "Local" }, demoId, demoItems);
    const localSession = await createSession(demoSnapshot, 2, [2], { preset: "uniform", levelCount: 10, weights: Array(10).fill(10) });
    const restoredModel = toModelState(
      localSession.id,
      localSession.modelVersion,
      fitModel(demoItems.map(({ subjectId, rate }) => ({ subjectId, rate })), []),
    );
    await initializeModel(localSession.id, restoredModel);
    const preservedUpdatedAt = new Date(1234).toISOString();
    await db.sessions.update(localSession.id, { status: "complete", updatedAt: preservedUpdatedAt });
    const payload = await exportProject("demo");
    payload.profile.nickname = "Restored";
    payload.sessions[0].title = "Restored session";
    const otherId = crypto.randomUUID();
    const otherItems = createDemoItems(otherId).slice(0, 2);
    await saveSnapshot({ username: "other", nickname: "Other" }, otherId, otherItems);
    const backup = validatedBackup(payload, "replace-demo");
    const stale = await previewBackupImport(backup);
    await db.sessions.update(localSession.id, { title: "Changed after preview" });
    await expect(commitBackupImport(backup, {
      mode: "replace", targetRevision: stale.targetRevision, confirmationUsername: "demo",
    })).rejects.toThrow(/重新预览/);
    const preview = await previewBackupImport(backup);
    await expect(commitBackupImport(backup, {
      mode: "replace", targetRevision: preview.targetRevision, confirmationUsername: "wrong",
    })).rejects.toThrow(/用户名/);
    const result = await commitBackupImport(backup, {
      mode: "replace", targetRevision: preview.targetRevision, confirmationUsername: "DEMO",
    });
    expect(result.profile.nickname).toBe("Restored");
    expect(result.audit.conflictSessionCount).toBe(0);
    expect(await db.sessions.get(localSession.id)).toMatchObject({
      id: localSession.id,
      title: "Restored session",
      status: "complete",
      createdAt: localSession.createdAt,
      updatedAt: preservedUpdatedAt,
    });
    expect(await db.models.get(localSession.id)).toMatchObject({
      sessionId: localSession.id,
      version: restoredModel.version,
      abilities: restoredModel.abilities,
      uncertainty: restoredModel.uncertainty,
    });
    expect(await db.profiles.get("other")).toBeDefined();
    expect((await listBackupImportHistory("demo"))[0].mode).toBe("replace");
  });

  it("remaps global primary-key collisions during replacement without touching another account", async () => {
    const payload = exportFixturePayload("global-collision");
    const sourceProfileId = payload.profile.id;
    payload.profile.username = "Alice";
    payload.snapshots.forEach((entry) => { entry.username = "Alice"; });
    const sharedSnapshotId = payload.snapshots[0].id;
    const sharedSessionId = payload.sessions[0].id;
    const sharedComparisonId = payload.comparisons[0].id;

    const localSnapshotId = "alice-local-snapshot";
    await saveSnapshot({ username: "Alice", nickname: "Local Alice" }, localSnapshotId, createDemoItems(localSnapshotId).slice(0, 2));
    const otherItems = createDemoItems(sharedSnapshotId).slice(0, 3);
    await saveSnapshot({ username: "other", nickname: "Other" }, sharedSnapshotId, otherItems);
    await db.sessions.add({ ...payload.sessions[0], id: sharedSessionId, profileId: "other", snapshotId: sharedSnapshotId, title: "Other session", comparisonHistoryMode: "local" });
    await db.sessionItems.bulkAdd(otherItems.map((entry) => ({ id: `${sharedSessionId}:${entry.subjectId}`, sessionId: sharedSessionId, subjectId: entry.subjectId })));
    await db.comparisons.add({ ...payload.comparisons[0], id: sharedComparisonId, profileId: "other", sessionId: sharedSessionId });
    const backup = validatedBackup(payload, "global-collision-backup");
    const preview = await previewBackupImport(backup);
    const result = await commitBackupImport(backup, {
      mode: "replace", targetRevision: preview.targetRevision, confirmationUsername: "Alice",
    });

    expect(result.profile).toMatchObject({ id: "alice", username: "Alice" });
    expect(await db.snapshots.get(sharedSnapshotId)).toMatchObject({ profileId: "other" });
    expect(await db.sessions.get(sharedSessionId)).toMatchObject({ profileId: "other", title: "Other session" });
    expect(await db.comparisons.get(sharedComparisonId)).toMatchObject({ profileId: "other" });
    expect(result.audit.conflictSessionCount).toBe(1);
    expect(result.audit.idMappings).toEqual(expect.arrayContaining([
      expect.objectContaining({ entity: "profile", sourceId: sourceProfileId, targetId: "alice" }),
      expect.objectContaining({ entity: "snapshot", sourceId: sharedSnapshotId }),
      expect.objectContaining({ entity: "session", sourceId: sharedSessionId }),
      expect.objectContaining({ entity: "comparison", sourceId: sharedComparisonId }),
    ]));
  });

  it("retains earlier audits and marks them superseded after replacement", async () => {
    const initial = validatedBackup(exportFixturePayload("audit-history"), "audit-history-create");
    const created = await commitBackupImport(initial, { mode: "create" });
    const replacementPayload = structuredClone(initial.payload);
    replacementPayload.profile.nickname = "Restored audit profile";
    const replacement = validatedBackup(replacementPayload, "audit-history-replace");
    const preview = await previewBackupImport(replacement);
    const restored = await commitBackupImport(replacement, {
      mode: "replace", targetRevision: preview.targetRevision, confirmationUsername: replacementPayload.profile.username,
    });
    const history = await listBackupImportHistory(restored.profile.id);
    expect(history).toHaveLength(2);
    const earlier = history.find((entry) => entry.id === created.audit.id)!;
    expect(earlier.supersededAt).toBeDefined();
    expect(earlier.supersededByImportId).toBe(restored.audit.id);
    expect(history.find((entry) => entry.id === restored.audit.id)?.supersededAt).toBeUndefined();
  });

  it("switches and restores an explicit active snapshot", async () => {
    const firstId = crypto.randomUUID();
    const secondId = crypto.randomUUID();
    await saveSnapshot({ username: "first" }, firstId, createDemoItems(firstId).slice(0, 2));
    await saveSnapshot({ username: "second" }, secondId, createDemoItems(secondId).slice(0, 2));
    await setActiveSnapshot(firstId);
    expect((await getActiveSnapshot())?.id).toBe(firstId);
    await db.snapshots.delete(firstId);
    expect((await getActiveSnapshot())?.id).toBe(secondId);
  });

  it("previews and atomically deletes one legacy imported snapshot with its owned data", async () => {
    const currentId = crypto.randomUUID();
    const legacyId = crypto.randomUUID();
    const current = await saveSnapshot({ username: "Alice", nickname: "Real" }, currentId, createDemoItems(currentId).slice(0, 3));
    const legacy = await saveSnapshot({ username: "alice", nickname: "Ignored" }, legacyId, createDemoItems(legacyId).slice(0, 3));
    const currentSession = await createSession(current, 2, [2], { preset: "uniform", levelCount: 10, weights: Array(10).fill(10) });
    const legacySession = await createSession(legacy, 2, [2], { preset: "uniform", levelCount: 10, weights: Array(10).fill(10) });
    const legacyItems = await db.sessionItems.where("sessionId").equals(legacySession.id).toArray();
    const comparison: ComparisonRecord = {
      id: crypto.randomUUID(), profileId: legacy.profileId, sessionId: legacySession.id, subjectType: 2,
      leftSubjectId: legacyItems[0].subjectId, rightSubjectId: legacyItems[1].subjectId, outcome: "left",
      acceptedCountAtAnswer: 1, active: true, createdAt: new Date().toISOString(),
    };
    const model = toModelState(legacySession.id, legacySession.modelVersion,
      fitModel(legacyItems.map((entry) => ({ subjectId: entry.subjectId, rate: 0 })), []));
    await db.comparisons.add(comparison);
    await db.models.put(model);
    await db.importBatches.add({
      id: crypto.randomUUID(), profileId: legacy.profileId, targetSessionId: legacySession.id,
      sourceSessionId: currentSession.id, sourceSnapshotId: current.id, targetSnapshotId: legacy.id,
      type: "existing-session", createdAt: new Date().toISOString(), importedCount: 1,
      duplicateOriginalCount: 0, duplicatePairCount: 0, outOfScopeCount: 0, skippedCount: 0,
      invalidCalibrationCount: 0,
    });
    const migration = legacyMigrationAudit(legacy.profileId, "Alice", [legacy.id], [legacySession.id]);
    await db.backupImports.add(migration);
    await setActiveSnapshot(legacy.id);

    const preview = await previewLegacyCloneDeletion(legacy.id);
    expect(preview).toMatchObject({ active: true, itemCount: 3, remainingSnapshotCount: 1 });
    expect(preview.sessionIds).toEqual([legacySession.id]);
    expect(preview.comparisonIds).toEqual([comparison.id]);
    expect(preview.importBatchIds).toHaveLength(1);
    expect(preview.modelSessionIds).toEqual([legacySession.id]);
    await expect(commitLegacyCloneDeletion({
      snapshotId: legacy.id, targetRevision: preview.targetRevision, confirmationUsername: "wrong",
    })).rejects.toThrow(/用户名/);

    const result = await commitLegacyCloneDeletion({
      snapshotId: legacy.id, targetRevision: preview.targetRevision, confirmationUsername: " ALICE ",
    });
    expect(result.activeSnapshot?.id).toBe(current.id);
    expect(await db.snapshots.get(legacy.id)).toBeUndefined();
    expect(await db.items.where("snapshotId").equals(legacy.id).count()).toBe(0);
    expect(await db.sessions.get(legacySession.id)).toBeUndefined();
    expect(await db.sessionItems.where("sessionId").equals(legacySession.id).count()).toBe(0);
    expect(await db.comparisons.get(comparison.id)).toBeUndefined();
    expect(await db.models.get(legacySession.id)).toBeUndefined();
    expect(await db.sessions.get(currentSession.id)).toBeDefined();
    expect(await db.snapshots.get(current.id)).toBeDefined();
    expect((await getActiveSnapshot())?.id).toBe(current.id);
    expect((await listLocalProjects())[0].legacySnapshotIds).not.toContain(legacy.id);
    const history = await listBackupImportHistory(current.profileId);
    expect(history[0]).toMatchObject({ mode: "legacy-clone-deletion", deletedSnapshotIds: [legacy.id] });
    expect(history.find((entry) => entry.id === migration.id)?.deletedAt).toBeDefined();
  });

  it("rejects ordinary snapshots and stale previews without deleting anything", async () => {
    const ordinaryId = crypto.randomUUID();
    const ordinary = await saveSnapshot({ username: "ordinary" }, ordinaryId, createDemoItems(ordinaryId).slice(0, 2));
    await expect(previewLegacyCloneDeletion(ordinary.id)).rejects.toThrow(/只能删除/);

    const legacyId = crypto.randomUUID();
    const legacy = await saveSnapshot({ username: "ordinary" }, legacyId, createDemoItems(legacyId).slice(0, 2));
    await db.backupImports.add(legacyMigrationAudit(legacy.profileId, legacy.username, [legacy.id], []));
    const preview = await previewLegacyCloneDeletion(legacy.id);
    const changedId = crypto.randomUUID();
    await saveSnapshot({ username: "ordinary" }, changedId, createDemoItems(changedId).slice(0, 2));
    await expect(commitLegacyCloneDeletion({
      snapshotId: legacy.id, targetRevision: preview.targetRevision, confirmationUsername: legacy.username,
    })).rejects.toThrow(/重新预览/);
    expect(await db.snapshots.get(legacy.id)).toBeDefined();
    expect((await listBackupImportHistory(legacy.profileId)).filter((entry) => entry.mode === "legacy-clone-deletion")).toHaveLength(0);
  });

  it("deletes one ordinary snapshot without touching sibling snapshots or accounts", async () => {
    const firstId = crypto.randomUUID();
    const secondId = crypto.randomUUID();
    const otherId = crypto.randomUUID();
    const first = await saveSnapshot({ username: "Alice", nickname: "Local Alice" }, firstId, createDemoItems(firstId).slice(0, 3));
    const second = await saveSnapshot({ username: " alice ", nickname: "Local Alice" }, secondId, createDemoItems(secondId).slice(0, 2));
    const other = await saveSnapshot({ username: "Bob" }, otherId, createDemoItems(otherId).slice(0, 2));
    const firstSession = await createSession(first, 2, [2], { preset: "uniform", levelCount: 10, weights: Array(10).fill(10) });
    const secondSession = await createSession(second, 2, [2], { preset: "uniform", levelCount: 10, weights: Array(10).fill(10) });
    const otherSession = await createSession(other, 2, [2], { preset: "uniform", levelCount: 10, weights: Array(10).fill(10) });
    const firstLinks = await db.sessionItems.where("sessionId").equals(firstSession.id).toArray();
    const firstComparison: ComparisonRecord = {
      id: crypto.randomUUID(), profileId: first.profileId, sessionId: firstSession.id, subjectType: 2,
      leftSubjectId: firstLinks[0].subjectId, rightSubjectId: firstLinks[1].subjectId, outcome: "left",
      acceptedCountAtAnswer: 1, active: true, createdAt: new Date().toISOString(),
    };
    await db.comparisons.add(firstComparison);
    await db.models.put(toModelState(firstSession.id, firstSession.modelVersion,
      fitModel(firstLinks.map((entry) => ({ subjectId: entry.subjectId, rate: 0 })), [])));
    await db.importBatches.add({
      id: crypto.randomUUID(), profileId: first.profileId, targetSessionId: firstSession.id,
      sourceSnapshotId: second.id, targetSnapshotId: first.id, type: "migration", createdAt: new Date().toISOString(),
      importedCount: 1, duplicateOriginalCount: 0, duplicatePairCount: 0, outOfScopeCount: 0,
      skippedCount: 0, invalidCalibrationCount: 0,
    });
    await setActiveSnapshot(first.id);

    const preview = await previewSnapshotDeletion(first.id);
    expect(preview).toMatchObject({ legacy: false, active: true, remainingSnapshotCount: 1, itemCount: 3 });
    expect(preview.sessionIds).toEqual([firstSession.id]);
    expect(preview.comparisonIds).toEqual([firstComparison.id]);
    expect(preview.importBatchIds).toHaveLength(1);
    expect(preview.modelSessionIds).toEqual([firstSession.id]);
    await expect(commitSnapshotDeletion({
      snapshotId: first.id, targetRevision: preview.targetRevision, confirmationUsername: "wrong",
    })).rejects.toThrow(/用户名/);

    const result = await commitSnapshotDeletion({
      snapshotId: first.id, targetRevision: preview.targetRevision, confirmationUsername: " ALICE ",
    });
    expect(result.audit.mode).toBe("snapshot-deletion");
    expect(result.activeSnapshot?.id).toBe(second.id);
    expect(await db.snapshots.get(first.id)).toBeUndefined();
    expect(await db.items.where("snapshotId").equals(first.id).count()).toBe(0);
    expect(await db.sessions.get(firstSession.id)).toBeUndefined();
    expect(await db.sessionItems.where("sessionId").equals(firstSession.id).count()).toBe(0);
    expect(await db.comparisons.get(firstComparison.id)).toBeUndefined();
    expect(await db.models.get(firstSession.id)).toBeUndefined();
    expect(await db.sessions.get(secondSession.id)).toBeDefined();
    expect(await db.sessions.get(otherSession.id)).toBeDefined();
    expect(await db.snapshots.get(second.id)).toBeDefined();
    expect(await db.snapshots.get(other.id)).toBeDefined();
    expect((await db.profiles.get(first.profileId))?.nickname).toBe("Local Alice");
    expect((await getActiveSnapshot())?.id).toBe(second.id);
    expect((await listBackupImportHistory(first.profileId))[0]).toMatchObject({
      mode: "snapshot-deletion", deletedSnapshotIds: [first.id], deletedSessionIds: [firstSession.id],
    });
  });

  it("protects the last ordinary snapshot from deletion", async () => {
    const snapshotId = crypto.randomUUID();
    const snapshot = await saveSnapshot({ username: "only-snapshot" }, snapshotId, createDemoItems(snapshotId).slice(0, 2));
    const preview = await previewSnapshotDeletion(snapshot.id);
    expect(preview.remainingSnapshotCount).toBe(0);
    expect(preview.warnings.join(" ")).toMatch(/至少需要保留一个/);
    await expect(commitSnapshotDeletion({
      snapshotId: snapshot.id, targetRevision: preview.targetRevision, confirmationUsername: snapshot.username,
    })).rejects.toThrow(/至少需要保留一个/);
    expect(await db.snapshots.get(snapshot.id)).toBeDefined();
    expect(await db.profiles.get(snapshot.profileId)).toBeDefined();
  });

  it("rejects a stale ordinary snapshot preview and rolls back an audit failure", async () => {
    const firstId = crypto.randomUUID();
    const secondId = crypto.randomUUID();
    const first = await saveSnapshot({ username: "snapshot-rollback" }, firstId, createDemoItems(firstId).slice(0, 2));
    await saveSnapshot({ username: "snapshot-rollback" }, secondId, createDemoItems(secondId).slice(0, 2));
    const stale = await previewSnapshotDeletion(first.id);
    const session = await createSession(first, 2, [2], { preset: "uniform", levelCount: 10, weights: Array(10).fill(10) });
    await expect(commitSnapshotDeletion({
      snapshotId: first.id, targetRevision: stale.targetRevision, confirmationUsername: first.username,
    })).rejects.toThrow(/重新预览/);
    expect(await db.snapshots.get(first.id)).toBeDefined();

    const preview = await previewSnapshotDeletion(first.id);
    const failAudit = (_key: string, entry: BackupImportAudit) => {
      if (entry.mode === "snapshot-deletion") throw new Error("injected snapshot deletion audit failure");
    };
    db.backupImports.hook("creating", failAudit);
    try {
      await expect(commitSnapshotDeletion({
        snapshotId: first.id, targetRevision: preview.targetRevision, confirmationUsername: first.username,
      })).rejects.toThrow(/injected snapshot deletion audit failure/);
    } finally {
      db.backupImports.hook.creating.unsubscribe(failAudit);
    }
    expect(await db.snapshots.get(first.id)).toBeDefined();
    expect(await db.items.where("snapshotId").equals(first.id).count()).toBe(2);
    expect(await db.sessions.get(session.id)).toBeDefined();
    expect((await listBackupImportHistory(first.profileId)).filter((entry) => entry.mode === "snapshot-deletion")).toHaveLength(0);
  });

  it("rolls back a legacy clone deletion when its audit write fails", async () => {
    const keepId = crypto.randomUUID();
    const legacyId = crypto.randomUUID();
    await saveSnapshot({ username: "rollback-delete" }, keepId, createDemoItems(keepId).slice(0, 2));
    const legacy = await saveSnapshot({ username: "rollback-delete" }, legacyId, createDemoItems(legacyId).slice(0, 2));
    await db.backupImports.add(legacyMigrationAudit(legacy.profileId, legacy.username, [legacy.id], []));
    const preview = await previewLegacyCloneDeletion(legacy.id);
    const failAudit = (_key: string, entry: BackupImportAudit) => {
      if (entry.mode === "legacy-clone-deletion") throw new Error("injected deletion audit failure");
    };
    db.backupImports.hook("creating", failAudit);
    try {
      await expect(commitLegacyCloneDeletion({
        snapshotId: legacy.id, targetRevision: preview.targetRevision, confirmationUsername: legacy.username,
      })).rejects.toThrow(/injected deletion audit failure/);
    } finally {
      db.backupImports.hook.creating.unsubscribe(failAudit);
    }
    expect(await db.snapshots.get(legacy.id)).toBeDefined();
    expect(await db.items.where("snapshotId").equals(legacy.id).count()).toBe(2);
  });

  it("migrates single and nested legacy clone profiles into an existing real account", async () => {
    const databaseName = `bangumi-resorter-v5-clones-${crypto.randomUUID()}`;
    const legacy = new Dexie(databaseName);
    legacy.version(5).stores({
      profiles: "id, username, updatedAt",
      snapshots: "id, profileId, syncedAt",
      items: "[snapshotId+subjectId], snapshotId, subjectId, subjectType, collectionType, rate",
      sessions: "id, profileId, snapshotId, subjectType, status, updatedAt",
      sessionItems: "id, sessionId, subjectId, [sessionId+subjectId]",
      comparisons: "id, profileId, sessionId, subjectType, active, createdAt, importBatchId, importedFromSessionId",
      models: "sessionId, version, updatedAt",
      importBatches: "id, profileId, targetSessionId, sourceSessionId, createdAt, type",
      meta: "key",
    });
    await legacy.open();
    const fixture = legacyProjectFixture("clone-existing");
    const realId = "alice-real";
    const cloneOne = "source:import:1234abcd";
    const cloneTwo = "source:import:1234abcd:import:deadbeef";
    await legacy.table("profiles").bulkAdd([
      { id: realId, username: "Alice", nickname: "Real profile", createdAt: new Date(2).toISOString(), updatedAt: new Date(3).toISOString() },
      { ...fixture.profile, id: cloneOne, username: "Alice（导入）", nickname: "Clone one", createdAt: new Date(1).toISOString(), updatedAt: new Date(4).toISOString() },
      { ...fixture.profile, id: cloneTwo, username: "Alice（导入）（导入）", nickname: "Clone two", createdAt: new Date(5).toISOString(), updatedAt: new Date(6).toISOString() },
    ]);
    const snapshots = [cloneOne, cloneTwo].map((profileId, index) => ({
      ...fixture.snapshot, id: `clone-snapshot-${index}`, profileId, username: index ? "Alice（导入）（导入）" : "Alice（导入）", syncedAt: new Date(10 + index).toISOString(),
    }));
    const sessions = [cloneOne, cloneTwo].map((profileId, index) => ({
      ...fixture.sessions[index], id: `clone-session-${index}`, profileId, snapshotId: snapshots[index].id, comparisonHistoryMode: "local" as const,
    }));
    await legacy.table("snapshots").bulkAdd(snapshots);
    await legacy.table("sessions").bulkAdd(sessions);
    await legacy.table("meta").put({ key: "active-snapshot", value: JSON.stringify({ profileId: cloneTwo, snapshotId: snapshots[1].id }) });
    legacy.close();

    const migrated = new ResorterDatabase(databaseName);
    try {
      await migrated.open();
      expect(await migrated.profiles.count()).toBe(1);
      expect(await migrated.profiles.get(realId)).toMatchObject({ username: "Alice", nickname: "Real profile", createdAt: new Date(1).toISOString(), updatedAt: new Date(6).toISOString() });
      expect((await migrated.snapshots.toArray()).every((entry) => entry.profileId === realId && entry.username === "Alice")).toBe(true);
      expect((await migrated.sessions.toArray()).every((entry) => entry.profileId === realId)).toBe(true);
      expect((await migrated.meta.get("active-snapshot"))?.value).toContain(`"profileId":"${realId}"`);
      const audit = (await migrated.backupImports.toArray())[0];
      expect(audit).toMatchObject({ mode: "legacy-clone-migration", profileId: realId });
      expect(audit.legacyCloneProfileIds).toEqual(expect.arrayContaining([cloneOne, cloneTwo]));
    } finally {
      migrated.close();
      await migrated.delete();
    }
  });

  it("creates a canonical profile from a legacy clone when the real account is absent", async () => {
    const databaseName = `bangumi-resorter-v5-clone-only-${crypto.randomUUID()}`;
    const legacy = new Dexie(databaseName);
    legacy.version(5).stores({
      profiles: "id, username, updatedAt",
      snapshots: "id, profileId, syncedAt",
      items: "[snapshotId+subjectId], snapshotId, subjectId, subjectType, collectionType, rate",
      sessions: "id, profileId, snapshotId, subjectType, status, updatedAt",
      sessionItems: "id, sessionId, subjectId, [sessionId+subjectId]",
      comparisons: "id, profileId, sessionId, subjectType, active, createdAt, importBatchId, importedFromSessionId",
      models: "sessionId, version, updatedAt",
      importBatches: "id, profileId, targetSessionId, sourceSessionId, createdAt, type",
      meta: "key",
    });
    await legacy.open();
    const fixture = legacyProjectFixture("clone-only");
    const cloneId = "random-source:import:abcdef12";
    await legacy.table("profiles").add({ ...fixture.profile, id: cloneId, username: "MixedCase（导入）", nickname: "Latest clone" });
    await legacy.table("snapshots").add({ ...fixture.snapshot, profileId: cloneId, username: "MixedCase（导入）" });
    legacy.close();

    const migrated = new ResorterDatabase(databaseName);
    try {
      await migrated.open();
      expect(await migrated.profiles.get("mixedcase")).toMatchObject({ username: "MixedCase", nickname: "Latest clone" });
      expect(await migrated.profiles.get(cloneId)).toBeUndefined();
      expect(await migrated.snapshots.get(fixture.snapshot.id)).toMatchObject({ profileId: "mixedcase", username: "MixedCase" });
      expect((await migrated.backupImports.toArray())[0].legacySnapshotIds).toEqual([fixture.snapshot.id]);
    } finally {
      migrated.close();
      await migrated.delete();
    }
  });

  it("drops an empty legacy clone instead of creating an empty canonical project", async () => {
    const databaseName = `bangumi-resorter-v5-empty-clone-${crypto.randomUUID()}`;
    const legacy = new Dexie(databaseName);
    legacy.version(5).stores({
      profiles: "id, username, updatedAt",
      snapshots: "id, profileId, syncedAt",
      items: "[snapshotId+subjectId], snapshotId, subjectId, subjectType, collectionType, rate",
      sessions: "id, profileId, snapshotId, subjectType, status, updatedAt",
      sessionItems: "id, sessionId, subjectId, [sessionId+subjectId]",
      comparisons: "id, profileId, sessionId, subjectType, active, createdAt, importBatchId, importedFromSessionId",
      models: "sessionId, version, updatedAt",
      importBatches: "id, profileId, targetSessionId, sourceSessionId, createdAt, type",
      meta: "key",
    });
    await legacy.open();
    await legacy.table("profiles").add({
      id: "empty:import:1234abcd", username: "Empty（导入）", createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
    });
    legacy.close();
    const migrated = new ResorterDatabase(databaseName);
    try {
      await migrated.open();
      expect(await migrated.profiles.count()).toBe(0);
      expect(await migrated.backupImports.count()).toBe(0);
    } finally {
      migrated.close();
      await migrated.delete();
    }
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
    const importedProfile = (await commitBackupImport(validatedBackup(payload), { mode: "create" })).profile;
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
    const importedProfile = (await commitBackupImport(validatedBackup({
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
    }), { mode: "create" })).profile;
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

    const firstPayload = retargetBackupAccount(await exportProject("demo"), "CopyOne");
    const firstImportedProfile = (await commitBackupImport(validatedBackup(firstPayload), { mode: "create" })).profile;
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

    const secondPayload = retargetBackupAccount(await exportProject(firstImportedProfile.id), "CopyTwo");
    const secondImportedProfile = (await commitBackupImport(validatedBackup(secondPayload), { mode: "create" })).profile;
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
    const payload = retargetBackupAccount(await exportProject("demo"), "ImportedDemo");
    const importedProfile = (await commitBackupImport(validatedBackup(payload), { mode: "create" })).profile;
    const imported = await db.comparisons.where("profileId").equals(importedProfile.id).toArray();
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
