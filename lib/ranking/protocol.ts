import { DistributionConfig, ModelState, NextPair, RankingHistoryInput, RankingItemInput } from "../types";

export type RankingOperation = "INIT_SESSION" | "APPLY_RESPONSE" | "UNDO" | "RECOMPUTE";

export interface RankingRequest {
  type: RankingOperation;
  requestId: string;
  sessionId: string;
  version: number;
  randomSeed: number;
  items: RankingItemInput[];
  history: RankingHistoryInput[];
  distribution: DistributionConfig;
  maxComparisons: number;
  previousModel?: ModelState;
  priorStrength?: number;
  priorScale?: number;
  maxRateGap?: number;
  maxRankDistance?: number;
  forecastEfficiency?: number;
}

export interface RankingSuccess {
  type: "MODEL_READY";
  requestId: string;
  model: ModelState;
  nextPair?: NextPair;
}

export interface RankingFailure {
  type: "ERROR";
  requestId: string;
  message: string;
}

export type RankingResponse = RankingSuccess | RankingFailure;
