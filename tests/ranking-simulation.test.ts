import { describe, expect, it } from "vitest";
import { analyzeRanking, buildRankedItems, chooseNextPair, fitModel, forecastStoppingTime, summarizeRankingEvidence } from "../lib/ranking/engine";
import type { CollectionItem, DistributionConfig, RankingHistoryInput, RankingItemInput } from "../lib/types";

const reverseJ: DistributionConfig = { preset: "reverse-j", levelCount: 10, weights: [50, 25, 14, 4, 2, 1, 1, 1, 1, 1] };

function randomGenerator(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function pairKey(left: number, right: number) {
  return left < right ? `${left}:${right}` : `${right}:${left}`;
}

function oldLocalPair(items: RankingItemInput[], fit: ReturnType<typeof fitModel>, history: RankingHistoryInput[]) {
  const ordered = [...items].sort((left, right) =>
    fit.abilities[right.subjectId] - fit.abilities[left.subjectId] || right.rate - left.rate || left.subjectId - right.subjectId,
  );
  const counts = new Map<string, number>();
  for (const entry of history) counts.set(pairKey(entry.leftSubjectId, entry.rightSubjectId), (counts.get(pairKey(entry.leftSubjectId, entry.rightSubjectId)) ?? 0) + 1);
  let best: { left: number; right: number; score: number } | undefined;
  for (let distance = 1; distance <= 3; distance += 1) {
    for (let index = 0; index + distance < ordered.length; index += 1) {
      const left = ordered[index];
      const right = ordered[index + distance];
      if (Math.abs(left.rate - right.rate) > 2) continue;
      const difference = fit.abilities[left.subjectId] - fit.abilities[right.subjectId];
      const probability = 1 / (1 + Math.exp(-difference));
      const variance = fit.uncertainty[left.subjectId] ** 2 + fit.uncertainty[right.subjectId] ** 2;
      const key = pairKey(left.subjectId, right.subjectId);
      const score = probability * (1 - probability) * variance / (1 + (counts.get(key) ?? 0));
      if (!best || score > best.score || (score === best.score && key < pairKey(best.left, best.right))) {
        best = { left: left.subjectId, right: right.subjectId, score };
      }
    }
  }
  return best;
}

function comparisons(history: RankingHistoryInput[]) {
  return summarizeRankingEvidence(history, "session").comparisons;
}

function simulate(seed: number, strategy: "posterior" | "old-local") {
  const random = randomGenerator(seed);
  const itemCount = 60;
  const latent = Array.from({ length: itemCount }, () => Math.log(Math.max(random(), 1e-6)) * -1);
  const noisy = latent.map((value) => value + (random() - 0.5) * 1.8);
  const noisyOrder = noisy.map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value);
  const rateByIndex = new Array<number>(itemCount);
  noisyOrder.forEach((entry, rank) => { rateByIndex[entry.index] = 1 + Math.floor(rank / (itemCount / 10)); });
  const items = latent.map((_, index) => ({ subjectId: index + 1, rate: rateByIndex[index] }));
  const history: RankingHistoryInput[] = [];

  for (let question = 0; question < 60; question += 1) {
    const fit = fitModel(items, comparisons(history), undefined, {
      priorStrength: 0.35, priorScale: 0.45, posteriorSampleCount: 16, randomSeed: seed * 1000 + question,
    });
    let leftSubjectId: number;
    let rightSubjectId: number;
    let queryKind: RankingHistoryInput["queryKind"] = "adaptive";
    let calibrationOfComparisonId: string | undefined;
    if (strategy === "posterior") {
      const diagnostics = analyzeRanking(items, fit, reverseJ, history, "session");
      const pair = chooseNextPair(items, history, fit, diagnostics, reverseJ, "session", question, seed, { maxRateGap: 2, maxRankDistance: 3 })!;
      leftSubjectId = pair.leftSubjectId;
      rightSubjectId = pair.rightSubjectId;
      queryKind = pair.queryKind;
      calibrationOfComparisonId = pair.calibrationOfComparisonId;
    } else {
      const pair = oldLocalPair(items, fit, history)!;
      leftSubjectId = pair.left;
      rightSubjectId = pair.right;
    }
    const difference = latent[leftSubjectId - 1] - latent[rightSubjectId - 1];
    const probability = 1 / (1 + Math.exp(-2 * difference));
    const outcome = random() < probability ? "left" as const : "right" as const;
    history.push({
      recordId: `${strategy}-${question}`,
      sessionId: "session",
      leftSubjectId,
      rightSubjectId,
      outcome,
      acceptedCountAtAnswer: question + 1,
      queryKind,
      calibrationOfComparisonId,
      createdAt: new Date(question * 1000).toISOString(),
    });
  }

  const finalFit = fitModel(items, comparisons(history), undefined, {
    priorStrength: 0.35, priorScale: 0.45, posteriorSampleCount: 16, randomSeed: seed * 1000 + 999,
  });
  const collection = items.map<CollectionItem>((entry) => ({
    snapshotId: "simulation", subjectId: entry.subjectId, subjectType: 2, collectionType: 2,
    rate: entry.rate, name: String(entry.subjectId), nameCn: "", private: false, tags: [],
  }));
  const trueAbilities = Object.fromEntries(items.map((entry, index) => [entry.subjectId, latent[index]]));
  const truth = buildRankedItems(collection, { abilities: trueAbilities, uncertainty: {} }, [], reverseJ);
  const predicted = buildRankedItems(collection, finalFit, comparisons(history), reverseJ);
  const truthRate = new Map(truth.map((entry) => [entry.subjectId, entry.newRate]));
  return predicted.filter((entry) => truthRate.get(entry.subjectId)! !== entry.newRate).length;
}

