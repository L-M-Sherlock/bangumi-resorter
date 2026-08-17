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
export type QueryKind = "adaptive" | "exploration" | "calibration";

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
  weights: number[];
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
  /** @deprecated Pre-0.6 preference; retained only so old backups remain readable. */
  stoppingTarget?: "top-tail" | "all-buckets";
  /** Legacy pre-dynamic-budget hint. Kept only so older backups remain readable. */
  suggestedComparisons?: number;
  /** Safety stop for fatigue; this is not a completion target. */
  maxComparisons?: number;
  createdAt: string;
  updatedAt: string;
}

export interface SessionItem {
  id: string;
  sessionId: string;
  subjectId: number;
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
  acceptedCountAtAnswer: number;
  active: boolean;
  createdAt: string;
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
  method: "posterior-contraction-mc-v1" | "posterior-contraction-mc-v2";
  status: StoppingForecastStatus;
  rolloutCount: number;
  /** Additional accepted answers at the 10th, 50th, and 90th stopping-time percentiles. */
  lowerAdditional?: number;
  medianAdditional?: number;
  upperAdditional?: number;
  nextCheckpoint: number;
  probabilityWithin20: number;
  probabilityBeforeLimit: number;
  /** Successful rollouts and central 90% Wilson Monte Carlo interval. */
  within20Successes?: number;
  probabilityWithin20Low?: number;
  probabilityWithin20High?: number;
  beforeLimitSuccesses?: number;
  probabilityBeforeLimitLow?: number;
  probabilityBeforeLimitHigh?: number;
  remainingCapacity: number;
}

export interface RankingDiagnostics {
  method: "laplace-mc-v1";
  sampleCount: number;
  bucketStability: Record<number, number>;
  /** Posterior probability that every item simultaneously remains in its current 1-10 bucket. */
  jointBucketStability: number;
  jointBucketStableSamples: number;
  /** Central 90% Monte Carlo interval for jointBucketStability. */
  jointBucketStabilityLow: number;
  jointBucketStabilityHigh: number;
  expectedBucketChangeRate: number;
  minBucketStability: number;
  /** Conservative constraint ratio based on the lower Monte Carlo bound; at or below 1 is acceptable. */
  decisionRiskRatio: number;
  evidenceCount: number;
  evidenceRequired: number;
  fatigueLimit?: number;
  fatigueReached?: boolean;
  ready: boolean;
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
  models: ModelState[];
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

export const APP_VERSION = "0.6.0";
