import { distributionConfig } from "../lib/distribution";
import type { RankingRequest } from "../lib/ranking/protocol";
import { rankingTuning } from "../lib/ranking/strategy";
import type { RankingHistoryInput, RankingItemInput } from "../lib/types";

export const COMPARISON_BENCHMARK_ITEM_COUNT = 284;
export const COMPARISON_BENCHMARK_EXISTING_HISTORY_COUNT = 1_212;
export const COMPARISON_BENCHMARK_LOCAL_HISTORY_COUNT = 721;
export const COMPARISON_BENCHMARK_IMPORTED_HISTORY_COUNT = 491;
export const COMPARISON_BENCHMARK_CALIBRATION_COUNT = 59;

const SESSION_ID = "comparison-benchmark-session";
const BASE_TIME = Date.UTC(2026, 6, 1, 0, 0, 0);
const DAY_MS = 24 * 60 * 60 * 1_000;

function seededRandom(seed: number) {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ value >>> 15, value | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 0x1_0000_0000;
  };
}

function reverseOutcome(outcome: Exclude<RankingHistoryInput["outcome"], "skip">) {
  if (outcome === "left") return "right" as const;
  if (outcome === "right") return "left" as const;
  return "tie" as const;
}

function benchmarkItems() {
  const items: RankingItemInput[] = Array.from(
    { length: COMPARISON_BENCHMARK_ITEM_COUNT },
    (_, index) => ({
      subjectId: index + 1,
      rate: 1 + ((index * 7 + 3) % 10),
    }),
  );
  const latent = new Map(items.map((item, index) => [
    item.subjectId,
    (item.rate - 5.5) * 0.38
      + Math.sin((index + 1) * 0.73) * 0.55
      + Math.cos((index + 1) * 0.19) * 0.25,
  ]));
  const orderedIds = [...items]
    .sort((left, right) => latent.get(right.subjectId)! - latent.get(left.subjectId)!
      || left.subjectId - right.subjectId)
    .map((item) => item.subjectId);
  return { items, latent, orderedIds };
}

function outcomeForPair(
  leftSubjectId: number,
  rightSubjectId: number,
  latent: Map<number, number>,
  random: () => number,
): Exclude<RankingHistoryInput["outcome"], "skip"> {
  const left = Math.exp(latent.get(leftSubjectId) ?? 0);
  const right = Math.exp(latent.get(rightSubjectId) ?? 0);
  const tie = 0.42 * Math.sqrt(left * right);
  const total = left + right + tie;
  const draw = random() * total;
  if (draw < left) return "left";
  if (draw < left + tie) return "tie";
  return "right";
}

function pairAt(orderedIds: number[], ordinal: number, phase: number) {
  const length = orderedIds.length;
  const leftRank = ordinal % length;
  const distanceBase = phase === 0 ? 1 : phase === 1 ? 8 : 20;
  const distance = distanceBase + Math.floor(ordinal / length);
  return {
    leftSubjectId: orderedIds[leftRank],
    rightSubjectId: orderedIds[(leftRank + distance) % length],
  };
}

function isoAt(index: number) {
  return new Date(BASE_TIME + index * 60_000).toISOString();
}

