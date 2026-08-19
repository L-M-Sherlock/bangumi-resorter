import { normalizeDistributionConfig } from "./distribution";
import { collectionTagFilter } from "./scope";
import {
  COLLECTION_TYPES,
  ExportV1,
  RankedItem,
  SUBJECT_TYPES,
  ValidatedBackup,
} from "./types";

function csvCell(value: string | number | boolean | undefined) {
  const text = value === undefined ? "" : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function resultsCsv(items: RankedItem[], levelCount = 10) {
  const headers = ["subject_type", "subject_id", "name", "name_cn", "collection_type", "original_rate", "new_rate", "level_count", "rank", "ability", "uncertainty", "bucket_stability", "comparison_count", "subject_url"];
  const rows = items.map((item) => [
    item.subjectType, item.subjectId, item.name, item.nameCn, item.collectionType,
    item.rate, item.newRate, levelCount, item.rank, item.ability.toFixed(6), item.uncertainty.toFixed(6),
    item.bucketStability === undefined ? "" : item.bucketStability.toFixed(6),
    item.comparisonCount, `https://bgm.tv/subject/${item.subjectId}`,
  ]);
  return `\uFEFF${[headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n")}`;
}

export function downloadText(filename: string, content: string, type: string) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export function downloadJson(filename: string, payload: ExportV1) {
  downloadText(filename, JSON.stringify(payload, null, 2), "application/json;charset=utf-8");
}

function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requiredObject(value: unknown, path: string) {
  if (!object(value)) throw new Error(`备份中的 ${path} 不是有效对象。`);
  return value;
}

function requiredArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`备份中的 ${path} 不是有效数组。`);
  return value;
}

function requiredString(value: unknown, path: string) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`备份中的 ${path} 不是有效字符串。`);
  return value;
}

function optionalString(value: unknown, path: string) {
  if (value !== undefined && typeof value !== "string") throw new Error(`备份中的 ${path} 不是有效字符串。`);
  return value as string | undefined;
}

function legacyNullableString(value: unknown, path: string, normalizedNullPaths: string[]) {
  if (value === null) {
    normalizedNullPaths.push(path);
    return undefined;
  }
  return optionalString(value, path);
}

function requiredNumber(value: unknown, path: string) {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`备份中的 ${path} 不是有效数字。`);
  return value;
}

function optionalNumber(value: unknown, path: string) {
  if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value))) {
    throw new Error(`备份中的 ${path} 不是有效数字。`);
  }
  return value as number | undefined;
}

function optionalBoolean(value: unknown, path: string) {
  if (value !== undefined && typeof value !== "boolean") throw new Error(`备份中的 ${path} 不是有效布尔值。`);
  return value as boolean | undefined;
}

function requiredBoolean(value: unknown, path: string) {
  if (typeof value !== "boolean") throw new Error(`备份中的 ${path} 不是有效布尔值。`);
  return value;
}

function uniqueId(value: unknown, path: string, ids: Set<string>) {
  const result = requiredString(value, path);
  if (ids.has(result)) throw new Error(`备份中的 ${path} 重复：${result}。`);
  ids.add(result);
  return result;
}

function enumNumber(value: unknown, path: string, allowed: Record<number, string>) {
  const result = requiredNumber(value, path);
  if (!Number.isInteger(result) || !(result in allowed)) throw new Error(`备份中的 ${path} 不受支持。`);
  return result;
}

function enumString(value: unknown, path: string, allowed: readonly string[]) {
  const result = requiredString(value, path);
  if (!allowed.includes(result)) throw new Error(`备份中的 ${path} 不受支持。`);
  return result;
}

function stringArray(value: unknown, path: string) {
  return requiredArray(value, path).map((entry, index) => requiredString(entry, `${path}[${index}]`));
}

