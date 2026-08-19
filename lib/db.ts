"use client";

import Dexie, { EntityTable, Table } from "dexie";
import {
  APP_VERSION,
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
import { sessionBudgetMode } from "./ranking/strategy";
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
  }
}

export const db = new ResorterDatabase();

function now() { return new Date().toISOString(); }
function id() { return crypto.randomUUID(); }

let localHistoryMigration: Promise<void> | undefined;

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
  await ensureLocalHistory();
  return db.snapshots.orderBy("syncedAt").last();
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
    const recordId = id();
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
    const recordId = id();
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
): LocalizedProjectData {
  const sessions = sessionsInput.map((session) => ({ ...session }));
  const comparisons = comparisonsInput.map((entry) => ({ ...entry }));
  const importBatches = batchesInput.map((entry) => ({ ...entry }));
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
      const batchId = id();
      const sourceSessionId = target.upgradedFromSessionId ?? target.derivedFromSessionId;
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
        sourceModelVersion: sourceSession?.modelVersion, type: "migration", createdAt: now(),
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
  return prepareComparisonImport({
    target: targetSession,
    source,
    targetSnapshotId,
    sourceSnapshotId: source.snapshotId,
    allowedSubjectIds,
    sourceRecords,
    targetRecords,
    type: target.targetSessionId ? "existing-session" : "new-session",
    batchId: "preview",
    batchCreatedAt: new Date(0).toISOString(),
  }).preview;
}

export async function commitComparisonImport(
  targetSessionId: string,
  sourceSessionId: string,
  expectedTargetVersion: number,
  expectedSourceVersion: number,
  nextModel: ModelState,
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
    const prepared = prepareComparisonImport({
      target,
      source,
      targetSnapshotId: target.snapshotId,
      sourceSnapshotId: source.snapshotId,
      allowedSubjectIds,
      sourceRecords,
      targetRecords,
      type: "existing-session",
    });
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
    budgetMode, comparisonReusePolicy: "session",
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
  return {
    schemaVersion: 1, appVersion: APP_VERSION, exportedAt: now(), profile, snapshots,
    items: (await db.items.toArray()).filter((item) => snapshotIds.has(item.snapshotId)),
    sessions,
    sessionItems: (await db.sessionItems.toArray()).filter((item) => sessionIds.has(item.sessionId)),
    comparisons: await db.comparisons.where("profileId").equals(profileId).toArray(),
    importBatches: (await db.importBatches.toArray()).filter((item) => sessionIds.has(item.targetSessionId)),
    models: (await db.models.toArray()).filter((item) => sessionIds.has(item.sessionId)),
  };
}

export async function importProject(payload: ExportV1): Promise<Profile> {
  if (payload.schemaVersion !== 1) throw new Error("不支持这个备份文件版本。");
  const localized = localizeProjectData(
    payload.sessions,
    payload.sessionItems,
    payload.comparisons,
    payload.importBatches ?? [],
    payload.models,
  );
  const suffix = id().slice(0, 8);
  const profileId = `${payload.profile.id}:import:${suffix}`;
  const mapSnapshot = new Map(payload.snapshots.map((item) => [item.id, `${item.id}:import:${suffix}`]));
  const mapSession = new Map(localized.sessions.map((item) => [item.id, `${item.id}:import:${suffix}`]));
  const mapComparison = new Map(localized.comparisons.map((item) => [item.id, id()]));
  const mapBatch = new Map(localized.importBatches.map((item) => [item.id, id()]));
  const profile = { ...payload.profile, id: profileId, username: `${payload.profile.username}（导入）`, updatedAt: now() };
  const importedAt = now();
  const snapshots = payload.snapshots.map((item, index) => ({ ...item, id: mapSnapshot.get(item.id)!, profileId, syncedAt: new Date(Date.parse(importedAt) + index).toISOString() }));
  const items = payload.items.map((item) => ({ ...item, snapshotId: mapSnapshot.get(item.snapshotId)! }));
  const sessions = localized.sessions.map((item) => ({
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
    distribution: normalizeDistributionConfig(item.distribution),
    tagFilter: collectionTagFilter(item.tagFilter?.tags ?? []),
    stoppingTarget: undefined,
    maxComparisons: undefined,
    status: "active" as const,
    updatedAt: now(),
  }));
  const sessionItems = payload.sessionItems.map((item) => ({ ...item, id: `${mapSession.get(item.sessionId)}:${item.subjectId}`, sessionId: mapSession.get(item.sessionId)! }));
  const comparisons = localized.comparisons.map((item) => ({
    ...item,
    id: mapComparison.get(item.id)!,
    profileId,
    sessionId: mapSession.get(item.sessionId)!,
    calibrationOfComparisonId: item.calibrationOfComparisonId
      ? mapComparison.get(item.calibrationOfComparisonId)
      : undefined,
    inheritedFromComparisonId: remapRootReference(item.inheritedFromComparisonId, mapComparison),
    importBatchId: item.importBatchId
      ? mapBatch.get(item.importBatchId) ?? item.importBatchId
      : undefined,
    importedFromSessionId: item.importedFromSessionId
      ? mapSession.get(item.importedFromSessionId) ?? item.importedFromSessionId
      : undefined,
    importedFromComparisonId: remapDirectComparisonReference(item.importedFromComparisonId, mapComparison),
  }));
  const importBatches = localized.importBatches.map((item) => ({
    ...item,
    id: mapBatch.get(item.id)!,
    profileId,
    targetSessionId: mapSession.get(item.targetSessionId)!,
    sourceSessionId: item.sourceSessionId
      ? mapSession.get(item.sourceSessionId) ?? item.sourceSessionId
      : undefined,
    sourceSnapshotId: item.sourceSnapshotId
      ? mapSnapshot.get(item.sourceSnapshotId) ?? item.sourceSnapshotId
      : undefined,
    targetSnapshotId: mapSnapshot.get(item.targetSnapshotId)!,
  }));
  const models = localized.models.map((item) => ({ ...item, sessionId: mapSession.get(item.sessionId)! }));
  await db.transaction("rw", [db.profiles, db.snapshots, db.items, db.sessions, db.sessionItems, db.comparisons, db.importBatches, db.models], async () => {
    await db.profiles.add(profile); await db.snapshots.bulkAdd(snapshots); await db.items.bulkAdd(items);
    await db.sessions.bulkAdd(sessions); await db.sessionItems.bulkAdd(sessionItems);
    await db.comparisons.bulkAdd(comparisons); await db.models.bulkAdd(models);
    if (importBatches.length > 0) await db.importBatches.bulkAdd(importBatches);
  });
  await ensureLocalHistory();
  return profile;
}

export async function markExported(profileId: string) {
  await db.meta.put({ key: `last-export:${profileId}`, value: now() });
}

export async function getLastExport(profileId: string) {
  return (await db.meta.get(`last-export:${profileId}`))?.value;
}