function existingHistory(
  latent: Map<number, number>,
  orderedIds: number[],
  random: () => number,
) {
  const history: RankingHistoryInput[] = [];
  const ordinary: RankingHistoryInput[] = [];
  const calibrationTargetIds = new Set<string>();
  const calibrationPositions = new Set(Array.from(
    { length: COMPARISON_BENCHMARK_CALIBRATION_COUNT },
    (_, index) => 20 + Math.floor(index * 700 / COMPARISON_BENCHMARK_CALIBRATION_COUNT),
  ));
  let ordinaryIndex = 0;
  let calibrationIndex = 0;

  for (let index = 0; index < COMPARISON_BENCHMARK_LOCAL_HISTORY_COUNT; index += 1) {
    if (calibrationPositions.has(index)) {
      let targetIndex = (calibrationIndex * 11) % ordinary.length;
      while (calibrationTargetIds.has(ordinary[targetIndex].recordId)) {
        targetIndex = (targetIndex + 1) % ordinary.length;
      }
      const target = ordinary[targetIndex];
      calibrationTargetIds.add(target.recordId);
      const consistent = random() < 0.74;
      const record: RankingHistoryInput = {
        recordId: `local-calibration-${calibrationIndex}`,
        sessionId: SESSION_ID,
        leftSubjectId: target.rightSubjectId,
        rightSubjectId: target.leftSubjectId,
        outcome: consistent
          ? reverseOutcome(target.outcome as Exclude<RankingHistoryInput["outcome"], "skip">)
          : target.outcome,
        acceptedCountAtAnswer: index + 1,
        queryKind: "calibration",
        calibrationOfComparisonId: target.recordId,
        createdAt: isoAt(index),
      };
      history.push(record);
      calibrationIndex += 1;
      continue;
    }

    const pair = pairAt(orderedIds, ordinaryIndex, 0);
    const record: RankingHistoryInput = {
      recordId: `local-${ordinaryIndex}`,
      sessionId: SESSION_ID,
      ...pair,
      outcome: outcomeForPair(pair.leftSubjectId, pair.rightSubjectId, latent, random),
      acceptedCountAtAnswer: index + 1,
      queryKind: index % 5 === 4 ? "exploration" : "adaptive",
      createdAt: isoAt(index),
    };
    history.push(record);
    ordinary.push(record);
    ordinaryIndex += 1;
  }

  const duplicateImportCount = 80;
  const duplicateCandidates = ordinary.filter((entry) => !calibrationTargetIds.has(entry.recordId));
  for (let index = 0; index < COMPARISON_BENCHMARK_IMPORTED_HISTORY_COUNT; index += 1) {
    const duplicate = index < duplicateImportCount
      ? duplicateCandidates[(index * 7) % duplicateCandidates.length]
      : undefined;
    const pair = duplicate ?? pairAt(orderedIds, index - duplicateImportCount, 1);
    const createdAt = BASE_TIME + (COMPARISON_BENCHMARK_LOCAL_HISTORY_COUNT + index) * 60_000;
    const ageDays = 18 + ((index * 37) % 91);
    history.push({
      recordId: `imported-${index}`,
      sessionId: SESSION_ID,
      leftSubjectId: pair.leftSubjectId,
      rightSubjectId: pair.rightSubjectId,
      outcome: outcomeForPair(pair.leftSubjectId, pair.rightSubjectId, latent, random),
      acceptedCountAtAnswer: COMPARISON_BENCHMARK_LOCAL_HISTORY_COUNT + index + 1,
      queryKind: "adaptive",
      inheritedFromComparisonId: `source-root-${index}`,
      importBatchId: "comparison-benchmark-import",
      importedFromSessionId: "comparison-benchmark-source",
      importedFromComparisonId: `source-${index}`,
      sourceCreatedAt: new Date(createdAt - ageDays * DAY_MS).toISOString(),
      createdAt: new Date(createdAt).toISOString(),
    });
  }
  return history;
}

export interface ComparisonBenchmarkScenario {
  request: RankingRequest;
  existingHistory: RankingHistoryInput[];
  addedAnswer: RankingHistoryInput;
}

/**
 * A deterministic, privacy-free workload shaped like the session in the
 * reference screenshot. The request contains the 1,212 existing judgments
 * plus the one answer whose latency is being measured.
 */
export function createComparisonBenchmarkScenario(): ComparisonBenchmarkScenario {
  const random = seededRandom(0x20260821);
  const { items, latent, orderedIds } = benchmarkItems();
  const history = existingHistory(latent, orderedIds, random);
  const pair = pairAt(orderedIds, 0, 2);
  const addedAnswer: RankingHistoryInput = {
    recordId: "newly-added-answer",
    sessionId: SESSION_ID,
    ...pair,
    outcome: outcomeForPair(pair.leftSubjectId, pair.rightSubjectId, latent, random),
    acceptedCountAtAnswer: history.length + 1,
    queryKind: "adaptive",
    createdAt: isoAt(history.length),
  };
  const request: RankingRequest = {
    type: "APPLY_RESPONSE",
    requestId: "comparison-benchmark",
    sessionId: SESSION_ID,
    version: history.length + 1,
    randomSeed: 0x20260821,
    items,
    history: [...history, addedAnswer],
    distribution: distributionConfig("high-tail", 10),
    budgetMode: "thorough",
    priorMode: "strong",
    ...rankingTuning("strong"),
  };
  return { request, existingHistory: history, addedAnswer };
}
