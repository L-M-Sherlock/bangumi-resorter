"use client";

import Dexie, { EntityTable, Table } from "dexie";
import {
  APP_VERSION,
  CollectionItem,
  CollectionType,
  ComparisonBudgetMode,
  ComparisonOutcome,
  ComparisonRecord,
  ComparisonReusePolicy,
  DistributionConfig,
  ExportV1,
  ModelState,
  Profile,
  SessionItem,
  SessionScopePreview,
  SessionTagFilter,
  SessionUpgradePreview,
  Snapshot,
  SortingSession,
  SubjectType,
} from "./types";
import { comparisonLimit, sessionBudgetMode, sessionReusePolicy } from "./ranking/strategy";
import { collectionTagFilter, filterScopeItems, sameTagFilter } from "./scope";

interface MetaRecord { key: string; value: string; }

class ResorterDatabase extends Dexie {
  profiles!: EntityTable<Profile, "id">;
  snapshots!: EntityTable<Snapshot, "id">;
  items!: Table<CollectionItem, [string, number]>;
  sessions!: EntityTable<SortingSession, "id">;
  sessionItems!: EntityTable<SessionItem, "id">;
  comparisons!: EntityTable<ComparisonRecord, "id">;
  models!: EntityTable<ModelState, "sessionId">;
  meta!: EntityTable<MetaRecord, "key">;

  constructor() {
    super("bangumi-resorter");
    this.version(1).stores({
      profiles: "id, username, updatedAt",
      snapshots: "id, profileId, syncedAt",
      items: "[snapshotId+subjectId], snapshotId, subjectId, subjectType, collectionType, rate",
      sessions: "id, profileId, snapshotId, subjectType, status, updatedAt",
      sessionItems: "id, sessionId, subjectId, [sessionId+subjectId]",
      comparisons: "id, profileId, sessionId, subjectType, active, createdAt",
      models: "sessionId, version, updatedAt",
      meta: "key",
    });
    this.version(2).stores({
      profiles: "id, username, updatedAt",
      snapshots: "id, profileId, syncedAt",
      items: "[snapshotId+subjectId], snapshotId, subjectId, subjectType, collectionType, rate",
      sessions: "id, profileId, snapshotId, subjectType, status, updatedAt",
      sessionItems: "id, sessionId, subjectId, [sessionId+subjectId]",
      comparisons: "id, profileId, sessionId, subjectType, active, createdAt",
      models: "sessionId, version, updatedAt",
      meta: "key",
    }).upgrade(async (transaction) => {
      await transaction.table("sessions").toCollection().modify((session: SortingSession) => {
        session.stoppingTarget = undefined;
        session.status = "active";
      });
    });
  }
}

export const db = new ResorterDatabase();

function now() { return new Date().toISOString(); }
function id() { return crypto.randomUUID(); }

export async function saveSnapshot(
  profileData: Pick<Profile, "username" | "nickname" | "avatar">,
  snapshotId: string,
  items: CollectionItem[],
): Promise<Snapshot> {
  const timestamp = now();
  const profileId = profileData.username.toLowerCase();
  const previous = await db.profiles.get(profileId);
  const profile: Profile = {
    id: profileId,
    ...profileData,
    createdAt: previous?.createdAt ?? timestamp,
    updatedAt: timestamp,
  };
  const snapshot: Snapshot = {
    id: snapshotId,
    profileId,
    username: profileData.username,
    syncedAt: timestamp,
    itemCount: items.length,
    containsPrivate: items.some((item) => item.private),
  };
  await db.transaction("rw", db.profiles, db.snapshots, db.items, async () => {
    await db.profiles.put(profile);
    await db.snapshots.put(snapshot);
    await db.items.bulkPut(items);
  });
  return snapshot;
}

export async function latestSnapshot(): Promise<Snapshot | undefined> {
  return db.snapshots.orderBy("syncedAt").last();
}

