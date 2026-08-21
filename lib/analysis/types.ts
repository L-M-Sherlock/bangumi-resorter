import type {
  ComparisonBudgetMode,
  DistributionConfig,
  PriorMode,
  RankingHistoryInput,
  StoppingForecastStatus,
} from "../types";

export const ANALYSIS_ALGORITHM_VERSION = "session-analysis-v4-source-time-availability-backtest-laplace6-forecast14";
export const ANALYSIS_ROLLOUT_COUNT = 64;

export interface AnalysisHistoryEntry extends RankingHistoryInput {
  imported: boolean;
}

export interface SessionAnalysisStoppingCheck {
  mode: ComparisonBudgetMode;
  target?: number;
  probabilityTarget?: number;
  sampleCount: number;
  stableSamples: number;
  probability: number;
  low: number;
  high: number;
  ready: boolean;
}

export interface SessionAnalysisForecast {
  mode: ComparisonBudgetMode;
  status: StoppingForecastStatus;
  rolloutCount: number;
  lowerAdditional?: number;
  medianAdditional?: number;
  upperAdditional?: number;
  projectionHorizon: number;
  probabilityWithinProjection: number;
  withinProjectionSuccesses?: number;
  probabilityWithinProjectionLow?: number;
  probabilityWithinProjectionHigh?: number;
}

export interface SessionAnalysisPoint {
  checkpoint: number;
  prefixDigest: string;
  rawEvidence: number;
  agedEvidence: number;
  effectiveEvidence: number;
  uniquePairCount: number;
  coveredItemCount: number;
  sourceAgeLoss: number;
  repeatedPairLoss: number;
  calibrationRaw: number;
  calibrationEffective: number;
  manualRaw?: number;
  importedRaw: number;
  importedEffective: number;
  meanUncertainty: number;
  tieStrength: number;
  posteriorSampleCount: number;
  expectedCrossTwoBucketCount?: number;
  crossTwoBucketCountMedian?: number;
  crossTwoBucketCountLow?: number;
  crossTwoBucketCountHigh?: number;
  stoppingChecks: Partial<Record<ComparisonBudgetMode, SessionAnalysisStoppingCheck>>;
  /** Causal stopping history using when evidence became available to this session. */
  backtestStoppingChecks?: Partial<Record<ComparisonBudgetMode, SessionAnalysisStoppingCheck>>;
  forecasts: Partial<Record<ComparisonBudgetMode, SessionAnalysisForecast>>;
  /** Provenance counts on the availability-time prefix used by forecasts and backtests. */
  forecastImportedRaw?: number;
  forecastManualRaw?: number;
  /** Digest of the availability-time prefix; source-time prefixDigest remains the cache identity. */
  forecastPrefixDigest?: string;
  computedAt: string;
}

export interface SessionAnalysisSeries {
  id: string;
  sessionId: string;
  priorMode: PriorMode;
  distributionSignature: string;
  algorithmVersion: string;
  itemCount: number;
  inputDigest: string;
  milestones: SessionAnalysisPoint[];
  latest?: SessionAnalysisPoint;
  updatedAt: string;
}

export interface SessionAnalysisIdentity {
  id: string;
  sessionId: string;
  priorMode: PriorMode;
  distributionSignature: string;
  algorithmVersion: string;
  itemCount: number;
}

export interface SessionAnalysisInputIdentity {
  sessionId: string;
  randomSeed: number;
  priorMode: PriorMode;
  distribution: DistributionConfig;
  items: Array<{ subjectId: number; rate: number }>;
  history: AnalysisHistoryEntry[];
}