function numericRecord(value: unknown, path: string) {
  const record = requiredObject(value, path);
  for (const [key, entry] of Object.entries(record)) {
    if (!/^\d+$/u.test(key)) throw new Error(`备份中的 ${path}.${key} 不是有效作品 ID。`);
    requiredNumber(entry, `${path}.${key}`);
  }
  return record as Record<string, number>;
}

function validateNumericFields(record: Record<string, unknown>, path: string, fields: readonly string[]) {
  for (const field of fields) optionalNumber(record[field], `${path}.${field}`);
}

function validateBooleanFields(record: Record<string, unknown>, path: string, fields: readonly string[]) {
  for (const field of fields) optionalBoolean(record[field], `${path}.${field}`);
}

function validateModelDiagnostics(value: unknown, path: string) {
  if (value === undefined) return undefined;
  const diagnostics = requiredObject(value, path);
  if (diagnostics.method !== undefined) {
    enumString(diagnostics.method, `${path}.method`, ["laplace-mc-v1", "laplace-mc-v2", "laplace-mc-v3", "laplace-mc-v4"]);
  }
  validateNumericFields(diagnostics, path, [
    "sampleCount", "jointBucketStability", "jointBucketStableSamples", "jointBucketStabilityLow", "jointBucketStabilityHigh",
    "adjacentBucketStability", "adjacentBucketStableSamples", "adjacentBucketStabilityLow", "adjacentBucketStabilityHigh",
    "coverageTargetStability", "coverageTargetStableSamples", "coverageTargetStabilityLow", "coverageTargetStabilityHigh",
    "requiredAdjacentStableItemCount", "allowedCrossTwoBucketCount", "expectedCrossTwoBucketCount", "crossTwoBucketCountMedian",
    "crossTwoBucketCountLow", "crossTwoBucketCountHigh", "maxBucketDisplacementMedian", "maxBucketDisplacementHigh",
    "expectedBucketChangeRate", "minBucketStability", "decisionRiskRatio", "evidenceCount", "evidenceRequired", "fatigueLimit",
  ]);
  validateBooleanFields(diagnostics, path, ["fatigueReached", "ready"]);
  for (const field of ["bucketStability", "adjacentBucketStabilityByItem"] as const) {
    if (diagnostics[field] !== undefined) numericRecord(diagnostics[field], `${path}.${field}`);
  }
  if (diagnostics.stoppingBottleneckMode !== undefined) {
    enumString(diagnostics.stoppingBottleneckMode, `${path}.stoppingBottleneckMode`, ["quick", "standard", "thorough"]);
  }
  if (diagnostics.stoppingChecks !== undefined) {
    requiredArray(diagnostics.stoppingChecks, `${path}.stoppingChecks`).forEach((value, index) => {
      const check = requiredObject(value, `${path}.stoppingChecks[${index}]`);
      enumString(check.mode, `${path}.stoppingChecks[${index}].mode`, ["quick", "standard", "thorough"]);
      validateNumericFields(check, `${path}.stoppingChecks[${index}]`, ["sampleCount", "stableSamples", "probability", "low", "high"]);
      optionalBoolean(check.ready, `${path}.stoppingChecks[${index}].ready`);
    });
  }
  if (diagnostics.calibration !== undefined) {
    const calibration = requiredObject(diagnostics.calibration, `${path}.calibration`);
    validateNumericFields(calibration, `${path}.calibration`, [
      "attempted", "completed", "consistent", "consistencyRate", "posteriorMean", "credibleLow", "credibleHigh", "probabilityAboveChance",
    ]);
    optionalBoolean(calibration.acceptable, `${path}.calibration.acceptable`);
  }
  if (diagnostics.forecast !== undefined) {
    const forecast = requiredObject(diagnostics.forecast, `${path}.forecast`);
    if (forecast.method !== undefined) {
      enumString(forecast.method, `${path}.forecast.method`, [
        "posterior-contraction-mc-v1", "posterior-contraction-mc-v2", "posterior-contraction-mc-v3", "posterior-contraction-mc-v4", "posterior-contraction-mc-v5",
      ]);
    }
    if (forecast.status !== undefined) enumString(forecast.status, `${path}.forecast.status`, ["ready", "forecast", "uncertain", "limit"]);
    validateNumericFields(forecast, `${path}.forecast`, [
      "rolloutCount", "lowerAdditional", "medianAdditional", "upperAdditional", "nextCheckpoint", "probabilityWithin20", "projectionHorizon",
      "probabilityWithinProjection", "within20Successes", "probabilityWithin20Low", "probabilityWithin20High", "withinProjectionSuccesses",
      "probabilityWithinProjectionLow", "probabilityWithinProjectionHigh", "probabilityBeforeLimit", "beforeLimitSuccesses",
      "probabilityBeforeLimitLow", "probabilityBeforeLimitHigh", "remainingCapacity",
    ]);
  }
  return diagnostics;
}

