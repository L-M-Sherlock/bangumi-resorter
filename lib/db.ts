"use client";

import Dexie, { EntityTable, Table, Transaction } from "dexie";
import {
  APP_VERSION,
  BackupImportAudit,
  BackupImportCounts,
  BackupImportIdMapping,
  BackupImportPreview,
  BackupImportRequest,
  BackupImportResult,
  CollectionItem,
  CollectionType,
  ComparisonBudgetMode,
  ComparisonHistoryMode,
  ComparisonImportBatch,
  ComparisonImportBatchType,
  ComparisonImportPreview,
  ComparisonImportResult,
  ComparisonImportTarget,
  ComparisonOutcome,
  ComparisonRecord,
  ComparisonReusePolicy,
  DistributionConfig,
  ExportV1,
  SnapshotDeletionPreview,
  SnapshotDeletionRequest,
  SnapshotDeletionResult,
  LocalProject,
  ModelState,
  Profile,
  PriorMode,
  SessionItem,
  SessionScopePreview,
  SessionTagFilter,
  SessionUpgradePreview,
  Snapshot,
  SortingSession,
  SubjectType,
  ValidatedBackup,
} from "./types";
import { legacyPriorMode, sessionBudgetMode, sessionPriorMode } from "./ranking/strategy";
import { collectionTagFilter, filterScopeItems, sameTagFilter } from "./scope";
import { normalizeDistributionConfig } from "./distribution";

interface MetaRecord { key: string; value: string; }

export class ResorterDatabase extends Dexie {
  profiles!: EntityTable<Profile, "id">;
  snapshots!: EntityTable<Snapshot, "id">;
  items!: Table<CollectionItem, [string, number]>;
  sessions!: EntityTable<SortingSession, "id">;
  sessionItems!: EntityTable<SessionItem, "id">;
  comparisons!: EntityTable<ComparisonRecord, "id">;
  models!: EntityTable<ModelState, "sessionId">;
  importBatches!: EntityTable<ComparisonImportBatch, "id">;
  backupImports!: EntityTable<BackupImportAudit, "id">;
  meta!: EntityTable<MetaRecord, "key">;

  constructor(databaseName = "bangumi-resorter") {
    super(databaseName);
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
    this.version(3).stores({
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
        session.maxComparisons = undefined;
      });
    });
    this.version(4).stores({
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
        session.distribution = normalizeDistributionConfig(session.distribution);
      });
    });
    this.version(5).stores({
      profiles: "id, username, updatedAt",
      snapshots: "id, profileId, syncedAt",
      items: "[snapshotId+subjectId], snapshotId, subjectId, subjectType, collectionType, rate",
      sessions: "id, profileId, snapshotId, subjectType, status, updatedAt",
      sessionItems: "id, sessionId, subjectId, [sessionId+subjectId]",
      comparisons: "id, profileId, sessionId, subjectType, active, createdAt, importBatchId, importedFromSessionId",
      models: "sessionId, version, updatedAt",
      importBatches: "id, profileId, targetSessionId, sourceSessionId, createdAt, type",
      meta: "key",
    }).upgrade(async (transaction) => {
      // Freeze every v4 input table before adding any materialized records. This
      // prevents copies created for an earlier target from becoming a source for
      // a later target in the same upgrade.
      const sessionsTable = transaction.table<SortingSession, string>("sessions");
      const linksTable = transaction.table<SessionItem, string>("sessionItems");
      const comparisonsTable = transaction.table<ComparisonRecord, string>("comparisons");
      const batchesTable = transaction.table<ComparisonImportBatch, string>("importBatches");
      const modelsTable = transaction.table<ModelState, string>("models");
      const [sessions, links, comparisons, models] = await Promise.all([
        sessionsTable.toArray(),
        linksTable.toArray(),
        comparisonsTable.toArray(),
        modelsTable.toArray(),
      ]);
      const localized = localizeProjectData(sessions, links, comparisons, [], models);
      await sessionsTable.bulkPut(localized.sessions);
      await comparisonsTable.bulkPut(localized.comparisons);
      if (localized.importBatches.length > 0) await batchesTable.bulkPut(localized.importBatches);
      await modelsTable.clear();
      if (localized.models.length > 0) await modelsTable.bulkPut(localized.models);
    });
    this.version(6).stores({
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
    }).upgrade(async (transaction) => {
      await migrateLegacyImportedClones(transaction);
    });
    this.version(7).stores({
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
    }).upgrade(async (transaction) => {
      const sessions = transaction.table<SortingSession, string>("sessions");
      await sessions.toCollection().modify((session) => {
        session.priorMode = legacyPriorMode(session.budgetMode);
        session.status = "active";
      });
      await transaction.table<ModelState, string>("models").clear();
    });
  }
}

export const db = new ResorterDatabase();

function now() { return new Date().toISOString(); }
function id() { return crypto.randomUUID(); }

const ACTIVE_SNAPSHOT_META_KEY = "active-snapshot";
const LEGACY_IMPORTED_PROFILE = /^(.*):import:[0-9a-f]{8}$/i;
const IMPORTED_USERNAME_SUFFIX = /（导入）$/u;

function canonicalUsername(username: string) {
  return username.trim().replace(/(?:（导入）)+$/gu, "").toLowerCase();
}

async function migrateLegacyImportedClones(transaction: Transaction) {
  const profilesTable = transaction.table<Profile, string>("profiles");
  const snapshotsTable = transaction.table<Snapshot, string>("snapshots");
  const sessionsTable = transaction.table<SortingSession, string>("sessions");
  const comparisonsTable = transaction.table<ComparisonRecord, string>("comparisons");
  const batchesTable = transaction.table<ComparisonImportBatch, string>("importBatches");
  const auditsTable = transaction.table<BackupImportAudit, string>("backupImports");
  const metaTable = transaction.table<MetaRecord, string>("meta");
  const profiles = await profilesTable.toArray();
  const occupiedProfileIds = new Set(profiles.map((entry) => entry.id));
  const cloneGroups = new Map<string, Profile[]>();
  for (const profile of profiles) {
    if (!LEGACY_IMPORTED_PROFILE.test(profile.id) || !IMPORTED_USERNAME_SUFFIX.test(profile.username)) continue;
    const username = canonicalUsername(profile.username);
    const group = cloneGroups.get(username) ?? [];
    group.push(profile);
    cloneGroups.set(username, group);
  }
  for (const [username, clones] of cloneGroups) {
    const existing = profiles.find((entry) => !clones.some((clone) => clone.id === entry.id)
      && canonicalUsername(entry.username) === username);
    const createdAt = [existing, ...clones].filter(Boolean).map((entry) => entry!.createdAt).sort()[0] ?? now();
    const updatedAt = [existing, ...clones].filter(Boolean).map((entry) => entry!.updatedAt).sort().at(-1) ?? createdAt;
    const newestClone = [...clones].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
    let profileId = existing?.id ?? username;
    if (!existing) {
      while (occupiedProfileIds.has(profileId)) profileId = `${username}:account:${id().slice(0, 8)}`;
    }
    const normalizedUsername = existing?.username ?? baseUsername(newestClone.username);
    const cloneIds = new Set(clones.map((entry) => entry.id));
    const snapshots = (await snapshotsTable.toArray()).filter((entry) => cloneIds.has(entry.profileId));
    const sessions = (await sessionsTable.toArray()).filter((entry) => cloneIds.has(entry.profileId));
    const comparisons = (await comparisonsTable.toArray()).filter((entry) => cloneIds.has(entry.profileId));
    const batches = (await batchesTable.toArray()).filter((entry) => cloneIds.has(entry.profileId));
    if (!existing && snapshots.length === 0 && sessions.length === 0 && comparisons.length === 0 && batches.length === 0) {
      await profilesTable.bulkDelete(clones.map((entry) => entry.id));
      for (const clone of clones) occupiedProfileIds.delete(clone.id);
      continue;
    }
    const profile: Profile = existing
      ? { ...existing, createdAt, updatedAt }
      : { ...newestClone, id: profileId, username: normalizedUsername, createdAt, updatedAt };
    await profilesTable.put(profile);
    if (snapshots.length > 0) await snapshotsTable.bulkPut(snapshots.map((entry) => ({ ...entry, profileId, username: profile.username })));
    if (sessions.length > 0) await sessionsTable.bulkPut(sessions.map((entry) => ({ ...entry, profileId })));
    if (comparisons.length > 0) await comparisonsTable.bulkPut(comparisons.map((entry) => ({ ...entry, profileId })));
    if (batches.length > 0) await batchesTable.bulkPut(batches.map((entry) => ({ ...entry, profileId })));
    const active = await metaTable.get(ACTIVE_SNAPSHOT_META_KEY);
    if (active) {
      try {
        const selection = JSON.parse(active.value) as { profileId?: unknown; snapshotId?: unknown };
        if (typeof selection.snapshotId === "string" && cloneIds.has(String(selection.profileId))) {
          await metaTable.put({ key: ACTIVE_SNAPSHOT_META_KEY, value: JSON.stringify({ profileId, snapshotId: selection.snapshotId }) });
        }
      } catch { /* A malformed selection safely falls back during startup. */ }
    }
    await profilesTable.bulkDelete(clones.map((entry) => entry.id));
    for (const clone of clones) occupiedProfileIds.delete(clone.id);
    occupiedProfileIds.add(profileId);
    const timestamp = now();
    await auditsTable.add({
      id: id(), profileId, mode: "legacy-clone-migration", sourceUsername: profile.username,
      createdAt: timestamp, selectedSessionIds: [], dependencySessionIds: [],
      importedSnapshotIds: snapshots.map((entry) => entry.id), importedSessionIds: sessions.map((entry) => entry.id),
      importedComparisonIds: comparisons.map((entry) => entry.id), importedBatchIds: batches.map((entry) => entry.id),
      importedModelSessionIds: [],
      reusedSessionIds: [], conflictSessionIds: [], importedComparisonCount: comparisons.length,
      reusedSessionCount: 0, conflictSessionCount: 0,
      warnings: ["旧版导入副本已归入真实账号；未尝试猜测或删除重复会话。"],
      idMappings: clones.map((entry) => ({ entity: "profile", sourceId: entry.id, targetId: profileId, reason: "legacy-clone" })),
      sessionFingerprints: [], legacyCloneProfileIds: clones.map((entry) => entry.id),
      legacySnapshotIds: snapshots.map((entry) => entry.id), legacySessionIds: sessions.map((entry) => entry.id),
    });
  }
}

let localHistoryMigration: Promise<void> | undefined;

