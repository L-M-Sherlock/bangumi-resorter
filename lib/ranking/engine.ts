import {
  CalibrationDiagnostics,
  CollectionItem,
  DistributionConfig,
  ModelState,
  NextPair,
  RankedItem,
  RankingComparisonInput,
  RankingDiagnostics,
  RankingHistoryInput,
  RankingItemInput,
  StoppingForecast,
} from "../types";
import { effectiveDistributionWeights, normalizeScoreLevelCount } from "../distribution";
import {
  allowedCrossTwoBucketCount,
  forecastProjectionHorizon,
  minimumEvidence,
  requiredAdjacentStableItemCount,
  STOPPING_PROBABILITY_TARGET,
} from "./strategy";

const DEFAULT_PRIOR_STRENGTH = 0.25;
const DEFAULT_PRIOR_SCALE = 0.35;
const DEFAULT_POSTERIOR_SAMPLES = 64;
const MAX_OUTER = 50;
const GRADIENT_TOLERANCE = 1e-6;
const PCG_TOLERANCE = 1e-4;
const POSTERIOR_PCG_TOLERANCE = 1e-3;
const BUCKET_STABILITY_TARGET = STOPPING_PROBABILITY_TARGET;
const STOPPING_EVENT_ERROR_TOLERANCE = 1 - STOPPING_PROBABILITY_TARGET;

interface IndexedComparison {
  left: number;
  right: number;
  y: number;
}

export interface FitResult {
  abilities: Record<number, number>;
  uncertainty: Record<number, number>;
  meanUncertainty: number;
  converged: boolean;
  iterations: number;
  acceptedComparisons: number;
  posteriorSamples: Float64Array[];
}

export interface FitOptions {
  priorStrength?: number;
  priorScale?: number;
  posteriorSampleCount?: number;
  randomSeed?: number;
}

export interface PairSelectionOptions {
  maxRateGap?: number;
  maxRankDistance?: number;
  boundaryWindow?: number;
  explorationInterval?: number;
  explorationRadius?: number;
  /** Forecasts simulate ordinary adaptive questions, not calibration repeats. */
  allowCalibration?: boolean;
  /** Internal cache used by long-running forecast paths. */
  selectionCache?: PairSelectionCache;
  /** Limit expensive posterior-information evaluations in a forecast path. */
  candidateLimit?: number;
  posteriorSampleStride?: number;
}

interface PairSelectionCache {
  pairCounts: Map<string, number>;
  itemCounts: Map<number, number>;
  cooled: Set<string>;
  nonCalibrationCount: number;
}

export interface StoppingForecastOptions {
  randomSeed: number;
  /**
   * Kept for backwards-compatible serialized requests.  The sequential
   * forecaster no longer turns this scalar into a synthetic amount of
   * evidence; future answers are simulated one at a time instead.
   */
  forecastEfficiency?: number;
  rolloutCount?: number;
  /** Finite Monte Carlo look-ahead only; never an answering limit. */
  projectionHorizon?: number;
  /** The same question-selection policy used by the selected inference mode. */
  pairSelection?: PairSelectionOptions;
  /** Legacy request field; forecast orientation is intentionally version-independent. */
  modelVersion?: number;
  /** Recompute the expensive ranking diagnostics every N simulated answers. */
  diagnosticStride?: number;
}

function sigmoid(value: number) {
  if (value >= 0) {
    const z = Math.exp(-value);
    return 1 / (1 + z);
  }
  const z = Math.exp(value);
  return z / (1 + z);
}

function logSigmoid(value: number) {
  return value >= 0 ? -Math.log1p(Math.exp(-value)) : value - Math.log1p(Math.exp(value));
}

function binaryEntropy(probability: number) {
  const p = Math.min(1 - 1e-12, Math.max(1e-12, probability));
  return -p * Math.log(p) - (1 - p) * Math.log(1 - p);
}

function dot(a: Float64Array, b: Float64Array) {
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) sum += a[i] * b[i];
  return sum;
}

function evaluate(theta: Float64Array, prior: Float64Array, comparisons: IndexedComparison[], priorStrength: number) {
  const gradient = new Float64Array(theta.length);
  const diagonal = new Float64Array(theta.length);
  diagonal.fill(priorStrength);
  let objective = 0;

  for (let i = 0; i < theta.length; i += 1) {
    const diff = theta[i] - prior[i];
    objective -= 0.5 * priorStrength * diff * diff;
    gradient[i] -= priorStrength * diff;
  }

  const weights = new Float64Array(comparisons.length);
  for (let k = 0; k < comparisons.length; k += 1) {
    const comparison = comparisons[k];
    const difference = theta[comparison.left] - theta[comparison.right];
    const probability = sigmoid(difference);
    objective += comparison.y * logSigmoid(difference) + (1 - comparison.y) * logSigmoid(-difference);
    const residual = comparison.y - probability;
    gradient[comparison.left] += residual;
    gradient[comparison.right] -= residual;
    const weight = Math.max(1e-12, probability * (1 - probability));
    weights[k] = weight;
    diagonal[comparison.left] += weight;
    diagonal[comparison.right] += weight;
  }
  return { objective, gradient, diagonal, weights };
}

function hessianProduct(
  vector: Float64Array,
  comparisons: IndexedComparison[],
  weights: Float64Array,
  priorStrength: number,
) {
  const output = new Float64Array(vector.length);
  for (let i = 0; i < vector.length; i += 1) output[i] = priorStrength * vector[i];
  for (let k = 0; k < comparisons.length; k += 1) {
    const { left, right } = comparisons[k];
    const weightedDifference = weights[k] * (vector[left] - vector[right]);
    output[left] += weightedDifference;
    output[right] -= weightedDifference;
  }
  return output;
}

function solvePcg(
  rightHandSide: Float64Array,
  diagonal: Float64Array,
  comparisons: IndexedComparison[],
  weights: Float64Array,
  priorStrength: number,
  tolerance = PCG_TOLERANCE,
  iterationLimit = 200,
) {
  const size = rightHandSide.length;
  const solution = new Float64Array(size);
  const residual = rightHandSide.slice();
  const z = new Float64Array(size);
  const direction = new Float64Array(size);
  for (let i = 0; i < size; i += 1) z[i] = direction[i] = residual[i] / diagonal[i];
  let residualDotZ = dot(residual, z);
  const initialNorm = Math.sqrt(dot(rightHandSide, rightHandSide));
  if (initialNorm === 0) return solution;
  const maxIterations = Math.max(1, Math.min(iterationLimit, size));

  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    const product = hessianProduct(direction, comparisons, weights, priorStrength);
    const denominator = dot(direction, product);
    if (!Number.isFinite(denominator) || denominator <= 0) break;
    const alpha = residualDotZ / denominator;
    for (let i = 0; i < size; i += 1) {
      solution[i] += alpha * direction[i];
      residual[i] -= alpha * product[i];
    }
    if (Math.sqrt(dot(residual, residual)) <= tolerance * initialNorm) break;
    for (let i = 0; i < size; i += 1) z[i] = residual[i] / diagonal[i];
    const nextResidualDotZ = dot(residual, z);
    const beta = nextResidualDotZ / Math.max(residualDotZ, 1e-30);
    for (let i = 0; i < size; i += 1) direction[i] = z[i] + beta * direction[i];
    residualDotZ = nextResidualDotZ;
  }
  return solution;
}

function hash(value: string) {
  let result = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    result ^= value.charCodeAt(i);
    result = Math.imul(result, 16777619);
  }
  return result >>> 0;
}

function seededRandom(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function normalGenerator(random: () => number) {
  let spare: number | undefined;
  return () => {
    if (spare !== undefined) {
      const value = spare;
      spare = undefined;
      return value;
    }
    const radius = Math.sqrt(-2 * Math.log(Math.max(random(), 1e-12)));
    const angle = 2 * Math.PI * random();
    spare = radius * Math.sin(angle);
    return radius * Math.cos(angle);
  };
}

function sampleLaplacePosterior(
  theta: Float64Array,
  comparisons: IndexedComparison[],
  weights: Float64Array,
  diagonal: Float64Array,
  priorStrength: number,
  sampleCount: number,
  seed: number,
) {
  const samples: Float64Array[] = [];
  const random = seededRandom(seed);
  const normal = normalGenerator(random);
  const priorNoiseScale = Math.sqrt(priorStrength);
  for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
    const noise = new Float64Array(theta.length);
    for (let i = 0; i < noise.length; i += 1) noise[i] = priorNoiseScale * normal();
    for (let k = 0; k < comparisons.length; k += 1) {
      const edgeNoise = Math.sqrt(weights[k]) * normal();
      noise[comparisons[k].left] += edgeNoise;
      noise[comparisons[k].right] -= edgeNoise;
    }
    const delta = solvePcg(
      noise,
      diagonal,
      comparisons,
      weights,
      priorStrength,
      POSTERIOR_PCG_TOLERANCE,
      100,
    );
    const sample = new Float64Array(theta.length);
    for (let i = 0; i < theta.length; i += 1) sample[i] = theta[i] + delta[i];
    samples.push(sample);
  }
  return samples;
}