export async function getSnapshotItems(snapshotId: string): Promise<CollectionItem[]> {
  return db.items.where("snapshotId").equals(snapshotId).toArray();
}

async function reusableHistory(session: SortingSession, allowed: Set<number>) {
  const reusePolicy = sessionReusePolicy(session);
  let reusableSessionIds: Set<string>;
  if (reusePolicy === "session") {
    reusableSessionIds = new Set([session.id]);
  } else if (reusePolicy === "snapshot") {
    reusableSessionIds = new Set((await db.sessions.where("snapshotId").equals(session.snapshotId).toArray()).map((entry) => entry.id));
  } else {
    reusableSessionIds = new Set((await db.sessions.where("profileId").equals(session.profileId).toArray()).map((entry) => entry.id));
  }
  return db.comparisons
    .where("profileId").equals(session.profileId)
    .filter((entry) => entry.subjectType === session.subjectType
      && entry.active
      && reusableSessionIds.has(entry.sessionId)
      && allowed.has(entry.leftSubjectId)
      && allowed.has(entry.rightSubjectId))
    .toArray();
}

export async function createSession(
  snapshot: Snapshot,
  subjectType: SubjectType,
  collectionTypes: CollectionType[],
  distribution: DistributionConfig,
  budgetMode: ComparisonBudgetMode = "quick",
  comparisonReusePolicy: ComparisonReusePolicy = "snapshot",
  tagFilter?: SessionTagFilter,
): Promise<SortingSession> {
  const all = await getSnapshotItems(snapshot.id);
  const normalizedTagFilter = collectionTagFilter(tagFilter?.tags ?? []);
  const selected = filterScopeItems({ subjectType, collectionTypes, tagFilter: normalizedTagFilter }, all);
  if (selected.length < 2) throw new Error("至少需要两个条目才能开始比较。");
  const timestamp = now();
  const session: SortingSession = {
    id: id(), profileId: snapshot.profileId, snapshotId: snapshot.id, subjectType, collectionTypes,
    title: `${snapshot.username} 的排序`, status: "active", distribution,
    randomSeed: crypto.getRandomValues(new Uint32Array(1))[0], modelVersion: 0,
    budgetMode, comparisonReusePolicy, tagFilter: normalizedTagFilter,
    maxComparisons: comparisonLimit(selected.length, budgetMode), createdAt: timestamp, updatedAt: timestamp,
  };
  const links = selected.map<SessionItem>((item) => ({ id: `${session.id}:${item.subjectId}`, sessionId: session.id, subjectId: item.subjectId }));
  await db.transaction("rw", db.sessions, db.sessionItems, async () => {
    await db.sessions.add(session);
    await db.sessionItems.bulkAdd(links);
  });
  return session;
}

export async function getSessionBundle(sessionId: string) {
  const session = await db.sessions.get(sessionId);
  if (!session) return undefined;
  const links = await db.sessionItems.where("sessionId").equals(sessionId).toArray();
  const allowed = new Set(links.map((item) => item.subjectId));
  const snapshotItems = await getSnapshotItems(session.snapshotId);
  const items = snapshotItems.filter((item) => allowed.has(item.subjectId));
  const history = await reusableHistory(session, allowed);
  const model = await db.models.get(sessionId);
  return { session, items, history, model };
}

interface SessionUpgradeState {
  source: SortingSession;
  targetSnapshot: Snapshot;
  previousItems: CollectionItem[];
  currentItems: CollectionItem[];
  history: ComparisonRecord[];
}

