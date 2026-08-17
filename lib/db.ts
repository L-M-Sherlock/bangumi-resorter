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
  Snapshot,
  SortingSession,
  SubjectType,
} from "./types";
import { comparisonLimit, sessionReusePolicy } from "./ranking/strategy";

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

export async function createSession(
  snapshot: Snapshot,
  subjectType: SubjectType,
  collectionTypes: CollectionType[],
  distribution: DistributionConfig,
  budgetMode: ComparisonBudgetMode = "quick",
  comparisonReusePolicy: ComparisonReusePolicy = "snapshot",
): Promise<SortingSession> {
  const all = await getSnapshotItems(snapshot.id);
  const selected = all.filter((item) => item.subjectType === subjectType && collectionTypes.includes(item.collectionType));
  if (selected.length < 2) throw new Error("至少需要两个条目才能开始比较。");
  const timestamp = now();
  const session: SortingSession = {
    id: id(), profileId: snapshot.profileId, snapshotId: snapshot.id, subjectType, collectionTypes,
    title: `${snapshot.username} 的排序`, status: "active", distribution,
    randomSeed: crypto.getRandomValues(new Uint32Array(1))[0], modelVersion: 0,
    budgetMode, comparisonReusePolicy,
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
  const reusePolicy = sessionReusePolicy(session);
  let reusableSessionIds: Set<string>;
  if (reusePolicy === "session") {
    reusableSessionIds = new Set([session.id]);
  } else if (reusePolicy === "snapshot") {
    reusableSessionIds = new Set((await db.sessions.where("snapshotId").equals(session.snapshotId).toArray()).map((entry) => entry.id));
  } else {
    reusableSessionIds = new Set((await db.sessions.where("profileId").equals(session.profileId).toArray()).map((entry) => entry.id));
  }
  const history = await db.comparisons
    .where("profileId").equals(session.profileId)
    .filter((entry) => entry.subjectType === session.subjectType
      && entry.active
      && reusableSessionIds.has(entry.sessionId)
      && allowed.has(entry.leftSubjectId)
      && allowed.has(entry.rightSubjectId))
    .toArray();
  const model = await db.models.get(sessionId);
  return { session, items, history, model };
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
      id: id(), profileId: session.profileId, sessionId, subjectType: session.subjectType,
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
