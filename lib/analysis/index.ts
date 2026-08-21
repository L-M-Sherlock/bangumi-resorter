import type {
  ComparisonBudgetMode,
  ComparisonRecord,
  CollectionItem,
  DistributionConfig,
  ModelState,
  PriorMode,
  SortingSession,
} from "../types";
import { summarizeRankingEvidence } from "../ranking/engine";
import {
  repeatedPairEffectiveSampleSize,
  SOURCE_AGE_HALF_LIFE_DAYS,
  STOPPING_MODE_ORDER,
} from "../ranking/strategy";
import {
  ANALYSIS_ALGORITHM_VERSION,
  type AnalysisHistoryEntry,
  type SessionAnalysisForecast,
  type SessionAnalysisIdentity,
  type SessionAnalysisInputIdentity,
  type SessionAnalysisPoint,
  type SessionAnalysisSeries,
  type SessionAnalysisStoppingCheck,
} from "./types";

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;
const HASH_OFFSET_A = 0x811c9dc5;
const HASH_OFFSET_B = 0x9e3779b9;

function hashText(value: string, offset: number) {
  let hash = offset >>> 0;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

export function analysisDigest(value: string) {
  return `${hashText(value, HASH_OFFSET_A)}${hashText(value, HASH_OFFSET_B)}`;
}

function stableNumber(value: number) {
  if (!Number.isFinite(value)) return "null";
  return Number(value.toPrecision(15)).toString();
}

export function distributionSignature(distribution: DistributionConfig) {
  return analysisDigest([
    distribution.preset,
    distribution.levelCount,
    ...distribution.weights.map(stableNumber),
  ].join("\u001f"));
}

export function analysisSeriesIdentity(
  sessionId: string,
  priorMode: PriorMode,
  distribution: DistributionConfig,
  itemCount: number,
): SessionAnalysisIdentity {
  const signature = distributionSignature(distribution);
  return {
    id: analysisDigest([sessionId, priorMode, signature, ANALYSIS_ALGORITHM_VERSION].join("\u001e")),
    sessionId,
    priorMode,
    distributionSignature: signature,
    algorithmVersion: ANALYSIS_ALGORITHM_VERSION,
    itemCount,
  };
}

function sourceOrder(entry: Pick<ComparisonRecord, "sourceCreatedAt" | "createdAt" | "id">) {
  return entry.sourceCreatedAt ?? entry.createdAt;
}

function sourceOrderValue(entry: Pick<ComparisonRecord, "sourceCreatedAt" | "createdAt" | "id">) {
  const parsed = Date.parse(sourceOrder(entry));
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
}

export function sortAnalysisRecords(records: ComparisonRecord[]) {
  return records
    .filter((entry) => entry.active && entry.outcome !== "skip")
    .sort((left, right) => sourceOrderValue(left) - sourceOrderValue(right)
      || sourceOrder(left).localeCompare(sourceOrder(right))
      || left.id.localeCompare(right.id));
}

export function toAnalysisHistory(records: ComparisonRecord[]): AnalysisHistoryEntry[] {
  return sortAnalysisRecords(records).map((record) => ({
    recordId: record.id,
    sessionId: record.sessionId,
    leftSubjectId: record.leftSubjectId,
    rightSubjectId: record.rightSubjectId,
    outcome: record.outcome as Exclude<typeof record.outcome, "skip">,
    acceptedCountAtAnswer: record.acceptedCountAtAnswer,
    queryKind: record.queryKind ?? "adaptive",
    calibrationOfComparisonId: record.calibrationOfComparisonId,
    inheritedFromComparisonId: record.inheritedFromComparisonId,
    importBatchId: record.importBatchId,
    importedFromSessionId: record.importedFromSessionId,
    importedFromComparisonId: record.importedFromComparisonId,
    sourceCreatedAt: record.sourceCreatedAt,
    createdAt: record.createdAt,
    imported: Boolean(record.importBatchId || record.importedFromSessionId),
  }));
}

function historyToken(entry: AnalysisHistoryEntry) {
  return [
    entry.recordId,
    entry.sessionId,
    entry.leftSubjectId,
    entry.rightSubjectId,
    entry.outcome,
    entry.acceptedCountAtAnswer,
    entry.queryKind,
    entry.calibrationOfComparisonId ?? "",
    entry.inheritedFromComparisonId ?? "",
    entry.importBatchId ?? "",
    entry.importedFromSessionId ?? "",
    entry.importedFromComparisonId ?? "",
    entry.sourceCreatedAt ?? "",
    entry.createdAt,
    entry.imported ? "1" : "0",
  ].join("\u001f");
}

export function analysisPrefixDigest(history: AnalysisHistoryEntry[], checkpoint = history.length) {
  const safeCheckpoint = Math.max(0, Math.min(history.length, Math.floor(checkpoint)));
  return analysisDigest(history.slice(0, safeCheckpoint).map(historyToken).join("\u001e"));
}

export function analysisInputDigest(input: SessionAnalysisInputIdentity) {
  return analysisDigest([
    input.sessionId,
    input.randomSeed,
    input.priorMode,
    distributionSignature(input.distribution),
    input.items.map((item) => `${item.subjectId}:${stableNumber(item.rate)}`).join(","),
    analysisPrefixDigest(input.history),
  ].join("\u001d"));
}

export interface SessionAnalysisContext extends SessionAnalysisInputIdentity {
  identity: SessionAnalysisIdentity;
  inputDigest: string;
  budgetMode: ComparisonBudgetMode;
}

export function sessionAnalysisContext(
  session: SortingSession,
  items: CollectionItem[],
  records: ComparisonRecord[],
  priorMode: PriorMode,
  budgetMode: ComparisonBudgetMode,
): SessionAnalysisContext {
  const history = toAnalysisHistory(records);
  const itemInputs = items.map(({ subjectId, rate }) => ({ subjectId, rate }))
    .sort((left, right) => left.subjectId - right.subjectId);
  const input: SessionAnalysisInputIdentity = {
    sessionId: session.id,
    randomSeed: session.randomSeed,
    priorMode,
    distribution: session.distribution,
    items: itemInputs,
    history,
  };
  return {
    ...input,
    identity: analysisSeriesIdentity(session.id, priorMode, session.distribution, items.length),
    inputDigest: analysisInputDigest(input),
    budgetMode,
  };
}

export function cleanCheckpointStep(itemCount: number) {
  const requested = Math.max(1, Math.ceil(Math.max(0, itemCount) / 6));
  const magnitude = 10 ** Math.floor(Math.log10(requested));
  for (const multiplier of [1, 2, 5, 10]) {
    const candidate = multiplier * magnitude;
    if (candidate >= requested) return candidate;
  }
  return 10 * magnitude;
}

/** Includes zero and the live endpoint. Long histories retain the newest 20 milestones. */
export function analysisCheckpoints(itemCount: number, evidenceCount: number, maximum = 60) {
  const endpoint = Math.max(0, Math.floor(evidenceCount));
  const step = cleanCheckpointStep(itemCount);
  const complete: number[] = [0];
  for (let checkpoint = step; checkpoint < endpoint; checkpoint += step) complete.push(checkpoint);
  if (complete.at(-1) !== endpoint) complete.push(endpoint);
  const limit = Math.max(2, Math.floor(maximum));
  if (complete.length <= limit) return complete;

  const newestCount = Math.min(20, limit - 1);
  const newest = complete.slice(-newestCount);
  const older = complete.slice(0, -newestCount);
  const olderSlots = limit - newest.length;
  const sampled = Array.from({ length: olderSlots }, (_, index) =>
    older[Math.round(index * (older.length - 1) / Math.max(1, olderSlots - 1))]);
  return [...new Set([...sampled, ...newest])].sort((left, right) => left - right);
}

export function isAnalysisMilestone(itemCount: number, checkpoint: number) {
  return checkpoint === 0 || (checkpoint > 0 && checkpoint % cleanCheckpointStep(itemCount) === 0);
}

function ageWeight(entry: AnalysisHistoryEntry) {
  if (!entry.sourceCreatedAt) return 1;
  const sourceTime = Date.parse(entry.sourceCreatedAt);
  const copiedTime = Date.parse(entry.createdAt);
  if (!Number.isFinite(sourceTime) || !Number.isFinite(copiedTime) || copiedTime <= sourceTime) return 1;
  return 2 ** (-((copiedTime - sourceTime) / MILLISECONDS_PER_DAY) / SOURCE_AGE_HALF_LIFE_DAYS);
}

function pairKey(entry: Pick<AnalysisHistoryEntry, "leftSubjectId" | "rightSubjectId">) {
  return entry.leftSubjectId < entry.rightSubjectId
    ? `${entry.leftSubjectId}:${entry.rightSubjectId}`
    : `${entry.rightSubjectId}:${entry.leftSubjectId}`;
}

export interface AnalysisEvidenceBreakdown {
  rawEvidence: number;
  agedEvidence: number;
  effectiveEvidence: number;
  uniquePairCount: number;
  coveredItemCount: number;
  sourceAgeLoss: number;
  repeatedPairLoss: number;
  calibrationRaw: number;
  calibrationEffective: number;
  importedRaw: number;
  importedEffective: number;
}

export function analysisEvidenceBreakdown(history: AnalysisHistoryEntry[]): AnalysisEvidenceBreakdown {
  const evidence = summarizeRankingEvidence(history);
  const pairMass = new Map<string, number>();
  for (const entry of history) {
    const key = pairKey(entry);
    pairMass.set(key, (pairMass.get(key) ?? 0) + ageWeight(entry));
  }
  let agedEvidence = 0;
  let calibrationRaw = 0;
  let calibrationEffective = 0;
  let importedRaw = 0;
  let importedEffective = 0;
  for (const entry of history) {
    const weight = ageWeight(entry);
    const mass = pairMass.get(pairKey(entry)) ?? weight;
    const contribution = mass > 0 ? weight * repeatedPairEffectiveSampleSize(mass) / mass : 0;
    agedEvidence += weight;
    if (entry.queryKind === "calibration") {
      calibrationRaw += 1;
      calibrationEffective += contribution;
    }
    if (entry.imported) {
      importedRaw += 1;
      importedEffective += contribution;
    }
  }
  return {
    rawEvidence: history.length,
    agedEvidence,
    effectiveEvidence: evidence.evidenceCount,
    uniquePairCount: evidence.uniquePairCount,
    coveredItemCount: evidence.coveredItemCount,
    sourceAgeLoss: Math.max(0, history.length - agedEvidence),
    repeatedPairLoss: Math.max(0, agedEvidence - evidence.evidenceCount),
    calibrationRaw,
    calibrationEffective,
    importedRaw,
    importedEffective,
  };
}

function mappedStoppingChecks(model: ModelState) {
  const mapped: Partial<Record<ComparisonBudgetMode, SessionAnalysisStoppingCheck>> = {};
  for (const check of model.diagnostics?.stoppingChecks ?? []) {
    mapped[check.mode] = {
      mode: check.mode,
      target: check.target,
      probabilityTarget: check.probabilityTarget,
      sampleCount: check.sampleCount,
      stableSamples: check.stableSamples,
      probability: check.probability,
      low: check.low,
      high: check.high,
      ready: check.ready,
    };
  }
  return mapped;
}

function mappedForecasts(model: ModelState) {
  const mapped: Partial<Record<ComparisonBudgetMode, SessionAnalysisForecast>> = {};
  for (const mode of STOPPING_MODE_ORDER) {
    const forecast = model.diagnostics?.forecasts?.[mode];
    if (!forecast) continue;
    mapped[mode] = {
      mode,
      status: forecast.status,
      rolloutCount: forecast.rolloutCount,
      lowerAdditional: forecast.lowerAdditional,
      medianAdditional: forecast.medianAdditional,
      upperAdditional: forecast.upperAdditional,
      projectionHorizon: forecast.projectionHorizon,
      probabilityWithinProjection: forecast.probabilityWithinProjection,
      withinProjectionSuccesses: forecast.withinProjectionSuccesses,
      probabilityWithinProjectionLow: forecast.probabilityWithinProjectionLow,
      probabilityWithinProjectionHigh: forecast.probabilityWithinProjectionHigh,
    };
  }
  return mapped;
}

export function analysisPointFromModel(
  history: AnalysisHistoryEntry[],
  model: ModelState,
  computedAt = new Date().toISOString(),
): SessionAnalysisPoint {
  const evidence = analysisEvidenceBreakdown(history);
  const diagnostics = model.diagnostics;
  return {
    checkpoint: history.length,
    prefixDigest: analysisPrefixDigest(history),
    ...evidence,
    meanUncertainty: model.currentMeanUncertainty,
    tieStrength: model.tieStrength ?? diagnostics?.tieStrength ?? 0,
    posteriorSampleCount: diagnostics?.sampleCount ?? 0,
    expectedCrossTwoBucketCount: diagnostics?.expectedCrossTwoBucketCount,
    crossTwoBucketCountMedian: diagnostics?.crossTwoBucketCountMedian,
    crossTwoBucketCountLow: diagnostics?.crossTwoBucketCountLow,
    crossTwoBucketCountHigh: diagnostics?.crossTwoBucketCountHigh,
    stoppingChecks: mappedStoppingChecks(model),
    forecasts: mappedForecasts(model),
    computedAt,
  };
}

export function reconcileAnalysisSeries(
  series: SessionAnalysisSeries | undefined,
  identity: SessionAnalysisIdentity,
  history: AnalysisHistoryEntry[],
  inputDigest: string,
) {
  const compatible = series
    && series.id === identity.id
    && series.algorithmVersion === identity.algorithmVersion
    && series.distributionSignature === identity.distributionSignature
    && series.itemCount === identity.itemCount;
  const expected = new Set(analysisCheckpoints(identity.itemCount, history.length));
  const milestones = compatible ? series.milestones.filter((point) =>
    expected.has(point.checkpoint)
    && point.checkpoint <= history.length
    && point.prefixDigest === analysisPrefixDigest(history, point.checkpoint)) : [];
  const latest = compatible && series.latest?.checkpoint === history.length
    && series.latest.prefixDigest === analysisPrefixDigest(history)
    ? series.latest
    : undefined;
  return {
    ...identity,
    inputDigest,
    milestones: milestones.sort((left, right) => left.checkpoint - right.checkpoint),
    latest,
    updatedAt: series?.updatedAt ?? new Date().toISOString(),
  } satisfies SessionAnalysisSeries;
}

export function mergeAnalysisPoint(
  series: SessionAnalysisSeries,
  point: SessionAnalysisPoint,
  history: AnalysisHistoryEntry[],
  latest = false,
) {
  if (point.checkpoint > history.length
    || point.prefixDigest !== analysisPrefixDigest(history, point.checkpoint)) return series;
  const mergedMilestones = isAnalysisMilestone(series.itemCount, point.checkpoint)
    ? [...series.milestones.filter((entry) => entry.checkpoint !== point.checkpoint), point]
      .sort((left, right) => left.checkpoint - right.checkpoint)
    : series.milestones;
  const expected = new Set(analysisCheckpoints(series.itemCount, history.length));
  const milestones = mergedMilestones.filter((entry) => expected.has(entry.checkpoint));
  return {
    ...series,
    milestones,
    latest: latest ? point : series.latest,
    updatedAt: new Date().toISOString(),
  };
}

export function analysisSeriesPoints(series: SessionAnalysisSeries | undefined, live: SessionAnalysisPoint) {
  const byCheckpoint = new Map<number, SessionAnalysisPoint>();
  for (const point of series?.milestones ?? []) byCheckpoint.set(point.checkpoint, point);
  byCheckpoint.set(live.checkpoint, live);
  return [...byCheckpoint.values()].sort((left, right) => left.checkpoint - right.checkpoint);
}
