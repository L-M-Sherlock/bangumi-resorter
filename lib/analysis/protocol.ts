import type { ComparisonBudgetMode, DistributionConfig, PriorMode } from "../types";
import type {
  AnalysisHistoryEntry,
  SessionAnalysisIdentity,
  SessionAnalysisPoint,
} from "./types";

export interface AnalysisWorkerRequest {
  type: "CALCULATE_HISTORY";
  taskId: string;
  identity: SessionAnalysisIdentity;
  inputDigest: string;
  randomSeed: number;
  items: Array<{ subjectId: number; rate: number }>;
  history: AnalysisHistoryEntry[];
  distribution: DistributionConfig;
  priorMode: PriorMode;
  /** Kept only for protocol diagnostics; all three modes are always calculated. */
  budgetMode: ComparisonBudgetMode;
  checkpoints: number[];
  forecastWorkerCount: 1 | 2;
}

export interface AnalysisWorkerProgress {
  type: "ANALYSIS_PROGRESS";
  taskId: string;
  seriesId: string;
  inputDigest: string;
  completed: number;
  total: number;
  point: SessionAnalysisPoint;
}

export interface AnalysisWorkerComplete {
  type: "ANALYSIS_COMPLETE";
  taskId: string;
  seriesId: string;
  inputDigest: string;
  completed: number;
  total: number;
}

export interface AnalysisWorkerError {
  type: "ANALYSIS_ERROR";
  taskId: string;
  seriesId: string;
  inputDigest: string;
  message: string;
}

export type AnalysisWorkerResponse = AnalysisWorkerProgress | AnalysisWorkerComplete | AnalysisWorkerError;