export async function saveSnapshot(
  profileData: Pick<Profile, "username" | "nickname" | "avatar">,
  snapshotId: string,
  items: CollectionItem[],
): Promise<Snapshot> {
  const timestamp = now();
  const username = profileData.username.trim();
  const previous = await findTargetProfile(username);
  const profileId = previous?.id ?? await availableProfileId(username);
  const profile: Profile = {
    id: profileId,
    ...profileData,
    username,
    createdAt: previous?.createdAt ?? timestamp,
    updatedAt: timestamp,
  };
  const snapshot: Snapshot = {
    id: snapshotId,
    profileId,
    username,
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

export async function getSnapshotItems(snapshotId: string): Promise<CollectionItem[]> {
  return db.items.where("snapshotId").equals(snapshotId).toArray();
}

function comparisonRoot(entry: Pick<ComparisonRecord, "id" | "inheritedFromComparisonId">) {
  return entry.inheritedFromComparisonId ?? entry.id;
}

function remapRootReference(root: string | undefined, mapComparison: Map<string, string>) {
  return root ? mapComparison.get(root) ?? root : undefined;
}

function remapDirectComparisonReference(reference: string | undefined, mapComparison: Map<string, string>) {
  return reference ? mapComparison.get(reference) ?? reference : undefined;
}

function comparisonPairKey(left: number, right: number) {
  return left < right ? `${left}:${right}` : `${right}:${left}`;
}

function comparisonOrder(left: ComparisonRecord, right: ComparisonRecord) {
  return left.acceptedCountAtAnswer - right.acceptedCountAtAnswer
    || left.createdAt.localeCompare(right.createdAt)
    || left.id.localeCompare(right.id);
}

function comparisonFingerprint(entry: ComparisonRecord) {
  return [entry.leftSubjectId, entry.rightSubjectId, entry.outcome, entry.queryKind ?? "adaptive", entry.createdAt].join("\u001f");
}

interface ImportPreparation {
  preview: ComparisonImportPreview;
  batch: ComparisonImportBatch;
  records: ComparisonRecord[];
}

interface ImportPreparationOptions {
  target: SortingSession;
  source: SortingSession;
  targetSnapshotId: string;
  sourceSnapshotId: string;
  allowedSubjectIds: Set<number>;
  sourceRecords: ComparisonRecord[];
  targetRecords: ComparisonRecord[];
  type: ComparisonImportBatchType;
  batchId?: string;
  batchCreatedAt?: string;
  recordId?: (entry: ComparisonRecord) => string;
}

/** Reserve the exact materialization identity used to calculate a preview. */
function existingSessionImportIdentity(preview?: ComparisonImportPreview) {
  const plannedIds = new Map((preview?.plannedRecords ?? [])
    .map((entry) => [entry.importedFromComparisonId, entry.id]));
  return {
    batchId: preview?.plannedBatch?.id ?? id(),
    batchCreatedAt: preview?.plannedBatch?.createdAt ?? now(),
    recordId: (entry: ComparisonRecord) => plannedIds.get(entry.id) ?? id(),
  };
}

/**
 * Purely prepares a one-time import. It never reads or writes IndexedDB, which
 * lets creation, future existing-session imports, and legacy migration share
 * exactly the same filtering, provenance, and idempotency rules.
 */
function prepareComparisonImport(options: ImportPreparationOptions): ImportPreparation {
  const {
    target, source, targetSnapshotId, sourceSnapshotId, allowedSubjectIds,
    sourceRecords, targetRecords, type,
  } = options;
  const batchId = options.batchId ?? id();
  const batchCreatedAt = options.batchCreatedAt ?? now();
  const sourceById = new Map(sourceRecords.map((entry) => [entry.id, entry]));
  const targetIdByRoot = new Map<string, string>();
  const targetPairs = new Set<string>();
  for (const entry of targetRecords) {
    if (!entry.active
      || entry.outcome === "skip"
      || entry.subjectType !== target.subjectType
      || !allowedSubjectIds.has(entry.leftSubjectId)
      || !allowedSubjectIds.has(entry.rightSubjectId)) continue;
    targetIdByRoot.set(comparisonRoot(entry), entry.id);
    targetPairs.add(comparisonPairKey(entry.leftSubjectId, entry.rightSubjectId));
  }

  let skippedCount = 0;
  let outOfScopeCount = 0;
  let invalidCalibrationCount = 0;
  let duplicateOriginalCount = 0;
  let duplicatePairCount = 0;
  const eligible = sourceRecords
    .filter((entry) => entry.active)
    .sort(comparisonOrder)
    .filter((entry) => {
      if (entry.outcome === "skip") {
        skippedCount += 1;
        return false;
      }
      if (entry.subjectType !== target.subjectType
        || !allowedSubjectIds.has(entry.leftSubjectId)
        || !allowedSubjectIds.has(entry.rightSubjectId)
        || entry.leftSubjectId === entry.rightSubjectId) {
        outOfScopeCount += 1;
        return false;
      }
      return true;
    });
  const sourceToTarget = new Map<string, string>();
  const pendingIds = new Map<string, string>();
  const validCalibrationTargets = new Map<string, string>();
  let acceptedCount = targetRecords.reduce((max, entry) => Math.max(max, entry.acceptedCountAtAnswer || 0), 0);

  function markDuplicate(entry: ComparisonRecord, targetRecordId: string) {
    duplicateOriginalCount += 1;
    sourceToTarget.set(entry.id, targetRecordId);
  }

  // Phase one maps every ordinary root either to an active target record or to
  // an ID reserved for this batch. No records are emitted yet, so calibration
  // references can be rebuilt without changing source order.
  for (const entry of eligible.filter((candidate) => candidate.queryKind !== "calibration")) {
    const root = comparisonRoot(entry);
    const existingId = targetIdByRoot.get(root);
    if (existingId) {
      markDuplicate(entry, existingId);
      continue;
    }
    const recordId = options.recordId?.(entry) ?? id();
    pendingIds.set(entry.id, recordId);
    sourceToTarget.set(entry.id, recordId);
    targetIdByRoot.set(root, recordId);
  }

  // Phase two validates calibration dependencies and reserves their IDs. An
  // unresolved direct reference may still be a root already owned by target,
  // which keeps old backups with external root strings importable.
  for (const entry of eligible.filter((candidate) => candidate.queryKind === "calibration")) {
    const originalId = entry.calibrationOfComparisonId;
    const original = originalId ? sourceById.get(originalId) : undefined;
    const originalTargetId = originalId
      ? sourceToTarget.get(originalId) ?? targetIdByRoot.get(original ? comparisonRoot(original) : originalId)
      : undefined;
    if (!originalTargetId || original?.outcome === "skip") {
      invalidCalibrationCount += 1;
      continue;
    }
    const root = comparisonRoot(entry);
    const existingId = targetIdByRoot.get(root);
    if (existingId) {
      markDuplicate(entry, existingId);
      continue;
    }
    const recordId = options.recordId?.(entry) ?? id();
    pendingIds.set(entry.id, recordId);
    sourceToTarget.set(entry.id, recordId);
    targetIdByRoot.set(root, recordId);
    validCalibrationTargets.set(entry.id, originalTargetId);
  }

  // Phase three emits records in the source's local sequence. Imported
  // accepted-count values are target-local and therefore append monotonically.
  const created: ComparisonRecord[] = [];
  for (const entry of eligible) {
    const recordId = pendingIds.get(entry.id);
    if (!recordId) continue;
    const pairKey = comparisonPairKey(entry.leftSubjectId, entry.rightSubjectId);
    if (targetPairs.has(pairKey)) duplicatePairCount += 1;
    acceptedCount += 1;
    const record: ComparisonRecord = {
      ...entry,
      id: recordId,
      profileId: target.profileId,
      sessionId: target.id,
      active: true,
      acceptedCountAtAnswer: acceptedCount,
      createdAt: new Date(Date.parse(batchCreatedAt) + created.length).toISOString(),
      sourceCreatedAt: entry.sourceCreatedAt ?? entry.createdAt,
      importBatchId: batchId,
      importedFromSessionId: source.id,
      importedFromComparisonId: entry.id,
      inheritedFromComparisonId: comparisonRoot(entry),
      calibrationOfComparisonId: entry.queryKind === "calibration"
        ? validCalibrationTargets.get(entry.id)
        : undefined,
    };
    created.push(record);
    targetPairs.add(pairKey);
  }

  const batch: ComparisonImportBatch = {
    id: batchId,
    profileId: target.profileId,
    targetSessionId: target.id,
    sourceSessionId: source.id || undefined,
    sourceSnapshotId,
    targetSnapshotId,
    sourceModelVersion: source.modelVersion,
    type,
    createdAt: batchCreatedAt,
    importedCount: created.length,
    duplicateOriginalCount,
    duplicatePairCount,
    outOfScopeCount,
    skippedCount,
    invalidCalibrationCount,
  };
  const preview: ComparisonImportPreview = {
    targetSessionId: target.id || undefined,
    sourceSessionId: source.id,
    targetVersion: target.modelVersion,
    sourceVersion: source.modelVersion,
    sourceTitle: source.title,
    sourceSnapshotId,
    targetSnapshotId,
    crossSnapshot: sourceSnapshotId !== targetSnapshotId,
    dedupeByRoot: true,
    importableCount: created.length,
    duplicateOriginalCount,
    duplicatePairCount,
    outOfScopeCount,
    skippedCount,
    invalidCalibrationCount,
  };
  return { preview, batch, records: created };
}

async function localSessionHistory(session: SortingSession, allowed: Set<number>) {
  return (await db.comparisons.where("sessionId").equals(session.id)
    .filter((entry) => entry.subjectType === session.subjectType
      && entry.active
      && allowed.has(entry.leftSubjectId)
      && allowed.has(entry.rightSubjectId))
    .toArray()).sort(comparisonOrder);
}

function legacyVisibleHistory(
  target: SortingSession,
  allowed: Set<number>,
  sessions: SortingSession[],
  comparisons: ComparisonRecord[],
) {
  const policy = target.comparisonReusePolicy ?? "profile";
  const reusableSessionIds = new Set(sessions
    .filter((candidate) => candidate.profileId === target.profileId
      && (policy === "profile"
        || (policy === "snapshot" && candidate.snapshotId === target.snapshotId)
        || (policy === "session" && candidate.id === target.id)))
    .map((candidate) => candidate.id));
  const outwardSafe = comparisons.filter((entry) => entry.profileId === target.profileId
    && entry.subjectType === target.subjectType
    && entry.active
    && reusableSessionIds.has(entry.sessionId)
    && allowed.has(entry.leftSubjectId)
    && allowed.has(entry.rightSubjectId)
    && (entry.sessionId === target.id || !entry.inheritedFromComparisonId));
  const byFingerprint = new Map<string, ComparisonRecord[]>();
  for (const entry of outwardSafe) {
    const group = byFingerprint.get(comparisonFingerprint(entry)) ?? [];
    group.push(entry);
    byFingerprint.set(comparisonFingerprint(entry), group);
  }
  return [...byFingerprint.values()].flatMap((group) => {
    if (new Set(group.map((entry) => entry.sessionId)).size === 1) return group;
    const local = group.filter((entry) => entry.sessionId === target.id);
    if (local.length > 0) return local;
    return [group.sort((left, right) => left.createdAt.localeCompare(right.createdAt)
      || left.sessionId.localeCompare(right.sessionId)
      || left.id.localeCompare(right.id))[0]];
  }).sort(comparisonOrder);
}

interface LocalizedProjectData {
  sessions: SortingSession[];
  comparisons: ComparisonRecord[];
  importBatches: ComparisonImportBatch[];
  models: ModelState[];
}

/** Materializes legacy dynamic visibility in an in-memory project snapshot. */
function localizeProjectData(
  sessionsInput: SortingSession[],
  sessionItems: SessionItem[],
  comparisonsInput: ComparisonRecord[],
  batchesInput: ComparisonImportBatch[],
  modelsInput: ModelState[],
  deterministic?: { key: string; timestamp: string },
): LocalizedProjectData {
  const sessions = sessionsInput.map((session) => ({ ...session }));
  const comparisons = comparisonsInput.map((entry) => ({ ...entry }));
  const importBatches = batchesInput.map((entry) => ({ ...entry }));
  const occupiedComparisonIds = new Set(comparisons.map((entry) => entry.id));
  const occupiedBatchIds = new Set(importBatches.map((entry) => entry.id));
  const compatibilityId = (prefix: string, seed: unknown, occupied: Set<string>) => {
    let candidate = `${prefix}:${compactHash(seed)}`;
    let suffix = 0;
    while (occupied.has(candidate)) candidate = `${prefix}:${compactHash([seed, ++suffix])}`;
    occupied.add(candidate);
    return candidate;
  };
  const legacy = sessions.filter((session) => session.comparisonHistoryMode !== "local");
  if (legacy.length === 0) return { sessions, comparisons, importBatches, models: modelsInput };
  const linksBySession = new Map<string, Set<number>>();
  for (const link of sessionItems) {
    const allowed = linksBySession.get(link.sessionId) ?? new Set<number>();
    allowed.add(link.subjectId);
    linksBySession.set(link.sessionId, allowed);
  }
  const sessionById = new Map(sessions.map((session) => [session.id, session]));
  const legacyComparisonSnapshot = comparisons.map((entry) => ({ ...entry }));
  const legacySessionSnapshot = sessions.map((session) => ({ ...session }));
  for (const target of legacy) {
    const allowed = linksBySession.get(target.id) ?? new Set<number>();
    const visible = legacyVisibleHistory(target, allowed, legacySessionSnapshot, legacyComparisonSnapshot);
    let targetRecords = comparisons.filter((entry) => entry.sessionId === target.id);
    const preexistingImported = targetRecords.filter((entry) => entry.inheritedFromComparisonId && !entry.importBatchId);
    if (preexistingImported.length > 0) {
      const sourceSessionId = target.upgradedFromSessionId ?? target.derivedFromSessionId;
      const batchId = deterministic
        ? compatibilityId("compat-batch", [deterministic.key, target.id, sourceSessionId ?? "", "preexisting"], occupiedBatchIds)
        : id();
      const sourceSession = sourceSessionId ? sessionById.get(sourceSessionId) : undefined;
      for (const entry of preexistingImported) {
        const directSource = sourceSessionId
          ? legacyComparisonSnapshot.find((candidate) => candidate.sessionId === sourceSessionId
            && comparisonRoot(candidate) === entry.inheritedFromComparisonId)
          : undefined;
        entry.importBatchId = batchId;
        entry.importedFromSessionId = sourceSessionId;
        entry.importedFromComparisonId = directSource?.id ?? entry.inheritedFromComparisonId;
        entry.sourceCreatedAt = entry.sourceCreatedAt ?? entry.createdAt;
      }
      importBatches.push({
        id: batchId, profileId: target.profileId, targetSessionId: target.id,
        sourceSessionId, sourceSnapshotId: sourceSession?.snapshotId, targetSnapshotId: target.snapshotId,
        sourceModelVersion: sourceSession?.modelVersion, type: "migration", createdAt: deterministic?.timestamp ?? now(),
        importedCount: preexistingImported.length, duplicateOriginalCount: 0, duplicatePairCount: 0,
        outOfScopeCount: 0, skippedCount: 0, invalidCalibrationCount: 0,
      });
    }
    const externalBySession = new Map<string, ComparisonRecord[]>();
    for (const entry of visible) {
      if (entry.sessionId === target.id) continue;
      const group = externalBySession.get(entry.sessionId) ?? [];
      group.push(entry);
      externalBySession.set(entry.sessionId, group);
    }
    for (const [sourceSessionId, sourceRecords] of [...externalBySession.entries()].sort(([, left], [, right]) => comparisonOrder(left[0], right[0]))) {
      const source = sessionById.get(sourceSessionId);
      if (!source) continue;
      const prepared = prepareComparisonImport({
        target, source, targetSnapshotId: target.snapshotId, sourceSnapshotId: source.snapshotId,
        allowedSubjectIds: allowed, sourceRecords, targetRecords, type: "migration",
        batchId: deterministic
          ? compatibilityId("compat-batch", [deterministic.key, target.id, sourceSessionId], occupiedBatchIds)
          : undefined,
        batchCreatedAt: deterministic?.timestamp,
        recordId: deterministic
          ? (entry) => compatibilityId("compat-comparison", [deterministic.key, target.id, sourceSessionId, entry.id], occupiedComparisonIds)
          : undefined,
      });
      comparisons.push(...prepared.records);
      importBatches.push(prepared.batch);
      targetRecords = [...targetRecords, ...prepared.records];
    }
    target.comparisonHistoryMode = "local";
    target.comparisonReusePolicy = "session";
    target.status = "active";
  }
  const legacyIds = new Set(legacy.map((session) => session.id));
  return {
    sessions,
    comparisons,
    importBatches,
    models: modelsInput.filter((model) => !legacyIds.has(model.sessionId)),
  };
}

async function materializeLegacyHistory() {
  const sessions = await db.sessions.toArray();
  const legacy = sessions.filter((session) => session.comparisonHistoryMode !== "local");
  if (legacy.length === 0) return;
  const [links, comparisonSnapshot] = await Promise.all([
    db.sessionItems.toArray(),
    db.comparisons.toArray(),
  ]);
  const linksBySession = new Map<string, Set<number>>();
  for (const link of links) {
    const allowed = linksBySession.get(link.sessionId) ?? new Set<number>();
    allowed.add(link.subjectId);
    linksBySession.set(link.sessionId, allowed);
  }
  const sessionById = new Map(sessions.map((session) => [session.id, session]));
  const recordsToPut: ComparisonRecord[] = [];
  const batchesToPut: ComparisonImportBatch[] = [];

  for (const target of legacy) {
    const allowed = linksBySession.get(target.id) ?? new Set<number>();
    const visible = legacyVisibleHistory(target, allowed, sessions, comparisonSnapshot);
    let targetRecords = comparisonSnapshot
      .filter((entry) => entry.sessionId === target.id)
      .map((entry) => ({ ...entry }));

    // Older upgrade/derive sessions already own copies but do not have an
    // import batch. Annotate them so undo and audit behavior matches new data.
    const preexistingImported = targetRecords.filter((entry) => entry.inheritedFromComparisonId && !entry.importBatchId);
    if (preexistingImported.length > 0) {
      const batchId = id();
      const sourceSessionId = target.upgradedFromSessionId ?? target.derivedFromSessionId;
      const sourceSession = sourceSessionId ? sessionById.get(sourceSessionId) : undefined;
      for (const entry of preexistingImported) {
        const directSource = sourceSessionId
          ? comparisonSnapshot.find((candidate) => candidate.sessionId === sourceSessionId
            && comparisonRoot(candidate) === entry.inheritedFromComparisonId)
          : undefined;
        entry.importBatchId = batchId;
        entry.importedFromSessionId = sourceSessionId;
        entry.importedFromComparisonId = directSource?.id ?? entry.inheritedFromComparisonId;
        entry.sourceCreatedAt = entry.sourceCreatedAt ?? entry.createdAt;
        recordsToPut.push(entry);
      }
      batchesToPut.push({
        id: batchId,
        profileId: target.profileId,
        targetSessionId: target.id,
        sourceSessionId,
        sourceSnapshotId: sourceSession?.snapshotId,
        targetSnapshotId: target.snapshotId,
        sourceModelVersion: sourceSession?.modelVersion,
        type: "migration",
        createdAt: now(),
        importedCount: preexistingImported.length,
        duplicateOriginalCount: 0,
        duplicatePairCount: 0,
        outOfScopeCount: 0,
        skippedCount: 0,
        invalidCalibrationCount: 0,
      });
    }

    const externalBySession = new Map<string, ComparisonRecord[]>();
    for (const entry of visible) {
      if (entry.sessionId === target.id) continue;
      const group = externalBySession.get(entry.sessionId) ?? [];
      group.push(entry);
      externalBySession.set(entry.sessionId, group);
    }
    const orderedSources = [...externalBySession.entries()].sort(([, left], [, right]) =>
      comparisonOrder(left[0], right[0]));
    for (const [sourceSessionId, sourceRecords] of orderedSources) {
      const source = sessionById.get(sourceSessionId);
      if (!source) continue;
      const prepared = prepareComparisonImport({
        target,
        source,
        targetSnapshotId: target.snapshotId,
        sourceSnapshotId: source.snapshotId,
        allowedSubjectIds: allowed,
        sourceRecords,
        targetRecords,
        type: "migration",
      });
      targetRecords = [...targetRecords, ...prepared.records];
      batchesToPut.push(prepared.batch);
      recordsToPut.push(...prepared.records);
    }
  }

  await db.transaction("rw", [db.sessions, db.comparisons, db.importBatches, db.models], async () => {
    // Recheck the marker inside the transaction so concurrent app tabs cannot
    // materialize the same dynamic histories twice.
    const stillLegacy = new Set((await db.sessions.toArray())
      .filter((session) => session.comparisonHistoryMode !== "local")
      .map((session) => session.id));
    if (stillLegacy.size === 0) return;
    const safeRecords = recordsToPut.filter((entry) => stillLegacy.has(entry.sessionId));
    const safeBatches = batchesToPut.filter((entry) => stillLegacy.has(entry.targetSessionId));
    if (safeBatches.length > 0) await db.importBatches.bulkPut(safeBatches);
    if (safeRecords.length > 0) await db.comparisons.bulkPut(safeRecords);
    for (const sessionId of stillLegacy) {
      await db.sessions.update(sessionId, {
        comparisonHistoryMode: "local" as ComparisonHistoryMode,
        comparisonReusePolicy: "session" as ComparisonReusePolicy,
        status: "active" as const,
      });
      await db.models.delete(sessionId);
    }
  });
}

export async function ensureLocalHistory() {
  if (localHistoryMigration) return localHistoryMigration;
  localHistoryMigration = materializeLegacyHistory().finally(() => {
    localHistoryMigration = undefined;
  });
  return localHistoryMigration;
}

export async function previewComparisonImport(
  sourceSessionId: string,
  target: ComparisonImportTarget,
): Promise<ComparisonImportPreview> {
  await ensureLocalHistory();
  const source = await db.sessions.get(sourceSessionId);
  if (!source) throw new Error("来源会话不存在，可能已经被删除。");
  let targetSession: SortingSession;
  let targetRecords: ComparisonRecord[] = [];
  let targetSnapshotId = target.snapshotId;
  let allowedSubjectIds = new Set(target.allowedSubjectIds);
  if (target.targetSessionId) {
    const stored = await db.sessions.get(target.targetSessionId);
    if (!stored) throw new Error("目标会话不存在，可能已经被删除。");
    if (stored.id === source.id) throw new Error("不能把会话导入到它自己。");
    if (target.profileId !== stored.profileId || target.subjectType !== stored.subjectType
      || target.snapshotId !== stored.snapshotId) {
      throw new Error("目标会话范围已经变化，请重新打开后预览。");
    }
    targetSession = stored;
    const [storedLinks, storedRecords] = await Promise.all([
      db.sessionItems.where("sessionId").equals(stored.id).toArray(),
      db.comparisons.where("sessionId").equals(stored.id).toArray(),
    ]);
    targetRecords = storedRecords;
    targetSnapshotId = stored.snapshotId;
    allowedSubjectIds = new Set(storedLinks.map((entry) => entry.subjectId));
  } else {
    targetSession = {
      id: "",
      profileId: target.profileId,
      snapshotId: target.snapshotId,
      subjectType: target.subjectType,
      collectionTypes: [],
      title: "新会话",
      status: "active",
      distribution: { preset: "uniform", levelCount: 10, weights: Array(10).fill(10) },
      randomSeed: 0,
      modelVersion: target.targetVersion ?? 0,
      comparisonHistoryMode: "local",
      createdAt: "",
      updatedAt: "",
    };
  }
  if (source.profileId !== targetSession.profileId || source.subjectType !== targetSession.subjectType) {
    throw new Error("来源会话必须属于同一账号且作品类型相同。");
  }
  if (target.targetVersion !== undefined && targetSession.modelVersion !== target.targetVersion) {
    throw new Error("目标会话已经更新，请重新预览。");
  }
  const sourceRecords = await db.comparisons.where("sessionId").equals(source.id).toArray();
  const identity = target.targetSessionId ? existingSessionImportIdentity() : undefined;
  const prepared = prepareComparisonImport({
    target: targetSession,
    source,
    targetSnapshotId,
    sourceSnapshotId: source.snapshotId,
    allowedSubjectIds,
    sourceRecords,
    targetRecords,
    type: target.targetSessionId ? "existing-session" : "new-session",
    batchId: identity?.batchId ?? "preview",
    batchCreatedAt: identity?.batchCreatedAt ?? new Date(0).toISOString(),
    recordId: identity?.recordId,
  });
  return target.targetSessionId
    ? { ...prepared.preview, plannedBatch: prepared.batch, plannedRecords: prepared.records }
    : prepared.preview;
}

export async function commitComparisonImport(
  targetSessionId: string,
  sourceSessionId: string,
  expectedTargetVersion: number,
  expectedSourceVersion: number,
  nextModel: ModelState,
  expectedPreview?: ComparisonImportPreview,
): Promise<ComparisonImportResult> {
  await ensureLocalHistory();
  return db.transaction("rw", [db.sessions, db.sessionItems, db.comparisons, db.importBatches, db.models], async () => {
    const [target, source] = await Promise.all([
      db.sessions.get(targetSessionId),
      db.sessions.get(sourceSessionId),
    ]);
    if (!target || target.modelVersion !== expectedTargetVersion) throw new Error("目标会话已经更新，请重新预览。");
    if (!source || source.modelVersion !== expectedSourceVersion) throw new Error("来源会话已经更新，请重新预览。");
    if (source.id === target.id) throw new Error("不能把会话导入到它自己。");
    if (source.profileId !== target.profileId || source.subjectType !== target.subjectType) {
      throw new Error("来源会话必须属于同一账号且作品类型相同。");
    }
    const [links, sourceRecords, targetRecords] = await Promise.all([
      db.sessionItems.where("sessionId").equals(target.id).toArray(),
      db.comparisons.where("sessionId").equals(source.id).toArray(),
      db.comparisons.where("sessionId").equals(target.id).toArray(),
    ]);
    const allowedSubjectIds = new Set(links.map((entry) => entry.subjectId));
    const identity = existingSessionImportIdentity(expectedPreview);
    const prepared = prepareComparisonImport({
      target,
      source,
      targetSnapshotId: target.snapshotId,
      sourceSnapshotId: source.snapshotId,
      allowedSubjectIds,
      sourceRecords,
      targetRecords,
      type: "existing-session",
      batchId: identity.batchId,
      batchCreatedAt: identity.batchCreatedAt,
      recordId: identity.recordId,
    });
    if (expectedPreview && (
      !expectedPreview.plannedBatch
      || !expectedPreview.plannedRecords
      || expectedPreview.targetSessionId !== target.id
      || expectedPreview.sourceSessionId !== source.id
      || expectedPreview.targetVersion !== expectedTargetVersion
      || expectedPreview.sourceVersion !== expectedSourceVersion
      || expectedPreview.importableCount !== prepared.preview.importableCount
      || expectedPreview.duplicateOriginalCount !== prepared.preview.duplicateOriginalCount
      || expectedPreview.duplicatePairCount !== prepared.preview.duplicatePairCount
      || expectedPreview.outOfScopeCount !== prepared.preview.outOfScopeCount
      || expectedPreview.skippedCount !== prepared.preview.skippedCount
      || expectedPreview.invalidCalibrationCount !== prepared.preview.invalidCalibrationCount
      || stableJson(expectedPreview.plannedBatch) !== stableJson(prepared.batch)
      || stableJson(expectedPreview.plannedRecords) !== stableJson(prepared.records)
    )) {
      throw new Error("导入预览已经变化，请重新预览。");
    }
    if (nextModel.sessionId !== target.id || nextModel.version !== expectedTargetVersion + 1
      || nextModel.acceptedComparisons !== targetRecords.filter((entry) => entry.active
        && entry.outcome !== "skip"
        && entry.subjectType === target.subjectType
        && allowedSubjectIds.has(entry.leftSubjectId)
        && allowedSubjectIds.has(entry.rightSubjectId)
        && entry.leftSubjectId !== entry.rightSubjectId).length + prepared.records.length) {
      throw new Error("重算模型与待提交的导入记录不一致，请重新预览。");
    }
    const nextVersion = expectedTargetVersion + 1;
    const updated: SortingSession = {
      ...target,
      modelVersion: nextVersion,
      comparisonHistoryMode: "local",
      comparisonReusePolicy: "session",
      status: modelMeetsTarget(nextModel) ? "complete" : "active",
      updatedAt: now(),
    };
    await db.importBatches.add(prepared.batch);
    if (prepared.records.length > 0) await db.comparisons.bulkAdd(prepared.records);
    await db.models.put({ ...nextModel, sessionId: target.id, version: nextVersion, updatedAt: now() });
    await db.sessions.put(updated);
    return { session: updated, ...prepared };
  });
}

interface CreateSessionOptions {
  budgetMode?: ComparisonBudgetMode;
  priorMode?: PriorMode;
  tagFilter?: SessionTagFilter;
  sourceSessionId?: string;
  expectedSourceVersion?: number;
  /** Legacy field accepted only for old callers; it no longer controls loading. */
  comparisonReusePolicy?: ComparisonReusePolicy;
}

export async function createSession(
  snapshot: Snapshot,
  subjectType: SubjectType,
  collectionTypes: CollectionType[],
  distribution: DistributionConfig,
  budgetModeOrOptions: ComparisonBudgetMode | CreateSessionOptions = "quick",
  legacyComparisonReusePolicy?: ComparisonReusePolicy,
  legacyTagFilter?: SessionTagFilter,
  legacySourceSessionId?: string,
): Promise<SortingSession> {
  await ensureLocalHistory();
  const options: CreateSessionOptions = typeof budgetModeOrOptions === "string"
    ? {
      budgetMode: budgetModeOrOptions,
      comparisonReusePolicy: legacyComparisonReusePolicy,
      tagFilter: legacyTagFilter,
      sourceSessionId: legacySourceSessionId,
    }
    : budgetModeOrOptions;
  const budgetMode = options.budgetMode ?? "quick";
  const priorMode = options.priorMode ?? "weak";
  const tagFilter = options.tagFilter;
  const all = await getSnapshotItems(snapshot.id);
  const normalizedTagFilter = collectionTagFilter(tagFilter?.tags ?? []);
  const selected = filterScopeItems({ subjectType, collectionTypes, tagFilter: normalizedTagFilter }, all);
  if (selected.length < 2) throw new Error("至少需要两个条目才能开始比较。");
  const timestamp = now();
  const session: SortingSession = {
    id: id(), profileId: snapshot.profileId, snapshotId: snapshot.id, subjectType, collectionTypes,
    title: `${snapshot.username} 的排序`, status: "active", distribution: normalizeDistributionConfig(distribution),
    randomSeed: crypto.getRandomValues(new Uint32Array(1))[0], modelVersion: 0,
    budgetMode, priorMode, comparisonReusePolicy: "session",
    comparisonHistoryMode: "local", tagFilter: normalizedTagFilter,
    createdAt: timestamp, updatedAt: timestamp,
  };
  const links = selected.map<SessionItem>((item) => ({ id: `${session.id}:${item.subjectId}`, sessionId: session.id, subjectId: item.subjectId }));
  await db.transaction("rw", [db.sessions, db.sessionItems, db.comparisons, db.importBatches], async () => {
    const source = options.sourceSessionId ? await db.sessions.get(options.sourceSessionId) : undefined;
    if (options.sourceSessionId && !source) throw new Error("来源会话不存在，可能已经被删除。");
    if (source && (source.profileId !== snapshot.profileId || source.subjectType !== subjectType)) {
      throw new Error("来源会话必须属于同一账号且作品类型相同。");
    }
    if (source?.id === session.id) throw new Error("不能把会话导入到它自己。");
    if (source && options.expectedSourceVersion !== undefined
      && source.modelVersion !== options.expectedSourceVersion) {
      throw new Error("来源会话已经更新，请重新预览。");
    }
    await db.sessions.add(session);
    await db.sessionItems.bulkAdd(links);
    if (source) {
      const sourceRecords = await db.comparisons.where("sessionId").equals(source.id).toArray();
      const prepared = prepareComparisonImport({
        target: session,
        source,
        targetSnapshotId: snapshot.id,
        sourceSnapshotId: source.snapshotId,
        allowedSubjectIds: new Set(selected.map((entry) => entry.subjectId)),
        sourceRecords,
        targetRecords: [],
        type: "new-session",
      });
      await db.importBatches.add(prepared.batch);
      if (prepared.records.length > 0) await db.comparisons.bulkAdd(prepared.records);
    }
  });
  return session;
}

export async function getSessionBundle(sessionId: string) {
  await ensureLocalHistory();
  const session = await db.sessions.get(sessionId);
  if (!session) return undefined;
  const links = await db.sessionItems.where("sessionId").equals(sessionId).toArray();
  const allowed = new Set(links.map((item) => item.subjectId));
  const snapshotItems = await getSnapshotItems(session.snapshotId);
  const items = snapshotItems.filter((item) => allowed.has(item.subjectId));
  const history = await localSessionHistory(session, allowed);
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
  const history = await localSessionHistory(source, previousAllowed);
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
  const informative = history.filter((entry) => entry.active && entry.outcome !== "skip");
  const previewTarget: SortingSession = {
    ...source,
    id: "scope-preview",
    snapshotId: targetSnapshot.id,
    modelVersion: 0,
    comparisonHistoryMode: "local",
    comparisonReusePolicy: "session",
  };
  const prepared = prepareComparisonImport({
    target: previewTarget,
    source,
    targetSnapshotId: targetSnapshot.id,
    sourceSnapshotId: source.snapshotId,
    allowedSubjectIds: new Set(currentById.keys()),
    sourceRecords: history,
    targetRecords: [],
    type: source.snapshotId === targetSnapshot.id ? "derive" : "upgrade",
    batchId: "scope-preview",
    batchCreatedAt: new Date(0).toISOString(),
  });
  const inheritedComparisonCount = prepared.records.length;
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

function sessionItemLinks(session: SortingSession, items: CollectionItem[]) {
  return items.map<SessionItem>((entry) => ({
    id: `${session.id}:${entry.subjectId}`,
    sessionId: session.id,
    subjectId: entry.subjectId,
  }));
}

export async function previewSessionUpgrade(sourceSessionId: string, targetSnapshotId: string) {
  await ensureLocalHistory();
  return upgradePreview(await loadSessionUpgradeState(sourceSessionId, targetSnapshotId));
}

export async function upgradeSessionToSnapshot(sourceSessionId: string, targetSnapshotId: string) {
  await ensureLocalHistory();
  return db.transaction(
    "rw",
    [db.snapshots, db.items, db.sessions, db.sessionItems, db.comparisons, db.importBatches],
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
        distribution: normalizeDistributionConfig(state.source.distribution),
        randomSeed: crypto.getRandomValues(new Uint32Array(1))[0],
        modelVersion: 0,
        budgetMode: sessionBudgetMode(state.source),
        priorMode: sessionPriorMode(state.source),
        comparisonReusePolicy: "session",
        comparisonHistoryMode: "local",
        upgradedFromSessionId: state.source.id,
        tagFilter: collectionTagFilter(state.source.tagFilter?.tags ?? []),
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      const links = sessionItemLinks(session, state.currentItems);
      await db.sessions.add(session);
      await db.sessionItems.bulkAdd(links);
      const prepared = prepareComparisonImport({
        target: session,
        source: state.source,
        targetSnapshotId: state.targetSnapshot.id,
        sourceSnapshotId: state.source.snapshotId,
        allowedSubjectIds: new Set(state.currentItems.map((entry) => entry.subjectId)),
        sourceRecords: state.history,
        targetRecords: [],
        type: "upgrade",
      });
      await db.importBatches.add(prepared.batch);
      if (prepared.records.length > 0) await db.comparisons.bulkAdd(prepared.records);
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
  const history = await localSessionHistory(source, previousAllowed);
  return { source, snapshot, previousItems, currentItems, history, tagFilter };
}

export async function previewSessionTagDerivation(
  sourceSessionId: string,
  tagFilter?: SessionTagFilter,
) {
  await ensureLocalHistory();
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
  await ensureLocalHistory();
  return db.transaction(
    "rw",
    [db.snapshots, db.items, db.sessions, db.sessionItems, db.comparisons, db.importBatches],
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
        distribution: normalizeDistributionConfig(state.source.distribution),
        randomSeed: crypto.getRandomValues(new Uint32Array(1))[0],
        modelVersion: 0,
        budgetMode: sessionBudgetMode(state.source),
        priorMode: sessionPriorMode(state.source),
        comparisonReusePolicy: "session",
        comparisonHistoryMode: "local",
        derivedFromSessionId: state.source.id,
        tagFilter: state.tagFilter,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      await db.sessions.add(session);
      await db.sessionItems.bulkAdd(sessionItemLinks(session, state.currentItems));
      const prepared = prepareComparisonImport({
        target: session,
        source: state.source,
        targetSnapshotId: state.snapshot.id,
        sourceSnapshotId: state.source.snapshotId,
        allowedSubjectIds: new Set(state.currentItems.map((entry) => entry.subjectId)),
        sourceRecords: state.history,
        targetRecords: [],
        type: "derive",
      });
      await db.importBatches.add(prepared.batch);
      if (prepared.records.length > 0) await db.comparisons.bulkAdd(prepared.records);
      return { session, preview };
    },
  );
}

export async function listSessions(profileId?: string): Promise<SortingSession[]> {
  await ensureLocalHistory();
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
  const active = await db.comparisons.where("sessionId").equals(sessionId)
    .filter((item) => item.active && !item.importBatchId && !item.inheritedFromComparisonId)
    .toArray();
  return active.sort((left, right) => right.acceptedCountAtAnswer - left.acceptedCountAtAnswer
    || right.createdAt.localeCompare(left.createdAt))[0];
}

export async function commitUndo(sessionId: string, expectedVersion: number, recordId: string, nextModel: ModelState) {
  return db.transaction("rw", db.sessions, db.comparisons, db.models, async () => {
    const session = await db.sessions.get(sessionId);
    const record = await db.comparisons.get(recordId);
    if (!session || session.modelVersion !== expectedVersion || !record?.active
      || record.sessionId !== sessionId || record.importBatchId || record.inheritedFromComparisonId) {
      throw new Error("无法撤销：会话已经更新。");
    }
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
  return db.transaction("rw", [db.sessions, db.sessionItems, db.comparisons, db.models, db.importBatches], async () => {
    const session = await db.sessions.get(sessionId);
    if (!session) throw new Error("会话不存在，可能已经被删除。");
    await db.sessionItems.where("sessionId").equals(sessionId).delete();
    await db.comparisons.where("sessionId").equals(sessionId).delete();
    await db.models.delete(sessionId);
    await db.importBatches.where("targetSessionId").equals(sessionId).delete();
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
      distribution: normalizeDistributionConfig(distribution),
      modelVersion: expectedVersion + 1,
      status: modelMeetsTarget(nextModel) ? "complete" : "active",
      updatedAt: now(),
    };
    await db.models.put({ ...nextModel, sessionId, version: expectedVersion + 1, updatedAt: now() });
    await db.sessions.put(updated);
    return updated;
  });
}

export async function commitSessionBudgetMode(
  sessionId: string,
  expectedVersion: number,
  budgetMode: ComparisonBudgetMode,
  nextModel: ModelState,
) {
  return db.transaction("rw", db.sessions, db.models, async () => {
    const session = await db.sessions.get(sessionId);
    if (!session || session.modelVersion !== expectedVersion) throw new Error("排序会话已在其他页面更新，请刷新后继续。");
    const updated: SortingSession = {
      ...session,
      budgetMode,
      modelVersion: expectedVersion + 1,
      status: modelMeetsTarget(nextModel) ? "complete" : "active",
      updatedAt: now(),
    };
    await db.models.put({ ...nextModel, sessionId, version: expectedVersion + 1, updatedAt: now() });
    await db.sessions.put(updated);
    return updated;
  });
}

export async function commitSessionPriorMode(
  sessionId: string,
  expectedVersion: number,
  priorMode: PriorMode,
  nextModel: ModelState,
) {
  return db.transaction("rw", db.sessions, db.models, async () => {
    const session = await db.sessions.get(sessionId);
    if (!session || session.modelVersion !== expectedVersion) throw new Error("排序会话已在其他页面更新，请刷新后继续。");
    const updated: SortingSession = {
      ...session,
      priorMode,
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
  await ensureLocalHistory();
  const profile = await db.profiles.get(profileId);
  if (!profile) throw new Error("项目不存在。");
  const snapshots = await db.snapshots.where("profileId").equals(profileId).toArray();
  const snapshotIds = new Set(snapshots.map((item) => item.id));
  const sessions = await db.sessions.where("profileId").equals(profileId).toArray();
  const sessionIds = new Set(sessions.map((item) => item.id));
  const items = (await db.items.toArray())
    .filter((item) => snapshotIds.has(item.snapshotId))
    .map((item) => ({
      ...item,
      date: item.date ?? undefined,
      platform: item.platform ?? undefined,
      image: item.image ?? undefined,
      updatedAt: item.updatedAt ?? undefined,
    }));
  return {
    schemaVersion: 1, appVersion: APP_VERSION, exportedAt: now(),
    profile: { ...profile, nickname: profile.nickname ?? undefined, avatar: profile.avatar ?? undefined },
    snapshots,
    items,
    sessions,
    sessionItems: (await db.sessionItems.toArray()).filter((item) => sessionIds.has(item.sessionId)),
    comparisons: await db.comparisons.where("profileId").equals(profileId).toArray(),
    importBatches: (await db.importBatches.toArray()).filter((item) => sessionIds.has(item.targetSessionId)),
    models: (await db.models.toArray()).filter((item) => sessionIds.has(item.sessionId)),
  };
}

interface ProjectRows {
  profile: Profile;
  snapshots: Snapshot[];
  items: CollectionItem[];
  sessions: SortingSession[];
  sessionItems: SessionItem[];
  comparisons: ComparisonRecord[];
  importBatches: ComparisonImportBatch[];
  models: ModelState[];
}

interface PreparedBackupProject extends ProjectRows {
  legacySessionIds: Set<string>;
}

function baseUsername(username: string) {
  return username.trim().replace(/(?:（导入）)+$/gu, "");
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, stableValue(entry)]));
  }
  return value;
}

function stableJson(value: unknown) {
  return JSON.stringify(stableValue(value));
}

function compactHash(value: unknown) {
  const text = typeof value === "string" ? value : stableJson(value);
  let left = 0x811c9dc5;
  let right = 0x9e3779b9;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    left = Math.imul(left ^ code, 0x01000193);
    right = Math.imul(right ^ code, 0x85ebca6b);
  }
  return `${(left >>> 0).toString(16).padStart(8, "0")}${(right >>> 0).toString(16).padStart(8, "0")}`;
}

function prepareBackupProject(backup: ValidatedBackup): PreparedBackupProject {
  const payload = backup.payload;
  const legacySessionIds = new Set([
    ...(backup.compatibilitySessionIds ?? []),
    ...payload.sessions
    .filter((session) => session.comparisonHistoryMode !== "local")
    .map((session) => session.id),
  ]);
  const localized = localizeProjectData(
    payload.sessions,
    payload.sessionItems,
    payload.comparisons,
    payload.importBatches ?? [],
    payload.models,
    { key: backup.digest, timestamp: payload.exportedAt },
  );
  return {
    profile: { ...payload.profile },
    snapshots: payload.snapshots.map((entry) => ({ ...entry })),
    items: payload.items.map((entry) => ({ ...entry, tags: [...entry.tags] })),
    sessions: localized.sessions.map((entry) => ({
      ...entry,
      collectionTypes: [...entry.collectionTypes],
      distribution: normalizeDistributionConfig(entry.distribution),
      tagFilter: collectionTagFilter(entry.tagFilter?.tags ?? []),
      stoppingTarget: legacySessionIds.has(entry.id) ? undefined : entry.stoppingTarget,
      maxComparisons: legacySessionIds.has(entry.id) ? undefined : entry.maxComparisons,
    })),
    sessionItems: payload.sessionItems.map((entry) => ({ ...entry })),
    comparisons: localized.comparisons.map((entry) => ({ ...entry })),
    importBatches: localized.importBatches.map((entry) => ({ ...entry })),
    models: localized.models.map((entry) => ({ ...entry })),
    legacySessionIds,
  };
}

async function loadProjectRows(profileId: string): Promise<ProjectRows | undefined> {
  const profile = await db.profiles.get(profileId);
  if (!profile) return undefined;
  const snapshots = await db.snapshots.where("profileId").equals(profileId).toArray();
  const snapshotIds = new Set(snapshots.map((entry) => entry.id));
  const sessions = await db.sessions.where("profileId").equals(profileId).toArray();
  const sessionIds = new Set(sessions.map((entry) => entry.id));
  const [items, sessionItems, comparisons, importBatches, models] = await Promise.all([
    db.items.toArray().then((entries) => entries.filter((entry) => snapshotIds.has(entry.snapshotId))),
    db.sessionItems.toArray().then((entries) => entries.filter((entry) => sessionIds.has(entry.sessionId))),
    db.comparisons.where("profileId").equals(profileId).toArray(),
    db.importBatches.toArray().then((entries) => entries.filter((entry) => sessionIds.has(entry.targetSessionId))),
    db.models.toArray().then((entries) => entries.filter((entry) => sessionIds.has(entry.sessionId))),
  ]);
  return { profile, snapshots, items, sessions, sessionItems, comparisons, importBatches, models };
}

function projectCounts(project?: ProjectRows): BackupImportCounts {
  return {
    snapshots: project?.snapshots.length ?? 0,
    items: project?.items.length ?? 0,
    sessions: project?.sessions.length ?? 0,
    comparisons: project?.comparisons.length ?? 0,
    models: project?.models.length ?? 0,
  };
}

function projectRevision(project?: ProjectRows) {
  if (!project) return undefined;
  return compactHash({
    profile: project.profile,
    snapshots: [...project.snapshots].sort((a, b) => a.id.localeCompare(b.id)),
    items: [...project.items].sort((a, b) => a.snapshotId.localeCompare(b.snapshotId) || a.subjectId - b.subjectId),
    sessions: [...project.sessions].sort((a, b) => a.id.localeCompare(b.id)),
    sessionItems: [...project.sessionItems].sort((a, b) => a.id.localeCompare(b.id)),
    comparisons: [...project.comparisons].sort((a, b) => a.id.localeCompare(b.id)),
    importBatches: [...project.importBatches].sort((a, b) => a.id.localeCompare(b.id)),
    models: [...project.models].sort((a, b) => a.sessionId.localeCompare(b.sessionId)),
  });
}

function sessionFingerprint(project: ProjectRows, sessionId: string, normalized = false) {
  const stored = project.sessions.find((entry) => entry.id === sessionId);
  if (!stored) return "";
  const sessionById = new Map(project.sessions.map((entry) => [entry.id, entry]));
  const sessionReferenceToken = (reference?: string) => {
    if (!reference) return undefined;
    const target = sessionById.get(reference);
    return target ? compactHash({
      subjectType: target.subjectType,
      collectionTypes: target.collectionTypes,
      title: target.title,
      distribution: target.distribution,
      randomSeed: target.randomSeed,
      modelVersion: target.modelVersion,
      budgetMode: target.budgetMode,
      priorMode: target.priorMode,
      comparisonReusePolicy: target.comparisonReusePolicy,
      comparisonHistoryMode: target.comparisonHistoryMode,
      tagFilter: target.tagFilter,
      createdAt: target.createdAt,
    }) : normalized ? "external" : `external:${reference}`;
  };
  const session = {
    subjectType: stored.subjectType,
    collectionTypes: stored.collectionTypes,
    title: stored.title,
    distribution: stored.distribution,
    randomSeed: stored.randomSeed,
    modelVersion: stored.modelVersion,
    budgetMode: stored.budgetMode,
    priorMode: stored.priorMode,
    comparisonReusePolicy: stored.comparisonReusePolicy,
    comparisonHistoryMode: stored.comparisonHistoryMode,
    stoppingTarget: stored.stoppingTarget,
    suggestedComparisons: stored.suggestedComparisons,
    maxComparisons: stored.maxComparisons,
    upgradedFromSession: sessionReferenceToken(stored.upgradedFromSessionId),
    derivedFromSession: sessionReferenceToken(stored.derivedFromSessionId),
    tagFilter: stored.tagFilter,
    createdAt: stored.createdAt,
  };
  const records = project.comparisons.filter((entry) => entry.sessionId === sessionId);
  const recordById = new Map(records.map((entry) => [entry.id, entry]));
  const referenceToken = (reference?: string) => {
    if (!reference) return undefined;
    const target = recordById.get(reference);
    if (!target) return normalized ? "external" : `external:${reference}`;
    return compactHash({
      leftSubjectId: target.leftSubjectId,
      rightSubjectId: target.rightSubjectId,
      outcome: target.outcome,
      queryKind: target.queryKind ?? "adaptive",
      acceptedCountAtAnswer: target.acceptedCountAtAnswer,
      sourceCreatedAt: target.sourceCreatedAt ?? target.createdAt,
    });
  };
  const comparisons = project.comparisons.filter((entry) => entry.sessionId === sessionId)
    .map((entry) => ({
      leftSubjectId: entry.leftSubjectId,
      rightSubjectId: entry.rightSubjectId,
      outcome: entry.outcome,
      queryKind: entry.queryKind ?? "adaptive",
      calibration: referenceToken(entry.calibrationOfComparisonId),
      inheritance: referenceToken(entry.inheritedFromComparisonId),
      importedFromSession: sessionReferenceToken(entry.importedFromSessionId),
      importedFromComparison: referenceToken(entry.importedFromComparisonId),
      sourceCreatedAt: entry.sourceCreatedAt ?? entry.createdAt,
      acceptedCountAtAnswer: entry.acceptedCountAtAnswer,
      active: entry.active,
    }))
    .sort((left, right) => stableJson(left).localeCompare(stableJson(right)));
  const batches = project.importBatches.filter((entry) => entry.targetSessionId === sessionId)
    .map((entry) => ({
      sourceSession: sessionReferenceToken(entry.sourceSessionId),
      sourceSnapshot: entry.sourceSnapshotId
        ? project.snapshots.some((snapshot) => snapshot.id === entry.sourceSnapshotId)
          ? snapshotFingerprint(project, entry.sourceSnapshotId)
          : normalized ? "external" : `external:${entry.sourceSnapshotId}`
        : undefined,
      targetSnapshot: project.snapshots.some((snapshot) => snapshot.id === entry.targetSnapshotId)
        ? snapshotFingerprint(project, entry.targetSnapshotId)
        : normalized ? "external" : `external:${entry.targetSnapshotId}`,
      sourceModelVersion: entry.sourceModelVersion,
      type: entry.type,
      importedCount: entry.importedCount,
      duplicateOriginalCount: entry.duplicateOriginalCount,
      duplicatePairCount: entry.duplicatePairCount,
      outOfScopeCount: entry.outOfScopeCount,
      skippedCount: entry.skippedCount,
      invalidCalibrationCount: entry.invalidCalibrationCount,
    }))
    .sort((left, right) => stableJson(left).localeCompare(stableJson(right)));
  const links = project.sessionItems.filter((entry) => entry.sessionId === sessionId)
    .map((entry) => entry.subjectId)
    .sort((left, right) => left - right);
  return compactHash({ session, links, comparisons, batches });
}

function snapshotFingerprint(project: Pick<ProjectRows, "snapshots" | "items">, snapshotId: string) {
  const stored = project.snapshots.find((entry) => entry.id === snapshotId);
  if (!stored) return "";
  const snapshot = {
    syncedAt: stored.syncedAt,
    itemCount: stored.itemCount,
    containsPrivate: stored.containsPrivate,
  };
  const items = project.items.filter((entry) => entry.snapshotId === snapshotId)
    .map((entry) => ({
      subjectId: entry.subjectId,
      subjectType: entry.subjectType,
      collectionType: entry.collectionType,
      rate: entry.rate,
      name: entry.name,
      nameCn: entry.nameCn,
      date: entry.date,
      platform: entry.platform,
      image: entry.image,
      private: entry.private,
      tags: entry.tags,
      updatedAt: entry.updatedAt,
    }))
    .sort((left, right) => left.subjectId - right.subjectId);
  return compactHash({ snapshot, items });
}

function sessionGraphFingerprint(project: ProjectRows, sessionId: string) {
  const session = project.sessions.find((entry) => entry.id === sessionId);
  if (!session) return "";
  return compactHash({
    session: sessionFingerprint(project, sessionId, true),
    snapshot: snapshotFingerprint(project, session.snapshotId),
  });
}

function dependencyClosure(project: ProjectRows, selectedIds: Iterable<string>) {
  const selected = new Set(selectedIds);
  const byId = new Map(project.sessions.map((entry) => [entry.id, entry]));
  const queue = [...selected];
  for (let index = 0; index < queue.length; index += 1) {
    const sessionId = queue[index];
    const session = byId.get(sessionId);
    if (!session) continue;
    const dependencies = new Set<string>();
    if (session.upgradedFromSessionId) dependencies.add(session.upgradedFromSessionId);
    if (session.derivedFromSessionId) dependencies.add(session.derivedFromSessionId);
    for (const record of project.comparisons.filter((entry) => entry.sessionId === sessionId)) {
      if (record.importedFromSessionId) dependencies.add(record.importedFromSessionId);
    }
    for (const batch of project.importBatches.filter((entry) => entry.targetSessionId === sessionId)) {
      if (batch.sourceSessionId) dependencies.add(batch.sourceSessionId);
    }
    for (const dependency of dependencies) {
      if (!byId.has(dependency) || selected.has(dependency)) continue;
      selected.add(dependency);
      queue.push(dependency);
    }
  }
  return selected;
}

async function findTargetProfile(username: string) {
  const canonical = canonicalUsername(username);
  return (await db.profiles.toArray()).find((entry) => canonicalUsername(entry.username) === canonical);
}

async function availableProfileId(username: string) {
  const canonical = canonicalUsername(username);
  const occupied = await db.profiles.get(canonical);
  if (!occupied || canonicalUsername(occupied.username) === canonical) return canonical;
  let candidate = `${canonical}:account:${compactHash(baseUsername(username)).slice(0, 8)}`;
  while (await db.profiles.get(candidate)) candidate = `${canonical}:account:${id().slice(0, 8)}`;
  return candidate;
}

interface ClassifiedSession {
  sourceId: string;
  status: "new" | "duplicate" | "conflict";
  targetSessionId?: string;
  sourceFingerprint: string;
  mappingAudit?: BackupImportAudit;
}

async function classifyBackupSessions(source: ProjectRows, target?: ProjectRows) {
  const targetById = new Map(target?.sessions.map((entry) => [entry.id, entry]) ?? []);
  const globalSessions = new Map((await db.sessions.toArray()).map((entry) => [entry.id, entry]));
  const audits = target
    ? (await db.backupImports.where("profileId").equals(target.profile.id).toArray())
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    : [];
  const result: ClassifiedSession[] = [];
  for (const session of source.sessions) {
    const sourceFingerprint = sessionGraphFingerprint(source, session.id);
    const direct = targetById.get(session.id);
    const priorMatch = audits.flatMap((audit) => audit.sessionFingerprints.map((fingerprint) => ({ audit, fingerprint })))
      .find(({ fingerprint }) => fingerprint.sourceSessionId === session.id
        && fingerprint.sourceFingerprint === sourceFingerprint
        && targetById.has(fingerprint.targetSessionId)
        && sessionGraphFingerprint(target!, fingerprint.targetSessionId) === fingerprint.targetFingerprint);
    if (direct && sessionGraphFingerprint(target!, direct.id) === sourceFingerprint) {
      result.push({
        sourceId: session.id,
        status: "duplicate",
        targetSessionId: direct.id,
        sourceFingerprint,
        mappingAudit: priorMatch?.fingerprint.targetSessionId === direct.id ? priorMatch.audit : undefined,
      });
      continue;
    }
    if (priorMatch) {
      result.push({
        sourceId: session.id,
        status: "duplicate",
        targetSessionId: priorMatch.fingerprint.targetSessionId,
        sourceFingerprint,
        mappingAudit: priorMatch.audit,
      });
      continue;
    }
    const collision = direct ?? globalSessions.get(session.id);
    result.push({
      sourceId: session.id,
      status: collision ? "conflict" : "new",
      targetSessionId: direct?.id,
      sourceFingerprint,
    });
  }
  return result;
}

export async function previewBackupImport(
  backup: ValidatedBackup,
  selectedSessionIds?: string[],
): Promise<BackupImportPreview> {
  await ensureLocalHistory();
  const source = prepareBackupProject(backup);
  const targetProfile = await findTargetProfile(source.profile.username);
  const target = targetProfile ? await loadProjectRows(targetProfile.id) : undefined;
  const targetProfileId = targetProfile?.id ?? await availableProfileId(source.profile.username);
  const classified = await classifyBackupSessions(source, target);
  const initial = new Set(selectedSessionIds ?? classified
    .filter((entry) => entry.status !== "duplicate")
    .map((entry) => entry.sourceId));
  for (const sessionId of initial) {
    if (!source.sessions.some((entry) => entry.id === sessionId)) throw new Error(`备份中不存在会话 ${sessionId}。`);
  }
  const selected = dependencyClosure(source, initial);
  const dependencyIds = [...selected].filter((entry) => !initial.has(entry));
  const classification = new Map(classified.map((entry) => [entry.sourceId, entry]));
  const linksBySession = new Map<string, number>();
  for (const link of source.sessionItems) linksBySession.set(link.sessionId, (linksBySession.get(link.sessionId) ?? 0) + 1);
  const comparisonsBySession = new Map<string, number>();
  for (const record of source.comparisons) comparisonsBySession.set(record.sessionId, (comparisonsBySession.get(record.sessionId) ?? 0) + 1);
  const warnings = [...backup.warnings];
  if (source.legacySessionIds.size > 0) warnings.push(`${source.legacySessionIds.size} 个旧版会话会转换为本地历史并在首次打开时重算模型。`);
  const sourceModelBySession = new Map(source.models.map((model) => [model.sessionId, model]));
  const invalidModelCount = source.sessions.filter((session) => {
    const model = sourceModelBySession.get(session.id);
    return model ? !validModel(model, session, source.sessionItems) : session.status === "complete";
  }).length;
  if (invalidModelCount > 0) warnings.push(`${invalidModelCount} 个无效模型缓存会被忽略，并在首次打开会话时重算。`);
  const selectedConflicts = [...selected].filter((entry) => classification.get(entry)?.status === "conflict");
  if (selectedConflicts.length > 0) warnings.push(`${selectedConflicts.length} 个冲突会话会改 ID 后另存，现有本地会话不会被覆盖。`);
  return {
    targetProfileId,
    targetExists: Boolean(target),
    suggestedMode: target ? "merge" : "create",
    targetRevision: projectRevision(target),
    source: projectCounts(source),
    target: projectCounts(target),
    sessions: source.sessions.map((session) => {
      const state = classification.get(session.id)!;
      return {
        id: session.id,
        title: session.title,
        snapshotId: session.snapshotId,
        subjectType: session.subjectType,
        itemCount: linksBySession.get(session.id) ?? 0,
        comparisonCount: comparisonsBySession.get(session.id) ?? 0,
        status: state.status,
        selected: selected.has(session.id),
        required: dependencyIds.includes(session.id),
        targetSessionId: state.targetSessionId,
      };
    }),
    selectedSessionIds: [...selected],
    dependencySessionIds: dependencyIds,
    importableSessionCount: [...selected].filter((entry) => classification.get(entry)?.status !== "duplicate").length,
    reusedSessionCount: [...selected].filter((entry) => classification.get(entry)?.status === "duplicate").length,
    conflictSessionCount: selectedConflicts.length,
    warnings,
  };
}

function validModel(model: ModelState | undefined, session: SortingSession, links: SessionItem[]) {
  if (!model || model.version !== session.modelVersion) return false;
  const diagnostics = model.diagnostics;
  if (diagnostics?.method !== "laplace-mc-v6"
    || diagnostics.forecast?.method !== "posterior-contraction-mc-v12"
    || !(["quick", "standard", "thorough"] as const)
      .every((mode) => diagnostics.forecasts?.[mode]?.method === "posterior-contraction-mc-v12")
    || !session.priorMode) return false;
  const allowed = new Set(links.filter((entry) => entry.sessionId === session.id).map((entry) => String(entry.subjectId)));
  const abilities = Object.keys(model.abilities);
  const uncertainty = Object.keys(model.uncertainty);
  return abilities.length === allowed.size && uncertainty.length === allowed.size
    && abilities.every((entry) => allowed.has(entry))
    && uncertainty.every((entry) => allowed.has(entry));
}

function mappedId(sourceId: string, occupied: Set<string>, mappings: BackupImportIdMapping[], entity: BackupImportIdMapping["entity"], reason: BackupImportIdMapping["reason"] = "collision") {
  if (!occupied.has(sourceId)) {
    occupied.add(sourceId);
    return sourceId;
  }
  let targetId = id();
  while (occupied.has(targetId)) targetId = id();
  occupied.add(targetId);
  mappings.push({ entity, sourceId, targetId, reason });
  return targetId;
}

async function removeProjectRows(project: ProjectRows) {
  const snapshotIds = project.snapshots.map((entry) => entry.id);
  const sessionIds = project.sessions.map((entry) => entry.id);
  if (snapshotIds.length > 0) await db.items.where("snapshotId").anyOf(snapshotIds).delete();
  if (sessionIds.length > 0) {
    await db.sessionItems.where("sessionId").anyOf(sessionIds).delete();
    await db.models.where("sessionId").anyOf(sessionIds).delete();
  }
  await db.importBatches.where("profileId").equals(project.profile.id).delete();
  await db.comparisons.where("profileId").equals(project.profile.id).delete();
  await db.sessions.where("profileId").equals(project.profile.id).delete();
  await db.snapshots.where("profileId").equals(project.profile.id).delete();
  await db.profiles.delete(project.profile.id);
}

export async function commitBackupImport(
  backup: ValidatedBackup,
  request: BackupImportRequest,
): Promise<BackupImportResult> {
  await ensureLocalHistory();
  const source = prepareBackupProject(backup);
  const existingProfile = await findTargetProfile(source.profile.username);
  if (request.mode === "create" && existingProfile) throw new Error("这个账号已经存在，请选择合并或覆盖恢复。");
  if ((request.mode === "merge" || request.mode === "replace") && !existingProfile) throw new Error("目标账号不存在，请创建新项目。");
  if (request.mode === "replace"
    && canonicalUsername(request.confirmationUsername ?? "") !== canonicalUsername(source.profile.username)) {
    throw new Error("请输入备份中的 Bangumi 用户名以确认覆盖恢复。");
  }
  const tables = [
    db.profiles, db.snapshots, db.items, db.sessions, db.sessionItems, db.comparisons,
    db.importBatches, db.models, db.backupImports, db.meta,
  ];
  return db.transaction("rw", tables, async () => {
    const targetProfile = await findTargetProfile(source.profile.username);
    if (request.mode === "create" && targetProfile) throw new Error("这个账号已经存在，请选择合并或覆盖恢复。");
    if ((request.mode === "merge" || request.mode === "replace") && !targetProfile) {
      throw new Error("目标账号已经变化，请重新预览导入。");
    }
    const target = targetProfile ? await loadProjectRows(targetProfile.id) : undefined;
    if (target && projectRevision(target) !== request.targetRevision) throw new Error("本地项目已经变化，请重新预览导入。");
    const preview = await previewBackupImport(backup, request.mode === "replace" ? source.sessions.map((entry) => entry.id) : request.selectedSessionIds);
    if (request.mode !== preview.suggestedMode && request.mode === "create" && preview.targetExists) throw new Error("目标账号已经存在。");

    const classified = await classifyBackupSessions(source, target);
    const classification = new Map(classified.map((entry) => [entry.sourceId, entry]));
    const initial = request.mode === "merge"
      ? new Set(request.selectedSessionIds ?? classified.filter((entry) => entry.status !== "duplicate").map((entry) => entry.sourceId))
      : new Set(source.sessions.map((entry) => entry.id));
    const selected = dependencyClosure(source, initial);
    const dependencySessionIds = [...selected].filter((entry) => !initial.has(entry));
    const importedSourceSessionIds = [...selected].filter((entry) => request.mode !== "merge" || classification.get(entry)?.status !== "duplicate");
    const reusedSourceSessionIds = request.mode === "merge"
      ? [...selected].filter((entry) => classification.get(entry)?.status === "duplicate")
      : [];
    if (request.mode === "merge" && importedSourceSessionIds.length === 0) throw new Error("所选会话都已经导入，没有新的内容可合并。");

    const targetProfileId = target?.profile.id ?? await availableProfileId(source.profile.username);
    const mappings: BackupImportIdMapping[] = [];
    if (source.profile.id !== targetProfileId) mappings.push({
      entity: "profile", sourceId: source.profile.id, targetId: targetProfileId, reason: "canonical-profile",
    });

    const replacingSnapshotIds = new Set(target?.snapshots.map((entry) => entry.id) ?? []);
    const replacingSessionIds = new Set(target?.sessions.map((entry) => entry.id) ?? []);
    const replacingComparisonIds = new Set(target?.comparisons.map((entry) => entry.id) ?? []);
    const replacingBatchIds = new Set(target?.importBatches.map((entry) => entry.id) ?? []);
    const globalSnapshots = (await db.snapshots.toArray()).filter((entry) => request.mode !== "replace" || !replacingSnapshotIds.has(entry.id));
    const globalSessions = (await db.sessions.toArray()).filter((entry) => request.mode !== "replace" || !replacingSessionIds.has(entry.id));
    const globalComparisons = (await db.comparisons.toArray()).filter((entry) => request.mode !== "replace" || !replacingComparisonIds.has(entry.id));
    const globalBatches = (await db.importBatches.toArray()).filter((entry) => request.mode !== "replace" || !replacingBatchIds.has(entry.id));
    const occupiedSnapshotIds = new Set(globalSnapshots.map((entry) => entry.id));
    const occupiedSessionIds = new Set(globalSessions.map((entry) => entry.id));
    const occupiedComparisonIds = new Set(globalComparisons.map((entry) => entry.id));
    const occupiedBatchIds = new Set(globalBatches.map((entry) => entry.id));

    const sessionMap = new Map<string, string>();
    for (const sourceId of reusedSourceSessionIds) sessionMap.set(sourceId, classification.get(sourceId)!.targetSessionId!);
    for (const sourceId of importedSourceSessionIds) {
      const state = classification.get(sourceId);
      const conflict = request.mode === "merge" && state?.status === "conflict";
      const targetId = mappedId(sourceId, occupiedSessionIds, mappings, "session", conflict ? "conflict" : "collision");
      sessionMap.set(sourceId, targetId);
    }

    const snapshotMap = new Map<string, string>();
    if (target) {
      for (const sourceSessionId of reusedSourceSessionIds) {
        const sourceSession = source.sessions.find((entry) => entry.id === sourceSessionId)!;
        const targetSession = target.sessions.find((entry) => entry.id === sessionMap.get(sourceSessionId))!;
        if (!snapshotMap.has(sourceSession.snapshotId)) {
          snapshotMap.set(sourceSession.snapshotId, targetSession.snapshotId);
        }
      }
    }
    const requiredSnapshotIds = new Set(importedSourceSessionIds.map((sessionId) =>
      source.sessions.find((entry) => entry.id === sessionId)!.snapshotId));
    if (request.mode !== "merge") for (const snapshot of source.snapshots) requiredSnapshotIds.add(snapshot.id);
    const snapshotsToAdd: Snapshot[] = [];
    const itemsToAdd: CollectionItem[] = [];
    for (const sourceSnapshotId of requiredSnapshotIds) {
      if (snapshotMap.has(sourceSnapshotId)) continue;
      const sourceSnapshot = source.snapshots.find((entry) => entry.id === sourceSnapshotId)!;
      const existing = target?.snapshots.find((entry) => entry.id === sourceSnapshotId);
      if (request.mode === "merge" && existing
        && snapshotFingerprint(source, sourceSnapshotId) === snapshotFingerprint(target!, existing.id)) {
        snapshotMap.set(sourceSnapshotId, existing.id);
        continue;
      }
      const reason = request.mode === "merge" && existing ? "conflict" : "collision";
      const targetSnapshotId = mappedId(sourceSnapshotId, occupiedSnapshotIds, mappings, "snapshot", reason);
      snapshotMap.set(sourceSnapshotId, targetSnapshotId);
      snapshotsToAdd.push({
        ...sourceSnapshot,
        id: targetSnapshotId,
        profileId: targetProfileId,
        username: request.mode === "merge" && target ? target.profile.username : baseUsername(source.profile.username),
      });
      itemsToAdd.push(...source.items.filter((entry) => entry.snapshotId === sourceSnapshotId)
        .map((entry) => ({ ...entry, snapshotId: targetSnapshotId, tags: [...entry.tags] })));
    }

    const comparisonMap = new Map<string, string>();
    if (target) {
      const comparisonCore = (entry: ComparisonRecord) => stableJson({
        leftSubjectId: entry.leftSubjectId,
        rightSubjectId: entry.rightSubjectId,
        outcome: entry.outcome,
        queryKind: entry.queryKind ?? "adaptive",
        acceptedCountAtAnswer: entry.acceptedCountAtAnswer,
        active: entry.active,
        sourceCreatedAt: entry.sourceCreatedAt ?? entry.createdAt,
      });
      for (const sourceSessionId of reusedSourceSessionIds) {
        const state = classification.get(sourceSessionId)!;
        const targetSessionId = sessionMap.get(sourceSessionId)!;
        const sourceRecords = source.comparisons.filter((entry) => entry.sessionId === sourceSessionId);
        const targetRecords = target.comparisons.filter((entry) => entry.sessionId === targetSessionId);
        const targetById = new Map(targetRecords.map((entry) => [entry.id, entry]));
        const usedTargetIds = new Set<string>();
        const unresolved: ComparisonRecord[] = [];
        for (const record of sourceRecords) {
          const auditedTargetId = state.mappingAudit?.idMappings.find((mapping) =>
            mapping.entity === "comparison" && mapping.sourceId === record.id)?.targetId;
          const candidateId = auditedTargetId ?? record.id;
          const candidate = targetById.get(candidateId);
          if (candidate && !usedTargetIds.has(candidate.id)) {
            comparisonMap.set(record.id, candidate.id);
            usedTargetIds.add(candidate.id);
          } else {
            unresolved.push(record);
          }
        }
        const availableByCore = new Map<string, ComparisonRecord[]>();
        for (const record of targetRecords.filter((entry) => !usedTargetIds.has(entry.id))) {
          const group = availableByCore.get(comparisonCore(record)) ?? [];
          group.push(record);
          availableByCore.set(comparisonCore(record), group);
        }
        for (const group of availableByCore.values()) group.sort((left, right) => left.id.localeCompare(right.id));
        for (const record of unresolved.sort((left, right) => left.id.localeCompare(right.id))) {
          const candidate = availableByCore.get(comparisonCore(record))?.shift();
          if (!candidate) throw new Error("复用会话的判断映射已经变化，请重新预览导入。");
          comparisonMap.set(record.id, candidate.id);
        }
      }
    }
    const sourceComparisons = source.comparisons.filter((entry) => importedSourceSessionIds.includes(entry.sessionId));
    for (const record of sourceComparisons) {
      if (!comparisonMap.has(record.id)) {
        comparisonMap.set(record.id, mappedId(record.id, occupiedComparisonIds, mappings, "comparison"));
      }
    }
    const sourceBatches = source.importBatches.filter((entry) => importedSourceSessionIds.includes(entry.targetSessionId));
    const batchMap = new Map<string, string>();
    for (const batch of sourceBatches) batchMap.set(batch.id, mappedId(batch.id, occupiedBatchIds, mappings, "importBatch"));

    const modelBySourceSession = new Map(source.models.map((model) => [model.sessionId, model]));
    const invalidModelSourceIds = new Set(source.sessions.filter((session) => {
      const model = modelBySourceSession.get(session.id);
      return model ? !validModel(model, session, source.sessionItems) : session.status === "complete";
    }).map((entry) => entry.id));
    const rewrittenSourceSessionIds = new Set(source.sessions
      .filter((entry) => importedSourceSessionIds.includes(entry.id))
      .filter((entry) => {
        if (targetProfileId !== entry.profileId
          || sessionMap.get(entry.id) !== entry.id
          || snapshotMap.get(entry.snapshotId) !== entry.snapshotId
          || (entry.upgradedFromSessionId !== undefined
            && (sessionMap.get(entry.upgradedFromSessionId) ?? entry.upgradedFromSessionId) !== entry.upgradedFromSessionId)
          || (entry.derivedFromSessionId !== undefined
            && (sessionMap.get(entry.derivedFromSessionId) ?? entry.derivedFromSessionId) !== entry.derivedFromSessionId)) return true;
        const comparisonsChanged = sourceComparisons.filter((record) => record.sessionId === entry.id).some((record) =>
          comparisonMap.get(record.id) !== record.id
          || remapDirectComparisonReference(record.calibrationOfComparisonId, comparisonMap) !== record.calibrationOfComparisonId
          || remapRootReference(record.inheritedFromComparisonId, comparisonMap) !== record.inheritedFromComparisonId
          || (record.importBatchId ? batchMap.get(record.importBatchId) ?? record.importBatchId : undefined) !== record.importBatchId
          || (record.importedFromSessionId
            ? sessionMap.get(record.importedFromSessionId) ?? record.importedFromSessionId
            : undefined) !== record.importedFromSessionId
          || remapDirectComparisonReference(record.importedFromComparisonId, comparisonMap) !== record.importedFromComparisonId);
        if (comparisonsChanged) return true;
        return sourceBatches.filter((batch) => batch.targetSessionId === entry.id).some((batch) =>
          batchMap.get(batch.id) !== batch.id
          || (batch.sourceSessionId ? sessionMap.get(batch.sourceSessionId) ?? batch.sourceSessionId : undefined) !== batch.sourceSessionId
          || (batch.sourceSnapshotId ? snapshotMap.get(batch.sourceSnapshotId) ?? batch.sourceSnapshotId : undefined) !== batch.sourceSnapshotId
          || (snapshotMap.get(batch.targetSnapshotId) ?? batch.targetSnapshotId) !== batch.targetSnapshotId);
      })
      .map((entry) => entry.id));
    for (const sessionId of source.legacySessionIds) rewrittenSourceSessionIds.add(sessionId);
    for (const sessionId of invalidModelSourceIds) rewrittenSourceSessionIds.add(sessionId);
    const sessionsToAdd = source.sessions.filter((entry) => importedSourceSessionIds.includes(entry.id)).map((entry) => {
      const targetSessionId = sessionMap.get(entry.id)!;
      const targetSnapshotId = snapshotMap.get(entry.snapshotId)!;
      return {
        ...entry,
        id: targetSessionId,
        profileId: targetProfileId,
        snapshotId: targetSnapshotId,
        upgradedFromSessionId: entry.upgradedFromSessionId
          ? sessionMap.get(entry.upgradedFromSessionId) ?? entry.upgradedFromSessionId
          : undefined,
        derivedFromSessionId: entry.derivedFromSessionId
          ? sessionMap.get(entry.derivedFromSessionId) ?? entry.derivedFromSessionId
          : undefined,
        status: rewrittenSourceSessionIds.has(entry.id) ? "active" as const : entry.status,
        distribution: normalizeDistributionConfig(entry.distribution),
        tagFilter: collectionTagFilter(entry.tagFilter?.tags ?? []),
      };
    });
    const rewrittenSessionIds = new Set([...rewrittenSourceSessionIds]
      .map((sourceSessionId) => sessionMap.get(sourceSessionId))
      .filter((entry): entry is string => Boolean(entry)));
    const sessionItemsToAdd = source.sessionItems.filter((entry) => importedSourceSessionIds.includes(entry.sessionId)).map((entry) => ({
      ...entry,
      id: `${sessionMap.get(entry.sessionId)!}:${entry.subjectId}`,
      sessionId: sessionMap.get(entry.sessionId)!,
    }));
    const comparisonsToAdd = sourceComparisons.map((entry) => ({
      ...entry,
      id: comparisonMap.get(entry.id)!,
      profileId: targetProfileId,
      sessionId: sessionMap.get(entry.sessionId)!,
      calibrationOfComparisonId: remapDirectComparisonReference(entry.calibrationOfComparisonId, comparisonMap),
      inheritedFromComparisonId: remapRootReference(entry.inheritedFromComparisonId, comparisonMap),
      importBatchId: entry.importBatchId ? batchMap.get(entry.importBatchId) ?? entry.importBatchId : undefined,
      importedFromSessionId: entry.importedFromSessionId
        ? sessionMap.get(entry.importedFromSessionId) ?? entry.importedFromSessionId
        : undefined,
      importedFromComparisonId: remapDirectComparisonReference(entry.importedFromComparisonId, comparisonMap),
    }));
    const batchesToAdd = sourceBatches.map((entry) => ({
      ...entry,
      id: batchMap.get(entry.id)!,
      profileId: targetProfileId,
      targetSessionId: sessionMap.get(entry.targetSessionId)!,
      sourceSessionId: entry.sourceSessionId ? sessionMap.get(entry.sourceSessionId) ?? entry.sourceSessionId : undefined,
      sourceSnapshotId: entry.sourceSnapshotId ? snapshotMap.get(entry.sourceSnapshotId) ?? entry.sourceSnapshotId : undefined,
      targetSnapshotId: snapshotMap.get(entry.targetSnapshotId) ?? entry.targetSnapshotId,
    }));
    const modelsToAdd = source.models.filter((model) => importedSourceSessionIds.includes(model.sessionId)).flatMap((model) => {
      const sourceSession = source.sessions.find((entry) => entry.id === model.sessionId)!;
      const targetSessionId = sessionMap.get(model.sessionId)!;
      if (rewrittenSessionIds.has(targetSessionId) || !validModel(model, sourceSession, source.sessionItems)) return [];
      return [{ ...model, sessionId: targetSessionId }];
    });

    const profile: Profile = request.mode === "merge" && target
      ? { ...target.profile }
      : { ...source.profile, id: targetProfileId, username: baseUsername(source.profile.username) };
    if (request.mode === "replace" && target) await removeProjectRows(target);
    if (request.mode !== "merge") await db.profiles.add(profile);
    if (snapshotsToAdd.length > 0) await db.snapshots.bulkAdd(snapshotsToAdd);
    if (itemsToAdd.length > 0) await db.items.bulkAdd(itemsToAdd);
    if (sessionsToAdd.length > 0) await db.sessions.bulkAdd(sessionsToAdd);
    if (sessionItemsToAdd.length > 0) await db.sessionItems.bulkAdd(sessionItemsToAdd);
    if (comparisonsToAdd.length > 0) await db.comparisons.bulkAdd(comparisonsToAdd);
    if (batchesToAdd.length > 0) await db.importBatches.bulkAdd(batchesToAdd);
    if (modelsToAdd.length > 0) await db.models.bulkAdd(modelsToAdd);

    const resultingProject = await loadProjectRows(targetProfileId);
    if (!resultingProject) throw new Error("导入后无法读取目标项目。");
    const timestamp = now();
    const auditId = id();
    const conflictSourceIds = importedSourceSessionIds.filter((entry) => sessionMap.get(entry) !== entry);
    const warnings = [...preview.warnings];
    const audit: BackupImportAudit = {
      id: auditId,
      profileId: targetProfileId,
      mode: request.mode,
      sourceUsername: baseUsername(source.profile.username),
      sourceExportedAt: backup.payload.exportedAt,
      sourceAppVersion: backup.payload.appVersion,
      backupDigest: backup.digest,
      createdAt: timestamp,
      selectedSessionIds: [...initial],
      dependencySessionIds,
      importedSnapshotIds: snapshotsToAdd.map((entry) => entry.id),
      importedSessionIds: sessionsToAdd.map((entry) => entry.id),
      importedComparisonIds: comparisonsToAdd.map((entry) => entry.id),
      importedBatchIds: batchesToAdd.map((entry) => entry.id),
      importedModelSessionIds: modelsToAdd.map((entry) => entry.sessionId),
      reusedSessionIds: reusedSourceSessionIds.map((entry) => sessionMap.get(entry)!),
      conflictSessionIds: conflictSourceIds.map((entry) => sessionMap.get(entry)!),
      importedComparisonCount: comparisonsToAdd.length,
      reusedSessionCount: reusedSourceSessionIds.length,
      conflictSessionCount: conflictSourceIds.length,
      warnings,
      idMappings: mappings,
      sessionFingerprints: importedSourceSessionIds.map((sourceSessionId) => ({
        sourceSessionId,
        targetSessionId: sessionMap.get(sourceSessionId)!,
        sourceFingerprint: sessionGraphFingerprint(source, sourceSessionId),
        targetFingerprint: sessionGraphFingerprint(resultingProject, sessionMap.get(sourceSessionId)!),
      })),
    };
    if (request.mode === "replace") {
      await db.backupImports.where("profileId").equals(targetProfileId).modify((entry) => {
        if (!entry.supersededAt) {
          entry.supersededAt = timestamp;
          entry.supersededByImportId = auditId;
        }
      });
    }
    await db.backupImports.add(audit);
    const allSnapshots = await db.snapshots.where("profileId").equals(targetProfileId).toArray();
    const snapshot = [...allSnapshots].sort((left, right) => right.syncedAt.localeCompare(left.syncedAt))[0];
    if (!snapshot) throw new Error("导入后没有可用的收藏快照。");
    await db.meta.put({ key: ACTIVE_SNAPSHOT_META_KEY, value: JSON.stringify({ profileId: targetProfileId, snapshotId: snapshot.id }) });
    return { profile, snapshot, audit };
  });
}

export async function listBackupImportHistory(profileId: string) {
  return (await db.backupImports.where("profileId").equals(profileId).toArray())
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

function legacySnapshotAudit(audits: BackupImportAudit[], profileId: string, snapshotId: string) {
  const deletedSnapshotIds = new Set(audits.flatMap((entry) => entry.deletedSnapshotIds ?? []));
  return audits.find((entry) => entry.profileId === profileId
    && entry.mode === "legacy-clone-migration"
    && !deletedSnapshotIds.has(snapshotId)
    && (entry.legacySnapshotIds ?? []).includes(snapshotId));
}

async function storedActiveSnapshot() {
  const saved = await db.meta.get(ACTIVE_SNAPSHOT_META_KEY);
  if (!saved) return undefined;
  try {
    const selection = JSON.parse(saved.value) as { profileId?: unknown; snapshotId?: unknown };
    if (typeof selection.snapshotId !== "string") return undefined;
    const snapshot = await db.snapshots.get(selection.snapshotId);
    return snapshot && (selection.profileId === undefined || selection.profileId === snapshot.profileId)
      ? snapshot
      : undefined;
  } catch {
    return undefined;
  }
}

async function buildSnapshotDeletionPreview(
  snapshot: Snapshot,
  audits: BackupImportAudit[],
): Promise<SnapshotDeletionPreview> {
  const profile = await db.profiles.get(snapshot.profileId);
  if (!profile) throw new Error("这个收藏快照所属的账号已不存在。");
  const sessions = await db.sessions.where("profileId").equals(profile.id).toArray();
  const deletedSessions = sessions.filter((entry) => entry.snapshotId === snapshot.id);
  const sessionIds = new Set(deletedSessions.map((entry) => entry.id));
  const [profileComparisons, allBatches, models, itemCount, snapshots, active] = await Promise.all([
    db.comparisons.where("profileId").equals(profile.id).toArray(),
    db.importBatches.toArray(),
    db.models.toArray().then((entries) => entries.filter((entry) => sessionIds.has(entry.sessionId))),
    db.items.where("snapshotId").equals(snapshot.id).count(),
    db.snapshots.where("profileId").equals(profile.id).toArray(),
    storedActiveSnapshot(),
  ]);
  const comparisons = profileComparisons.filter((entry) => sessionIds.has(entry.sessionId));
  const batches = allBatches.filter((entry) => sessionIds.has(entry.targetSessionId));
  const survivingReferenceSessionIds = new Set(sessions
    .filter((entry) => !sessionIds.has(entry.id)
      && ((entry.upgradedFromSessionId && sessionIds.has(entry.upgradedFromSessionId))
        || (entry.derivedFromSessionId && sessionIds.has(entry.derivedFromSessionId))))
    .map((entry) => entry.id));
  for (const record of profileComparisons) {
    if (!sessionIds.has(record.sessionId) && record.importedFromSessionId
      && sessionIds.has(record.importedFromSessionId)) survivingReferenceSessionIds.add(record.sessionId);
  }
  for (const batch of allBatches) {
    if (!sessionIds.has(batch.targetSessionId)
      && ((batch.sourceSessionId && sessionIds.has(batch.sourceSessionId))
        || batch.sourceSnapshotId === snapshot.id)) survivingReferenceSessionIds.add(batch.targetSessionId);
  }
  const legacy = legacySnapshotAudit(audits, profile.id, snapshot.id);
  const warnings = ["删除只发生在本机浏览器中，且无法撤销。建议先下载当前账号的 JSON 备份。"];
  if (legacy) warnings.push("这是由旧版导入迁移识别出的副本；删除后会在审计中保留清理记录。");
  if (!legacy && snapshots.length <= 1) {
    warnings.push("普通账号至少需要保留一个收藏快照；请先同步或导入另一个快照后再删除当前快照。");
  }
  if (survivingReferenceSessionIds.size > 0) {
    warnings.push(`${survivingReferenceSessionIds.size} 个保留会话会继续显示“来源已删除”的历史引用。`);
  }
  const project = await loadProjectRows(profile.id);
  const revision = projectRevision(project);
  if (!revision) throw new Error("无法读取当前项目版本。");
  return {
    profileId: profile.id,
    profile,
    snapshot,
    legacy: Boolean(legacy),
    sessionIds: [...sessionIds],
    comparisonIds: comparisons.map((entry) => entry.id),
    importBatchIds: batches.map((entry) => entry.id),
    modelSessionIds: models.map((entry) => entry.sessionId),
    itemCount,
    active: active?.id === snapshot.id,
    remainingSnapshotCount: Math.max(0, snapshots.length - 1),
    survivingReferenceSessionIds: [...survivingReferenceSessionIds],
    targetRevision: revision,
    warnings,
  };
}

export async function previewSnapshotDeletion(snapshotId: string): Promise<SnapshotDeletionPreview> {
  await ensureLocalHistory();
  const snapshot = await db.snapshots.get(snapshotId);
  if (!snapshot) throw new Error("这个收藏快照已不存在。");
  const audits = await db.backupImports.where("profileId").equals(snapshot.profileId).toArray();
  return buildSnapshotDeletionPreview(snapshot, audits);
}

export async function commitSnapshotDeletion(
  request: SnapshotDeletionRequest,
): Promise<SnapshotDeletionResult> {
  await ensureLocalHistory();
  const tables = [
    db.profiles, db.snapshots, db.items, db.sessions, db.sessionItems, db.comparisons,
    db.importBatches, db.models, db.backupImports, db.meta,
  ];
  return db.transaction("rw", tables, async () => {
    const snapshot = await db.snapshots.get(request.snapshotId);
    if (!snapshot) throw new Error("这个收藏快照已不存在，请刷新后重试。");
    const audits = await db.backupImports.where("profileId").equals(snapshot.profileId).toArray();
    const preview = await buildSnapshotDeletionPreview(snapshot, audits);
    if (canonicalUsername(request.confirmationUsername ?? "") !== canonicalUsername(preview.profile.username)) {
      throw new Error("请输入目标 Bangumi 用户名以确认删除。");
    }
    if (preview.targetRevision !== request.targetRevision) throw new Error("本地项目已经变化，请重新预览删除。");
    if (!preview.legacy && preview.remainingSnapshotCount === 0) {
      throw new Error("普通账号至少需要保留一个收藏快照，无法删除最后一个快照。");
    }

    const timestamp = now();
    const auditId = id();
    const audit: BackupImportAudit = {
      id: auditId,
      profileId: preview.profileId,
      mode: preview.legacy ? "legacy-clone-deletion" : "snapshot-deletion",
      sourceUsername: preview.profile.username,
      createdAt: timestamp,
      selectedSessionIds: [],
      dependencySessionIds: [],
      importedSnapshotIds: [],
      importedSessionIds: [],
      importedComparisonIds: [],
      importedBatchIds: [],
      importedModelSessionIds: [],
      reusedSessionIds: [],
      conflictSessionIds: [],
      importedComparisonCount: 0,
      reusedSessionCount: 0,
      conflictSessionCount: 0,
      warnings: preview.warnings,
      idMappings: [],
      sessionFingerprints: [],
      deletedSnapshotIds: [snapshot.id],
      deletedSessionIds: preview.sessionIds,
      deletedComparisonIds: preview.comparisonIds,
      deletedImportBatchIds: preview.importBatchIds,
      deletedModelSessionIds: preview.modelSessionIds,
    };

    if (preview.sessionIds.length > 0) {
      await db.sessionItems.where("sessionId").anyOf(preview.sessionIds).delete();
      await db.comparisons.where("sessionId").anyOf(preview.sessionIds).delete();
      await db.importBatches.where("targetSessionId").anyOf(preview.sessionIds).delete();
      await db.models.where("sessionId").anyOf(preview.sessionIds).delete();
      await db.sessions.where("id").anyOf(preview.sessionIds).delete();
    }
    await db.items.where("snapshotId").equals(snapshot.id).delete();
    await db.snapshots.delete(snapshot.id);
    for (const entry of audits) {
      if (entry.mode !== "legacy-clone-migration"
        || !(entry.legacySnapshotIds ?? []).includes(snapshot.id)) continue;
      const deletedSnapshotIds = [...new Set([...(entry.deletedSnapshotIds ?? []), snapshot.id])];
      const deletedSessionIds = [...new Set([...(entry.deletedSessionIds ?? []),
        ...preview.sessionIds.filter((sessionId) => (entry.legacySessionIds ?? []).includes(sessionId))])];
      const fullyDeleted = (entry.legacySnapshotIds ?? []).every((snapshotId) => deletedSnapshotIds.includes(snapshotId));
      await db.backupImports.update(entry.id, {
        deletedSnapshotIds,
        deletedSessionIds,
        deletedByAuditId: auditId,
        ...(fullyDeleted ? { deletedAt: timestamp } : {}),
      });
    }
    await db.backupImports.add(audit);

    const remaining = (await db.snapshots.where("profileId").equals(preview.profileId).toArray())
      .sort((left, right) => right.syncedAt.localeCompare(left.syncedAt))[0];
    let nextActive: Snapshot | undefined;
    if (preview.active) {
      nextActive = remaining ?? (await db.snapshots.toArray())
        .sort((left, right) => right.syncedAt.localeCompare(left.syncedAt))[0];
      if (nextActive) {
        await db.meta.put({ key: ACTIVE_SNAPSHOT_META_KEY, value: JSON.stringify({ profileId: nextActive.profileId, snapshotId: nextActive.id }) });
      } else {
        await db.meta.delete(ACTIVE_SNAPSHOT_META_KEY);
      }
    } else {
      nextActive = await storedActiveSnapshot();
    }
    const profile = remaining ? preview.profile : undefined;
    if (!remaining) await db.profiles.delete(preview.profileId);
    return {
      profile,
      deletedSnapshotId: snapshot.id,
      deletedSessionIds: preview.sessionIds,
      deletedComparisonIds: preview.comparisonIds,
      deletedImportBatchIds: preview.importBatchIds,
      deletedModelSessionIds: preview.modelSessionIds,
      activeSnapshot: nextActive,
      audit,
    };
  });
}

/**
 * Compatibility wrapper for callers of the pre-v6 legacy-clone-only API.
 *
 * The public snapshot deletion API now handles every local snapshot, but the
 * old names intentionally retain their original safety boundary.  This keeps
 * older callers (and, more importantly, older UI bundles) from accidentally
 * turning a regular snapshot deletion into a legacy cleanup operation.
 */
export async function previewLegacyCloneDeletion(snapshotId: string) {
  const preview = await previewSnapshotDeletion(snapshotId);
  if (!preview.legacy) throw new Error("只能删除由旧版导入迁移识别出的副本。");
  return preview;
}

/** @deprecated Use commitSnapshotDeletion. */
export async function commitLegacyCloneDeletion(request: SnapshotDeletionRequest) {
  const preview = await previewSnapshotDeletion(request.snapshotId);
  if (!preview.legacy) throw new Error("只能删除由旧版导入迁移识别出的副本。");
  return commitSnapshotDeletion(request);
}

export async function listLocalProjects(): Promise<LocalProject[]> {
  await ensureLocalHistory();
  const [profiles, snapshots, audits] = await Promise.all([
    db.profiles.toArray(), db.snapshots.toArray(), db.backupImports.toArray(),
  ]);
  return profiles.map((profile) => {
    const profileAudits = audits.filter((entry) => entry.profileId === profile.id);
    const deletedLegacySnapshotIds = new Set(profileAudits.flatMap((entry) => entry.deletedSnapshotIds ?? []));
    const deletedLegacySessionIds = new Set(profileAudits.flatMap((entry) => entry.deletedSessionIds ?? []));
    return {
      profile,
      snapshots: snapshots.filter((entry) => entry.profileId === profile.id)
        .sort((left, right) => right.syncedAt.localeCompare(left.syncedAt)),
      legacySnapshotIds: [...new Set(profileAudits.flatMap((entry) => entry.legacySnapshotIds ?? []))]
        .filter((entry) => !deletedLegacySnapshotIds.has(entry)),
      legacySessionIds: [...new Set(profileAudits.flatMap((entry) => entry.legacySessionIds ?? []))]
        .filter((entry) => !deletedLegacySessionIds.has(entry)),
    };
  }).filter((entry) => entry.snapshots.length > 0)
    .sort((left, right) => right.snapshots[0].syncedAt.localeCompare(left.snapshots[0].syncedAt));
}

export async function setActiveSnapshot(snapshotId: string) {
  const snapshot = await db.snapshots.get(snapshotId);
  if (!snapshot) throw new Error("收藏快照不存在。");
  await db.meta.put({ key: ACTIVE_SNAPSHOT_META_KEY, value: JSON.stringify({ profileId: snapshot.profileId, snapshotId }) });
  return snapshot;
}

export async function getActiveSnapshot() {
  await ensureLocalHistory();
  const saved = await db.meta.get(ACTIVE_SNAPSHOT_META_KEY);
  if (saved) {
    try {
      const parsed = JSON.parse(saved.value) as { profileId?: unknown; snapshotId?: unknown };
      if (typeof parsed.snapshotId === "string") {
        const snapshot = await db.snapshots.get(parsed.snapshotId);
        if (snapshot && (parsed.profileId === undefined || snapshot.profileId === parsed.profileId)) return snapshot;
      }
    } catch { /* Fall back to the latest valid snapshot. */ }
  }
  const snapshot = await db.snapshots.orderBy("syncedAt").last();
  if (snapshot) await setActiveSnapshot(snapshot.id);
  return snapshot;
}

export async function markExported(profileId: string) {
  await db.meta.put({ key: `last-export:${profileId}`, value: now() });
}

export async function getLastExport(profileId: string) {
  return (await db.meta.get(`last-export:${profileId}`))?.value;
}