export function fitModel(
  items: RankingItemInput[],
  comparisonsInput: RankingComparisonInput[],
  previousAbilities?: Record<number, number>,
  options: FitOptions = {},
): FitResult {
  if (items.length === 0) {
    return {
      abilities: {}, uncertainty: {}, meanUncertainty: 0, converged: true,
      iterations: 0, acceptedComparisons: 0, posteriorSamples: [],
    };
  }
  const indexById = new Map(items.map((item, index) => [item.subjectId, index]));
  const comparisons: IndexedComparison[] = [];
  for (const comparison of comparisonsInput) {
    const left = indexById.get(comparison.leftSubjectId);
    const right = indexById.get(comparison.rightSubjectId);
    if (left === undefined || right === undefined || left === right) continue;
    comparisons.push({ left, right, y: comparison.outcome === "left" ? 1 : comparison.outcome === "right" ? 0 : 0.5 });
  }

  const priorStrength = Math.max(1e-6, options.priorStrength ?? DEFAULT_PRIOR_STRENGTH);
  const priorScale = Math.max(0, options.priorScale ?? DEFAULT_PRIOR_SCALE);
  const prior = new Float64Array(items.map((item) => priorScale * (item.rate - 5.5)));
  let theta = new Float64Array(items.map((item, index) => {
    const previous = previousAbilities?.[item.subjectId];
    return previous !== undefined && Number.isFinite(previous) ? previous : prior[index];
  }));
  let converged = false;
  let iterations = 0;

  for (iterations = 0; iterations < MAX_OUTER; iterations += 1) {
    const current = evaluate(theta, prior, comparisons, priorStrength);
    let gradientInfinityNorm = 0;
    for (const value of current.gradient) gradientInfinityNorm = Math.max(gradientInfinityNorm, Math.abs(value));
    if (gradientInfinityNorm < GRADIENT_TOLERANCE) {
      converged = true;
      break;
    }
    let step = solvePcg(current.gradient, current.diagonal, comparisons, current.weights, priorStrength);
    let directionalDerivative = dot(current.gradient, step);
    if (!Number.isFinite(directionalDerivative) || directionalDerivative <= 0) {
      step = new Float64Array(step.length);
      for (let i = 0; i < step.length; i += 1) step[i] = current.gradient[i] / current.diagonal[i];
      directionalDerivative = dot(current.gradient, step);
    }
    let scale = 1;
    let accepted = false;
    for (let lineIteration = 0; lineIteration < 20; lineIteration += 1) {
      const candidate = new Float64Array(theta.length);
      for (let i = 0; i < theta.length; i += 1) candidate[i] = theta[i] + scale * step[i];
      const candidateObjective = evaluate(candidate, prior, comparisons, priorStrength).objective;
      if (Number.isFinite(candidateObjective) && candidateObjective >= current.objective + 1e-4 * scale * directionalDerivative) {
        theta = candidate;
        accepted = true;
        break;
      }
      scale *= 0.5;
    }
    if (!accepted) break;
  }

  const finalEvaluation = evaluate(theta, prior, comparisons, priorStrength);
  const sampleCount = Math.max(8, Math.round(options.posteriorSampleCount ?? DEFAULT_POSTERIOR_SAMPLES));
  const posteriorSamples = sampleLaplacePosterior(
    theta,
    comparisons,
    finalEvaluation.weights,
    finalEvaluation.diagonal,
    priorStrength,
    sampleCount,
    options.randomSeed ?? 0x5eed1234,
  );
  const abilities: Record<number, number> = {};
  const uncertainty: Record<number, number> = {};
  let meanUncertainty = 0;
  items.forEach((item, index) => {
    if (!Number.isFinite(theta[index])) throw new Error("模型计算产生了无效数值。");
    abilities[item.subjectId] = theta[index];
    let sampleMean = 0;
    for (const sample of posteriorSamples) sampleMean += sample[index];
    sampleMean /= posteriorSamples.length;
    let sampleVariance = 0;
    for (const sample of posteriorSamples) sampleVariance += (sample[index] - sampleMean) ** 2;
    sampleVariance /= Math.max(1, posteriorSamples.length - 1);
    uncertainty[item.subjectId] = Math.sqrt(Math.max(0, sampleVariance));
    meanUncertainty += uncertainty[item.subjectId];
  });
  meanUncertainty /= items.length;
  return { abilities, uncertainty, meanUncertainty, converged, iterations, acceptedComparisons: comparisons.length, posteriorSamples };
}

function pairKey(a: number, b: number) { return a < b ? `${a}:${b}` : `${b}:${a}`; }

function normalizedWinner(entry: Pick<RankingHistoryInput, "leftSubjectId" | "rightSubjectId" | "outcome">) {
  if (entry.outcome === "tie") return "tie";
  if (entry.outcome === "left") return String(entry.leftSubjectId);
  if (entry.outcome === "right") return String(entry.rightSubjectId);
  return undefined;
}

function logCombination(n: number, k: number) {
  const smaller = Math.min(k, n - k);
  let value = 0;
  for (let index = 1; index <= smaller; index += 1) {
    value += Math.log(n - smaller + index) - Math.log(index);
  }
  return value;
}

/** Regularized incomplete beta for positive integer parameters. */
function betaCdf(value: number, alpha: number, beta: number) {
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  const n = alpha + beta - 1;
  const terms: number[] = [];
  let maxLog = Number.NEGATIVE_INFINITY;
  for (let successes = alpha; successes <= n; successes += 1) {
    const logTerm = logCombination(n, successes)
      + successes * Math.log(value)
      + (n - successes) * Math.log1p(-value);
    terms.push(logTerm);
    maxLog = Math.max(maxLog, logTerm);
  }
  let scaled = 0;
  for (const term of terms) scaled += Math.exp(term - maxLog);
  return Math.min(1, Math.max(0, Math.exp(maxLog) * scaled));
}

function betaQuantile(probability: number, alpha: number, beta: number) {
  let lower = 0;
  let upper = 1;
  for (let iteration = 0; iteration < 52; iteration += 1) {
    const middle = (lower + upper) / 2;
    if (betaCdf(middle, alpha, beta) < probability) lower = middle;
    else upper = middle;
  }
  return (lower + upper) / 2;
}

export function calibrationPosterior(completed: number, consistent: number) {
  const safeCompleted = Math.max(0, Math.round(completed));
  const safeConsistent = Math.min(safeCompleted, Math.max(0, Math.round(consistent)));
  const alpha = safeConsistent + 1;
  const beta = safeCompleted - safeConsistent + 1;
  const probabilityAboveChance = 1 - betaCdf(0.5, alpha, beta);
  return {
    posteriorMean: alpha / (alpha + beta),
    credibleLow: betaQuantile(0.1, alpha, beta),
    credibleHigh: betaQuantile(0.9, alpha, beta),
    probabilityAboveChance,
    acceptable: safeCompleted < 3 || probabilityAboveChance >= 0.8,
  };
}

function calibrationDiagnostics(history: RankingHistoryInput[]): CalibrationDiagnostics {
  const byId = new Map(history.map((entry) => [entry.recordId, entry]));
  const calibration = history.filter((entry) => entry.queryKind === "calibration");
  let completed = 0;
  let consistent = 0;
  for (const entry of calibration) {
    if (entry.outcome === "skip" || !entry.calibrationOfComparisonId) continue;
    const original = byId.get(entry.calibrationOfComparisonId);
    if (!original || original.outcome === "skip") continue;
    completed += 1;
    if (normalizedWinner(entry) === normalizedWinner(original)) consistent += 1;
  }
  return {
    attempted: calibration.length,
    completed,
    consistent,
    consistencyRate: completed > 0 ? consistent / completed : undefined,
    ...calibrationPosterior(completed, consistent),
  };
}

interface RateItem { subjectId: number; rate: number }

function mappedRates<T extends RateItem>(ordered: T[], config: DistributionConfig) {
  const output = new Map<number, number>();
  const levelCount = normalizeScoreLevelCount(config.levelCount);
  const weights = effectiveDistributionWeights(ordered, config);
  const total = weights.reduce((sum, value) => sum + value, 0);
  const topDown = [...weights].reverse().map((value) => value / total);
  ordered.forEach((item, rankIndex) => {
    const quantile = (rankIndex + 0.5) / ordered.length;
    let cumulative = 0;
    let score = 1;
    for (let index = 0; index < topDown.length; index += 1) {
      cumulative += topDown[index];
      if (quantile <= cumulative + 1e-12) { score = levelCount - index; break; }
    }
    output.set(item.subjectId, score);
  });
  return output;
}