function sha256Hex(buffer: ArrayBuffer) {
  return crypto.subtle.digest("SHA-256", buffer).then((digest) =>
    [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join(""));
}

/** Strictly validates required ExportV1 structure while retaining known legacy optional fields. */
export function validateBackupPayload(input: unknown): Pick<ValidatedBackup, "payload" | "warnings" | "compatibilitySessionIds"> {
  const root = requiredObject(input, "根对象");
  if (root.schemaVersion !== 1) throw new Error("不支持这个备份文件版本。");
  const appVersion = requiredString(root.appVersion, "appVersion");
  const exportedAt = requiredString(root.exportedAt, "exportedAt");
  const normalizedNullPaths: string[] = [];
  const profileInput = requiredObject(root.profile, "profile");
  const profileId = requiredString(profileInput.id, "profile.id");
  const profile = {
    ...profileInput,
    id: profileId,
    username: requiredString(profileInput.username, "profile.username"),
    nickname: legacyNullableString(profileInput.nickname, "profile.nickname", normalizedNullPaths),
    avatar: legacyNullableString(profileInput.avatar, "profile.avatar", normalizedNullPaths),
    createdAt: requiredString(profileInput.createdAt, "profile.createdAt"),
    updatedAt: requiredString(profileInput.updatedAt, "profile.updatedAt"),
  };

  const snapshotIds = new Set<string>();
  const snapshots = requiredArray(root.snapshots, "snapshots").map((value, index) => {
    const entry = requiredObject(value, `snapshots[${index}]`);
    const id = uniqueId(entry.id, `snapshots[${index}].id`, snapshotIds);
    if (requiredString(entry.profileId, `snapshots[${index}].profileId`) !== profileId) {
      throw new Error(`快照 ${id} 不属于备份账号。`);
    }
    return {
      ...entry,
      id,
      profileId,
      username: requiredString(entry.username, `snapshots[${index}].username`),
      syncedAt: requiredString(entry.syncedAt, `snapshots[${index}].syncedAt`),
      itemCount: requiredNumber(entry.itemCount, `snapshots[${index}].itemCount`),
      containsPrivate: requiredBoolean(entry.containsPrivate, `snapshots[${index}].containsPrivate`),
    };
  });
  if (snapshots.length === 0) throw new Error("备份中没有收藏快照。");

  const itemKeys = new Set<string>();
  const items = requiredArray(root.items, "items").map((value, index) => {
    const entry = requiredObject(value, `items[${index}]`);
    const snapshotId = requiredString(entry.snapshotId, `items[${index}].snapshotId`);
    if (!snapshotIds.has(snapshotId)) throw new Error(`条目 ${index + 1} 引用了不存在的快照。`);
    const subjectId = requiredNumber(entry.subjectId, `items[${index}].subjectId`);
    if (!Number.isInteger(subjectId)) throw new Error(`备份中的 items[${index}].subjectId 不是整数。`);
    const key = `${snapshotId}:${subjectId}`;
    if (itemKeys.has(key)) throw new Error(`备份中存在重复条目 ${key}。`);
    itemKeys.add(key);
    return {
      ...entry,
      snapshotId,
      subjectId,
      subjectType: enumNumber(entry.subjectType, `items[${index}].subjectType`, SUBJECT_TYPES),
      collectionType: enumNumber(entry.collectionType, `items[${index}].collectionType`, COLLECTION_TYPES),
      rate: requiredNumber(entry.rate, `items[${index}].rate`),
      name: requiredString(entry.name, `items[${index}].name`),
      nameCn: typeof entry.nameCn === "string" ? entry.nameCn : "",
      date: legacyNullableString(entry.date, `items[${index}].date`, normalizedNullPaths),
      platform: legacyNullableString(entry.platform, `items[${index}].platform`, normalizedNullPaths),
      image: legacyNullableString(entry.image, `items[${index}].image`, normalizedNullPaths),
      private: requiredBoolean(entry.private, `items[${index}].private`),
      tags: stringArray(entry.tags, `items[${index}].tags`),
      updatedAt: legacyNullableString(entry.updatedAt, `items[${index}].updatedAt`, normalizedNullPaths),
    };
  });
  const itemCountBySnapshot = new Map<string, number>();
  for (const item of items) itemCountBySnapshot.set(item.snapshotId, (itemCountBySnapshot.get(item.snapshotId) ?? 0) + 1);
  for (const snapshot of snapshots) {
    if (snapshot.itemCount !== (itemCountBySnapshot.get(snapshot.id) ?? 0)) {
      throw new Error(`快照 ${snapshot.id} 的条目数量与备份内容不一致。`);
    }
  }

  const sessionIds = new Set<string>();
  const compatibilitySessionIds = new Set<string>();
  const sessions = requiredArray(root.sessions, "sessions").map((value, index) => {
    const entry = requiredObject(value, `sessions[${index}]`);
    const id = uniqueId(entry.id, `sessions[${index}].id`, sessionIds);
    const snapshotId = requiredString(entry.snapshotId, `sessions[${index}].snapshotId`);
    if (!snapshotIds.has(snapshotId)) throw new Error(`会话 ${id} 引用了不存在的快照。`);
    if (requiredString(entry.profileId, `sessions[${index}].profileId`) !== profileId) {
      throw new Error(`会话 ${id} 不属于备份账号。`);
    }
    const distribution = requiredObject(entry.distribution, `sessions[${index}].distribution`);
    enumString(distribution.preset, `sessions[${index}].distribution.preset`, ["uniform", "preserve", "high-tail", "reverse-j", "custom"]);
    const weights = requiredArray(distribution.weights, `sessions[${index}].distribution.weights`)
      .map((weight, weightIndex) => requiredNumber(weight, `sessions[${index}].distribution.weights[${weightIndex}]`));
    const levelCount = optionalNumber(distribution.levelCount, `sessions[${index}].distribution.levelCount`);
    if (levelCount !== undefined && (!Number.isInteger(levelCount) || levelCount < 3 || levelCount > 20)) {
      throw new Error(`备份中的 sessions[${index}].distribution.levelCount 不受支持。`);
    }
    const tagFilter = entry.tagFilter === undefined ? undefined : requiredObject(entry.tagFilter, `sessions[${index}].tagFilter`);
    if (tagFilter) {
      if (tagFilter.source !== "collection" || tagFilter.match !== "all") throw new Error(`会话 ${id} 的标签筛选规则不受支持。`);
      stringArray(tagFilter.tags, `sessions[${index}].tagFilter.tags`);
    }
    const budgetMode = entry.budgetMode === undefined ? undefined : enumString(entry.budgetMode, `sessions[${index}].budgetMode`, ["quick", "standard", "thorough"]);
    const comparisonReusePolicy = entry.comparisonReusePolicy === undefined ? undefined : enumString(entry.comparisonReusePolicy, `sessions[${index}].comparisonReusePolicy`, ["session", "snapshot", "profile"]);
    const comparisonHistoryMode = entry.comparisonHistoryMode === undefined ? undefined : enumString(entry.comparisonHistoryMode, `sessions[${index}].comparisonHistoryMode`, ["dynamic", "local"]);
    const stoppingTarget = entry.stoppingTarget === undefined ? undefined : enumString(entry.stoppingTarget, `sessions[${index}].stoppingTarget`, ["top-tail", "all-buckets"]);
    const suggestedComparisons = optionalNumber(entry.suggestedComparisons, `sessions[${index}].suggestedComparisons`);
    const maxComparisons = optionalNumber(entry.maxComparisons, `sessions[${index}].maxComparisons`);
    const upgradedFromSessionId = optionalString(entry.upgradedFromSessionId, `sessions[${index}].upgradedFromSessionId`);
    const derivedFromSessionId = optionalString(entry.derivedFromSessionId, `sessions[${index}].derivedFromSessionId`);
    const normalizedDistribution = normalizeDistributionConfig({ ...distribution, weights } as never);
    const normalizedTagFilter = collectionTagFilter(tagFilter ? stringArray(tagFilter.tags, `sessions[${index}].tagFilter.tags`) : []);
    const distributionChanged = distribution.preset !== normalizedDistribution.preset
      || levelCount !== normalizedDistribution.levelCount
      || weights.length !== normalizedDistribution.weights.length
      || weights.some((weight, weightIndex) => weight !== normalizedDistribution.weights[weightIndex]);
    const rawTags = tagFilter ? stringArray(tagFilter.tags, `sessions[${index}].tagFilter.tags`) : [];
    const normalizedTags = normalizedTagFilter?.tags ?? [];
    const tagFilterChanged = Boolean(tagFilter) !== Boolean(normalizedTagFilter)
      || rawTags.length !== normalizedTags.length
      || rawTags.some((tag, tagIndex) => tag !== normalizedTags[tagIndex]);
    if (comparisonHistoryMode !== "local" || stoppingTarget !== undefined || maxComparisons !== undefined
      || distributionChanged || tagFilterChanged) {
      compatibilitySessionIds.add(id);
    }
    return {
      ...entry,
      id,
      profileId,
      snapshotId,
      subjectType: enumNumber(entry.subjectType, `sessions[${index}].subjectType`, SUBJECT_TYPES),
      collectionTypes: requiredArray(entry.collectionTypes, `sessions[${index}].collectionTypes`).map((type, typeIndex) =>
        enumNumber(type, `sessions[${index}].collectionTypes[${typeIndex}]`, COLLECTION_TYPES)),
      title: requiredString(entry.title, `sessions[${index}].title`),
      status: enumString(entry.status, `sessions[${index}].status`, ["active", "complete"]),
      distribution: normalizedDistribution,
      randomSeed: requiredNumber(entry.randomSeed, `sessions[${index}].randomSeed`),
      modelVersion: requiredNumber(entry.modelVersion, `sessions[${index}].modelVersion`),
      budgetMode,
      comparisonReusePolicy,
      comparisonHistoryMode,
      stoppingTarget,
      suggestedComparisons,
      maxComparisons,
      upgradedFromSessionId,
      derivedFromSessionId,
      tagFilter: normalizedTagFilter,
      createdAt: requiredString(entry.createdAt, `sessions[${index}].createdAt`),
      updatedAt: requiredString(entry.updatedAt, `sessions[${index}].updatedAt`),
    } as ExportV1["sessions"][number];
  });

  const sessionItemIds = new Set<string>();
  const sessionItemPairs = new Set<string>();
  const sessionById = new Map(sessions.map((entry) => [entry.id, entry]));
  const sessionItems = requiredArray(root.sessionItems, "sessionItems").map((value, index) => {
    const entry = requiredObject(value, `sessionItems[${index}]`);
    const id = uniqueId(entry.id, `sessionItems[${index}].id`, sessionItemIds);
    const sessionId = requiredString(entry.sessionId, `sessionItems[${index}].sessionId`);
    const session = sessionById.get(sessionId);
    if (!session) throw new Error(`会话范围 ${id} 引用了不存在的会话。`);
    const subjectId = requiredNumber(entry.subjectId, `sessionItems[${index}].subjectId`);
    if (!Number.isInteger(subjectId)) throw new Error(`备份中的 sessionItems[${index}].subjectId 不是整数。`);
    const pair = `${sessionId}:${subjectId}`;
    if (sessionItemPairs.has(pair)) throw new Error(`会话 ${sessionId} 的作品范围包含重复条目 ${subjectId}。`);
    sessionItemPairs.add(pair);
    const item = items.find((candidate) => candidate.snapshotId === session.snapshotId && candidate.subjectId === subjectId);
    if (!item || item.subjectType !== session.subjectType) throw new Error(`会话 ${sessionId} 的作品 ${subjectId} 不存在于对应收藏快照。`);
    return { ...entry, id, sessionId, subjectId };
  });

  const comparisonIds = new Set<string>();
  const comparisons = requiredArray(root.comparisons, "comparisons").map((value, index) => {
    const entry = requiredObject(value, `comparisons[${index}]`);
    const id = uniqueId(entry.id, `comparisons[${index}].id`, comparisonIds);
    const sessionId = requiredString(entry.sessionId, `comparisons[${index}].sessionId`);
    const session = sessionById.get(sessionId);
    if (!session) throw new Error(`判断 ${id} 引用了不存在的会话。`);
    if (requiredString(entry.profileId, `comparisons[${index}].profileId`) !== profileId) throw new Error(`判断 ${id} 不属于备份账号。`);
    const subjectType = enumNumber(entry.subjectType, `comparisons[${index}].subjectType`, SUBJECT_TYPES);
    const leftSubjectId = requiredNumber(entry.leftSubjectId, `comparisons[${index}].leftSubjectId`);
    const rightSubjectId = requiredNumber(entry.rightSubjectId, `comparisons[${index}].rightSubjectId`);
    if (!Number.isInteger(leftSubjectId) || !Number.isInteger(rightSubjectId)) throw new Error(`判断 ${id} 的作品 ID 无效。`);
    if (subjectType !== session.subjectType || leftSubjectId === rightSubjectId
      || !sessionItemPairs.has(`${sessionId}:${leftSubjectId}`) || !sessionItemPairs.has(`${sessionId}:${rightSubjectId}`)) {
      throw new Error(`判断 ${id} 不符合所属会话的作品范围。`);
    }
    if (entry.queryKind !== undefined) enumString(entry.queryKind, `comparisons[${index}].queryKind`, ["adaptive", "exploration", "calibration", "manual"]);
    return {
      ...entry,
      id,
      profileId,
      sessionId,
      subjectType,
      leftSubjectId,
      rightSubjectId,
      outcome: enumString(entry.outcome, `comparisons[${index}].outcome`, ["left", "tie", "right", "skip"]),
      calibrationOfComparisonId: optionalString(entry.calibrationOfComparisonId, `comparisons[${index}].calibrationOfComparisonId`),
      inheritedFromComparisonId: optionalString(entry.inheritedFromComparisonId, `comparisons[${index}].inheritedFromComparisonId`),
      importBatchId: optionalString(entry.importBatchId, `comparisons[${index}].importBatchId`),
      importedFromSessionId: optionalString(entry.importedFromSessionId, `comparisons[${index}].importedFromSessionId`),
      importedFromComparisonId: optionalString(entry.importedFromComparisonId, `comparisons[${index}].importedFromComparisonId`),
      sourceCreatedAt: optionalString(entry.sourceCreatedAt, `comparisons[${index}].sourceCreatedAt`),
      acceptedCountAtAnswer: requiredNumber(entry.acceptedCountAtAnswer, `comparisons[${index}].acceptedCountAtAnswer`),
      active: requiredBoolean(entry.active, `comparisons[${index}].active`),
      createdAt: requiredString(entry.createdAt, `comparisons[${index}].createdAt`),
    };
  });

  const batchIds = new Set<string>();
  const importBatches = (root.importBatches === undefined ? [] : requiredArray(root.importBatches, "importBatches")).map((value, index) => {
    const entry = requiredObject(value, `importBatches[${index}]`);
    const id = uniqueId(entry.id, `importBatches[${index}].id`, batchIds);
    const targetSessionId = requiredString(entry.targetSessionId, `importBatches[${index}].targetSessionId`);
    const target = sessionById.get(targetSessionId);
    if (!target) throw new Error(`导入批次 ${id} 引用了不存在的目标会话。`);
    const targetSnapshotId = requiredString(entry.targetSnapshotId, `importBatches[${index}].targetSnapshotId`);
    if (!snapshotIds.has(targetSnapshotId) || target.snapshotId !== targetSnapshotId) throw new Error(`导入批次 ${id} 的目标快照无效。`);
    if (requiredString(entry.profileId, `importBatches[${index}].profileId`) !== profileId) throw new Error(`导入批次 ${id} 不属于备份账号。`);
    return {
      ...entry,
      id,
      profileId,
      targetSessionId,
      sourceSessionId: optionalString(entry.sourceSessionId, `importBatches[${index}].sourceSessionId`),
      sourceSnapshotId: optionalString(entry.sourceSnapshotId, `importBatches[${index}].sourceSnapshotId`),
      targetSnapshotId,
      sourceModelVersion: entry.sourceModelVersion === undefined ? undefined : requiredNumber(entry.sourceModelVersion, `importBatches[${index}].sourceModelVersion`),
      type: enumString(entry.type, `importBatches[${index}].type`, ["new-session", "existing-session", "upgrade", "derive", "migration"]),
      createdAt: requiredString(entry.createdAt, `importBatches[${index}].createdAt`),
      importedCount: requiredNumber(entry.importedCount, `importBatches[${index}].importedCount`),
      duplicateOriginalCount: requiredNumber(entry.duplicateOriginalCount, `importBatches[${index}].duplicateOriginalCount`),
      duplicatePairCount: requiredNumber(entry.duplicatePairCount, `importBatches[${index}].duplicatePairCount`),
      outOfScopeCount: requiredNumber(entry.outOfScopeCount, `importBatches[${index}].outOfScopeCount`),
      skippedCount: requiredNumber(entry.skippedCount, `importBatches[${index}].skippedCount`),
      invalidCalibrationCount: requiredNumber(entry.invalidCalibrationCount, `importBatches[${index}].invalidCalibrationCount`),
    };
  });

  const modelSessionIds = new Set<string>();
  const models = requiredArray(root.models, "models").map((value, index) => {
    const entry = requiredObject(value, `models[${index}]`);
    const sessionId = uniqueId(entry.sessionId, `models[${index}].sessionId`, modelSessionIds);
    if (!sessionById.has(sessionId)) throw new Error(`模型 ${sessionId} 引用了不存在的会话。`);
    return {
      ...entry,
      sessionId,
      version: requiredNumber(entry.version, `models[${index}].version`),
      abilities: numericRecord(entry.abilities, `models[${index}].abilities`),
      uncertainty: numericRecord(entry.uncertainty, `models[${index}].uncertainty`),
      acceptedComparisons: requiredNumber(entry.acceptedComparisons, `models[${index}].acceptedComparisons`),
      initialMeanUncertainty: requiredNumber(entry.initialMeanUncertainty, `models[${index}].initialMeanUncertainty`),
      currentMeanUncertainty: requiredNumber(entry.currentMeanUncertainty, `models[${index}].currentMeanUncertainty`),
      converged: requiredBoolean(entry.converged, `models[${index}].converged`),
      iterations: requiredNumber(entry.iterations, `models[${index}].iterations`),
      diagnostics: validateModelDiagnostics(entry.diagnostics, `models[${index}].diagnostics`),
      updatedAt: requiredString(entry.updatedAt, `models[${index}].updatedAt`),
    };
  });

  const batchById = new Map(importBatches.map((entry) => [entry.id, entry]));
  for (const entry of comparisons) {
    if (!entry.importBatchId) continue;
    const batch = batchById.get(entry.importBatchId);
    if (!batch || batch.targetSessionId !== entry.sessionId) {
      throw new Error(`判断 ${entry.id} 引用了不存在或不属于该会话的导入批次。`);
    }
  }

  const warnings: string[] = [];
  const danglingSessions = new Set<string>();
  const danglingComparisons = new Set<string>();
  for (const session of sessions) {
    for (const reference of [session.upgradedFromSessionId, session.derivedFromSessionId]) {
      if (reference && !sessionIds.has(reference)) danglingSessions.add(reference);
    }
  }
  for (const entry of comparisons) {
    if (entry.importedFromSessionId && !sessionIds.has(entry.importedFromSessionId)) danglingSessions.add(entry.importedFromSessionId);
    for (const reference of [entry.calibrationOfComparisonId, entry.inheritedFromComparisonId, entry.importedFromComparisonId]) {
      if (reference && !comparisonIds.has(reference)) danglingComparisons.add(reference);
    }
  }
  const danglingSnapshots = new Set<string>();
  for (const batch of importBatches) {
    if (batch.sourceSessionId && !sessionIds.has(batch.sourceSessionId)) danglingSessions.add(batch.sourceSessionId);
    if (batch.sourceSnapshotId && !snapshotIds.has(batch.sourceSnapshotId)) danglingSnapshots.add(batch.sourceSnapshotId);
  }
  if (danglingSessions.size > 0) warnings.push(`保留 ${danglingSessions.size} 个已删除来源会话的历史引用。`);
  if (danglingComparisons.size > 0) warnings.push(`保留 ${danglingComparisons.size} 个已删除或孤立判断的历史引用。`);
  if (danglingSnapshots.size > 0) warnings.push(`保留 ${danglingSnapshots.size} 个已删除来源快照的历史引用。`);
  if (compatibilitySessionIds.size > 0) warnings.push(`${compatibilitySessionIds.size} 个旧版会话需要兼容迁移并重新计算模型。`);
  if (normalizedNullPaths.length > 0) {
    warnings.push(`${normalizedNullPaths.length} 个旧版可选资料字段为 null，已按未提供处理。`);
  }

  return {
    payload: {
      schemaVersion: 1,
      appVersion,
      exportedAt,
      profile: profile as ExportV1["profile"],
      snapshots: snapshots as ExportV1["snapshots"],
      items: items as ExportV1["items"],
      sessions: sessions as ExportV1["sessions"],
      sessionItems: sessionItems as ExportV1["sessionItems"],
      comparisons: comparisons as ExportV1["comparisons"],
      importBatches: importBatches as ExportV1["importBatches"],
      models: models as ExportV1["models"],
    },
    warnings,
    compatibilitySessionIds: [...compatibilitySessionIds],
  };
}

export async function readBackup(file: File): Promise<ValidatedBackup> {
  if (file.size > 20 * 1024 * 1024) throw new Error("备份文件不能超过 20 MB。");
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw new Error("这不是有效的 JSON 备份文件。"); }
  const validated = validateBackupPayload(parsed);
  return {
    ...validated,
    digest: await sha256Hex(buffer),
    fileName: file.name,
    byteSize: file.size,
  };
}

export async function storageStatus() {
  const estimate = await navigator.storage?.estimate?.();
  const persisted = await navigator.storage?.persisted?.();
  return { usage: estimate?.usage ?? 0, quota: estimate?.quota ?? 0, persisted: Boolean(persisted) };
}

export async function requestPersistentStorage() {
  return Boolean(await navigator.storage?.persist?.());
}
