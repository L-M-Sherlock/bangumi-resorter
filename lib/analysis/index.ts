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

/**
 * The historical order is the time at which the comparison actually
 * happened. Imported rows carry that time in sourceCreatedAt; their local
 * createdAt is only the time they were copied into this session and must not
 * reorder the historical reconstruction.
 */
function arrivalOrderValue(entry: Pick<ComparisonRecord, "createdAt" | "sourceCreatedAt">) {
  const parsed = Date.parse(entry.sourceCreatedAt ?? entry.createdAt);
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
}

export function sortAnalysisRecords(records: ComparisonRecord[]) {
  const active = records.filter((entry) => entry.active && entry.outcome !== "skip");
  return [...active].sort(recordArrivalOrder);
}

function recordArrivalOrder(left: ComparisonRecord, right: ComparisonRecord) {
  return arrivalOrderValue(left) - arrivalOrderValue(right)
    || left.id.localeCompare(right.id);
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

function availabilityOrderValue(entry: Pick<AnalysisHistoryEntry, "createdAt">) {
  const parsed = Date.parse(entry.createdAt);
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
}

/** The evidence set that was actually visible to the session at each historical checkpoint. */
export function sortAnalysisHistoryByAvailability(history: AnalysisHistoryEntry[]) {
  return [...history].sort((left, right) =>
    availabilityOrderValue(left) - availabilityOrderValue(right)
    || left.recordId.localeCompare(right.recordId));
}

export function analysisHistoryOrderDiffers(history: AnalysisHistoryEntry[]) {
  return sortAnalysisHistoryByAvailability(history)
    .some((entry, index) => entry.recordId !== history[index]?.recordId);
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

/** Historical model states follow the reconstructed actual occurrence order. */
export function analysisCheckpointsForHistory(
  itemCount: number,
  history: AnalysisHistoryEntry[],
  maximum = 60,
) {
  return analysisCheckpoints(itemCount, history.length, maximum);
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
  manualRaw: number;
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
  let manualRaw = 0;
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
    if (entry.queryKind === "manual") manualRaw += 1;
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
    manualRaw,
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
  const stoppingChecks = mappedStoppingChecks(model);
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
    stoppingChecks,
    backtestStoppingChecks: stoppingChecks,
    forecasts: mappedForecasts(model),
    forecastImportedRaw: evidence.importedRaw,
    forecastManualRaw: evidence.manualRaw,
    forecastPrefixDigest: analysisPrefixDigest(history),
    computedAt,
  };
}

/** Retain source-time diagnostics while attaching a causally available forecast state. */
export function analysisPointWithAvailabilityForecast(
  sourcePoint: SessionAnalysisPoint,
  availabilityPoint: SessionAnalysisPoint,
): SessionAnalysisPoint {
  return {
    ...sourcePoint,
    forecasts: availabilityPoint.forecasts,
    backtestStoppingChecks: availabilityPoint.stoppingChecks,
    forecastImportedRaw: availabilityPoint.importedRaw,
    forecastManualRaw: availabilityPoint.manualRaw,
    forecastPrefixDigest: availabilityPoint.prefixDigest,
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
  const expected = new Set(analysisCheckpointsForHistory(identity.itemCount, history));
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
  const expected = new Set(analysisCheckpointsForHistory(series.itemCount, history));
  const mergedMilestones = expected.has(point.checkpoint)
    ? [...series.milestones.filter((entry) => entry.checkpoint !== point.checkpoint), point]
      .sort((left, right) => left.checkpoint - right.checkpoint)
    : series.milestones;
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

export interface AnalysisForecastBacktest {
  mode: ComparisonBudgetMode;
  status: "observed" | "right-censored";
  /** First integer answer count in the checkpoint-resolution stopping window. */
  observedStopWindowStart?: number;
  /** Last integer answer count in the checkpoint-resolution stopping window. */
  observedStopCheckpoint?: number;
  forecastCount: number;
  boundedIntervalCount: number;
  boundedIntervalHits: number;
  /** Forecast interval ended before the checkpoint-resolution stop window. */
  belowIntervalCount: number;
  /** Forecast interval started after the checkpoint-resolution stop window. */
  aboveIntervalCount: number;
  interruptedForecastCount: number;
  empiricalIntervalCoverage?: number;
  medianAbsoluteError?: number;
  medianBias?: number;
}

function median(values: number[]) {
  if (values.length === 0) return undefined;
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2
    ? ordered[middle]
    : (ordered[middle - 1] + ordered[middle]) / 2;
}

/** Retrospective, checkpoint-resolution evaluation; incomplete modes are right-censored. */
export function analysisForecastBacktest(
  points: SessionAnalysisPoint[],
  mode: ComparisonBudgetMode,
): AnalysisForecastBacktest {
  const ordered = [...points].sort((left, right) => left.checkpoint - right.checkpoint);
  const backtestCheck = (point: SessionAnalysisPoint) =>
    point.backtestStoppingChecks?.[mode] ?? point.stoppingChecks[mode];
  const forecastImportedRaw = (point: SessionAnalysisPoint) =>
    point.forecastImportedRaw ?? point.importedRaw;
  const forecastManualRaw = (point: SessionAnalysisPoint) =>
    point.forecastManualRaw ?? point.manualRaw ?? 0;
  const stopped = ordered.find((point) => backtestCheck(point)?.ready);
  const lastKnownNotReady = stopped
    ? ordered.filter((point) => point.checkpoint < stopped.checkpoint && !backtestCheck(point)?.ready).at(-1)
    : undefined;
  const observedStopWindowStart = stopped
    ? (lastKnownNotReady?.checkpoint ?? -1) + 1
    : undefined;
  const endpoint = stopped ?? ordered.at(-1);
  const comparableForecast = (point: SessionAnalysisPoint) =>
    forecastImportedRaw(point) === (endpoint ? forecastImportedRaw(endpoint) : undefined)
    && forecastManualRaw(point) === (endpoint ? forecastManualRaw(endpoint) : undefined);
  const candidateForecasts = ordered.filter((point) => point.checkpoint < (stopped?.checkpoint ?? Number.POSITIVE_INFINITY)
    && point.forecasts[mode]?.medianAdditional !== undefined);
  const interruptedForecastCount = candidateForecasts.filter((point) => !comparableForecast(point)).length;
  if (!stopped) {
    return {
      mode,
      status: "right-censored",
      forecastCount: candidateForecasts.length - interruptedForecastCount,
      boundedIntervalCount: 0,
      boundedIntervalHits: 0,
      belowIntervalCount: 0,
      aboveIntervalCount: 0,
      interruptedForecastCount,
    };
  }
  const errors: number[] = [];
  let boundedIntervalCount = 0;
  let boundedIntervalHits = 0;
  let belowIntervalCount = 0;
  let aboveIntervalCount = 0;
  for (const point of ordered) {
    if (point.checkpoint >= stopped.checkpoint) continue;
    const forecast = point.forecasts[mode];
    if (forecast?.medianAdditional === undefined) continue;
    if (!comparableForecast(point)) continue;
    const actualAdditionalLow = Math.max(0, observedStopWindowStart! - point.checkpoint);
    const actualAdditionalHigh = stopped.checkpoint - point.checkpoint;
    const error = forecast.medianAdditional < actualAdditionalLow
      ? forecast.medianAdditional - actualAdditionalLow
      : forecast.medianAdditional > actualAdditionalHigh
        ? forecast.medianAdditional - actualAdditionalHigh
        : 0;
    errors.push(error);
    if (forecast.lowerAdditional === undefined || forecast.upperAdditional === undefined) continue;
    boundedIntervalCount += 1;
    if (forecast.lowerAdditional <= actualAdditionalHigh
      && forecast.upperAdditional >= actualAdditionalLow) {
      boundedIntervalHits += 1;
    } else if (forecast.upperAdditional < actualAdditionalLow) {
      belowIntervalCount += 1;
    } else if (forecast.lowerAdditional > actualAdditionalHigh) {
      aboveIntervalCount += 1;
    }
  }
  return {
    mode,
    status: "observed",
    observedStopWindowStart,
    observedStopCheckpoint: stopped.checkpoint,
    forecastCount: errors.length,
    boundedIntervalCount,
    boundedIntervalHits,
    belowIntervalCount,
    aboveIntervalCount,
    interruptedForecastCount,
    empiricalIntervalCoverage: boundedIntervalCount > 0
      ? boundedIntervalHits / boundedIntervalCount
      : undefined,
    medianAbsoluteError: median(errors.map(Math.abs)),
    medianBias: median(errors),
  };
}

export interface AnalysisForecastReliability {
  status: "insufficient" | "compatible" | "systematic-underprediction" | "systematic-overprediction";
  suppressInterval: boolean;
  directionalMissCount: number;
  requiredDirectionalMissCount: number;
}

/**
 * Conservative within-session guard. Correlated checkpoints are not treated
 * as independent calibration samples: protection requires at least three
 * bounded forecasts, 80% same-direction misses, and one full checkpoint step
 * of median bias.
 */
export function analysisForecastReliability(
  backtest: AnalysisForecastBacktest,
  checkpointStep: number,
): AnalysisForecastReliability {
  const requiredDirectionalMissCount = Math.max(
    3,
    Math.ceil(backtest.boundedIntervalCount * 0.8),
  );
  if (backtest.status !== "observed"
    || backtest.forecastCount < 3
    || backtest.boundedIntervalCount < 3
    || backtest.medianBias === undefined) {
    return {
      status: "insufficient",
      suppressInterval: false,
      directionalMissCount: 0,
      requiredDirectionalMissCount,
    };
  }
  const materialBias = Math.max(1, checkpointStep);
  if (backtest.belowIntervalCount >= requiredDirectionalMissCount
    && backtest.medianBias <= -materialBias) {
    return {
      status: "systematic-underprediction",
      suppressInterval: true,
      directionalMissCount: backtest.belowIntervalCount,
      requiredDirectionalMissCount,
    };
  }
  if (backtest.aboveIntervalCount >= requiredDirectionalMissCount
    && backtest.medianBias >= materialBias) {
    return {
      status: "systematic-overprediction",
      suppressInterval: true,
      directionalMissCount: backtest.aboveIntervalCount,
      requiredDirectionalMissCount,
    };
  }
  return {
    status: "compatible",
    suppressInterval: false,
    directionalMissCount: Math.max(backtest.belowIntervalCount, backtest.aboveIntervalCount),
    requiredDirectionalMissCount,
  };
}