async function loadSessionUpgradeState(sourceSessionId: string, targetSnapshotId: string): Promise<SessionUpgradeState> {
  const [source, targetSnapshot] = await Promise.all([
    db.sessions.get(sourceSessionId),
    db.snapshots.get(targetSnapshotId),
  ]);
  if (!source) throw new Error("原会话不存在，可能已经被删除。");
  if (!targetSnapshot) throw new Error("目标收藏快照不存在。");
  if (source.profileId !== targetSnapshot.profileId) throw new Error("只能升级到同一 Bangumi 用户的收藏快照。");
  if (source.snapshotId === targetSnapshot.id) throw new Error("这个会话已经使用当前收藏快照。");

  const [links, sourceSnapshotItems, targetSnapshotItems] = await Promise.all([
    db.sessionItems.where("sessionId").equals(source.id).toArray(),
    getSnapshotItems(source.snapshotId),
    getSnapshotItems(targetSnapshot.id),
  ]);
  const previousAllowed = new Set(links.map((entry) => entry.subjectId));
  const previousItems = sourceSnapshotItems.filter((entry) => previousAllowed.has(entry.subjectId));
  const currentItems = filterScopeItems(source, targetSnapshotItems);
  if (currentItems.length < 2) throw new Error("当前收藏中符合原会话范围的条目不足两个，无法升级。");
  const history = await reusableHistory(source, previousAllowed);
  return { source, targetSnapshot, previousItems, currentItems, history };
}

function scopePreview(
  source: SortingSession,
  targetSnapshot: Snapshot,
  previousItems: CollectionItem[],
  currentItems: CollectionItem[],
  history: ComparisonRecord[],
): SessionScopePreview {
  const previousById = new Map(previousItems.map((entry) => [entry.subjectId, entry]));
  const currentById = new Map(currentItems.map((entry) => [entry.subjectId, entry]));
  const addedSubjectIds = [...currentById.keys()].filter((subjectId) => !previousById.has(subjectId)).sort((a, b) => a - b);
  const removedSubjectIds = [...previousById.keys()].filter((subjectId) => !currentById.has(subjectId)).sort((a, b) => a - b);
  const informative = history.filter((entry) => entry.outcome !== "skip");
  const inheritedComparisonCount = informative.filter((entry) =>
    currentById.has(entry.leftSubjectId) && currentById.has(entry.rightSubjectId)).length;
  return {
    sourceSessionId: source.id,
    targetSnapshotId: targetSnapshot.id,
    previousItemCount: previousItems.length,
    currentItemCount: currentItems.length,
    addedSubjectIds,
    removedSubjectIds,
    inheritedComparisonCount,
    droppedComparisonCount: informative.length - inheritedComparisonCount,
  };
}

function upgradePreview(state: SessionUpgradeState): SessionUpgradePreview {
  const preview = scopePreview(
    state.source,
    state.targetSnapshot,
    state.previousItems,
    state.currentItems,
    state.history,
  );
  const previousById = new Map(state.previousItems.map((entry) => [entry.subjectId, entry]));
  const ratingChangedSubjectIds = state.currentItems
    .filter((entry) => previousById.has(entry.subjectId) && previousById.get(entry.subjectId)?.rate !== entry.rate)
    .map((entry) => entry.subjectId)
    .sort((a, b) => a - b);
  return { ...preview, ratingChangedSubjectIds };
}

function cloneRetainedComparisons(
  source: ComparisonRecord[],
  session: SortingSession,
  currentIds: Set<number>,
) {
  const retained = source
    .filter((entry) => entry.outcome !== "skip"
      && currentIds.has(entry.leftSubjectId)
      && currentIds.has(entry.rightSubjectId))
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
  const clonedIds = new Map(retained.map((entry) => [entry.id, id()]));
  return retained.map((entry, index): ComparisonRecord => ({
    ...entry,
    id: clonedIds.get(entry.id)!,
    profileId: session.profileId,
    sessionId: session.id,
    calibrationOfComparisonId: entry.calibrationOfComparisonId
      ? clonedIds.get(entry.calibrationOfComparisonId)
      : undefined,
    acceptedCountAtAnswer: index + 1,
    active: true,
  }));
}