describe("ranking strategy simulation", () => {
  it("does not increase full reverse-J bucket errors versus the previous local heuristic", () => {
    let posteriorErrors = 0;
    let oldLocalErrors = 0;
    for (let seed = 1; seed <= 8; seed += 1) {
      posteriorErrors += simulate(seed, "posterior");
      oldLocalErrors += simulate(seed, "old-local");
    }
    expect(posteriorErrors).toBeLessThanOrEqual(oldLocalErrors);
  });

  it("reports a held-out stopping time without overclaiming forecast certainty", () => {
    const distribution: DistributionConfig = { preset: "high-tail", levelCount: 10, weights: [3, 5, 8, 14, 20, 20, 12, 8, 6, 4] };
    const rated = Array.from({ length: 8 }, (_, index) => ({
      subjectId: index + 1,
      rate: 10 - Math.floor(index / 2),
      truth: 4 - index * 0.45,
    }));
    const entries: RankingHistoryInput[] = [];
    const checkpoint = 2;
    let checkpointForecast: ReturnType<typeof forecastStoppingTime> | undefined;
    let stoppedAt: number | undefined;
    for (let question = 0; question <= 300; question += 1) {
      const fit = fitModel(rated, comparisons(entries), undefined, {
        priorStrength: 0.8, priorScale: 0.65, posteriorSampleCount: 32, randomSeed: 1000 + question,
      });
      const diagnostics = analyzeRanking(rated, fit, distribution, entries, "session");
      if (question === checkpoint) {
        checkpointForecast = forecastStoppingTime(rated, fit, distribution, entries, "session", diagnostics, {
          projectionHorizon: 300, randomSeed: 3, forecastEfficiency: 16,
        });
      }
      if (diagnostics.ready) { stoppedAt = question; break; }
      const pair = chooseNextPair(rated, entries, fit, diagnostics, distribution, "session", question, 3, {
        maxRateGap: 1, maxRankDistance: 2,
      })!;
      const left = rated[pair.leftSubjectId - 1];
      const right = rated[pair.rightSubjectId - 1];
      entries.push({
        recordId: `forecast-${question}`, sessionId: "session",
        leftSubjectId: left.subjectId, rightSubjectId: right.subjectId,
        outcome: left.truth > right.truth ? "left" : "right",
        acceptedCountAtAnswer: question + 1, queryKind: pair.queryKind,
        calibrationOfComparisonId: pair.calibrationOfComparisonId,
        createdAt: new Date(question * 1000).toISOString(),
      });
    }
    expect(checkpointForecast).toBeDefined();
    expect(checkpointForecast?.rolloutCount).toBe(64);
    expect(checkpointForecast?.method).toBe("posterior-contraction-mc-v11");
    if (stoppedAt !== undefined) {
      const actualAdditional = stoppedAt - checkpoint;
      if (checkpointForecast?.lowerAdditional !== undefined && checkpointForecast.upperAdditional !== undefined) {
        expect(checkpointForecast.lowerAdditional).toBeLessThanOrEqual(actualAdditional);
        expect(checkpointForecast.upperAdditional).toBeGreaterThanOrEqual(actualAdditional);
      } else {
        expect(checkpointForecast?.status).toBe("uncertain");
        expect(checkpointForecast?.probabilityWithinProjectionHigh).toBeGreaterThan(0);
      }
    } else {
      expect(checkpointForecast?.status).toBe("uncertain");
      expect(checkpointForecast?.upperAdditional).toBeUndefined();
    }
  });
});