function orderByAbilities<T extends RateItem>(items: T[], abilities: Record<number, number>) {
  return [...items].sort((a, b) =>
    (abilities[b.subjectId] ?? 0) - (abilities[a.subjectId] ?? 0) || b.rate - a.rate || a.subjectId - b.subjectId,
  );
}

function orderBySample(items: RankingItemInput[], sample: Float64Array) {
  const indices = items.map((_, index) => index);
  indices.sort((a, b) =>
    sample[b] - sample[a] || items[b].rate - items[a].rate || items[a].subjectId - items[b].subjectId,
  );
  return indices.map((index) => items[index]);
}

interface AssignmentMetrics {
  bucketStability: Record<number, number>;
  adjacentBucketStabilityByItem: Record<number, number>;
  jointBucketStability: number;
  jointBucketStableSamples: number;
  adjacentBucketStability: number;
  adjacentBucketStableSamples: number;
  coverageTargetStability: number;
  coverageTargetStableSamples: number;
  requiredAdjacentStableItemCount: number;
  allowedCrossTwoBucketCount: number;
  expectedCrossTwoBucketCount: number;
  crossTwoBucketCountMedian: number;
  crossTwoBucketCountLow: number;
  crossTwoBucketCountHigh: number;
  maxBucketDisplacementMedian: number;
  maxBucketDisplacementHigh: number;
  expectedBucketChangeRate: number;
  minBucketStability: number;
}

function assignmentMetrics(
  items: RankingItemInput[],
  referenceRates: Map<number, number>,
  posteriorSamples: Float64Array[],
  distribution: DistributionConfig,
): AssignmentMetrics {
  const posteriorRates = posteriorSamples.map((sample) => mappedRates(orderBySample(items, sample), distribution));
  return assignmentMetricsFromRates(items, referenceRates, posteriorRates);
}

function assignmentMetricsFromRates(
  items: RankingItemInput[],
  referenceRates: Map<number, number>,
  posteriorRates: Map<number, number>[],
): AssignmentMetrics {
  const stableWeights = new Map(items.map((item) => [item.subjectId, 0]));
  const adjacentStableWeights = new Map(items.map((item) => [item.subjectId, 0]));
  let changedAssignments = 0;
  let jointStableWeight = 0;
  let adjacentStableWeight = 0;
  let coverageTargetStableWeight = 0;
  let totalWeight = 0;
  const requiredAdjacentCount = requiredAdjacentStableItemCount(items.length);
  const allowedCrossCount = allowedCrossTwoBucketCount(items.length);
  const crossTwoBucketCounts: number[] = [];
  const maxBucketDisplacements: number[] = [];
  for (let sampleIndex = 0; sampleIndex < posteriorRates.length; sampleIndex += 1) {
    const weight = 1;
    totalWeight += weight;
    const sampleRates = posteriorRates[sampleIndex];
    let jointStable = true;
    let adjacentStable = true;
    let crossTwoBucketCount = 0;
    let maxBucketDisplacement = 0;
    for (const item of items) {
      const referenceRate = referenceRates.get(item.subjectId) ?? item.rate;
      const sampleRate = sampleRates.get(item.subjectId) ?? item.rate;
      const displacement = Math.abs(referenceRate - sampleRate);
      maxBucketDisplacement = Math.max(maxBucketDisplacement, displacement);
      if (referenceRate === sampleRate) {
        stableWeights.set(item.subjectId, (stableWeights.get(item.subjectId) ?? 0) + weight);
      } else {
        changedAssignments += weight;
        jointStable = false;
      }
      if (displacement <= 1) {
        adjacentStableWeights.set(item.subjectId, (adjacentStableWeights.get(item.subjectId) ?? 0) + weight);
      } else {
        crossTwoBucketCount += 1;
        adjacentStable = false;
      }
    }
    crossTwoBucketCounts.push(crossTwoBucketCount);
    maxBucketDisplacements.push(maxBucketDisplacement);
    if (jointStable) jointStableWeight += weight;
    if (adjacentStable) adjacentStableWeight += weight;
    if (crossTwoBucketCount <= allowedCrossCount) coverageTargetStableWeight += weight;
  }
  const denominator = Math.max(totalWeight, Number.EPSILON);
  const bucketStability: Record<number, number> = {};
  const adjacentBucketStabilityByItem: Record<number, number> = {};
  let minBucketStability = 1;
  for (const item of items) {
    const stability = (stableWeights.get(item.subjectId) ?? 0) / denominator;
    bucketStability[item.subjectId] = stability;
    adjacentBucketStabilityByItem[item.subjectId] = (adjacentStableWeights.get(item.subjectId) ?? 0) / denominator;
    minBucketStability = Math.min(minBucketStability, stability);
  }
  return {
    bucketStability,
    adjacentBucketStabilityByItem,
    jointBucketStability: jointStableWeight / denominator,
    jointBucketStableSamples: jointStableWeight,
    adjacentBucketStability: adjacentStableWeight / denominator,
    adjacentBucketStableSamples: adjacentStableWeight,
    coverageTargetStability: coverageTargetStableWeight / denominator,
    coverageTargetStableSamples: coverageTargetStableWeight,
    requiredAdjacentStableItemCount: requiredAdjacentCount,
    allowedCrossTwoBucketCount: allowedCrossCount,
    expectedCrossTwoBucketCount: crossTwoBucketCounts.reduce((sum, value) => sum + value, 0) / denominator,
    crossTwoBucketCountMedian: forecastQuantile(crossTwoBucketCounts, 0.5) ?? 0,
    crossTwoBucketCountLow: forecastQuantile(crossTwoBucketCounts, 0.1) ?? 0,
    crossTwoBucketCountHigh: forecastQuantile(crossTwoBucketCounts, 0.9) ?? 0,
    maxBucketDisplacementMedian: forecastQuantile(maxBucketDisplacements, 0.5) ?? 0,
    maxBucketDisplacementHigh: forecastQuantile(maxBucketDisplacements, 0.9) ?? 0,
    expectedBucketChangeRate: changedAssignments / (denominator * Math.max(1, items.length)),
    minBucketStability,
  };
}

function decisionRiskRatio(stoppingEventStability: number) {
  return (1 - stoppingEventStability) / STOPPING_EVENT_ERROR_TOLERANCE;
}

export function analyzeRanking(
  items: RankingItemInput[],
  fit: FitResult,
  distribution: DistributionConfig,
  history: RankingHistoryInput[],
  sessionId: string,
): RankingDiagnostics {
  if (items.length === 0 || fit.posteriorSamples.length === 0) {
    const calibration = calibrationDiagnostics(history);
    return {
      method: "laplace-mc-v4", sampleCount: 0, bucketStability: {}, adjacentBucketStabilityByItem: {},
      jointBucketStability: 1, jointBucketStableSamples: 0,
      jointBucketStabilityLow: 1, jointBucketStabilityHigh: 1,
      adjacentBucketStability: 1, adjacentBucketStableSamples: 0,
      adjacentBucketStabilityLow: 1, adjacentBucketStabilityHigh: 1,
      coverageTargetStability: 1, coverageTargetStableSamples: 0,
      coverageTargetStabilityLow: 1, coverageTargetStabilityHigh: 1,
      requiredAdjacentStableItemCount: 0, allowedCrossTwoBucketCount: 0,
      expectedCrossTwoBucketCount: 0,
      crossTwoBucketCountMedian: 0, crossTwoBucketCountLow: 0, crossTwoBucketCountHigh: 0,
      maxBucketDisplacementMedian: 0, maxBucketDisplacementHigh: 0,
      expectedBucketChangeRate: 0, minBucketStability: 1,
      decisionRiskRatio: 0, evidenceCount: 0, evidenceRequired: 0,
      ready: true, calibration,
    };
  }
  const mapOrder = orderByAbilities(items, fit.abilities);
  const mapRates = mappedRates(mapOrder, distribution);
  const metrics = assignmentMetrics(items, mapRates, fit.posteriorSamples, distribution);
  const jointInterval = wilsonInterval(metrics.jointBucketStableSamples, fit.posteriorSamples.length);
  const adjacentInterval = wilsonInterval(metrics.adjacentBucketStableSamples, fit.posteriorSamples.length);
  const coverageTargetInterval = wilsonInterval(metrics.coverageTargetStableSamples, fit.posteriorSamples.length);
  const risk = decisionRiskRatio(coverageTargetInterval.low);
  const evidenceCount = history.filter((entry) => entry.sessionId === sessionId && entry.outcome !== "skip").length;
  const evidenceRequired = minimumEvidence(items.length);
  const calibration = calibrationDiagnostics(history);
  const evidenceSatisfied = evidenceCount >= evidenceRequired;
  return {
    method: "laplace-mc-v4",
    sampleCount: fit.posteriorSamples.length,
    ...metrics,
    jointBucketStabilityLow: jointInterval.low,
    jointBucketStabilityHigh: jointInterval.high,
    adjacentBucketStabilityLow: adjacentInterval.low,
    adjacentBucketStabilityHigh: adjacentInterval.high,
    coverageTargetStabilityLow: coverageTargetInterval.low,
    coverageTargetStabilityHigh: coverageTargetInterval.high,
    decisionRiskRatio: risk,
    evidenceCount,
    evidenceRequired,
    ready: evidenceSatisfied && risk <= 1 + 1e-9,
    calibration,
  };
}

