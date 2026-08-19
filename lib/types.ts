export const SUBJECT_TYPES = {
  1: "书籍",
  2: "动画",
  3: "音乐",
  4: "游戏",
  6: "三次元",
} as const;

export const COLLECTION_TYPES = {
  1: "想看",
  2: "看过",
  3: "在看",
  4: "搁置",
  5: "抛弃",
} as const;

export type SubjectType = keyof typeof SUBJECT_TYPES;
export type CollectionType = keyof typeof COLLECTION_TYPES;
export type ComparisonOutcome = "left" | "tie" | "right" | "skip";
export type SessionStatus = "active" | "complete";
export type DistributionPreset = "uniform" | "preserve" | "high-tail" | "reverse-j" | "custom";
export type ComparisonBudgetMode = "quick" | "standard" | "thorough";
export type ComparisonReusePolicy = "session" | "snapshot" | "profile";
/** How a session obtains comparison history. Dynamic is retained for legacy data only. */
export type ComparisonHistoryMode = "dynamic" | "local";
export type ComparisonImportBatchType = "new-session" | "existing-session" | "upgrade" | "derive" | "migration";
export type QueryKind = "adaptive" | "exploration" | "calibration" | "manual";

export interface SubjectImages {
  large?: string;
  common?: string;
  medium?: string;
  small?: string;
  grid?: string;
}

export interface CollectionItem {
  snapshotId: string;
  subjectId: number;
  subjectType: SubjectType;
  collectionType: CollectionType;
  rate: number;
  name: string;
  nameCn: string;
  date?: string;
  platform?: string;
  image?: string;
  private: boolean;
  tags: string[];
  updatedAt?: string;
}

