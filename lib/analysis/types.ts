import type {
  ComparisonBudgetMode,
  DistributionConfig,
  PriorMode,
  RankingHistoryInput,
  StoppingForecastStatus,
} from "../types";

export const ANALYSIS_ALGORITHM_VERSION = "session-analysis-v3-source-time-fixed-checkpoints-backtest-laplace6-forecast12";
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
  forecasts: Partial<Record<ComparisonBudgetMode, SessionAnalysisForecast>>;
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
