/// <reference lib="webworker" />

import { analyzeRanking, chooseNextPair, fitModel, forecastStoppingTime, toModelState } from "./engine";
import { RankingRequest, RankingResponse } from "./protocol";

function posteriorSampleCount(request: RankingRequest) {
  const diagnostics = request.previousModel?.diagnostics;
  const currentSessionAnswers = request.history.filter((entry) => entry.sessionId === request.sessionId && entry.outcome !== "skip").length;
  const risk = diagnostics?.decisionRiskRatio;
  const stability = diagnostics?.jointBucketStability;
  if ((risk !== undefined && risk <= 2) || (stability ?? 0) >= 0.75) return 256;
  if (currentSessionAnswers >= 20) return 128;
  return 64;
}

self.onmessage = (event: MessageEvent<RankingRequest>) => {
  const request = event.data;
  try {
    const comparisons = request.history
      .filter((entry) => entry.outcome !== "skip")
      .map((entry) => ({
        leftSubjectId: entry.leftSubjectId,
        rightSubjectId: entry.rightSubjectId,
        outcome: entry.outcome as "left" | "tie" | "right",
      }));
    const result = fitModel(request.items, comparisons, request.previousModel?.abilities, {
      priorStrength: request.priorStrength,
      priorScale: request.priorScale,
      posteriorSampleCount: posteriorSampleCount(request),
      randomSeed: (request.randomSeed ^ Math.imul(request.version + 1, 0x9e3779b1)) >>> 0,
    });
    const diagnostics = analyzeRanking(
      request.items,
      result,
      request.distribution,
      request.history,
      request.sessionId,
      request.maxComparisons,
    );
    diagnostics.forecast = forecastStoppingTime(
      request.items,
      result,
      request.distribution,
      request.history,
      request.sessionId,
      diagnostics,
      {
        fatigueLimit: request.maxComparisons,
        randomSeed: request.randomSeed,
        forecastEfficiency: request.forecastEfficiency,
      },
    );
    const model = toModelState(
      request.sessionId,
      request.version,
      result,
      request.previousModel?.initialMeanUncertainty,
      diagnostics,
    );
    const nextPair = chooseNextPair(
      request.items,
      request.history,
      result,
      diagnostics,
      request.distribution,
      request.sessionId,
      request.version,
      request.randomSeed,
      {
        maxRateGap: request.maxRateGap,
        maxRankDistance: request.maxRankDistance,
      },
    );
    const response: RankingResponse = { type: "MODEL_READY", requestId: request.requestId, model, nextPair };
    self.postMessage(response);
  } catch (error) {
    const response: RankingResponse = { type: "ERROR", requestId: request.requestId, message: error instanceof Error ? error.message : "排序模型计算失败。" };
    self.postMessage(response);
  }
};

export {};