export interface Profile {
  id: string;
  username: string;
  nickname?: string;
  avatar?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Snapshot {
  id: string;
  profileId: string;
  username: string;
  syncedAt: string;
  itemCount: number;
  containsPrivate: boolean;
}

export interface DistributionConfig {
  preset: DistributionPreset;
  /** Number of output score buckets. Legacy sessions without this field use 10. */
  levelCount: number;
  weights: number[];
}

export interface SessionTagFilter {
  source: "collection";
  match: "all";
  tags: string[];
}

export interface SortingSession {
  id: string;
  profileId: string;
  snapshotId: string;
  subjectType: SubjectType;
  collectionTypes: CollectionType[];
  title: string;
  status: SessionStatus;
  distribution: DistributionConfig;
  randomSeed: number;
  modelVersion: number;
  /** Missing only on backups created before comparison budgets were introduced. */
  budgetMode?: ComparisonBudgetMode;
  /** Missing on pre-0.4 sessions, which retain the legacy profile-wide behavior. */
  comparisonReusePolicy?: ComparisonReusePolicy;
  /** New sessions own a frozen local history. Dynamic is only used while migrating legacy data. */
  comparisonHistoryMode?: ComparisonHistoryMode;
  /** @deprecated Pre-0.6 preference; retained only so old backups remain readable. */
  stoppingTarget?: "top-tail" | "all-buckets";
  /** Legacy pre-dynamic-budget hint. Kept only so older backups remain readable. */
  suggestedComparisons?: number;
  /** @deprecated Pre-0.13 hard cap; ignored and removed during database upgrade/import. */
  maxComparisons?: number;
  /** Set when this session was forked onto a newer collection snapshot. */
  upgradedFromSessionId?: string;
  /** Set when this session was forked with a different immutable item scope. */
  derivedFromSessionId?: string;
  /** Missing or empty means that all personal collection tags are accepted. */
  tagFilter?: SessionTagFilter;
  createdAt: string;
  updatedAt: string;
}

export interface SessionItem {
  id: string;
  sessionId: string;
  subjectId: number;
}

export interface SessionScopePreview {
  sourceSessionId: string;
  targetSnapshotId: string;
  previousItemCount: number;
  currentItemCount: number;
  addedSubjectIds: number[];
  removedSubjectIds: number[];
  inheritedComparisonCount: number;
  droppedComparisonCount: number;
}

export interface SessionUpgradePreview extends SessionScopePreview {
  ratingChangedSubjectIds: number[];
}

export interface ComparisonRecord {
  id: string;
  profileId: string;
  sessionId: string;
  subjectType: SubjectType;
  leftSubjectId: number;
  rightSubjectId: number;
  outcome: ComparisonOutcome;
  /** Missing on pre-0.4 records, which are ordinary adaptive questions. */
  queryKind?: QueryKind;
  calibrationOfComparisonId?: string;
  /**
   * Canonical root judgment ID. It survives any number of import generations
   * and is used for idempotency; it is provenance, not a runtime foreign key.
   */
  inheritedFromComparisonId?: string;
  /** Import batch that materialized this record into the current session. */
  importBatchId?: string;
  /** Session containing the direct source record, when this is an imported copy. */
  importedFromSessionId?: string;
  /** Direct source record ID, when this is an imported copy. */
  importedFromComparisonId?: string;
  /** Original source timestamp, preserved separately from local materialization time. */
  sourceCreatedAt?: string;
  acceptedCountAtAnswer: number;
  active: boolean;
  createdAt: string;
}

export interface ComparisonImportBatch {
  id: string;
  profileId: string;
  targetSessionId: string;
  sourceSessionId?: string;
  sourceSnapshotId?: string;
  targetSnapshotId: string;
  sourceModelVersion?: number;
  type: ComparisonImportBatchType;
  createdAt: string;
  importedCount: number;
  duplicateOriginalCount: number;
  duplicatePairCount: number;
  outOfScopeCount: number;
  skippedCount: number;
  invalidCalibrationCount: number;
}

/** Scope and version information used when previewing a one-time import. */
export interface ComparisonImportTarget {
  targetSessionId?: string;
  profileId: string;
  snapshotId: string;
  subjectType: SubjectType;
  allowedSubjectIds: number[];
  targetVersion?: number;
}

export interface ComparisonImportPreview {
  targetSessionId?: string;
  sourceSessionId: string;
  targetVersion: number;
  sourceVersion: number;
  sourceTitle: string;
  sourceSnapshotId: string;
  targetSnapshotId: string;
  crossSnapshot: boolean;
  dedupeByRoot: boolean;
  importableCount: number;
  duplicateOriginalCount: number;
  duplicatePairCount: number;
  outOfScopeCount: number;
  skippedCount: number;
  invalidCalibrationCount: number;
  /**
   * Materialized records reserved by an existing-session preview. These are
   * in-memory only: they let the ranking worker calculate the exact post-
   * import model before the atomic commit, and are never written by preview.
   */
  plannedBatch?: ComparisonImportBatch;
  plannedRecords?: ComparisonRecord[];
}

export interface ComparisonImportResult {
  session: SortingSession;
  batch: ComparisonImportBatch;
  preview: ComparisonImportPreview;
  records: ComparisonRecord[];
}

export interface CalibrationDiagnostics {
  attempted: number;
  completed: number;
  consistent: number;
  consistencyRate?: number;
  /** Mean of a Beta(1, 1) posterior over repeat consistency. */
  posteriorMean: number;
  /** Central 80% credible interval for repeat consistency. */
  credibleLow: number;
  credibleHigh: number;
  /** Posterior probability that repeat consistency is better than chance. */
  probabilityAboveChance: number;
  /** @deprecated Diagnostic only; it must not gate stopping or forecasting. */
  acceptable: boolean;
}

export type StoppingForecastStatus = "ready" | "forecast" | "uncertain" | "limit";

export interface StoppingForecast {
  method: "posterior-contraction-mc-v1" | "posterior-contraction-mc-v2" | "posterior-contraction-mc-v3" | "posterior-contraction-mc-v4" | "posterior-contraction-mc-v5";
  status: StoppingForecastStatus;
  rolloutCount: number;
  /** Integer additional accepted answers at the 10th, 50th, and 90th stopping-time percentiles. */
  lowerAdditional?: number;
  medianAdditional?: number;
  upperAdditional?: number;
  nextCheckpoint: number;
  probabilityWithin20: number;
  projectionHorizon: number;
  probabilityWithinProjection: number;
  /** Successful rollouts and central 90% Wilson Monte Carlo interval. */
  within20Successes?: number;
  probabilityWithin20Low?: number;
  probabilityWithin20High?: number;
  withinProjectionSuccesses?: number;
  probabilityWithinProjectionLow?: number;
  probabilityWithinProjectionHigh?: number;
  /** @deprecated Pre-0.13 forecast fields retained for old serialized models. */
  probabilityBeforeLimit?: number;
  beforeLimitSuccesses?: number;
  probabilityBeforeLimitLow?: number;
  probabilityBeforeLimitHigh?: number;
  remainingCapacity?: number;
}

export interface RankingDiagnostics {
  method: "laplace-mc-v1" | "laplace-mc-v2" | "laplace-mc-v3" | "laplace-mc-v4";
  sampleCount: number;
  /** Per-item probability of remaining in the exact current bucket. */
  bucketStability: Record<number, number>;
  /** Per-item probability of remaining within one bucket of the current assignment. */
  adjacentBucketStabilityByItem: Record<number, number>;
  /** Posterior probability that every item simultaneously remains in its current score bucket. */
  jointBucketStability: number;
  jointBucketStableSamples: number;
  /** Central 90% Monte Carlo interval for jointBucketStability. */
  jointBucketStabilityLow: number;
  jointBucketStabilityHigh: number;
  /** Posterior probability that no item moves more than one bucket from the current assignment. */
  adjacentBucketStability: number;
  adjacentBucketStableSamples: number;
  /** Central 90% Monte Carlo interval for adjacentBucketStability. */
  adjacentBucketStabilityLow: number;
  adjacentBucketStabilityHigh: number;
  /** Posterior probability that at least 90% of items remain within one bucket. */
  coverageTargetStability: number;
  coverageTargetStableSamples: number;
  /** Central 90% Monte Carlo interval for coverageTargetStability. */
  coverageTargetStabilityLow: number;
  coverageTargetStabilityHigh: number;
  /** Integer form of the 90%-of-items stopping event for this collection size. */
  requiredAdjacentStableItemCount: number;
  allowedCrossTwoBucketCount: number;
  /** Posterior distribution of items moving more than one bucket: mean and central 80% interval. */
  expectedCrossTwoBucketCount?: number;
  crossTwoBucketCountMedian?: number;
  crossTwoBucketCountLow?: number;
  crossTwoBucketCountHigh?: number;
  /** Posterior median and 90th percentile of the largest absolute bucket displacement. */
  maxBucketDisplacementMedian?: number;
  maxBucketDisplacementHigh?: number;
  expectedBucketChangeRate: number;
  minBucketStability: number;
  /** Conservative 90%-coverage stopping-event risk ratio; at or below 1 is acceptable. */
  decisionRiskRatio: number;
  evidenceCount: number;
  evidenceRequired: number;
  /** @deprecated Pre-0.13 diagnostics; no longer used to block comparisons. */
  fatigueLimit?: number;
  /** @deprecated Pre-0.13 diagnostics; no longer used to block comparisons. */
  fatigueReached?: boolean;
  ready: boolean;
  /** Nested prior-robustness checks required by the selected inference mode. */
  stoppingChecks?: Array<{
    mode: ComparisonBudgetMode;
    sampleCount: number;
    stableSamples: number;
    probability: number;
    low: number;
    high: number;
    ready: boolean;
  }>;
  stoppingBottleneckMode?: ComparisonBudgetMode;
  calibration: CalibrationDiagnostics;
  forecast?: StoppingForecast;
}

export interface ModelState {
  sessionId: string;
  version: number;
  abilities: Record<number, number>;
  uncertainty: Record<number, number>;
  acceptedComparisons: number;
  initialMeanUncertainty: number;
  currentMeanUncertainty: number;
  converged: boolean;
  iterations: number;
  diagnostics?: RankingDiagnostics;
  updatedAt: string;
}

export interface RankingItemInput {
  subjectId: number;
  rate: number;
}

export interface RankingComparisonInput {
  leftSubjectId: number;
  rightSubjectId: number;
  outcome: Exclude<ComparisonOutcome, "skip">;
}

export interface RankingHistoryInput {
  recordId: string;
  sessionId: string;
  leftSubjectId: number;
  rightSubjectId: number;
  outcome: ComparisonOutcome;
  acceptedCountAtAnswer: number;
  queryKind: QueryKind;
  calibrationOfComparisonId?: string;
  createdAt: string;
}

export interface PairSkipInput {
  leftSubjectId: number;
  rightSubjectId: number;
  acceptedCountAtAnswer: number;
}

export interface NextPair {
  pairId: string;
  leftSubjectId: number;
  rightSubjectId: number;
  modelVersion: number;
  informationScore: number;
  queryKind: QueryKind;
  calibrationOfComparisonId?: string;
}

export interface RankedItem extends CollectionItem {
  rank: number;
  ability: number;
  uncertainty: number;
  newRate: number;
  bucketStability?: number;
  comparisonCount: number;
}

export interface ExportV1 {
  schemaVersion: 1;
  appVersion: string;
  exportedAt: string;
  profile: Profile;
  snapshots: Snapshot[];
  items: CollectionItem[];
  sessions: SortingSession[];
  sessionItems: SessionItem[];
  comparisons: ComparisonRecord[];
  /** Optional in legacy backups; present in current backups. */
  importBatches?: ComparisonImportBatch[];
  models: ModelState[];
}

export type BackupImportMode = "create" | "merge" | "replace";
export type BackupImportAuditMode = BackupImportMode | "legacy-clone-migration" | "legacy-clone-deletion" | "snapshot-deletion";
export type BackupEntityKind = "profile" | "snapshot" | "session" | "comparison" | "importBatch";

export interface ValidatedBackup {
  payload: ExportV1;
  digest: string;
  fileName: string;
  byteSize: number;
  warnings: string[];
  /** Sessions whose legacy fields were converted while validating the file. */
  compatibilitySessionIds?: string[];
}

export interface BackupImportIdMapping {
  entity: BackupEntityKind;
  sourceId: string;
  targetId: string;
  reason: "canonical-profile" | "collision" | "conflict" | "legacy-clone";
}

export interface BackupImportedSessionFingerprint {
  sourceSessionId: string;
  targetSessionId: string;
  sourceFingerprint: string;
  targetFingerprint: string;
}

export interface BackupImportAudit {
  id: string;
  profileId: string;
  mode: BackupImportAuditMode;
  sourceUsername: string;
  sourceExportedAt?: string;
  sourceAppVersion?: string;
  backupDigest?: string;
  createdAt: string;
  selectedSessionIds: string[];
  dependencySessionIds: string[];
  importedSnapshotIds: string[];
  importedSessionIds: string[];
  importedComparisonIds: string[];
  importedBatchIds: string[];
  importedModelSessionIds: string[];
  reusedSessionIds: string[];
  conflictSessionIds: string[];
  importedComparisonCount: number;
  reusedSessionCount: number;
  conflictSessionCount: number;
  warnings: string[];
  idMappings: BackupImportIdMapping[];
  sessionFingerprints: BackupImportedSessionFingerprint[];
  legacyCloneProfileIds?: string[];
  legacySnapshotIds?: string[];
  legacySessionIds?: string[];
  deletedSnapshotIds?: string[];
  deletedSessionIds?: string[];
  deletedComparisonIds?: string[];
  deletedImportBatchIds?: string[];
  deletedModelSessionIds?: string[];
  deletedAt?: string;
  deletedByAuditId?: string;
  supersededAt?: string;
  supersededByImportId?: string;
}

export type BackupSessionImportStatus = "new" | "duplicate" | "conflict";

export interface BackupImportSessionPreview {
  id: string;
  title: string;
  snapshotId: string;
  subjectType: SubjectType;
  itemCount: number;
  comparisonCount: number;
  status: BackupSessionImportStatus;
  selected: boolean;
  required: boolean;
  targetSessionId?: string;
}

export interface BackupImportCounts {
  snapshots: number;
  items: number;
  sessions: number;
  comparisons: number;
  models: number;
}

export interface BackupImportPreview {
  targetProfileId: string;
  targetExists: boolean;
  suggestedMode: BackupImportMode;
  targetRevision?: string;
  source: BackupImportCounts;
  target: BackupImportCounts;
  sessions: BackupImportSessionPreview[];
  selectedSessionIds: string[];
  dependencySessionIds: string[];
  importableSessionCount: number;
  reusedSessionCount: number;
  conflictSessionCount: number;
  warnings: string[];
}

export interface BackupImportRequest {
  mode: BackupImportMode;
  selectedSessionIds?: string[];
  targetRevision?: string;
  confirmationUsername?: string;
}

export interface BackupImportResult {
  profile: Profile;
  snapshot: Snapshot;
  audit: BackupImportAudit;
}

/** A destructive operation preview for one local collection snapshot. */
export interface SnapshotDeletionPreview {
  profileId: string;
  profile: Profile;
  snapshot: Snapshot;
  legacy: boolean;
  sessionIds: string[];
  comparisonIds: string[];
  importBatchIds: string[];
  modelSessionIds: string[];
  itemCount: number;
  active: boolean;
  remainingSnapshotCount: number;
  survivingReferenceSessionIds: string[];
  targetRevision: string;
  warnings: string[];
}

export interface SnapshotDeletionRequest {
  snapshotId: string;
  targetRevision: string;
  confirmationUsername?: string;
}

export interface SnapshotDeletionResult {
  profile?: Profile;
  deletedSnapshotId: string;
  deletedSessionIds: string[];
  deletedComparisonIds: string[];
  deletedImportBatchIds: string[];
  deletedModelSessionIds: string[];
  activeSnapshot?: Snapshot;
  audit: BackupImportAudit;
}

/** Backwards-compatible names for the legacy-clone-only API. */
export type LegacyCloneDeletionPreview = SnapshotDeletionPreview;
export type LegacyCloneDeletionRequest = SnapshotDeletionRequest;
export type LegacyCloneDeletionResult = SnapshotDeletionResult;

export interface LocalProject {
  profile: Profile;
  snapshots: Snapshot[];
  legacySnapshotIds: string[];
  legacySessionIds: string[];
}

export interface AppErrorShape {
  code: string;
  message: string;
  retryable: boolean;
  details?: string;
}

export class AppError extends Error implements AppErrorShape {
  code: string;
  retryable: boolean;
  details?: string;

  constructor(code: string, message: string, retryable = false, details?: string) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.retryable = retryable;
    this.details = details;
  }
}

export const DISTRIBUTIONS: Record<Exclude<DistributionPreset, "custom">, number[]> = {
  uniform: [10, 10, 10, 10, 10, 10, 10, 10, 10, 10],
  preserve: [10, 10, 10, 10, 10, 10, 10, 10, 10, 10],
  "high-tail": [3, 5, 8, 14, 20, 20, 12, 8, 6, 4],
  "reverse-j": [50, 25, 14, 4, 2, 1, 1, 1, 1, 1],
};

export const APP_VERSION = "0.16.0";
