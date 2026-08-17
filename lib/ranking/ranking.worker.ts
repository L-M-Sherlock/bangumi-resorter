/// <reference lib="webworker" />

import { computeRanking } from "./compute";
import { RankingRequest, RankingResponse } from "./protocol";

self.onmessage = (event: MessageEvent<RankingRequest>) => {
  const request = event.data;
  try {
    const response: RankingResponse = computeRanking(request);
    self.postMessage(response);
  } catch (error) {
    const response: RankingResponse = { type: "ERROR", requestId: request.requestId, message: error instanceof Error ? error.message : "排序模型计算失败。" };
    self.postMessage(response);
  }
};

export {};