function sessionItemLinks(session: SortingSession, items: CollectionItem[]) {
  return items.map<SessionItem>((entry) => ({
    id: `${session.id}:${entry.subjectId}`,
    sessionId: session.id,
    subjectId: entry.subjectId,
  }));
}

export async function previewSessionUpgrade(sourceSessionId: string, targetSnapshotId: string) {
  return upgradePreview(await loadSessionUpgradeState(sourceSessionId, targetSnapshotId));
}

export async function upgradeSessionToSnapshot(sourceSessionId: string, targetSnapshotId: string) {
  return db.transaction(
    "rw",
    [db.snapshots, db.items, db.sessions, db.sessionItems, db.comparisons],
    async () => {
      const state = await loadSessionUpgradeState(sourceSessionId, targetSnapshotId);
      const preview = upgradePreview(state);
      const timestamp = now();
      const session: SortingSession = {
        id: id(),
        profileId: state.source.profileId,
        snapshotId: state.targetSnapshot.id,
        subjectType: state.source.subjectType,
        collectionTypes: [...state.source.collectionTypes],
        title: state.source.title,
        status: "active",
        distribution: { ...state.source.distribution, weights: [...state.source.distribution.weights] },
        randomSeed: crypto.getRandomValues(new Uint32Array(1))[0],
        modelVersion: 0,
        budgetMode: sessionBudgetMode(state.source),
        comparisonReusePolicy: "session",
        maxComparisons: comparisonLimit(state.currentItems.length, sessionBudgetMode(state.source)),
        upgradedFromSessionId: state.source.id,
        tagFilter: collectionTagFilter(state.source.tagFilter?.tags ?? []),
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      const currentIds = new Set(state.currentItems.map((entry) => entry.subjectId));
      const clonedComparisons = cloneRetainedComparisons(state.history, session, currentIds);
      const links = sessionItemLinks(session, state.currentItems);
      await db.sessions.add(session);
      await db.sessionItems.bulkAdd(links);
      if (clonedComparisons.length > 0) await db.comparisons.bulkAdd(clonedComparisons);
      return { session, preview };
    },
  );
}

interface SessionTagDerivationState {
  source: SortingSession;
  snapshot: Snapshot;
  previousItems: CollectionItem[];
  currentItems: CollectionItem[];
  history: ComparisonRecord[];
  tagFilter?: SessionTagFilter;
}

async function loadSessionTagDerivationState(
  sourceSessionId: string,
  requestedTagFilter?: SessionTagFilter,
): Promise<SessionTagDerivationState> {
  const source = await db.sessions.get(sourceSessionId);
  if (!source) throw new Error("原会话不存在，可能已经被删除。");
  const snapshot = await db.snapshots.get(source.snapshotId);
  if (!snapshot) throw new Error("原会话的收藏快照不存在。");
  const tagFilter = collectionTagFilter(requestedTagFilter?.tags ?? []);
  if (sameTagFilter(source.tagFilter, tagFilter)) throw new Error("标签范围没有变化。");

  const [links, snapshotItems] = await Promise.all([
    db.sessionItems.where("sessionId").equals(source.id).toArray(),
    getSnapshotItems(source.snapshotId),
  ]);
  const previousAllowed = new Set(links.map((entry) => entry.subjectId));
  const previousItems = snapshotItems.filter((entry) => previousAllowed.has(entry.subjectId));
  const currentItems = filterScopeItems({ ...source, tagFilter }, snapshotItems);
  if (currentItems.length < 2) throw new Error("筛选后不足两个条目，无法派生会话。");
  const history = await reusableHistory(source, previousAllowed);
  return { source, snapshot, previousItems, currentItems, history, tagFilter };
}

export async function previewSessionTagDerivation(
  sourceSessionId: string,
  tagFilter?: SessionTagFilter,
) {
  const state = await loadSessionTagDerivationState(sourceSessionId, tagFilter);
  return scopePreview(
    state.source,
    state.snapshot,
    state.previousItems,
    state.currentItems,
    state.history,
  );
}

export async function deriveSessionWithTagFilter(
  sourceSessionId: string,
  tagFilter?: SessionTagFilter,
) {
  return db.transaction(
    "rw",
    [db.snapshots, db.items, db.sessions, db.sessionItems, db.comparisons],
    async () => {
      const state = await loadSessionTagDerivationState(sourceSessionId, tagFilter);
      const preview = scopePreview(
        state.source,
        state.snapshot,
        state.previousItems,
        state.currentItems,
        state.history,
      );
      const timestamp = now();
      const session: SortingSession = {
        id: id(),
        profileId: state.source.profileId,
        snapshotId: state.snapshot.id,
        subjectType: state.source.subjectType,
        collectionTypes: [...state.source.collectionTypes],
        title: state.source.title,
        status: "active",
        distribution: { ...state.source.distribution, weights: [...state.source.distribution.weights] },
        randomSeed: crypto.getRandomValues(new Uint32Array(1))[0],
        modelVersion: 0,
        budgetMode: sessionBudgetMode(state.source),
        comparisonReusePolicy: "session",
        maxComparisons: comparisonLimit(state.currentItems.length, sessionBudgetMode(state.source)),
        derivedFromSessionId: state.source.id,
        tagFilter: state.tagFilter,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      const currentIds = new Set(state.currentItems.map((entry) => entry.subjectId));
      const clonedComparisons = cloneRetainedComparisons(state.history, session, currentIds);
      await db.sessions.add(session);
      await db.sessionItems.bulkAdd(sessionItemLinks(session, state.currentItems));
      if (clonedComparisons.length > 0) await db.comparisons.bulkAdd(clonedComparisons);
      return { session, preview };
    },
  );
}

export async function listSessions(profileId?: string): Promise<SortingSession[]> {
  const sessions = profileId
    ? await db.sessions.where("profileId").equals(profileId).toArray()
    : await db.sessions.toArray();
  return sessions.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export async function commitResponse(
  sessionId: string,
  expectedVersion: number,
  pair: {
    recordId?: string;
    leftSubjectId: number;
    rightSubjectId: number;
    queryKind?: ComparisonRecord["queryKind"];
    calibrationOfComparisonId?: string;
  },
  outcome: ComparisonOutcome,
  nextModel: ModelState,
): Promise<SortingSession> {
  return db.transaction("rw", db.sessions, db.comparisons, db.models, async () => {
    const session = await db.sessions.get(sessionId);
    if (!session || session.modelVersion !== expectedVersion) throw new Error("排序会话已在其他页面更新，请刷新后继续。");
    const record: ComparisonRecord = {
      id: pair.recordId ?? id(), profileId: session.profileId, sessionId, subjectType: session.subjectType,
      leftSubjectId: pair.leftSubjectId, rightSubjectId: pair.rightSubjectId, outcome,
      queryKind: pair.queryKind ?? "adaptive", calibrationOfComparisonId: pair.calibrationOfComparisonId,
      acceptedCountAtAnswer: nextModel.acceptedComparisons, active: true, createdAt: now(),
    };
    const updated = {
      ...session,
      modelVersion: expectedVersion + 1,
      status: modelMeetsTarget(nextModel) ? "complete" as const : "active" as const,
      updatedAt: now(),
    };
    await db.comparisons.add(record);
    await db.models.put({ ...nextModel, sessionId, version: expectedVersion + 1, updatedAt: now() });
    await db.sessions.put(updated);
    return updated;
  });
}

export async function initializeModel(sessionId: string, model: ModelState) {
  await db.transaction("rw", db.sessions, db.models, async () => {
    const session = await db.sessions.get(sessionId);
    if (!session) throw new Error("会话不存在。");
    await db.models.put({ ...model, sessionId, version: session.modelVersion, updatedAt: now() });
    await db.sessions.update(sessionId, { status: modelMeetsTarget(model) ? "complete" : "active" });
  });
}

export async function lastActiveResponse(sessionId: string) {
  const active = await db.comparisons.where("sessionId").equals(sessionId).filter((item) => item.active).toArray();
  return active.sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
}

export async function commitUndo(sessionId: string, expectedVersion: number, recordId: string, nextModel: ModelState) {
  return db.transaction("rw", db.sessions, db.comparisons, db.models, async () => {
    const session = await db.sessions.get(sessionId);
    const record = await db.comparisons.get(recordId);
    if (!session || session.modelVersion !== expectedVersion || !record?.active) throw new Error("无法撤销：会话已经更新。");
    await db.comparisons.update(recordId, { active: false });
    const updated = {
      ...session,
      modelVersion: expectedVersion + 1,
      status: modelMeetsTarget(nextModel) ? "complete" as const : "active" as const,
      updatedAt: now(),
    };
    await db.models.put({ ...nextModel, sessionId, version: expectedVersion + 1, updatedAt: now() });
    await db.sessions.put(updated);
    return updated;
  });
}

export async function commitComparisonDeletion(
  sessionId: string,
  expectedVersion: number,
  recordId: string,
  nextModel: ModelState,
) {
  return db.transaction("rw", db.sessions, db.comparisons, db.models, async () => {
    const session = await db.sessions.get(sessionId);
    const record = await db.comparisons.get(recordId);
    if (!session || session.modelVersion !== expectedVersion) throw new Error("排序会话已在其他页面更新，请刷新后继续。");
    if (!record?.active || record.sessionId !== sessionId) throw new Error("这条判断记录不存在，或不属于当前会话。");
    const updated: SortingSession = {
      ...session,
      modelVersion: expectedVersion + 1,
      status: modelMeetsTarget(nextModel) ? "complete" : "active",
      updatedAt: now(),
    };
    await db.comparisons.delete(recordId);
    await db.models.put({ ...nextModel, sessionId, version: expectedVersion + 1, updatedAt: now() });
    await db.sessions.put(updated);
    return updated;
  });
}

export async function deleteSession(sessionId: string): Promise<SortingSession> {
  return db.transaction("rw", [db.sessions, db.sessionItems, db.comparisons, db.models], async () => {
    const session = await db.sessions.get(sessionId);
    if (!session) throw new Error("会话不存在，可能已经被删除。");
    await db.sessionItems.where("sessionId").equals(sessionId).delete();
    await db.comparisons.where("sessionId").equals(sessionId).delete();
    await db.models.delete(sessionId);
    await db.sessions.delete(sessionId);
    return session;
  });
}

function modelMeetsTarget(model?: ModelState) {
  return model?.diagnostics?.ready ?? false;
}

export async function commitSessionDistribution(
  sessionId: string,
  expectedVersion: number,
  distribution: DistributionConfig,
  nextModel: ModelState,
) {
  return db.transaction("rw", db.sessions, db.models, async () => {
    const session = await db.sessions.get(sessionId);
    if (!session || session.modelVersion !== expectedVersion) throw new Error("排序会话已在其他页面更新，请刷新后继续。");
    const updated: SortingSession = {
      ...session,
      distribution,
      modelVersion: expectedVersion + 1,
      status: modelMeetsTarget(nextModel) ? "complete" : "active",
      updatedAt: now(),
    };
    await db.models.put({ ...nextModel, sessionId, version: expectedVersion + 1, updatedAt: now() });
    await db.sessions.put(updated);
    return updated;
  });
}

export async function setSessionComplete(sessionId: string, complete: boolean) {
  await db.sessions.update(sessionId, { status: complete ? "complete" : "active", updatedAt: now() });
}

export async function exportProject(profileId: string): Promise<ExportV1> {
  const profile = await db.profiles.get(profileId);
  if (!profile) throw new Error("项目不存在。");
  const snapshots = await db.snapshots.where("profileId").equals(profileId).toArray();
  const snapshotIds = new Set(snapshots.map((item) => item.id));
  const sessions = await db.sessions.where("profileId").equals(profileId).toArray();
  const sessionIds = new Set(sessions.map((item) => item.id));
  return {
    schemaVersion: 1, appVersion: APP_VERSION, exportedAt: now(), profile, snapshots,
    items: (await db.items.toArray()).filter((item) => snapshotIds.has(item.snapshotId)),
    sessions,
    sessionItems: (await db.sessionItems.toArray()).filter((item) => sessionIds.has(item.sessionId)),
    comparisons: await db.comparisons.where("profileId").equals(profileId).toArray(),
    models: (await db.models.toArray()).filter((item) => sessionIds.has(item.sessionId)),
  };
}

export async function importProject(payload: ExportV1): Promise<Profile> {
  if (payload.schemaVersion !== 1) throw new Error("不支持这个备份文件版本。");
  const suffix = id().slice(0, 8);
  const profileId = `${payload.profile.id}:import:${suffix}`;
  const mapSnapshot = new Map(payload.snapshots.map((item) => [item.id, `${item.id}:import:${suffix}`]));
  const mapSession = new Map(payload.sessions.map((item) => [item.id, `${item.id}:import:${suffix}`]));
  const mapComparison = new Map(payload.comparisons.map((item) => [item.id, id()]));
  const profile = { ...payload.profile, id: profileId, username: `${payload.profile.username}（导入）`, updatedAt: now() };
  const importedAt = now();
  const snapshots = payload.snapshots.map((item, index) => ({ ...item, id: mapSnapshot.get(item.id)!, profileId, syncedAt: new Date(Date.parse(importedAt) + index).toISOString() }));
  const items = payload.items.map((item) => ({ ...item, snapshotId: mapSnapshot.get(item.snapshotId)! }));
  const sessions = payload.sessions.map((item) => ({
    ...item,
    id: mapSession.get(item.id)!,
    profileId,
    snapshotId: mapSnapshot.get(item.snapshotId)!,
    upgradedFromSessionId: item.upgradedFromSessionId
      ? mapSession.get(item.upgradedFromSessionId)
      : undefined,
    derivedFromSessionId: item.derivedFromSessionId
      ? mapSession.get(item.derivedFromSessionId)
      : undefined,
    tagFilter: collectionTagFilter(item.tagFilter?.tags ?? []),
    stoppingTarget: undefined,
    status: "active" as const,
    updatedAt: now(),
  }));
  const sessionItems = payload.sessionItems.map((item) => ({ ...item, id: `${mapSession.get(item.sessionId)}:${item.subjectId}`, sessionId: mapSession.get(item.sessionId)! }));
  const comparisons = payload.comparisons.map((item) => ({
    ...item,
    id: mapComparison.get(item.id)!,
    profileId,
    sessionId: mapSession.get(item.sessionId)!,
    calibrationOfComparisonId: item.calibrationOfComparisonId
      ? mapComparison.get(item.calibrationOfComparisonId)
      : undefined,
  }));
  const models = payload.models.map((item) => ({ ...item, sessionId: mapSession.get(item.sessionId)! }));
  await db.transaction("rw", [db.profiles, db.snapshots, db.items, db.sessions, db.sessionItems, db.comparisons, db.models], async () => {
    await db.profiles.add(profile); await db.snapshots.bulkAdd(snapshots); await db.items.bulkAdd(items);
    await db.sessions.bulkAdd(sessions); await db.sessionItems.bulkAdd(sessionItems);
    await db.comparisons.bulkAdd(comparisons); await db.models.bulkAdd(models);
  });
  return profile;
}

export async function markExported(profileId: string) {
  await db.meta.put({ key: `last-export:${profileId}`, value: now() });
}

export async function getLastExport(profileId: string) {
  return (await db.meta.get(`last-export:${profileId}`))?.value;
}