function posteriorInformation(
  first: number,
  second: number,
  samples: Float64Array[],
  indexById: Map<number, number>,
  sampleStride = 1,
) {
  if (samples.length === 0) return 0;
  const firstIndex = indexById.get(first);
  const secondIndex = indexById.get(second);
  if (firstIndex === undefined || secondIndex === undefined) return 0;
  let meanProbability = 0;
  let conditionalEntropy = 0;
  const stride = Math.max(1, Math.round(sampleStride));
  let sampleCount = 0;
  for (let sampleIndex = 0; sampleIndex < samples.length; sampleIndex += stride) {
    const sample = samples[sampleIndex];
    const probability = sigmoid(sample[firstIndex] - sample[secondIndex]);
    meanProbability += probability;
    conditionalEntropy += binaryEntropy(probability);
    sampleCount += 1;
  }
  meanProbability /= Math.max(1, sampleCount);
  conditionalEntropy /= Math.max(1, sampleCount);
  return Math.max(0, binaryEntropy(meanProbability) - conditionalEntropy);
}

function nextCalibrationPair(
  history: RankingHistoryInput[],
  sessionId: string,
  version: number,
  randomSeed: number,
): NextPair | undefined {
  const currentSessionResponses = history.filter((entry) => entry.sessionId === sessionId);
  if ((currentSessionResponses.length + 1) % 20 !== 0) return undefined;
  const targeted = new Set(history.map((entry) => entry.calibrationOfComparisonId).filter(Boolean));
  const ordinary = [...history]
    .filter((entry) => entry.outcome !== "skip" && entry.queryKind !== "calibration" && !targeted.has(entry.recordId))
    .sort((a, b) => a.acceptedCountAtAnswer - b.acceptedCountAtAnswer
      || a.createdAt.localeCompare(b.createdAt)
      || a.recordId.localeCompare(b.recordId));
  const eligible = ordinary.length > 10 ? ordinary.slice(0, -10) : [];
  if (eligible.length === 0) return undefined;
  const target = eligible[hash(`${randomSeed}:${version}:calibration`) % eligible.length];
  return {
    pairId: `${version}-cal-${hash(target.recordId).toString(36)}`,
    leftSubjectId: target.rightSubjectId,
    rightSubjectId: target.leftSubjectId,
    modelVersion: version,
    informationScore: 0,
    queryKind: "calibration",
    calibrationOfComparisonId: target.recordId,
  };
}

function globalExplorationPair(
  items: RankingItemInput[],
  history: RankingHistoryInput[],
  fit: FitResult,
  diagnostics: RankingDiagnostics,
  cooled: Set<string>,
  version: number,
  randomSeed: number,
  radius: number,
  cache?: PairSelectionCache,
  posteriorSampleStride = 1,
): { first: number; second: number; score: number } | undefined {
  const pairCounts = cache?.pairCounts ?? new Map<string, number>();
  const itemCounts = cache?.itemCounts ?? new Map(items.map((item) => [item.subjectId, 0]));
  if (!cache) {
    for (const entry of history) {
      if (entry.outcome === "skip") continue;
      const key = pairKey(entry.leftSubjectId, entry.rightSubjectId);
      pairCounts.set(key, (pairCounts.get(key) ?? 0) + 1);
      itemCounts.set(entry.leftSubjectId, (itemCounts.get(entry.leftSubjectId) ?? 0) + 1);
      itemCounts.set(entry.rightSubjectId, (itemCounts.get(entry.rightSubjectId) ?? 0) + 1);
    }
  }
  const indexById = new Map(items.map((item, index) => [item.subjectId, index]));
  const ordered = orderByAbilities(items, fit.abilities);
  const orderedIndex = new Map(ordered.map((item, index) => [item.subjectId, index]));
  const stabilities = diagnostics.adjacentBucketStabilityByItem ?? diagnostics.bucketStability;
  const unstable = items.filter((item) =>
    (stabilities[item.subjectId] ?? 0) < BUCKET_STABILITY_TARGET - 1e-12);
  const firstPool = unstable.length > 0 ? unstable : items;
  const firstCandidates = [...firstPool]
    .sort((left, right) =>
      (itemCounts.get(left.subjectId) ?? 0) - (itemCounts.get(right.subjectId) ?? 0)
      || (stabilities[left.subjectId] ?? 0) - (stabilities[right.subjectId] ?? 0)
      || hash(`${randomSeed}:${version}:${left.subjectId}:coverage`)
        - hash(`${randomSeed}:${version}:${right.subjectId}:coverage`))
    .slice(0, 24);
  const candidates: Array<{
    first: number;
    second: number;
    cooled: boolean;
    repeats: number;
    secondCount: number;
    information: number;
    tieBreak: number;
  }> = [];
  for (const first of firstCandidates) {
    const position = orderedIndex.get(first.subjectId);
    if (position === undefined) continue;
    for (let distance = 1; distance <= radius; distance += 1) {
      for (const neighborIndex of [position - distance, position + distance]) {
        const second = ordered[neighborIndex];
        if (!second) continue;
        const key = pairKey(first.subjectId, second.subjectId);
        candidates.push({
          first: first.subjectId,
          second: second.subjectId,
          cooled: cooled.has(key),
          repeats: pairCounts.get(key) ?? 0,
          secondCount: itemCounts.get(second.subjectId) ?? 0,
          information: posteriorInformation(
            first.subjectId, second.subjectId, fit.posteriorSamples, indexById, posteriorSampleStride,
          ),
          tieBreak: hash(`${randomSeed}:${version}:${key}:exploration`),
        });
      }
    }
  }
  candidates.sort((left, right) =>
    Number(left.cooled) - Number(right.cooled)
    || left.repeats - right.repeats
    || left.secondCount - right.secondCount
    || right.information - left.information
    || left.tieBreak - right.tieBreak);
  const selected = candidates[0];
  if (!selected) return undefined;
  return {
    first: selected.first,
    second: selected.second,
    score: selected.information,
  };
}

