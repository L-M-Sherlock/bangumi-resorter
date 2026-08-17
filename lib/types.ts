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
export type DistributionPreset = "uniform" | "preserve" | "high-tail" | "custom";
export type ComparisonBudgetMode = "quick" | "standard" | "thorough";

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
  suggestedComparisons: number;
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
  acceptedCountAtAnswer: number;
  active: boolean;
  createdAt: string;
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
}

export interface RankedItem extends CollectionItem {
  rank: number;
  ability: number;
  uncertainty: number;
  newRate: number;
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
};

export const APP_VERSION = "0.2.0";
