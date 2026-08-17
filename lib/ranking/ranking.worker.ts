/// <reference lib="webworker" />

import { chooseNextPair, fitModel, toModelState } from "./engine";
import { RankingRequest, RankingResponse } from "./protocol";

self.onmessage = (event: MessageEvent<RankingRequest>) => {
  const request = event.data;
  try {
    const result = fitModel(request.items, request.comparisons, request.previousModel?.abilities, {
      priorStrength: request.priorStrength,
      priorScale: request.priorScale,
    });
    const model = toModelState(request.sessionId, request.version, result, request.previousModel?.initialMeanUncertainty);
    const nextPair = chooseNextPair(request.items, request.comparisons, request.skips, model, request.randomSeed, {
      maxRateGap: request.maxRateGap,
      maxRankDistance: request.maxRankDistance,
    });
    const response: RankingResponse = { type: "MODEL_READY", requestId: request.requestId, model, nextPair };
    self.postMessage(response);
  } catch (error) {
    const response: RankingResponse = { type: "ERROR", requestId: request.requestId, message: error instanceof Error ? error.message : "排序模型计算失败。" };
    self.postMessage(response);
  }
};

export {};