export function chooseNextPair(
  items: RankingItemInput[],
  history: RankingHistoryInput[],
  fit: FitResult,
  diagnostics: RankingDiagnostics,
  distribution: DistributionConfig,
  sessionId: string,
  version: number,
  randomSeed: number,
  options: PairSelectionOptions = {},
): NextPair | undefined {
  if (items.length < 2) return undefined;
  const calibration = options.allowCalibration === false
    ? undefined
    : nextCalibrationPair(history, sessionId, version, randomSeed);
  if (calibration) return calibration;

  const ordered = orderByAbilities(items, fit.abilities);
  const selectionCache = options.selectionCache;
  const counts = selectionCache?.pairCounts ?? new Map<string, number>();
  if (!selectionCache) {
    for (const entry of history) {
      if (entry.outcome === "skip") continue;
      const key = pairKey(entry.leftSubjectId, entry.rightSubjectId);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  const cooled = selectionCache?.cooled ?? new Set(history
    .filter((entry) => entry.outcome === "skip" && fit.acceptedComparisons - entry.acceptedCountAtAnswer < 20)
    .map((entry) => pairKey(entry.leftSubjectId, entry.rightSubjectId)));
  const nonCalibrationCount = selectionCache?.nonCalibrationCount
    ?? history.filter((entry) => entry.sessionId === sessionId && entry.queryKind !== "calibration").length;
  const posteriorSampleStride = Math.max(1, Math.round(options.posteriorSampleStride ?? 1));
  let selected: { first: number; second: number; score: number } | undefined;
  let queryKind: NextPair["queryKind"] = "adaptive";
  const explorationInterval = Math.max(1, Math.round(options.explorationInterval ?? 10));
  if ((nonCalibrationCount + 1) % explorationInterval === 0) {
    const explorationRadius = Math.max(1, Math.round(options.explorationRadius ?? 5));
    const exploration = globalExplorationPair(
      items, history, fit, diagnostics, cooled, version, randomSeed, explorationRadius,
      selectionCache, posteriorSampleStride,
    );
    if (exploration) {
      selected = exploration;
      queryKind = "exploration";
    }
  }

  if (!selected) {
    const candidatePairs = new Map<string, [number, number]>();
    const candidateCapacity = options.candidateLimit === undefined
      ? Number.POSITIVE_INFINITY
      : Math.max(128, Math.round(options.candidateLimit) * 4);
    const addCandidate = (first: number, second: number) => {
      const key = pairKey(first, second);
      if (candidatePairs.has(key) || candidatePairs.size < candidateCapacity) {
        candidatePairs.set(key, [first, second]);
      }
    };
    const maxRankDistance = Math.max(1, options.maxRankDistance ?? 3);
    const maxRateGap = Math.max(0, options.maxRateGap ?? 10);
    for (let distance = 1; distance <= Math.min(maxRankDistance, ordered.length - 1); distance += 1) {
      for (let index = 0; index + distance < ordered.length; index += 1) {
        const first = ordered[index];
        const second = ordered[index + distance];
        if (Math.abs(first.rate - second.rate) <= maxRateGap) {
          addCandidate(first.subjectId, second.subjectId);
        }
      }
    }
    const mapRates = mappedRates(ordered, distribution);
    const boundaryWindow = Math.max(0, Math.round(options.boundaryWindow ?? 3));
    for (let cut = 1; cut < ordered.length; cut += 1) {
      if (mapRates.get(ordered[cut - 1].subjectId) === mapRates.get(ordered[cut].subjectId)) continue;
      for (let left = Math.max(0, cut - boundaryWindow); left < cut; left += 1) {
        for (let right = cut; right < Math.min(ordered.length, cut + boundaryWindow); right += 1) {
          addCandidate(ordered[left].subjectId, ordered[right].subjectId);
        }
      }
    }
    if (candidatePairs.size === 0) {
      for (let index = 0; index + 1 < ordered.length; index += 1) {
        addCandidate(ordered[index].subjectId, ordered[index + 1].subjectId);
      }
    }
    const indexById = new Map(items.map((item, index) => [item.subjectId, index]));
    const candidateEntries = [...candidatePairs.entries()];
    const candidateLimit = options.candidateLimit === undefined
      ? candidateEntries.length
      : Math.max(1, Math.round(options.candidateLimit));
    const candidateStride = Math.max(1, Math.ceil(candidateEntries.length / candidateLimit));
    const candidateOffset = candidateStride === 1
      ? 0
      : hash(`${randomSeed}:${version}:candidate-window`) % candidateStride;
    const choose = (ignoreCooldown: boolean) => {
      let best: { first: number; second: number; score: number; key: string } | undefined;
      let considered = 0;
      for (let candidateIndex = candidateOffset;
        candidateIndex < candidateEntries.length && considered < candidateLimit;
        candidateIndex += candidateStride) {
        const [key, [first, second]] = candidateEntries[candidateIndex];
        considered += 1;
        if (!ignoreCooldown && cooled.has(key)) continue;
        const information = posteriorInformation(
          first, second, fit.posteriorSamples, indexById, posteriorSampleStride,
        );
        const score = information / (1 + (counts.get(key) ?? 0));
        if (!best || score > best.score + 1e-12
          || (Math.abs(score - best.score) <= 1e-12 && key < best.key)) {
          best = { first, second, score, key };
        }
      }
      return best;
    };
    selected = choose(false) ?? choose(true);
  }

  if (!selected) return undefined;
  const flip = hash(`${randomSeed}:${version}:${pairKey(selected.first, selected.second)}`) % 2 === 1;
  const leftSubjectId = flip ? selected.second : selected.first;
  const rightSubjectId = flip ? selected.first : selected.second;
  return {
    pairId: `${version}-${hash(`${leftSubjectId}:${rightSubjectId}:${randomSeed}:${queryKind}`).toString(36)}`,
    leftSubjectId,
    rightSubjectId,
    modelVersion: version,
    informationScore: selected.score,
    queryKind,
  };
}

function forecastQuantile(values: number[], probability: number) {
  const ordered = [...values].sort((left, right) => left - right);
  const value = ordered[Math.floor(probability * Math.max(0, ordered.length - 1))];
  return Number.isFinite(value) ? value : undefined;
}

function wilsonInterval(successes: number, trials: number, z = 1.6448536269514722) {
  if (trials <= 0) return { low: 0, high: 1 };
  const probability = successes / trials;
  const zSquared = z * z;
  const denominator = 1 + zSquared / trials;
  const center = (probability + zSquared / (2 * trials)) / denominator;
  const margin = z * Math.sqrt(
    (probability * (1 - probability) + zSquared / (4 * trials)) / trials,
  ) / denominator;
  return {
    low: Math.max(0, center - margin),
    high: Math.min(1, center + margin),
  };
}

function forecastScoreByRank(items: RankingItemInput[], distribution: DistributionConfig) {
  const levelCount = normalizeScoreLevelCount(distribution.levelCount);
  const weights = effectiveDistributionWeights(items, distribution);
  const total = weights.reduce((sum, value) => sum + value, 0);
  const topDown = [...weights].reverse().map((value) => value / total);
  const output = new Uint8Array(items.length);
  for (let rankIndex = 0; rankIndex < items.length; rankIndex += 1) {
    const quantile = (rankIndex + 0.5) / items.length;
    let cumulative = 0;
    let score = 1;
    for (let index = 0; index < topDown.length; index += 1) {
      cumulative += topDown[index];
      if (quantile <= cumulative + 1e-12) { score = levelCount - index; break; }
    }
    output[rankIndex] = score;
  }
  return output;
}

function ratesByItem(items: RankingItemInput[], sample: Float64Array, scoreByRank: Uint8Array) {
  const indices = items.map((_, index) => index);
  indices.sort((left, right) =>
    sample[right] - sample[left]
      || items[right].rate - items[left].rate
      || items[left].subjectId - items[right].subjectId);
  const output = new Uint8Array(items.length);
  for (let rankIndex = 0; rankIndex < indices.length; rankIndex += 1) {
    output[indices[rankIndex]] = scoreByRank[rankIndex];
  }
  return output;
}

export interface StoppingForecastSimulation {
  forecast: StoppingForecast;
  stoppingTimes: number[];
}

function forecastRandomSeed(options: StoppingForecastOptions, diagnostics: RankingDiagnostics) {
  return hash(`${options.randomSeed}:${diagnostics.evidenceCount}:coverage-90-adjacent:forecast`);
}

export interface StoppingForecastRolloutInput {
  items: RankingItemInput[];
  distribution: DistributionConfig;
  history: RankingHistoryInput[];
  sessionId: string;
  modelVersion: number;
  selectionOptions: PairSelectionOptions;
  initialDiagnostics: RankingDiagnostics;
  /** Initial MAP abilities retained for worker/backward compatibility. */
  currentAbilities: Float64Array;
  forecastSamples: Float64Array[];
  truthSamples: Float64Array[];
  rolloutSeeds: Uint32Array;
  scoreByRank: Uint8Array;
  acceptedComparisons: number;
  evidenceRequired: number;
  diagnosticStride: number;
  /** Internal safety bound used as the actual finite forecast window. */
  simulationHorizon: number;
  projectionHorizon: number;
  evidenceCount: number;
  ready: boolean;
}

/**
 * The old forecast extrapolated a single scalar contraction curve.  That
 * assumes every future answer is equally informative and, importantly, never
 * chooses or answers a question.  The forecast now runs the same adaptive
 * policy as the product: choose one pair, draw one Davidson response, and
 * update a small posterior ensemble before checking the stopping event again.
 *
 * These constants are deliberately fixed.  They describe a conservative
 * response model for a *forecast*, not parameters estimated from a user's
 * historical calibration answers (historical calibration is intentionally out
 * of scope for this revision).
 */
const FORECAST_DAVIDSON_TIE_STRENGTH = 0.35;
const FORECAST_LAPSE_RATE = 0.04;
const FORECAST_UPDATE_TEMPERATURE = 0.72;
const FORECAST_MIN_PAIR_VARIANCE = 1e-8;
// Sorting every posterior draw is the dominant cost for large collections.
// A sixteen-answer cadence is frequent enough to adapt exploration and keeps
// the interactive forecast responsive; the public model itself still checks
// the stopping event on every real answer.
const FORECAST_DEFAULT_DIAGNOSTIC_STRIDE = 32;

interface DavidsonProbabilities {
  left: number;
  tie: number;
  right: number;
}

function davidsonProbabilities(difference: number): DavidsonProbabilities {
  // With strengths exp(theta), dividing Davidson's denominator by the
  // geometric mean leaves exp(d/2), exp(-d/2), and a constant tie weight.
  const bounded = Math.max(-40, Math.min(40, difference));
  const leftWeight = Math.exp(bounded / 2);
  const rightWeight = Math.exp(-bounded / 2);
  const tieWeight = FORECAST_DAVIDSON_TIE_STRENGTH;
  const denominator = leftWeight + rightWeight + tieWeight;
  const base = {
    left: leftWeight / denominator,
    tie: tieWeight / denominator,
    right: rightWeight / denominator,
  };
  // A small fixed lapse prevents a deterministic answer from making a future
  // path infinitely certain.  It is mixed uniformly across all three buttons.
  return {
    left: (1 - FORECAST_LAPSE_RATE) * base.left + FORECAST_LAPSE_RATE / 3,
    tie: (1 - FORECAST_LAPSE_RATE) * base.tie + FORECAST_LAPSE_RATE / 3,
    right: (1 - FORECAST_LAPSE_RATE) * base.right + FORECAST_LAPSE_RATE / 3,
  };
}

function simulatedOutcome(difference: number, random: () => number): "left" | "tie" | "right" {
  const probabilities = davidsonProbabilities(difference);
  const draw = random();
  if (draw < probabilities.left) return "left";
  if (draw < probabilities.left + probabilities.tie) return "tie";
  return "right";
}

function outcomeLikelihood(
  difference: number,
  outcome: "left" | "tie" | "right",
) {
  const probabilities = davidsonProbabilities(difference);
  return outcome === "left" ? probabilities.left
    : outcome === "right" ? probabilities.right
      : probabilities.tie;
}

/**
 * Apply an ensemble-transform Kalman-style update to one pairwise direction.
 * Only theta[left] - theta[right] is changed; all orthogonal directions are
 * preserved.  Tempered likelihood weights keep a 64-member ensemble useful
 * over a long simulated path and avoid pretending that the approximate
 * Davidson response model is exact.
 */
function updateForecastPosterior(
  posteriorSamples: Float64Array[],
  leftIndex: number,
  rightIndex: number,
  outcome: "left" | "tie" | "right",
) {
  if (posteriorSamples.length === 0) return 0;
  const differences = posteriorSamples.map((sample) => sample[leftIndex] - sample[rightIndex]);
  let mean = 0;
  for (const difference of differences) mean += difference;
  mean /= differences.length;
  let variance = 0;
  for (const difference of differences) variance += (difference - mean) ** 2;
  variance /= Math.max(1, differences.length - 1);

  // A degenerate hand-written/test ensemble still needs to react to a new
  // answer.  The fallback is a deliberately modest pseudo-observation shift.
  if (variance < FORECAST_MIN_PAIR_VARIANCE) {
    const target = outcome === "left" ? 0.9 : outcome === "right" ? -0.9 : 0;
    const shift = Math.max(-0.75, Math.min(0.75, (target - mean) * 0.2));
    for (const sample of posteriorSamples) {
      sample[leftIndex] += shift / 2;
      sample[rightIndex] -= shift / 2;
    }
    return shift;
  }

  const logWeights = differences.map((difference) =>
    FORECAST_UPDATE_TEMPERATURE * Math.log(Math.max(1e-12, outcomeLikelihood(difference, outcome))));
  const maximum = Math.max(...logWeights);
  let weightTotal = 0;
  let weightedMean = 0;
  for (const logWeight of logWeights) weightTotal += Math.exp(logWeight - maximum);
  for (let index = 0; index < differences.length; index += 1) {
    weightedMean += differences[index] * Math.exp(logWeights[index] - maximum);
  }
  weightedMean /= Math.max(weightTotal, Number.EPSILON);
  let weightedVariance = 0;
  for (let index = 0; index < differences.length; index += 1) {
    const weight = Math.exp(logWeights[index] - maximum);
    weightedVariance += weight * (differences[index] - weightedMean) ** 2;
  }
  weightedVariance /= Math.max(weightTotal, Number.EPSILON);

  // Temper once more in moment space.  This makes the update stable when a
  // path repeatedly asks nearly identical pairs while retaining the observed
  // direction of evidence.
  const meanBlend = 0.82;
  const nextMean = mean + meanBlend * (weightedMean - mean);
  const nextVariance = Math.max(
    FORECAST_MIN_PAIR_VARIANCE,
    variance * (1 - meanBlend) + weightedVariance * meanBlend,
  );
  const scale = Math.sqrt(nextVariance / variance);
  let differenceDeltaTotal = 0;
  for (let index = 0; index < posteriorSamples.length; index += 1) {
    const nextDifference = nextMean + scale * (differences[index] - mean);
    const delta = nextDifference - differences[index];
    differenceDeltaTotal += delta;
    posteriorSamples[index][leftIndex] += delta / 2;
    posteriorSamples[index][rightIndex] -= delta / 2;
  }
  return differenceDeltaTotal / posteriorSamples.length;
}

function fitFromForecastEnsemble(
  items: RankingItemInput[],
  posteriorSamples: Float64Array[],
  acceptedComparisons: number,
): FitResult {
  const abilities: Record<number, number> = {};
  const uncertainty: Record<number, number> = {};
  if (posteriorSamples.length === 0) {
    for (const item of items) {
      abilities[item.subjectId] = 0;
      uncertainty[item.subjectId] = 0;
    }
    return {
      abilities, uncertainty, meanUncertainty: 0, converged: true, iterations: 0,
      acceptedComparisons, posteriorSamples,
    };
  }
  for (let itemIndex = 0; itemIndex < items.length; itemIndex += 1) {
    let mean = 0;
    for (const sample of posteriorSamples) mean += sample[itemIndex];
    mean /= posteriorSamples.length;
    abilities[items[itemIndex].subjectId] = mean;
    // Pair selection and stopping read the ensemble directly.  Computing all
    // marginal variances at every simulated answer would double the hottest
    // O(items × samples) loop without changing either decision.
    uncertainty[items[itemIndex].subjectId] = 0;
  }
  return {
    abilities,
    uncertainty,
    meanUncertainty: 0,
    converged: true,
    iterations: 1,
    acceptedComparisons,
    posteriorSamples,
  };
}

function coverageTargetStableSampleCount(
  items: RankingItemInput[],
  referenceRates: Uint8Array,
  posteriorSamples: Float64Array[],
  scoreByRank: Uint8Array,
) {
  const allowedCrossCount = allowedCrossTwoBucketCount(items.length);
  let stableSamples = 0;
  for (const sample of posteriorSamples) {
    const sampleRates = ratesByItem(items, sample, scoreByRank);
    let crossTwoBucketCount = 0;
    for (let itemIndex = 0; itemIndex < items.length; itemIndex += 1) {
      if (Math.abs(referenceRates[itemIndex] - sampleRates[itemIndex]) > 1) crossTwoBucketCount += 1;
      if (crossTwoBucketCount > allowedCrossCount) break;
    }
    if (crossTwoBucketCount <= allowedCrossCount) stableSamples += 1;
  }
  return stableSamples;
}

function forecastStoppingEventPassed(
  items: RankingItemInput[],
  abilities: Float64Array,
  posteriorSamples: Float64Array[],
  scoreByRank: Uint8Array,
  evidenceCount: number,
  evidenceRequired: number,
) {
  if (evidenceCount < evidenceRequired || posteriorSamples.length === 0) return false;
  const referenceRates = ratesByItem(items, abilities, scoreByRank);
  const stableSamples = coverageTargetStableSampleCount(items, referenceRates, posteriorSamples, scoreByRank);
  return wilsonInterval(stableSamples, posteriorSamples.length).low >= STOPPING_PROBABILITY_TARGET;
}

function forecastHistoryRecord(
  input: StoppingForecastRolloutInput,
  pair: NextPair,
  outcome: "left" | "tie" | "right",
  acceptedCountAtAnswer: number,
  rolloutSeed: number,
  answerIndex: number,
): RankingHistoryInput {
  return {
    recordId: `forecast:${rolloutSeed.toString(16)}:${answerIndex}`,
    sessionId: input.sessionId,
    leftSubjectId: pair.leftSubjectId,
    rightSubjectId: pair.rightSubjectId,
    outcome,
    acceptedCountAtAnswer,
    queryKind: pair.queryKind,
    createdAt: new Date(answerIndex * 1000).toISOString(),
  };
}

function createForecastSelectionCache(
  items: RankingItemInput[],
  history: RankingHistoryInput[],
  sessionId: string,
  acceptedComparisons: number,
): PairSelectionCache {
  const pairCounts = new Map<string, number>();
  const itemCounts = new Map(items.map((item) => [item.subjectId, 0]));
  const cooled = new Set<string>();
  let nonCalibrationCount = 0;
  for (const entry of history) {
    if (entry.outcome === "skip") {
      if (acceptedComparisons - entry.acceptedCountAtAnswer < 20) {
        cooled.add(pairKey(entry.leftSubjectId, entry.rightSubjectId));
      }
      continue;
    }
    const key = pairKey(entry.leftSubjectId, entry.rightSubjectId);
    pairCounts.set(key, (pairCounts.get(key) ?? 0) + 1);
    itemCounts.set(entry.leftSubjectId, (itemCounts.get(entry.leftSubjectId) ?? 0) + 1);
    itemCounts.set(entry.rightSubjectId, (itemCounts.get(entry.rightSubjectId) ?? 0) + 1);
    if (entry.sessionId === sessionId && entry.queryKind !== "calibration") nonCalibrationCount += 1;
  }
  return { pairCounts, itemCounts, cooled, nonCalibrationCount };
}

function refreshForecastSelectionDiagnostics(
  items: RankingItemInput[],
  fit: FitResult,
  distribution: DistributionConfig,
  previous: RankingDiagnostics,
) {
  const mapOrder = orderByAbilities(items, fit.abilities);
  const mapRates = mappedRates(mapOrder, distribution);
  // Selection needs only a rough unstable-item ranking.  Use a deterministic
  // eighth of the ensemble here; the stopping event itself still evaluates all
  // forecast members at its check cadence.
  const diagnosticSamples = fit.posteriorSamples.filter((_, index) => index % 8 === 0);
  const metrics = assignmentMetrics(items, mapRates, diagnosticSamples, distribution);
  // Question selection only consumes the per-item stability maps.  Rebuilding
  // calibration and rescanning an ever-growing synthetic history here would
  // be quadratic in the forecast horizon without affecting the selected pair.
  return { ...previous, ...metrics };
}

function simulateForecastRollout(
  input: StoppingForecastRolloutInput,
  truth: Float64Array,
  rolloutSeed: number,
) {
  const random = seededRandom(rolloutSeed);
  const posteriorSamples = input.forecastSamples.map((sample) => sample.slice());
  const indexById = new Map(input.items.map((item, index) => [item.subjectId, index]));
  const history = input.history.slice();
  let acceptedComparisons = input.acceptedComparisons;
  const selectionCache = createForecastSelectionCache(
    input.items, history, input.sessionId, acceptedComparisons,
  );
  let evidenceCount = input.evidenceCount;
  const fit = fitFromForecastEnsemble(input.items, posteriorSamples, acceptedComparisons);
  const abilities = new Float64Array(input.items.map((item) => fit.abilities[item.subjectId] ?? 0));
  let diagnostics = input.initialDiagnostics;
  const diagnosticStride = Math.max(1, Math.round(input.diagnosticStride));
  const stoppingCheckStride = Math.max(8, diagnosticStride);

  for (let answerIndex = 1; answerIndex <= input.simulationHorizon; answerIndex += 1) {
    if (answerIndex === 1 || (answerIndex - 1) % diagnosticStride === 0) {
      diagnostics = refreshForecastSelectionDiagnostics(
        input.items, fit, input.distribution, diagnostics,
      );
    }
    const pair = chooseNextPair(
      input.items,
      history,
      fit,
      diagnostics,
      input.distribution,
      input.sessionId,
      input.modelVersion,
      answerIndex + input.modelVersion,
      {
        ...input.selectionOptions,
        allowCalibration: false,
        selectionCache,
        candidateLimit: input.items.length > 80 ? 96 : (input.selectionOptions.candidateLimit ?? 64),
        posteriorSampleStride: input.items.length > 80 ? 16 : (input.selectionOptions.posteriorSampleStride ?? 4),
      },
    );
    if (!pair) return Number.POSITIVE_INFINITY;
    const leftIndex = indexById.get(pair.leftSubjectId);
    const rightIndex = indexById.get(pair.rightSubjectId);
    if (leftIndex === undefined || rightIndex === undefined || leftIndex === rightIndex) {
      return Number.POSITIVE_INFINITY;
    }
    const outcome = simulatedOutcome(truth[leftIndex] - truth[rightIndex], random);
    const differenceDelta = updateForecastPosterior(posteriorSamples, leftIndex, rightIndex, outcome);
    fit.abilities[pair.leftSubjectId] += differenceDelta / 2;
    fit.abilities[pair.rightSubjectId] -= differenceDelta / 2;
    abilities[leftIndex] += differenceDelta / 2;
    abilities[rightIndex] -= differenceDelta / 2;
    acceptedComparisons += 1;
    fit.acceptedComparisons = acceptedComparisons;
    evidenceCount += 1;
    history.push(forecastHistoryRecord(input, pair, outcome, acceptedComparisons, rolloutSeed, answerIndex));
    const selectedKey = pairKey(pair.leftSubjectId, pair.rightSubjectId);
    selectionCache.pairCounts.set(selectedKey, (selectionCache.pairCounts.get(selectedKey) ?? 0) + 1);
    selectionCache.itemCounts.set(pair.leftSubjectId, (selectionCache.itemCounts.get(pair.leftSubjectId) ?? 0) + 1);
    selectionCache.itemCounts.set(pair.rightSubjectId, (selectionCache.itemCounts.get(pair.rightSubjectId) ?? 0) + 1);
    if (pair.queryKind !== "calibration") selectionCache.nonCalibrationCount += 1;
    const checkNow = answerIndex <= Math.min(4, stoppingCheckStride)
      || answerIndex % stoppingCheckStride === 0
      || evidenceCount === input.evidenceRequired;
    if (checkNow) {
      if (forecastStoppingEventPassed(
        input.items,
        abilities,
        posteriorSamples,
        input.scoreByRank,
        evidenceCount,
        input.evidenceRequired,
      )) return answerIndex;
    }
  }
  return Number.POSITIVE_INFINITY;
}

export function prepareStoppingForecastRollouts(
  items: RankingItemInput[],
  fit: FitResult,
  distribution: DistributionConfig,
  history: RankingHistoryInput[],
  sessionId: string,
  diagnostics: RankingDiagnostics,
  options: StoppingForecastOptions,
  rolloutCount = Math.max(16, Math.round(options.rolloutCount ?? 64)),
): StoppingForecastRolloutInput {
  const forecastSampleCount = Math.min(64, fit.posteriorSamples.length);
  // Preserve the shared random stream before distributing paths to workers.
  // Each path receives its own seed, so splitting the paths cannot change the
  // simulated questions or responses.
  const random = seededRandom(forecastRandomSeed(options, diagnostics));
  const truthSamples: Float64Array[] = [];
  const rolloutSeeds = new Uint32Array(rolloutCount);
  for (let rollout = 0; rollout < rolloutCount && fit.posteriorSamples.length > 0; rollout += 1) {
    truthSamples.push(fit.posteriorSamples[Math.floor(random() * fit.posteriorSamples.length)].slice());
    rolloutSeeds[rollout] = Math.floor(random() * 0x100000000) >>> 0;
  }
  const selectedSamples = Array.from({ length: forecastSampleCount }, (_, index) =>
    fit.posteriorSamples[Math.floor(index * fit.posteriorSamples.length / forecastSampleCount)].slice());
  const currentAbilities = new Float64Array(items.map((item) => fit.abilities[item.subjectId] ?? 0));
  const effectiveHistory = history.map((entry) => ({ ...entry }));
  const requestedProjectionHorizon = Math.max(
    5,
    Math.round(options.projectionHorizon ?? forecastProjectionHorizon(items.length)),
  );
  const simulationHorizon = Math.min(
    requestedProjectionHorizon,
    Math.max(120, Math.min(500, Math.ceil(items.length * 1.75))),
  );
  return {
    items: items.map((item) => ({ ...item })),
    distribution: { ...distribution, weights: [...distribution.weights] },
    history: effectiveHistory,
    sessionId,
    // Forecast random streams depend on evidence, never on a cached model
    // version, so switching away from a mode and back is exactly reproducible.
    modelVersion: 0,
    selectionOptions: { ...(options.pairSelection ?? {}), allowCalibration: false },
    initialDiagnostics: diagnostics,
    currentAbilities,
    forecastSamples: selectedSamples,
    truthSamples,
    rolloutSeeds,
    scoreByRank: forecastScoreByRank(items, distribution),
    acceptedComparisons: fit.acceptedComparisons,
    evidenceRequired: diagnostics.evidenceRequired,
    diagnosticStride: Math.max(1, Math.round(options.diagnosticStride ?? FORECAST_DEFAULT_DIAGNOSTIC_STRIDE)),
    simulationHorizon,
    projectionHorizon: simulationHorizon,
    evidenceCount: diagnostics.evidenceCount,
    ready: diagnostics.ready,
  };
}

/** Calculate an independently seeded slice of sequential forecast rollouts. */
export function forecastStoppingTimeRollouts(
  input: StoppingForecastRolloutInput,
  rolloutStart: number,
  rolloutCount: number,
) {
  if (rolloutCount <= 0) return [];
  if (input.ready) return Array<number>(rolloutCount).fill(0);
  if (input.forecastSamples.length === 0) return Array<number>(rolloutCount).fill(Number.POSITIVE_INFINITY);
  const stoppingTimes: number[] = [];

  for (let offset = 0; offset < rolloutCount; offset += 1) {
    const absoluteIndex = rolloutStart + offset;
    const truth = input.truthSamples[absoluteIndex];
    if (!truth) {
      stoppingTimes.push(Number.POSITIVE_INFINITY);
      continue;
    }
    const seed = input.rolloutSeeds[absoluteIndex] ?? hash(`${absoluteIndex}:forecast`);
    stoppingTimes.push(simulateForecastRollout(input, truth, seed));
  }
  return stoppingTimes;
}

function summarizeStoppingTimes(
  stoppingTimes: number[],
  projectionHorizon: number,
  nextCheckpoint: number,
  evidenceCount: number,
  evidenceRequired: number,
  ready: boolean,
): StoppingForecast {
  const rolloutCount = stoppingTimes.length;
  const base = {
    method: "posterior-contraction-mc-v6" as const,
    rolloutCount,
    nextCheckpoint,
    projectionHorizon,
  };
  if (ready) {
    return {
      ...base, status: "ready", lowerAdditional: 0, medianAdditional: 0, upperAdditional: 0,
      probabilityWithin20: 1, probabilityWithinProjection: 1,
      within20Successes: rolloutCount, probabilityWithin20Low: 1, probabilityWithin20High: 1,
      withinProjectionSuccesses: rolloutCount,
      probabilityWithinProjectionLow: 1, probabilityWithinProjectionHigh: 1,
    };
  }
  const reached = stoppingTimes.filter(Number.isFinite).length;
  const probabilityWithinProjection = reached / rolloutCount;
  const within20Successes = stoppingTimes.filter((value) => value <= 20).length;
  const probabilityWithin20 = within20Successes / rolloutCount;
  const within20Interval = wilsonInterval(within20Successes, rolloutCount);
  const withinProjectionInterval = wilsonInterval(reached, rolloutCount);
  const lowerAdditional = forecastQuantile(stoppingTimes, 0.1);
  const medianAdditional = forecastQuantile(stoppingTimes, 0.5);
  const upperAdditional = forecastQuantile(stoppingTimes, 0.9);
  return {
    ...base,
    status: evidenceCount < evidenceRequired
      ? "uncertain"
      : medianAdditional !== undefined
        ? "forecast"
        : "uncertain",
    lowerAdditional,
    medianAdditional,
    upperAdditional,
    probabilityWithin20,
    probabilityWithinProjection,
    within20Successes,
    probabilityWithin20Low: within20Interval.low,
    probabilityWithin20High: within20Interval.high,
    withinProjectionSuccesses: reached,
    probabilityWithinProjectionLow: withinProjectionInterval.low,
    probabilityWithinProjectionHigh: withinProjectionInterval.high,
  };
}

export function summarizeStoppingTimeRollouts(
  stoppingTimes: number[],
  projectionHorizon: number,
  diagnostics: Pick<RankingDiagnostics, "evidenceCount" | "evidenceRequired" | "ready">,
  posteriorAvailable = true,
): StoppingForecastSimulation {
  const forecast = summarizeStoppingTimes(
    stoppingTimes,
    projectionHorizon,
    10,
    diagnostics.evidenceCount,
    diagnostics.evidenceRequired,
    diagnostics.ready,
  );
  return {
    forecast: posteriorAvailable ? forecast : {
      ...forecast,
      probabilityWithin20High: 1,
      probabilityWithinProjectionHigh: 1,
    },
    stoppingTimes,
  };
}

export function forecastStoppingTimeSimulation(
  items: RankingItemInput[],
  fit: FitResult,
  distribution: DistributionConfig,
  history: RankingHistoryInput[],
  sessionId: string,
  diagnostics: RankingDiagnostics,
  options: StoppingForecastOptions,
): StoppingForecastSimulation {
  const rolloutCount = Math.max(16, Math.round(options.rolloutCount ?? 64));
  const targetReady = diagnostics.ready;
  const projectionHorizon = Math.max(
    5,
    Math.round(options.projectionHorizon ?? forecastProjectionHorizon(items.length)),
  );
  const nextCheckpoint = 10;
  if (targetReady) {
    const stoppingTimes = Array<number>(rolloutCount).fill(0);
    return {
      forecast: summarizeStoppingTimes(
        stoppingTimes, projectionHorizon, nextCheckpoint,
        diagnostics.evidenceCount, diagnostics.evidenceRequired, true,
      ),
      stoppingTimes,
    };
  }
  const input = prepareStoppingForecastRollouts(
    items, fit, distribution, history, sessionId, diagnostics, options, rolloutCount,
  );
  const stoppingTimes = forecastStoppingTimeRollouts(input, 0, rolloutCount);
  return summarizeStoppingTimeRollouts(
    stoppingTimes, input.projectionHorizon, diagnostics, fit.posteriorSamples.length > 0,
  );
}

export function combineStoppingForecastSimulations(
  simulations: StoppingForecastSimulation[],
  diagnostics: Pick<RankingDiagnostics, "evidenceCount" | "evidenceRequired" | "ready">,
): StoppingForecast {
  if (simulations.length === 0) throw new Error("至少需要一个停止时间模拟。");
  if (simulations.length === 1) return simulations[0].forecast;
  const rolloutCount = Math.min(...simulations.map((simulation) => simulation.stoppingTimes.length));
  const stoppingTimes = Array.from({ length: rolloutCount }, (_, index) =>
    Math.max(...simulations.map((simulation) => simulation.stoppingTimes[index])));
  return summarizeStoppingTimes(
    stoppingTimes,
    Math.min(...simulations.map((simulation) => simulation.forecast.projectionHorizon)),
    Math.max(...simulations.map((simulation) => simulation.forecast.nextCheckpoint)),
    diagnostics.evidenceCount,
    diagnostics.evidenceRequired,
    diagnostics.ready,
  );
}

export function forecastStoppingTime(
  items: RankingItemInput[],
  fit: FitResult,
  distribution: DistributionConfig,
  history: RankingHistoryInput[],
  sessionId: string,
  diagnostics: RankingDiagnostics,
  options: StoppingForecastOptions,
): StoppingForecast {
  return forecastStoppingTimeSimulation(
    items, fit, distribution, history, sessionId, diagnostics, options,
  ).forecast;
}

export function buildRankedItems(
  items: CollectionItem[],
  model: Pick<ModelState, "abilities" | "uncertainty" | "diagnostics">,
  comparisons: RankingComparisonInput[],
  distribution: DistributionConfig,
): RankedItem[] {
  const ordered = orderByAbilities(items, model.abilities);
  const rates = mappedRates(ordered, distribution);
  const counts = new Map<number, number>();
  for (const comparison of comparisons) {
    counts.set(comparison.leftSubjectId, (counts.get(comparison.leftSubjectId) ?? 0) + 1);
    counts.set(comparison.rightSubjectId, (counts.get(comparison.rightSubjectId) ?? 0) + 1);
  }
  return ordered.map((item, index) => ({
    ...item,
    rank: index + 1,
    ability: model.abilities[item.subjectId] ?? 0,
    uncertainty: model.uncertainty[item.subjectId] ?? 2,
    newRate: rates.get(item.subjectId) ?? item.rate,
    bucketStability: model.diagnostics?.bucketStability[item.subjectId],
    comparisonCount: counts.get(item.subjectId) ?? 0,
  }));
}

export function toModelState(
  sessionId: string,
  version: number,
  result: FitResult,
  initialMeanUncertainty?: number,
  diagnostics?: RankingDiagnostics,
): ModelState {
  return {
    sessionId,
    version,
    abilities: result.abilities,
    uncertainty: result.uncertainty,
    acceptedComparisons: result.acceptedComparisons,
    initialMeanUncertainty: initialMeanUncertainty ?? result.meanUncertainty,
    currentMeanUncertainty: result.meanUncertainty,
    converged: result.converged,
    iterations: result.iterations,
    diagnostics,
    updatedAt: new Date().toISOString(),
  };
}
