import {
  CalibrationDiagnostics,
  CollectionItem,
  ComparisonBudgetMode,
  DistributionConfig,
  ModelState,
  NextPair,
  OptimizationStatus,
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
  minimumCoveredItems,
  minimumEvidence,
  minimumUniquePairs,
  MINIMUM_COVERAGE_WEIGHT,
  repeatedPairEffectiveSampleSize,
  REPEATED_PAIR_CORRELATION,
  requiredAdjacentStableItemCount,
  SOURCE_AGE_HALF_LIFE_DAYS,
  stoppingCoverageTarget,
  STOPPING_MODE_ORDER,
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
const DEFAULT_TIE_STRENGTH = 0.35;
const TIE_LOG_PRIOR_MEAN = Math.log(DEFAULT_TIE_STRENGTH);
const TIE_LOG_PRIOR_STRENGTH = 1;
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

interface IndexedComparison {
  left: number;
  right: number;
  outcome: "left" | "tie" | "right";
  weight: number;
}

export interface FitResult {
  abilities: Record<number, number>;
  uncertainty: Record<number, number>;
  meanUncertainty: number;
  converged: boolean;
  iterations: number;
  acceptedComparisons: number;
  effectiveComparisons?: number;
  tieStrength?: number;
  optimizationStatus?: OptimizationStatus;
  posteriorSamples: Float64Array[];
  /** Joint Laplace draws of log(nu), aligned with posteriorSamples. */
  tieLogSamples?: Float64Array;
  /** Fit configuration retained for exact forecast checkpoint refreshes. */
  priorStrength?: number;
  priorScale?: number;
  posteriorRandomSeed?: number;
}

export interface FitOptions {
  priorStrength?: number;
  priorScale?: number;
  posteriorSampleCount?: number;
  randomSeed?: number;
  /** Primarily exposed for deterministic fail-closed tests and diagnostics. */
  maxIterations?: number;
}

export interface PairSelectionOptions {
  maxRateGap?: number;
  maxRankDistance?: number;
  boundaryWindow?: number;
  explorationInterval?: number;
  explorationRadius?: number;
  /** Whether scheduled calibration repeats participate in this selection path. */
  allowCalibration?: boolean;
  /** Internal cache used by long-running forecast paths. */
  selectionCache?: PairSelectionCache;
  /** Limit expensive posterior-information evaluations in a forecast path. */
  candidateLimit?: number;
  posteriorSampleStride?: number;
}

interface PairSelectionCache {
  sessionId: string;
  pairMass: Map<string, number>;
  pairEffectiveWeight: Map<string, number>;
  itemEffectiveWeight: Map<number, number>;
  cooled: Set<string>;
  nonCalibrationCount: number;
  currentSessionResponseCount: number;
  calibrationTargetIds: Set<string>;
  calibrationCandidates: RankingHistoryInput[];
}

export interface StoppingForecastOptions {
  randomSeed: number;
  /** Active display mode; all three ordered modes are simulated together. */
  stoppingMode?: ComparisonBudgetMode;
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

export interface DavidsonProbabilities {
  left: number;
  tie: number;
  right: number;
}

/** The shared three-result observation model used by fitting, selection, and forecast. */
export function davidsonProbabilities(
  difference: number,
  tieStrength = DEFAULT_TIE_STRENGTH,
): DavidsonProbabilities {
  const bounded = Math.max(-80, Math.min(80, difference));
  const leftLogWeight = bounded / 2;
  const rightLogWeight = -bounded / 2;
  const tieLogWeight = Math.log(Math.max(1e-8, tieStrength));
  const maximum = Math.max(leftLogWeight, rightLogWeight, tieLogWeight);
  const leftWeight = Math.exp(leftLogWeight - maximum);
  const tieWeight = Math.exp(tieLogWeight - maximum);
  const rightWeight = Math.exp(rightLogWeight - maximum);
  const denominator = leftWeight + tieWeight + rightWeight;
  return {
    left: leftWeight / denominator,
    tie: tieWeight / denominator,
    right: rightWeight / denominator,
  };
}

function tieStrengthFromLog(logStrength: number) {
  return Math.exp(Math.max(-80, Math.min(80, logStrength)));
}

function categoricalEntropy(probabilities: DavidsonProbabilities) {
  let entropy = 0;
  for (const probability of [probabilities.left, probabilities.tie, probabilities.right]) {
    if (probability > 0) entropy -= probability * Math.log(probability);
  }
  return entropy;
}

function dot(a: Float64Array, b: Float64Array) {
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) sum += a[i] * b[i];
  return sum;
}

interface ModelEvaluation {
  objective: number;
  gradient: Float64Array;
  diagonal: Float64Array;
  edgeWeights: Float64Array;
  tieWeights: Float64Array;
  crossWeights: Float64Array;
}

function evaluate(
  parameters: Float64Array,
  prior: Float64Array,
  comparisons: IndexedComparison[],
  priorStrength: number,
): ModelEvaluation {
  const itemCount = prior.length;
  const tieIndex = itemCount;
  const gradient = new Float64Array(parameters.length);
  const diagonal = new Float64Array(parameters.length);
  diagonal.fill(priorStrength, 0, itemCount);
  diagonal[tieIndex] = TIE_LOG_PRIOR_STRENGTH;
  let objective = 0;

  for (let i = 0; i < itemCount; i += 1) {
    const diff = parameters[i] - prior[i];
    objective -= 0.5 * priorStrength * diff * diff;
    gradient[i] -= priorStrength * diff;
  }
  const tiePriorDifference = parameters[tieIndex] - TIE_LOG_PRIOR_MEAN;
  objective -= 0.5 * TIE_LOG_PRIOR_STRENGTH * tiePriorDifference ** 2;
  gradient[tieIndex] -= TIE_LOG_PRIOR_STRENGTH * tiePriorDifference;

  const edgeWeights = new Float64Array(comparisons.length);
  const tieWeights = new Float64Array(comparisons.length);
  const crossWeights = new Float64Array(comparisons.length);
  const tieStrength = Math.exp(parameters[tieIndex]);
  for (let k = 0; k < comparisons.length; k += 1) {
    const comparison = comparisons[k];
    const difference = parameters[comparison.left] - parameters[comparison.right];
    const probabilities = davidsonProbabilities(difference, tieStrength);
    const observedScore = comparison.outcome === "left" ? 1 : comparison.outcome === "right" ? -1 : 0;
    const expectedScore = probabilities.left - probabilities.right;
    const residual = comparison.weight * 0.5 * (observedScore - expectedScore);
    const likelihood = probabilities[comparison.outcome];
    objective += comparison.weight * Math.log(Math.max(1e-300, likelihood));
    gradient[comparison.left] += residual;
    gradient[comparison.right] -= residual;
    gradient[tieIndex] += comparison.weight
      * (Number(comparison.outcome === "tie") - probabilities.tie);

    const edgeWeight = comparison.weight * 0.25
      * (probabilities.left + probabilities.right - expectedScore ** 2);
    const tieWeight = comparison.weight * probabilities.tie * (1 - probabilities.tie);
    const crossWeight = comparison.weight * -0.5 * expectedScore * probabilities.tie;
    edgeWeights[k] = Math.max(0, edgeWeight);
    tieWeights[k] = Math.max(0, tieWeight);
    crossWeights[k] = crossWeight;
    diagonal[comparison.left] += edgeWeights[k];
    diagonal[comparison.right] += edgeWeights[k];
    diagonal[tieIndex] += tieWeights[k];
  }
  return { objective, gradient, diagonal, edgeWeights, tieWeights, crossWeights };
}

function hessianProduct(
  vector: Float64Array,
  comparisons: IndexedComparison[],
  evaluation: Pick<ModelEvaluation, "edgeWeights" | "tieWeights" | "crossWeights">,
  priorStrength: number,
) {
  const output = new Float64Array(vector.length);
  const tieIndex = vector.length - 1;
  for (let i = 0; i < tieIndex; i += 1) output[i] = priorStrength * vector[i];
  output[tieIndex] = TIE_LOG_PRIOR_STRENGTH * vector[tieIndex];
  for (let k = 0; k < comparisons.length; k += 1) {
    const { left, right } = comparisons[k];
    const difference = vector[left] - vector[right];
    const weightedDifference = evaluation.edgeWeights[k] * difference
      + evaluation.crossWeights[k] * vector[tieIndex];
    output[left] += weightedDifference;
    output[right] -= weightedDifference;
    output[tieIndex] += evaluation.tieWeights[k] * vector[tieIndex]
      + evaluation.crossWeights[k] * difference;
  }
  return output;
}

function solvePcg(
  rightHandSide: Float64Array,
  diagonal: Float64Array,
  comparisons: IndexedComparison[],
  evaluation: Pick<ModelEvaluation, "edgeWeights" | "tieWeights" | "crossWeights">,
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
    const product = hessianProduct(direction, comparisons, evaluation, priorStrength);
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
  parameters: Float64Array,
  comparisons: IndexedComparison[],
  evaluation: ModelEvaluation,
  priorStrength: number,
  sampleCount: number,
  seed: number,
) {
  const samples: Float64Array[] = [];
  const tieLogSamples = new Float64Array(sampleCount);
  const random = seededRandom(seed);
  const normal = normalGenerator(random);
  const priorNoiseScale = Math.sqrt(priorStrength);
  const tieIndex = parameters.length - 1;
  for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
    const noise = new Float64Array(parameters.length);
    for (let i = 0; i < tieIndex; i += 1) noise[i] = priorNoiseScale * normal();
    noise[tieIndex] = Math.sqrt(TIE_LOG_PRIOR_STRENGTH) * normal();
    for (let k = 0; k < comparisons.length; k += 1) {
      const edgeScale = Math.sqrt(Math.max(0, evaluation.edgeWeights[k]));
      const firstNormal = normal();
      const edgeNoise = edgeScale * firstNormal;
      const correlatedTieNoise = edgeScale > 0
        ? evaluation.crossWeights[k] / edgeScale * firstNormal
        : 0;
      const residualTieVariance = Math.max(
        0,
        evaluation.tieWeights[k]
          - evaluation.crossWeights[k] ** 2 / Math.max(evaluation.edgeWeights[k], 1e-30),
      );
      noise[comparisons[k].left] += edgeNoise;
      noise[comparisons[k].right] -= edgeNoise;
      noise[tieIndex] += correlatedTieNoise + Math.sqrt(residualTieVariance) * normal();
    }
    const delta = solvePcg(
      noise,
      evaluation.diagonal,
      comparisons,
      evaluation,
      priorStrength,
      POSTERIOR_PCG_TOLERANCE,
      100,
    );
    const sample = new Float64Array(tieIndex);
    for (let i = 0; i < tieIndex; i += 1) sample[i] = parameters[i] + delta[i];
    samples.push(sample);
    tieLogSamples[sampleIndex] = parameters[tieIndex] + delta[tieIndex];
  }
  recenterSamples(samples, parameters.subarray(0, tieIndex));
  recenterScalarSamples(tieLogSamples, parameters[tieIndex]);
  return { samples, tieLogSamples };
}

/** Shift only the ensemble mean, preserving every centered sample and covariance. */
export function recenterSamples(samples: Float64Array[], target: Float64Array) {
  if (samples.length === 0) return samples;
  for (let itemIndex = 0; itemIndex < target.length; itemIndex += 1) {
    let mean = 0;
    for (const sample of samples) mean += sample[itemIndex] ?? 0;
    mean /= samples.length;
    const shift = target[itemIndex] - mean;
    for (const sample of samples) sample[itemIndex] += shift;
  }
  return samples;
}

/** Shift a scalar ensemble mean while preserving its variance and covariances. */
function recenterScalarSamples(samples: Float64Array, target: number) {
  if (samples.length === 0) return samples;
  let mean = 0;
  for (const sample of samples) mean += sample;
  const shift = target - mean / samples.length;
  for (let index = 0; index < samples.length; index += 1) samples[index] += shift;
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
      iterations: 0, acceptedComparisons: 0, effectiveComparisons: 0,
      tieStrength: DEFAULT_TIE_STRENGTH, optimizationStatus: "converged", posteriorSamples: [],
      tieLogSamples: new Float64Array(),
      priorStrength: Math.max(1e-6, options.priorStrength ?? DEFAULT_PRIOR_STRENGTH),
      priorScale: Math.max(0, options.priorScale ?? DEFAULT_PRIOR_SCALE),
      posteriorRandomSeed: options.randomSeed ?? 0x5eed1234,
    };
  }
  const indexById = new Map(items.map((item, index) => [item.subjectId, index]));
  const comparisons: IndexedComparison[] = [];
  for (const comparison of comparisonsInput) {
    const left = indexById.get(comparison.leftSubjectId);
    const right = indexById.get(comparison.rightSubjectId);
    if (left === undefined || right === undefined || left === right) continue;
    const weight = comparison.weight ?? 1;
    if (!Number.isFinite(weight) || weight <= 0) continue;
    comparisons.push({ left, right, outcome: comparison.outcome, weight });
  }

  const priorStrength = Math.max(1e-6, options.priorStrength ?? DEFAULT_PRIOR_STRENGTH);
  const priorScale = Math.max(0, options.priorScale ?? DEFAULT_PRIOR_SCALE);
  const prior = new Float64Array(items.map((item) => priorScale * (item.rate - 5.5)));
  let parameters = new Float64Array(items.length + 1);
  items.forEach((item, index) => {
    const previous = previousAbilities?.[item.subjectId];
    parameters[index] = previous !== undefined && Number.isFinite(previous) ? previous : prior[index];
  });
  parameters[items.length] = TIE_LOG_PRIOR_MEAN;
  let converged = false;
  let iterations = 0;
  let optimizationStatus: OptimizationStatus = "iteration-limit";
  const maxIterations = Math.max(0, Math.round(options.maxIterations ?? MAX_OUTER));

  for (iterations = 0; iterations < maxIterations; iterations += 1) {
    const current = evaluate(parameters, prior, comparisons, priorStrength);
    let gradientInfinityNorm = 0;
    for (const value of current.gradient) gradientInfinityNorm = Math.max(gradientInfinityNorm, Math.abs(value));
    if (!Number.isFinite(current.objective) || !Number.isFinite(gradientInfinityNorm)) {
      optimizationStatus = "non-finite";
      break;
    }
    if (gradientInfinityNorm < GRADIENT_TOLERANCE) {
      converged = true;
      optimizationStatus = "converged";
      break;
    }
    let step = solvePcg(current.gradient, current.diagonal, comparisons, current, priorStrength);
    let directionalDerivative = dot(current.gradient, step);
    if (!Number.isFinite(directionalDerivative) || directionalDerivative <= 0) {
      step = new Float64Array(step.length);
      for (let i = 0; i < step.length; i += 1) step[i] = current.gradient[i] / current.diagonal[i];
      directionalDerivative = dot(current.gradient, step);
    }
    let scale = 1;
    let accepted = false;
    for (let lineIteration = 0; lineIteration < 20; lineIteration += 1) {
      const candidate = new Float64Array(parameters.length);
      for (let i = 0; i < parameters.length; i += 1) candidate[i] = parameters[i] + scale * step[i];
      const candidateObjective = evaluate(candidate, prior, comparisons, priorStrength).objective;
      if (Number.isFinite(candidateObjective) && candidateObjective >= current.objective + 1e-4 * scale * directionalDerivative) {
        parameters = candidate;
        accepted = true;
        break;
      }
      scale *= 0.5;
    }
    if (!accepted) {
      optimizationStatus = "line-search-failed";
      break;
    }
  }

  const finalEvaluation = evaluate(parameters, prior, comparisons, priorStrength);
  let finalGradientInfinityNorm = 0;
  for (const value of finalEvaluation.gradient) {
    finalGradientInfinityNorm = Math.max(finalGradientInfinityNorm, Math.abs(value));
  }
  if (Number.isFinite(finalEvaluation.objective)
    && Number.isFinite(finalGradientInfinityNorm)
    && finalGradientInfinityNorm < GRADIENT_TOLERANCE) {
    converged = true;
    optimizationStatus = "converged";
  } else if (!Number.isFinite(finalEvaluation.objective) || !Number.isFinite(finalGradientInfinityNorm)) {
    optimizationStatus = "non-finite";
  }
  const sampleCount = Math.max(8, Math.round(options.posteriorSampleCount ?? DEFAULT_POSTERIOR_SAMPLES));
  const posterior = sampleLaplacePosterior(
    parameters,
    comparisons,
    finalEvaluation,
    priorStrength,
    sampleCount,
    options.randomSeed ?? 0x5eed1234,
  );
  const posteriorSamples = posterior.samples;
  const abilities: Record<number, number> = {};
  const uncertainty: Record<number, number> = {};
  let meanUncertainty = 0;
  items.forEach((item, index) => {
    if (!Number.isFinite(parameters[index])) throw new Error("模型计算产生了无效数值。");
    abilities[item.subjectId] = parameters[index];
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
  const tieStrength = Math.exp(parameters[items.length]);
  if (!Number.isFinite(tieStrength)) throw new Error("平局参数计算产生了无效数值。");
  return {
    abilities,
    uncertainty,
    meanUncertainty,
    converged,
    iterations,
    acceptedComparisons: comparisons.length,
    effectiveComparisons: comparisons.reduce((sum, comparison) => sum + comparison.weight, 0),
    tieStrength,
    optimizationStatus,
    posteriorSamples,
    tieLogSamples: posterior.tieLogSamples,
    priorStrength,
    priorScale,
    posteriorRandomSeed: options.randomSeed ?? 0x5eed1234,
  };
}

function pairKey(a: number, b: number) { return a < b ? `${a}:${b}` : `${b}:${a}`; }

export interface PairOutcomeMass {
  lowerWin: number;
  tie: number;
  higherWin: number;
}

export type CanonicalPairOutcome = keyof PairOutcomeMass;

function canonicalPairOutcome(
  leftSubjectId: number,
  rightSubjectId: number,
  outcome: "left" | "tie" | "right",
): CanonicalPairOutcome {
  if (outcome === "tie") return "tie";
  const winner = outcome === "left" ? leftSubjectId : rightSubjectId;
  return winner === Math.min(leftSubjectId, rightSubjectId) ? "lowerWin" : "higherWin";
}

export interface RankingEvidenceSummary {
  comparisons: RankingComparisonInput[];
  rawEvidenceCount: number;
  evidenceCount: number;
  uniquePairCount: number;
  coveredItemCount: number;
  /** Sum of source-age-decayed observations before the pair design effect. */
  pairMass: Record<string, number>;
  /** Source-age-decayed outcome masses in canonical subject-ID orientation. */
  pairOutcomeMass: Record<string, PairOutcomeMass>;
  pairEffectiveWeight: Record<string, number>;
  itemEffectiveWeight: Record<number, number>;
}

function sourceAgeWeight(entry: RankingHistoryInput) {
  if (!entry.sourceCreatedAt) return 1;
  const sourceTime = Date.parse(entry.sourceCreatedAt);
  const copiedTime = Date.parse(entry.createdAt);
  if (!Number.isFinite(sourceTime) || !Number.isFinite(copiedTime) || copiedTime <= sourceTime) return 1;
  const ageDays = (copiedTime - sourceTime) / MILLISECONDS_PER_DAY;
  return 2 ** (-ageDays / SOURCE_AGE_HALF_LIFE_DAYS);
}

/**
 * Turn accepted history into fractional-likelihood observations.  Every
 * calibration answer is ordinary preference evidence, but all answers about
 * the same unordered pair share one correlation-adjusted cluster.
 */
export function summarizeRankingEvidence(
  history: RankingHistoryInput[],
  sessionId?: string,
): RankingEvidenceSummary {
  const accepted = history.filter((entry) =>
    entry.outcome !== "skip" && (sessionId === undefined || entry.sessionId === sessionId));
  const clusters = new Map<string, Array<{ entry: RankingHistoryInput; baseWeight: number }>>();
  for (const entry of accepted) {
    const key = pairKey(entry.leftSubjectId, entry.rightSubjectId);
    const cluster = clusters.get(key) ?? [];
    cluster.push({ entry, baseWeight: sourceAgeWeight(entry) });
    clusters.set(key, cluster);
  }

  const comparisons: RankingComparisonInput[] = [];
  const pairMass: Record<string, number> = {};
  const pairOutcomeMass: Record<string, PairOutcomeMass> = {};
  const pairEffectiveWeight: Record<string, number> = {};
  const itemEffectiveWeight: Record<number, number> = {};
  let evidenceCount = 0;
  let uniquePairCount = 0;
  for (const [key, cluster] of clusters) {
    const mass = cluster.reduce((sum, observation) => sum + observation.baseWeight, 0);
    const effectiveWeight = repeatedPairEffectiveSampleSize(mass);
    const multiplier = mass > 0 ? effectiveWeight / mass : 0;
    pairMass[key] = mass;
    const outcomeMass: PairOutcomeMass = { lowerWin: 0, tie: 0, higherWin: 0 };
    for (const { entry, baseWeight } of cluster) {
      const outcome = canonicalPairOutcome(
        entry.leftSubjectId,
        entry.rightSubjectId,
        entry.outcome as "left" | "tie" | "right",
      );
      outcomeMass[outcome] += baseWeight;
    }
    pairOutcomeMass[key] = outcomeMass;
    pairEffectiveWeight[key] = effectiveWeight;
    evidenceCount += effectiveWeight;
    if (effectiveWeight >= MINIMUM_COVERAGE_WEIGHT) uniquePairCount += 1;
    const first = cluster[0].entry;
    itemEffectiveWeight[first.leftSubjectId] = (itemEffectiveWeight[first.leftSubjectId] ?? 0) + effectiveWeight;
    itemEffectiveWeight[first.rightSubjectId] = (itemEffectiveWeight[first.rightSubjectId] ?? 0) + effectiveWeight;
    for (const { entry, baseWeight } of cluster) {
      comparisons.push({
        leftSubjectId: entry.leftSubjectId,
        rightSubjectId: entry.rightSubjectId,
        outcome: entry.outcome as "left" | "tie" | "right",
        weight: baseWeight * multiplier,
      });
    }
  }
  const coveredItemCount = Object.values(itemEffectiveWeight)
    .filter((weight) => weight >= MINIMUM_COVERAGE_WEIGHT).length;
  return {
    comparisons,
    rawEvidenceCount: accepted.length,
    evidenceCount,
    uniquePairCount,
    coveredItemCount,
    pairMass,
    pairOutcomeMass,
    pairEffectiveWeight,
    itemEffectiveWeight,
  };
}

interface ForecastEvidenceObservation {
  leftSubjectId: number;
  rightSubjectId: number;
  outcome: "left" | "tie" | "right";
  baseWeight: number;
}

interface ForecastEvidenceCache {
  sessionId: string;
  clusters: Map<string, ForecastEvidenceObservation[]>;
  comparisons?: RankingComparisonInput[];
}

function createForecastEvidenceCache(
  history: RankingHistoryInput[],
  sessionId: string,
): ForecastEvidenceCache {
  const cache: ForecastEvidenceCache = { sessionId, clusters: new Map() };
  for (const entry of history) appendForecastEvidence(cache, entry);
  return cache;
}

function appendForecastEvidence(cache: ForecastEvidenceCache, entry: RankingHistoryInput) {
  if (entry.sessionId !== cache.sessionId || entry.outcome === "skip") return;
  const key = pairKey(entry.leftSubjectId, entry.rightSubjectId);
  const cluster = cache.clusters.get(key) ?? [];
  cluster.push({
    leftSubjectId: entry.leftSubjectId,
    rightSubjectId: entry.rightSubjectId,
    outcome: entry.outcome,
    baseWeight: sourceAgeWeight(entry),
  });
  cache.clusters.set(key, cluster);
  cache.comparisons = undefined;
}

function forecastEvidenceComparisons(cache: ForecastEvidenceCache) {
  if (cache.comparisons) return cache.comparisons;
  const comparisons: RankingComparisonInput[] = [];
  for (const cluster of cache.clusters.values()) {
    const mass = cluster.reduce((sum, observation) => sum + observation.baseWeight, 0);
    const multiplier = mass > 0 ? repeatedPairEffectiveSampleSize(mass) / mass : 0;
    for (const observation of cluster) {
      comparisons.push({
        leftSubjectId: observation.leftSubjectId,
        rightSubjectId: observation.rightSubjectId,
        outcome: observation.outcome,
        weight: observation.baseWeight * multiplier,
      });
    }
  }
  cache.comparisons = comparisons;
  return comparisons;
}

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
    (abilities[b.subjectId] ?? 0) - (abilities[a.subjectId] ?? 0) || a.subjectId - b.subjectId,
  );
}

function orderBySample(items: RankingItemInput[], sample: Float64Array) {
  const indices = items.map((_, index) => index);
  indices.sort((a, b) =>
    sample[b] - sample[a] || items[a].subjectId - items[b].subjectId,
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
  coverageTargetStableSamplesByMode: Record<ComparisonBudgetMode, number>;
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
  const coverageTargetStableSamplesByMode = Object.fromEntries(
    STOPPING_MODE_ORDER.map((mode) => {
      const allowed = allowedCrossTwoBucketCount(items.length, stoppingCoverageTarget(mode));
      return [mode, crossTwoBucketCounts.filter((count) => count <= allowed).length];
    }),
  ) as Record<ComparisonBudgetMode, number>;
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
    coverageTargetStableSamplesByMode,
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

function decisionRiskRatio(stoppingEventStability: number, probabilityTarget = STOPPING_PROBABILITY_TARGET) {
  return (1 - stoppingEventStability) / Math.max(1e-12, 1 - probabilityTarget);
}

function buildStoppingChecks(
  itemCount: number,
  sampleCount: number,
  stableSamplesByMode: Record<ComparisonBudgetMode, number>,
  evidence: Pick<RankingEvidenceSummary, "evidenceCount" | "uniquePairCount" | "coveredItemCount">,
  evidenceRequired: number,
  optimizerConverged: boolean,
): NonNullable<RankingDiagnostics["stoppingChecks"]> {
  return STOPPING_MODE_ORDER.map((mode) => {
    const target = stoppingCoverageTarget(mode);
    const stableSamples = stableSamplesByMode[mode];
    const interval = sampleCount > 0
      ? wilsonInterval(stableSamples, sampleCount)
      : itemCount === 0 ? { low: 1, high: 1 } : { low: 0, high: 1 };
    const uniquePairRequired = minimumUniquePairs(itemCount);
    const coveredItemRequired = minimumCoveredItems(itemCount, mode);
    const evidenceSatisfied = evidence.evidenceCount + 1e-12 >= evidenceRequired;
    const uniquePairsSatisfied = evidence.uniquePairCount >= uniquePairRequired;
    const itemCoverageSatisfied = evidence.coveredItemCount >= coveredItemRequired;
    return {
      mode,
      target,
      probabilityTarget: STOPPING_PROBABILITY_TARGET,
      requiredAdjacentStableItemCount: requiredAdjacentStableItemCount(itemCount, target),
      allowedCrossTwoBucketCount: allowedCrossTwoBucketCount(itemCount, target),
      uniquePairRequired,
      coveredItemRequired,
      evidenceSatisfied,
      uniquePairsSatisfied,
      itemCoverageSatisfied,
      optimizerSatisfied: optimizerConverged,
      sampleCount,
      stableSamples,
      probability: sampleCount > 0 ? stableSamples / sampleCount : 1,
      low: interval.low,
      high: interval.high,
      ready: evidenceSatisfied
        && uniquePairsSatisfied
        && itemCoverageSatisfied
        && optimizerConverged
        && interval.low >= STOPPING_PROBABILITY_TARGET,
    };
  });
}

export function analyzeRanking(
  items: RankingItemInput[],
  fit: FitResult,
  distribution: DistributionConfig,
  history: RankingHistoryInput[],
  sessionId: string,
  stoppingModeOrLegacyTarget: ComparisonBudgetMode | number = "standard",
): RankingDiagnostics {
  // A numeric sixth argument was accepted by pre-v10 callers as the active
  // probability threshold. Coverage targets are now mode-specific, so retain
  // that call shape by selecting the standard mode rather than changing the
  // new semantics based on an arbitrary number.
  const stoppingMode = typeof stoppingModeOrLegacyTarget === "string"
    ? stoppingModeOrLegacyTarget
    : "standard";
  const evidence = summarizeRankingEvidence(history, sessionId);
  const evidenceRequired = minimumEvidence(items.length);
  if (items.length === 0 || fit.posteriorSamples.length === 0) {
    const calibration = calibrationDiagnostics(history);
    const stoppingChecks = buildStoppingChecks(items.length, 0, {
      quick: 0, standard: 0, thorough: 0,
    }, evidence, evidenceRequired, fit.converged);
    const activeCheck = stoppingChecks.find((check) => check.mode === stoppingMode)!;
    return {
      method: "laplace-mc-v6", sampleCount: 0, bucketStability: {}, adjacentBucketStabilityByItem: {},
      jointBucketStability: items.length === 0 ? 1 : 0, jointBucketStableSamples: 0,
      jointBucketStabilityLow: items.length === 0 ? 1 : 0, jointBucketStabilityHigh: 1,
      adjacentBucketStability: items.length === 0 ? 1 : 0, adjacentBucketStableSamples: 0,
      adjacentBucketStabilityLow: items.length === 0 ? 1 : 0, adjacentBucketStabilityHigh: 1,
      coverageTargetStability: items.length === 0 ? 1 : 0, coverageTargetStableSamples: 0,
      coverageTargetStabilityLow: items.length === 0 ? 1 : 0, coverageTargetStabilityHigh: 1,
      requiredAdjacentStableItemCount: requiredAdjacentStableItemCount(items.length),
      allowedCrossTwoBucketCount: allowedCrossTwoBucketCount(items.length),
      expectedCrossTwoBucketCount: 0,
      crossTwoBucketCountMedian: 0, crossTwoBucketCountLow: 0, crossTwoBucketCountHigh: 0,
      maxBucketDisplacementMedian: 0, maxBucketDisplacementHigh: 0,
      expectedBucketChangeRate: 0, minBucketStability: 1,
      decisionRiskRatio: decisionRiskRatio(activeCheck.low),
      evidenceCount: evidence.evidenceCount,
      rawEvidenceCount: evidence.rawEvidenceCount,
      uniquePairCount: evidence.uniquePairCount,
      uniquePairRequired: minimumUniquePairs(items.length),
      coveredItemCount: evidence.coveredItemCount,
      itemCoverageWeightRequired: MINIMUM_COVERAGE_WEIGHT,
      repeatedPairCorrelation: REPEATED_PAIR_CORRELATION,
      sourceAgeHalfLifeDays: SOURCE_AGE_HALF_LIFE_DAYS,
      tieStrength: fit.tieStrength,
      optimizerConverged: fit.converged,
      optimizationStatus: fit.optimizationStatus,
      evidenceRequired,
      ready: activeCheck.ready, stoppingChecks, stoppingBottleneckMode: stoppingMode, calibration,
    };
  }
  const mapOrder = orderByAbilities(items, fit.abilities);
  const mapRates = mappedRates(mapOrder, distribution);
  const assignment = assignmentMetrics(items, mapRates, fit.posteriorSamples, distribution);
  const { coverageTargetStableSamplesByMode, ...metrics } = assignment;
  const jointInterval = wilsonInterval(metrics.jointBucketStableSamples, fit.posteriorSamples.length);
  const adjacentInterval = wilsonInterval(metrics.adjacentBucketStableSamples, fit.posteriorSamples.length);
  const coverageTargetInterval = wilsonInterval(metrics.coverageTargetStableSamples, fit.posteriorSamples.length);
  const calibration = calibrationDiagnostics(history);
  const stoppingChecks = buildStoppingChecks(
    items.length,
    fit.posteriorSamples.length,
    coverageTargetStableSamplesByMode,
    evidence,
    evidenceRequired,
    fit.converged,
  );
  const activeCheck = stoppingChecks.find((check) => check.mode === stoppingMode)!;
  return {
    method: "laplace-mc-v6",
    sampleCount: fit.posteriorSamples.length,
    ...metrics,
    jointBucketStabilityLow: jointInterval.low,
    jointBucketStabilityHigh: jointInterval.high,
    adjacentBucketStabilityLow: adjacentInterval.low,
    adjacentBucketStabilityHigh: adjacentInterval.high,
    coverageTargetStabilityLow: coverageTargetInterval.low,
    coverageTargetStabilityHigh: coverageTargetInterval.high,
    decisionRiskRatio: decisionRiskRatio(activeCheck.low),
    evidenceCount: evidence.evidenceCount,
    rawEvidenceCount: evidence.rawEvidenceCount,
    uniquePairCount: evidence.uniquePairCount,
    uniquePairRequired: minimumUniquePairs(items.length),
    coveredItemCount: evidence.coveredItemCount,
    itemCoverageWeightRequired: MINIMUM_COVERAGE_WEIGHT,
    repeatedPairCorrelation: REPEATED_PAIR_CORRELATION,
    sourceAgeHalfLifeDays: SOURCE_AGE_HALF_LIFE_DAYS,
    tieStrength: fit.tieStrength,
    optimizerConverged: fit.converged,
    optimizationStatus: fit.optimizationStatus,
    evidenceRequired,
    ready: activeCheck.ready,
    stoppingChecks,
    stoppingBottleneckMode: stoppingMode,
    calibration,
  };
}

function posteriorInformation(
  first: number,
  second: number,
  samples: Float64Array[],
  indexById: Map<number, number>,
  tieStrength: number,
  tieLogSamples?: Float64Array,
  sampleStride = 1,
) {
  if (samples.length === 0) return 0;
  const firstIndex = indexById.get(first);
  const secondIndex = indexById.get(second);
  if (firstIndex === undefined || secondIndex === undefined) return 0;
  const meanProbabilities: DavidsonProbabilities = { left: 0, tie: 0, right: 0 };
  let conditionalEntropy = 0;
  const stride = Math.max(1, Math.round(sampleStride));
  let sampleCount = 0;
  for (let sampleIndex = 0; sampleIndex < samples.length; sampleIndex += stride) {
    const sample = samples[sampleIndex];
    const probabilities = davidsonProbabilities(
      sample[firstIndex] - sample[secondIndex],
      tieLogSamples?.length === samples.length
        ? tieStrengthFromLog(tieLogSamples[sampleIndex])
        : tieStrength,
    );
    meanProbabilities.left += probabilities.left;
    meanProbabilities.tie += probabilities.tie;
    meanProbabilities.right += probabilities.right;
    conditionalEntropy += categoricalEntropy(probabilities);
    sampleCount += 1;
  }
  meanProbabilities.left /= Math.max(1, sampleCount);
  meanProbabilities.tie /= Math.max(1, sampleCount);
  meanProbabilities.right /= Math.max(1, sampleCount);
  conditionalEntropy /= Math.max(1, sampleCount);
  return Math.max(0, categoricalEntropy(meanProbabilities) - conditionalEntropy);
}

function compareCalibrationCandidate(left: RankingHistoryInput, right: RankingHistoryInput) {
  return left.acceptedCountAtAnswer - right.acceptedCountAtAnswer
    || left.createdAt.localeCompare(right.createdAt)
    || left.recordId.localeCompare(right.recordId);
}

function nextCalibrationPair(
  cache: PairSelectionCache,
  version: number,
  randomSeed: number,
): NextPair | undefined {
  if ((cache.currentSessionResponseCount + 1) % 20 !== 0) return undefined;
  let availableCount = 0;
  for (const candidate of cache.calibrationCandidates) {
    if (!cache.calibrationTargetIds.has(candidate.recordId)) availableCount += 1;
  }
  const eligibleCount = Math.max(0, availableCount - 10);
  if (eligibleCount === 0) return undefined;
  let targetOrdinal = hash(`${randomSeed}:${version}:calibration`) % eligibleCount;
  let target: RankingHistoryInput | undefined;
  for (const candidate of cache.calibrationCandidates) {
    if (cache.calibrationTargetIds.has(candidate.recordId)) continue;
    if (targetOrdinal === 0) {
      target = candidate;
      break;
    }
    targetOrdinal -= 1;
  }
  if (!target) return undefined;
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
  fit: FitResult,
  diagnostics: RankingDiagnostics,
  version: number,
  randomSeed: number,
  radius: number,
  cache: PairSelectionCache,
  posteriorSampleStride = 1,
): { first: number; second: number; score: number } | undefined {
  const pairWeights = cache.pairEffectiveWeight;
  const itemWeights = cache.itemEffectiveWeight;
  const indexById = new Map(items.map((item, index) => [item.subjectId, index]));
  const ordered = orderByAbilities(items, fit.abilities);
  const orderedIndex = new Map(ordered.map((item, index) => [item.subjectId, index]));
  const stabilities = diagnostics.adjacentBucketStabilityByItem ?? diagnostics.bucketStability;
  const unstable = items.filter((item) =>
    (stabilities[item.subjectId] ?? 0) < BUCKET_STABILITY_TARGET - 1e-12);
  const firstPool = unstable.length > 0 ? unstable : items;
  const firstCandidates = [...firstPool]
    .sort((left, right) =>
      (itemWeights.get(left.subjectId) ?? 0) - (itemWeights.get(right.subjectId) ?? 0)
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
          cooled: cache.cooled.has(key),
          repeats: pairWeights.get(key) ?? 0,
          secondCount: itemWeights.get(second.subjectId) ?? 0,
          information: posteriorInformation(
            first.subjectId, second.subjectId, fit.posteriorSamples, indexById,
            fit.tieStrength ?? DEFAULT_TIE_STRENGTH, fit.tieLogSamples, posteriorSampleStride,
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
  const selectionCache = options.selectionCache ?? createPairSelectionCache(
    items, history, sessionId, fit.acceptedComparisons,
  );
  const calibration = options.allowCalibration === false
    ? undefined
    : nextCalibrationPair(selectionCache, version, randomSeed);
  if (calibration) return calibration;

  const ordered = orderByAbilities(items, fit.abilities);
  const pairWeights = selectionCache.pairEffectiveWeight;
  const cooled = selectionCache.cooled;
  const nonCalibrationCount = selectionCache.nonCalibrationCount;
  const posteriorSampleStride = Math.max(1, Math.round(options.posteriorSampleStride ?? 1));
  let selected: { first: number; second: number; score: number } | undefined;
  let queryKind: NextPair["queryKind"] = "adaptive";
  const explorationInterval = Math.max(1, Math.round(options.explorationInterval ?? 10));
  if ((nonCalibrationCount + 1) % explorationInterval === 0) {
    const explorationRadius = Math.max(1, Math.round(options.explorationRadius ?? 5));
    const exploration = globalExplorationPair(
      items, fit, diagnostics, version, randomSeed, explorationRadius,
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
          first, second, fit.posteriorSamples, indexById,
          fit.tieStrength ?? DEFAULT_TIE_STRENGTH, fit.tieLogSamples, posteriorSampleStride,
        );
        const score = information / (1 + (pairWeights.get(key) ?? 0));
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

/** @internal Smallest success count whose one-sided Wilson lower bound may stop a path. */
export function minimumForecastStableSamples(sampleCount: number) {
  const trials = Math.max(0, Math.floor(sampleCount));
  for (let successes = 0; successes <= trials; successes += 1) {
    if (wilsonInterval(successes, trials).low >= STOPPING_PROBABILITY_TARGET) return successes;
  }
  return trials + 1;
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
  forecasts: Record<ComparisonBudgetMode, StoppingForecast>;
  stoppingTimesByMode: StoppingTimesByMode;
}

export type StoppingTimesByMode = Record<ComparisonBudgetMode, number[]>;

function forecastRandomSeed(options: StoppingForecastOptions, diagnostics: RankingDiagnostics) {
  return hash(`${options.randomSeed}:${diagnostics.evidenceCount}:coverage-80-90-95-adjacent:forecast`);
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
  /** Joint log(nu) particles, aligned with forecastSamples. */
  forecastTieLogSamples: Float64Array;
  truthSamples: Float64Array[];
  /** Latent log(nu) used to answer each corresponding truth rollout. */
  truthTieLogSamples: Float64Array;
  rolloutSeeds: Uint32Array;
  scoreByRank: Uint8Array;
  acceptedComparisons: number;
  tieStrength: number;
  optimizerConverged: boolean;
  /** The production fit configuration used to rebuild path posteriors. */
  priorStrength: number;
  priorScale: number;
  posteriorRandomSeed: number;
  evidenceRequired: number;
  uniquePairRequired: number;
  pairMass: Record<string, number>;
  pairOutcomeMass: Record<string, PairOutcomeMass>;
  itemEffectiveWeight: Record<number, number>;
  diagnosticStride: number;
  /** Internal safety bound used as the actual finite forecast window. */
  simulationHorizon: number;
  projectionHorizon: number;
  evidenceCount: number;
  stoppingMode: ComparisonBudgetMode;
}

/**
 * The old forecast extrapolated a single scalar contraction curve.  That
 * assumes every future answer is equally informative and, importantly, never
 * chooses or answers a question.  The forecast now runs the same adaptive
 * policy as the product: choose one pair, draw one Davidson response, and
 * update a small posterior ensemble before checking the stopping event again.
 *
 * Response generation and the joint local-Laplace update use the same fitted
 * Davidson likelihood and pair-cluster design effect as the real-data fit.
 */
const FORECAST_MIN_PAIR_VARIANCE = 1e-8;
// Sorting every posterior draw is the dominant cost for large collections.
// A sixteen-answer cadence is frequent enough to adapt exploration and keeps
// the interactive forecast responsive; the public model itself still checks
// the stopping event on every real answer.
const FORECAST_DEFAULT_DIAGNOSTIC_STRIDE = 16;
/** Local path state may screen checks, but only a refreshed posterior may stop. */
const FORECAST_EXACT_REFRESH_TRIGGER = STOPPING_PROBABILITY_TARGET;
const FORECAST_MAX_EXACT_REFRESH_GAP = 128;

function simulatedOutcome(
  difference: number,
  random: () => number,
  tieStrength: number,
): "left" | "tie" | "right" {
  const probabilities = davidsonProbabilities(difference, tieStrength);
  const draw = random();
  if (draw < probabilities.left) return "left";
  if (draw < probabilities.left + probabilities.tie) return "tie";
  return "right";
}

function outcomeLikelihood(
  difference: number,
  outcome: "left" | "tie" | "right",
  tieStrength: number,
) {
  const probabilities = davidsonProbabilities(difference, tieStrength);
  return outcome === "left" ? probabilities.left
    : outcome === "right" ? probabilities.right
      : probabilities.tie;
}

/**
 * Apply an ensemble-transform Kalman-style update to one pairwise direction.
 * The observed difference is transformed first, then that change is
 * propagated through Cov(theta_i, theta_left - theta_right) to every related
 * item.  This mirrors the graph-wide contraction of a Laplace refit without
 * refitting the full model after every simulated answer.
 *
 * @internal Exported so the covariance-propagation invariant can be tested.
 */
export function updateForecastPosterior(
  posteriorSamples: Float64Array[],
  leftIndex: number,
  rightIndex: number,
  outcome: "left" | "tie" | "right",
  tieStrength = DEFAULT_TIE_STRENGTH,
  observationWeight = 1,
) {
  const itemCount = posteriorSamples[0]?.length ?? 0;
  const gains = new Float64Array(itemCount);
  const safeObservationWeight = Math.max(0, observationWeight);
  if (posteriorSamples.length === 0 || itemCount === 0 || safeObservationWeight === 0) return gains;
  const differences = new Float64Array(posteriorSamples.length);
  let mean = 0;
  for (let sampleIndex = 0; sampleIndex < posteriorSamples.length; sampleIndex += 1) {
    const sample = posteriorSamples[sampleIndex];
    const difference = sample[leftIndex] - sample[rightIndex];
    differences[sampleIndex] = difference;
    mean += difference;
  }
  mean /= differences.length;
  let variance = 0;
  for (const difference of differences) variance += (difference - mean) ** 2;
  variance /= Math.max(1, differences.length - 1);

  // Degenerate hand-written/test ensembles cannot be importance-reweighted.
  // Use one ridge-regularized Davidson Newton step in the observed direction.
  if (variance < FORECAST_MIN_PAIR_VARIANCE) {
    const probabilities = davidsonProbabilities(mean, tieStrength);
    const observedScore = outcome === "left" ? 1 : outcome === "right" ? -1 : 0;
    const expectedScore = probabilities.left - probabilities.right;
    const gradient = safeObservationWeight * 0.5 * (observedScore - expectedScore);
    const curvature = safeObservationWeight * 0.25
      * (probabilities.left + probabilities.right - expectedScore ** 2);
    const shift = gradient / (1 + curvature);
    for (const sample of posteriorSamples) {
      sample[leftIndex] += shift / 2;
      sample[rightIndex] -= shift / 2;
    }
    gains[leftIndex] = shift / 2;
    gains[rightIndex] = -shift / 2;
    return gains;
  }

  const logWeights = differences.map((difference) =>
    safeObservationWeight
      * Math.log(Math.max(1e-12, outcomeLikelihood(difference, outcome, tieStrength))));
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

  // Moment-match the exactly importance-weighted one-answer posterior.  The
  // affine ensemble transform preserves graph-wide covariance propagation.
  const nextMean = weightedMean;
  const nextVariance = Math.max(FORECAST_MIN_PAIR_VARIANCE, weightedVariance);
  const scale = Math.sqrt(nextVariance / variance);
  const differenceDeltas = new Float64Array(posteriorSamples.length);
  let covarianceDenominator = 0;
  let meanDifferenceDelta = 0;
  for (let sampleIndex = 0; sampleIndex < posteriorSamples.length; sampleIndex += 1) {
    const centered = differences[sampleIndex] - mean;
    covarianceDenominator += centered * centered;
    const nextDifference = nextMean + scale * centered;
    const delta = nextDifference - differences[sampleIndex];
    differenceDeltas[sampleIndex] = delta;
    meanDifferenceDelta += delta;
  }
  meanDifferenceDelta /= posteriorSamples.length;

  for (let itemIndex = 0; itemIndex < itemCount; itemIndex += 1) {
    let covarianceNumerator = 0;
    for (let sampleIndex = 0; sampleIndex < posteriorSamples.length; sampleIndex += 1) {
      const value = posteriorSamples[sampleIndex][itemIndex];
      covarianceNumerator += value * (differences[sampleIndex] - mean);
    }
    gains[itemIndex] = covarianceNumerator / covarianceDenominator;
  }
  // The direct comparison direction is observed rather than estimated from a
  // noisy cross-covariance, so keep it exact and symmetric.
  gains[leftIndex] = 0.5;
  gains[rightIndex] = -0.5;

  for (let sampleIndex = 0; sampleIndex < posteriorSamples.length; sampleIndex += 1) {
    const sample = posteriorSamples[sampleIndex];
    const delta = differenceDeltas[sampleIndex];
    for (let itemIndex = 0; itemIndex < itemCount; itemIndex += 1) {
      sample[itemIndex] += gains[itemIndex] * delta;
    }
  }
  for (let itemIndex = 0; itemIndex < itemCount; itemIndex += 1) {
    gains[itemIndex] *= meanDifferenceDelta;
  }
  return gains;
}

function pairOutcomeMassTotal(outcomeMass: PairOutcomeMass) {
  return outcomeMass.lowerWin + outcomeMass.tie + outcomeMass.higherWin;
}

/** Fractional log likelihood of one correlation-adjusted unordered-pair cluster. */
function pairClusterLogLikelihood(
  difference: number,
  tieLogStrength: number,
  outcomeMass: PairOutcomeMass,
) {
  const mass = pairOutcomeMassTotal(outcomeMass);
  if (!(mass > 0)) return 0;
  const probabilities = davidsonProbabilities(difference, tieStrengthFromLog(tieLogStrength));
  const multiplier = repeatedPairEffectiveSampleSize(mass) / mass;
  return multiplier * (
    outcomeMass.lowerWin * Math.log(Math.max(1e-300, probabilities.left))
    + outcomeMass.tie * Math.log(Math.max(1e-300, probabilities.tie))
    + outcomeMass.higherWin * Math.log(Math.max(1e-300, probabilities.right))
  );
}

interface PairClusterDerivatives {
  gradient0: number;
  gradient1: number;
  information00: number;
  information01: number;
  information11: number;
}

function pairClusterDerivatives(
  difference: number,
  tieLogStrength: number,
  outcomeMass: PairOutcomeMass,
): PairClusterDerivatives {
  const mass = pairOutcomeMassTotal(outcomeMass);
  if (!(mass > 0)) {
    return {
      gradient0: 0, gradient1: 0,
      information00: 0, information01: 0, information11: 0,
    };
  }
  const probabilities = davidsonProbabilities(difference, tieStrengthFromLog(tieLogStrength));
  const effectiveWeight = repeatedPairEffectiveSampleSize(mass);
  const multiplier = effectiveWeight / mass;
  const expectedDifferenceFeature = 0.5 * (probabilities.left - probabilities.right);
  return {
    gradient0: multiplier * 0.5 * (outcomeMass.lowerWin - outcomeMass.higherWin)
      - effectiveWeight * expectedDifferenceFeature,
    gradient1: multiplier * outcomeMass.tie - effectiveWeight * probabilities.tie,
    information00: effectiveWeight * (
      0.25 * (probabilities.left + probabilities.right) - expectedDifferenceFeature ** 2
    ),
    information01: effectiveWeight * -expectedDifferenceFeature * probabilities.tie,
    information11: effectiveWeight * probabilities.tie * (1 - probabilities.tie),
  };
}

function regularizePositiveDefinite2x2(
  matrix00: number,
  matrix01: number,
  matrix11: number,
  minimumEigenvalue = FORECAST_MIN_PAIR_VARIANCE,
) {
  const discriminant = Math.hypot(matrix00 - matrix11, 2 * matrix01);
  const smallestEigenvalue = 0.5 * (matrix00 + matrix11 - discriminant);
  const diagonalShift = Math.max(0, minimumEigenvalue - smallestEigenvalue);
  return {
    matrix00: matrix00 + diagonalShift,
    matrix01,
    matrix11: matrix11 + diagonalShift,
  };
}

interface Cholesky2x2 {
  lower00: number;
  lower10: number;
  lower11: number;
}

function covarianceCholesky2x2(covariance00: number, covariance01: number, covariance11: number) {
  // The shared ridge makes the transform the identity when the source and
  // target moments are equal, while keeping hand-written degenerate ensembles
  // finite.
  const lower00 = Math.sqrt(Math.max(FORECAST_MIN_PAIR_VARIANCE, covariance00 + FORECAST_MIN_PAIR_VARIANCE));
  const lower10 = covariance01 / lower00;
  const lower11 = Math.sqrt(Math.max(
    FORECAST_MIN_PAIR_VARIANCE,
    covariance11 + FORECAST_MIN_PAIR_VARIANCE - lower10 ** 2,
  ));
  return { lower00, lower10, lower11 } satisfies Cholesky2x2;
}

export interface ForecastClusterPosteriorUpdate {
  abilityMeanShifts: Float64Array;
  tieLogMeanShift: number;
}

interface ForecastClusterPosteriorScratch {
  differences: Float64Array;
  abilityMeans: Float64Array;
  gainDifference: Float64Array;
  gainTieLog: Float64Array;
  abilityMeanShifts: Float64Array;
}

function createForecastClusterPosteriorScratch(
  sampleCount: number,
  itemCount: number,
): ForecastClusterPosteriorScratch {
  return {
    differences: new Float64Array(sampleCount),
    abilityMeans: new Float64Array(itemCount),
    gainDifference: new Float64Array(itemCount),
    gainTieLog: new Float64Array(itemCount),
    abilityMeanShifts: new Float64Array(itemCount),
  };
}

/**
 * Update a joint theta/log(nu) forecast ensemble after adding one answer to an
 * unordered-pair cluster. The local Laplace target replaces the old cluster
 * likelihood with the fully reweighted new cluster likelihood, so a
 * contradictory repeat can also reduce the weight of the earlier answer.
 */
export function updateForecastClusterPosterior(
  posteriorSamples: Float64Array[],
  tieLogSamples: Float64Array,
  lowerIndex: number,
  higherIndex: number,
  previousOutcomeMass: PairOutcomeMass,
  newOutcome: CanonicalPairOutcome,
  scratch?: ForecastClusterPosteriorScratch,
): ForecastClusterPosteriorUpdate {
  const itemCount = posteriorSamples[0]?.length ?? 0;
  const sampleCount = posteriorSamples.length;
  const buffers = scratch
    && scratch.differences.length === sampleCount
    && scratch.abilityMeans.length === itemCount
    ? scratch
    : createForecastClusterPosteriorScratch(sampleCount, itemCount);
  const abilityMeanShifts = buffers.abilityMeanShifts;
  abilityMeanShifts.fill(0);
  if (sampleCount === 0 || itemCount === 0) {
    return { abilityMeanShifts, tieLogMeanShift: 0 };
  }
  if (tieLogSamples.length !== sampleCount) {
    throw new Error("预测中的能力样本与平局参数样本没有对齐。");
  }
  if (lowerIndex < 0 || higherIndex < 0
    || lowerIndex >= itemCount || higherIndex >= itemCount || lowerIndex === higherIndex) {
    throw new Error("预测中的作品对索引无效。");
  }

  const oldOutcomeMass: PairOutcomeMass = {
    lowerWin: Math.max(0, previousOutcomeMass.lowerWin),
    tie: Math.max(0, previousOutcomeMass.tie),
    higherWin: Math.max(0, previousOutcomeMass.higherWin),
  };
  const nextOutcomeMass = { ...oldOutcomeMass };
  nextOutcomeMass[newOutcome] += 1;

  const differences = buffers.differences;
  let differenceMean = 0;
  let tieLogMean = 0;
  for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
    const sample = posteriorSamples[sampleIndex];
    differences[sampleIndex] = sample[lowerIndex] - sample[higherIndex];
    differenceMean += differences[sampleIndex];
    tieLogMean += tieLogSamples[sampleIndex];
  }
  differenceMean /= sampleCount;
  tieLogMean /= sampleCount;
  let covariance00 = 0;
  let covariance01 = 0;
  let covariance11 = 0;
  for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
    const centeredDifference = differences[sampleIndex] - differenceMean;
    const centeredTieLog = tieLogSamples[sampleIndex] - tieLogMean;
    covariance00 += centeredDifference ** 2;
    covariance01 += centeredDifference * centeredTieLog;
    covariance11 += centeredTieLog ** 2;
  }
  covariance00 /= sampleCount;
  covariance01 /= sampleCount;
  covariance11 /= sampleCount;

  // A finite Laplace ensemble is reliable near its centre but its Gaussian
  // tails cannot safely be divided by the old cluster likelihood. Recover the
  // local precision of every other factor by subtracting the old cluster's
  // information, then add the complete new cluster and solve its concave 2-D
  // target. This is the stable local-Laplace form of the same new/old
  // likelihood-ratio update.
  const sourceCovariance = regularizePositiveDefinite2x2(
    covariance00, covariance01, covariance11,
  );
  const sourceDeterminant = sourceCovariance.matrix00 * sourceCovariance.matrix11
    - sourceCovariance.matrix01 ** 2;
  const currentPrecision00 = sourceCovariance.matrix11 / sourceDeterminant;
  const currentPrecision01 = -sourceCovariance.matrix01 / sourceDeterminant;
  const currentPrecision11 = sourceCovariance.matrix00 / sourceDeterminant;
  const oldDerivatives = pairClusterDerivatives(
    differenceMean, tieLogMean, oldOutcomeMass,
  );
  const otherPrecision = regularizePositiveDefinite2x2(
    currentPrecision00 - oldDerivatives.information00,
    currentPrecision01 - oldDerivatives.information01,
    currentPrecision11 - oldDerivatives.information11,
  );
  const otherGradient0 = -oldDerivatives.gradient0;
  const otherGradient1 = -oldDerivatives.gradient1;
  const targetObjective = (difference: number, tieLogStrength: number) => {
    const delta0 = difference - differenceMean;
    const delta1 = tieLogStrength - tieLogMean;
    return otherGradient0 * delta0 + otherGradient1 * delta1
      - 0.5 * (
        otherPrecision.matrix00 * delta0 ** 2
        + 2 * otherPrecision.matrix01 * delta0 * delta1
        + otherPrecision.matrix11 * delta1 ** 2
      )
      + pairClusterLogLikelihood(difference, tieLogStrength, nextOutcomeMass);
  };

  let targetDifferenceMean = differenceMean;
  let targetTieLogMean = tieLogMean;
  for (let iteration = 0; iteration < 24; iteration += 1) {
    const targetDerivatives = pairClusterDerivatives(
      targetDifferenceMean, targetTieLogMean, nextOutcomeMass,
    );
    const delta0 = targetDifferenceMean - differenceMean;
    const delta1 = targetTieLogMean - tieLogMean;
    const gradient0 = otherGradient0
      - otherPrecision.matrix00 * delta0 - otherPrecision.matrix01 * delta1
      + targetDerivatives.gradient0;
    const gradient1 = otherGradient1
      - otherPrecision.matrix01 * delta0 - otherPrecision.matrix11 * delta1
      + targetDerivatives.gradient1;
    const targetPrecision = regularizePositiveDefinite2x2(
      otherPrecision.matrix00 + targetDerivatives.information00,
      otherPrecision.matrix01 + targetDerivatives.information01,
      otherPrecision.matrix11 + targetDerivatives.information11,
    );
    const determinant = targetPrecision.matrix00 * targetPrecision.matrix11
      - targetPrecision.matrix01 ** 2;
    const step0 = (
      targetPrecision.matrix11 * gradient0 - targetPrecision.matrix01 * gradient1
    ) / determinant;
    const step1 = (
      targetPrecision.matrix00 * gradient1 - targetPrecision.matrix01 * gradient0
    ) / determinant;
    if (!Number.isFinite(step0) || !Number.isFinite(step1)) break;
    const directionalDerivative = gradient0 * step0 + gradient1 * step1;
    if (Math.max(Math.abs(step0), Math.abs(step1)) < 1e-8) break;
    const currentObjective = targetObjective(targetDifferenceMean, targetTieLogMean);
    let scale = 1;
    let accepted = false;
    for (let lineIteration = 0; lineIteration < 24; lineIteration += 1) {
      const candidateDifference = targetDifferenceMean + scale * step0;
      const candidateTieLog = targetTieLogMean + scale * step1;
      const candidateObjective = targetObjective(candidateDifference, candidateTieLog);
      if (Number.isFinite(candidateObjective)
        && candidateObjective >= currentObjective + 1e-4 * scale * directionalDerivative) {
        targetDifferenceMean = candidateDifference;
        targetTieLogMean = candidateTieLog;
        accepted = true;
        break;
      }
      scale *= 0.5;
    }
    if (!accepted) break;
  }
  const finalTargetDerivatives = pairClusterDerivatives(
    targetDifferenceMean, targetTieLogMean, nextOutcomeMass,
  );
  const finalTargetPrecision = regularizePositiveDefinite2x2(
    otherPrecision.matrix00 + finalTargetDerivatives.information00,
    otherPrecision.matrix01 + finalTargetDerivatives.information01,
    otherPrecision.matrix11 + finalTargetDerivatives.information11,
  );
  const targetDeterminant = finalTargetPrecision.matrix00 * finalTargetPrecision.matrix11
    - finalTargetPrecision.matrix01 ** 2;
  const targetCovariance00 = finalTargetPrecision.matrix11 / targetDeterminant;
  const targetCovariance01 = -finalTargetPrecision.matrix01 / targetDeterminant;
  const targetCovariance11 = finalTargetPrecision.matrix00 / targetDeterminant;

  // A = L_target L_source^-1, so A C_source A' = C_target.
  const sourceCholesky = covarianceCholesky2x2(covariance00, covariance01, covariance11);
  const targetCholesky = covarianceCholesky2x2(
    targetCovariance00, targetCovariance01, targetCovariance11,
  );
  const transform00 = targetCholesky.lower00 / sourceCholesky.lower00;
  const transform01 = 0;
  const transform11 = targetCholesky.lower11 / sourceCholesky.lower11;
  const transform10 = (
    targetCholesky.lower10 - transform11 * sourceCholesky.lower10
  ) / sourceCholesky.lower00;

  // Regress every ability on the observed two-dimensional subspace, then
  // enforce the exact contrast and zero-global-shift invariants that finite
  // Monte Carlo covariance estimates only satisfy approximately.
  const abilityMeans = buffers.abilityMeans;
  abilityMeans.fill(0);
  for (const sample of posteriorSamples) {
    for (let itemIndex = 0; itemIndex < itemCount; itemIndex += 1) {
      abilityMeans[itemIndex] += sample[itemIndex];
    }
  }
  for (let itemIndex = 0; itemIndex < itemCount; itemIndex += 1) {
    abilityMeans[itemIndex] /= sampleCount;
  }
  const gainDifference = buffers.gainDifference;
  const gainTieLog = buffers.gainTieLog;
  const regularized00 = covariance00 + FORECAST_MIN_PAIR_VARIANCE;
  const regularized11 = covariance11 + FORECAST_MIN_PAIR_VARIANCE;
  const determinant = Math.max(
    FORECAST_MIN_PAIR_VARIANCE ** 2,
    regularized00 * regularized11 - covariance01 ** 2,
  );
  for (let itemIndex = 0; itemIndex < itemCount; itemIndex += 1) {
    let itemCovarianceDifference = 0;
    let itemCovarianceTieLog = 0;
    for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
      const centeredAbility = posteriorSamples[sampleIndex][itemIndex] - abilityMeans[itemIndex];
      itemCovarianceDifference += centeredAbility * (differences[sampleIndex] - differenceMean);
      itemCovarianceTieLog += centeredAbility * (tieLogSamples[sampleIndex] - tieLogMean);
    }
    itemCovarianceDifference /= sampleCount;
    itemCovarianceTieLog /= sampleCount;
    gainDifference[itemIndex] = (
      itemCovarianceDifference * regularized11 - itemCovarianceTieLog * covariance01
    ) / determinant;
    gainTieLog[itemIndex] = (
      itemCovarianceTieLog * regularized00 - itemCovarianceDifference * covariance01
    ) / determinant;
  }
  const enforceGainInvariants = (gains: Float64Array, expectedDifference: number) => {
    const contrastCorrection = expectedDifference - (gains[lowerIndex] - gains[higherIndex]);
    gains[lowerIndex] += contrastCorrection / 2;
    gains[higherIndex] -= contrastCorrection / 2;
    let gainSum = 0;
    for (const gain of gains) gainSum += gain;
    const commonCorrection = gainSum / itemCount;
    for (let itemIndex = 0; itemIndex < itemCount; itemIndex += 1) {
      gains[itemIndex] -= commonCorrection;
    }
  };
  enforceGainInvariants(gainDifference, 1);
  enforceGainInvariants(gainTieLog, 0);

  let actualTieLogMeanShift = 0;
  for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
    const centeredDifference = differences[sampleIndex] - differenceMean;
    const centeredTieLog = tieLogSamples[sampleIndex] - tieLogMean;
    const nextDifference = targetDifferenceMean
      + transform00 * centeredDifference + transform01 * centeredTieLog;
    const nextTieLog = targetTieLogMean
      + transform10 * centeredDifference + transform11 * centeredTieLog;
    const differenceDelta = nextDifference - differences[sampleIndex];
    const tieLogDelta = nextTieLog - tieLogSamples[sampleIndex];
    const sample = posteriorSamples[sampleIndex];
    for (let itemIndex = 0; itemIndex < itemCount; itemIndex += 1) {
      const abilityDelta = gainDifference[itemIndex] * differenceDelta
        + gainTieLog[itemIndex] * tieLogDelta;
      sample[itemIndex] += abilityDelta;
      abilityMeanShifts[itemIndex] += abilityDelta;
    }
    tieLogSamples[sampleIndex] = nextTieLog;
    actualTieLogMeanShift += tieLogDelta;
  }
  for (let itemIndex = 0; itemIndex < itemCount; itemIndex += 1) {
    abilityMeanShifts[itemIndex] /= sampleCount;
  }
  return {
    abilityMeanShifts,
    tieLogMeanShift: actualTieLogMeanShift / sampleCount,
  };
}

function fitFromForecastEnsemble(
  items: RankingItemInput[],
  posteriorSamples: Float64Array[],
  tieLogSamples: Float64Array,
  acceptedComparisons: number,
  effectiveComparisons: number,
  fallbackTieStrength: number,
  optimizerConverged: boolean,
): FitResult {
  const abilities: Record<number, number> = {};
  const uncertainty: Record<number, number> = {};
  if (posteriorSamples.length === 0) {
    for (const item of items) {
      abilities[item.subjectId] = 0;
      uncertainty[item.subjectId] = 0;
    }
    const tieStrength = tieLogSamples.length > 0
      ? tieStrengthFromLog(tieLogSamples.reduce((sum, value) => sum + value, 0) / tieLogSamples.length)
      : fallbackTieStrength;
    return {
      abilities, uncertainty, meanUncertainty: 0, converged: optimizerConverged, iterations: 0,
      acceptedComparisons, effectiveComparisons, tieStrength,
      optimizationStatus: optimizerConverged ? "converged" : "iteration-limit",
      posteriorSamples, tieLogSamples,
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
  const tieStrength = tieLogSamples.length === posteriorSamples.length
    ? tieStrengthFromLog(tieLogSamples.reduce((sum, value) => sum + value, 0) / tieLogSamples.length)
    : fallbackTieStrength;
  return {
    abilities,
    uncertainty,
    meanUncertainty: 0,
    converged: optimizerConverged,
    iterations: 1,
    acceptedComparisons,
    effectiveComparisons,
    tieStrength,
    optimizationStatus: optimizerConverged ? "converged" : "iteration-limit",
    posteriorSamples,
    tieLogSamples,
  };
}

function coverageTargetStableSampleCounts(
  items: RankingItemInput[],
  referenceRates: Uint8Array,
  posteriorSamples: Float64Array[],
  scoreByRank: Uint8Array,
) {
  const allowedCrossCounts = Object.fromEntries(STOPPING_MODE_ORDER.map((mode) => [
    mode,
    allowedCrossTwoBucketCount(items.length, stoppingCoverageTarget(mode)),
  ])) as Record<ComparisonBudgetMode, number>;
  const largestAllowance = Math.max(...Object.values(allowedCrossCounts));
  const stableSamples = Object.fromEntries(STOPPING_MODE_ORDER.map((mode) => [mode, 0])) as Record<ComparisonBudgetMode, number>;
  for (const sample of posteriorSamples) {
    const sampleRates = ratesByItem(items, sample, scoreByRank);
    let crossTwoBucketCount = 0;
    for (let itemIndex = 0; itemIndex < items.length; itemIndex += 1) {
      if (Math.abs(referenceRates[itemIndex] - sampleRates[itemIndex]) > 1) crossTwoBucketCount += 1;
      if (crossTwoBucketCount > largestAllowance) break;
    }
    for (const mode of STOPPING_MODE_ORDER) {
      if (crossTwoBucketCount <= allowedCrossCounts[mode]) stableSamples[mode] += 1;
    }
  }
  return stableSamples;
}

function forecastStoppingEventLows(
  items: RankingItemInput[],
  abilities: Float64Array,
  posteriorSamples: Float64Array[],
  scoreByRank: Uint8Array,
  evidenceCount: number,
  evidenceRequired: number,
  uniquePairCount: number,
  uniquePairRequired: number,
  coveredItemCount: number,
  optimizerConverged: boolean,
) {
  if (evidenceCount + 1e-12 < evidenceRequired
    || uniquePairCount < uniquePairRequired
    || !optimizerConverged
    || posteriorSamples.length === 0) {
    return { quick: 0, standard: 0, thorough: 0 };
  }
  const referenceRates = ratesByItem(items, abilities, scoreByRank);
  const stableSamples = coverageTargetStableSampleCounts(items, referenceRates, posteriorSamples, scoreByRank);
  return Object.fromEntries(STOPPING_MODE_ORDER.map((mode) => [
    mode,
    coveredItemCount >= minimumCoveredItems(items.length, mode)
      ? wilsonInterval(stableSamples[mode], posteriorSamples.length).low
      : 0,
  ])) as Record<ComparisonBudgetMode, number>;
}

/**
 * Exact threshold-only screen. It stops sorting posterior samples as soon as
 * every unresolved mode is guaranteed either to reach or to miss the Wilson
 * threshold. The full posterior refresh remains the only stopping authority.
 */
function forecastScreenCanTriggerExactRefresh(
  items: RankingItemInput[],
  abilities: Float64Array,
  posteriorSamples: Float64Array[],
  scoreByRank: Uint8Array,
  evidenceCount: number,
  evidenceRequired: number,
  uniquePairCount: number,
  uniquePairRequired: number,
  coveredItemCount: number,
  optimizerConverged: boolean,
  stoppingTimes: Record<ComparisonBudgetMode, number>,
) {
  if (evidenceCount + 1e-12 < evidenceRequired
    || uniquePairCount < uniquePairRequired
    || !optimizerConverged
    || posteriorSamples.length === 0) return false;

  const unresolvedModes = new Set(STOPPING_MODE_ORDER.filter((mode) =>
    !Number.isFinite(stoppingTimes[mode])
    && coveredItemCount >= minimumCoveredItems(items.length, mode)));
  if (unresolvedModes.size === 0) return false;

  const requiredStableSamples = minimumForecastStableSamples(posteriorSamples.length);
  if (requiredStableSamples > posteriorSamples.length) return false;
  const allowedCrossCounts = Object.fromEntries(STOPPING_MODE_ORDER.map((mode) => [
    mode,
    allowedCrossTwoBucketCount(items.length, stoppingCoverageTarget(mode)),
  ])) as Record<ComparisonBudgetMode, number>;
  const largestAllowance = Math.max(...[...unresolvedModes].map((mode) => allowedCrossCounts[mode]));
  const stableSamples = Object.fromEntries(STOPPING_MODE_ORDER.map((mode) => [mode, 0])) as Record<ComparisonBudgetMode, number>;
  const referenceRates = ratesByItem(items, abilities, scoreByRank);

  for (let sampleIndex = 0; sampleIndex < posteriorSamples.length; sampleIndex += 1) {
    const sampleRates = ratesByItem(items, posteriorSamples[sampleIndex], scoreByRank);
    let crossTwoBucketCount = 0;
    for (let itemIndex = 0; itemIndex < items.length; itemIndex += 1) {
      if (Math.abs(referenceRates[itemIndex] - sampleRates[itemIndex]) > 1) crossTwoBucketCount += 1;
      if (crossTwoBucketCount > largestAllowance) break;
    }
    const remainingSamples = posteriorSamples.length - sampleIndex - 1;
    for (const mode of [...unresolvedModes]) {
      if (crossTwoBucketCount <= allowedCrossCounts[mode]) stableSamples[mode] += 1;
      if (stableSamples[mode] >= requiredStableSamples) return true;
      if (stableSamples[mode] + remainingSamples < requiredStableSamples) unresolvedModes.delete(mode);
    }
    if (unresolvedModes.size === 0) return false;
  }
  return false;
}

/** @internal Pure refresh policy used by tests and the rollout loop. */
export function shouldRefreshForecastPosterior(
  stoppingEventLows: Record<ComparisonBudgetMode, number>,
  stoppingTimes: Record<ComparisonBudgetMode, number>,
  answersSinceRefresh: number,
) {
  if (answersSinceRefresh >= FORECAST_MAX_EXACT_REFRESH_GAP) return true;
  return STOPPING_MODE_ORDER.some((mode) =>
    !Number.isFinite(stoppingTimes[mode])
    && stoppingEventLows[mode] >= FORECAST_EXACT_REFRESH_TRIGGER);
}

/** @internal Pure stopping-check cadence, including a non-stride window endpoint. */
export function shouldCheckForecastStopping(
  answerIndex: number,
  stoppingCheckStride: number,
  simulationHorizon: number,
  evidenceCount: number,
  evidenceRequired: number,
) {
  return answerIndex === simulationHorizon
    || answerIndex <= Math.min(4, stoppingCheckStride)
    || answerIndex % stoppingCheckStride === 0
    || evidenceCount === evidenceRequired;
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
    calibrationOfComparisonId: pair.calibrationOfComparisonId,
    createdAt: new Date(answerIndex * 1000).toISOString(),
  };
}

function createPairSelectionCache(
  items: RankingItemInput[],
  history: RankingHistoryInput[],
  sessionId: string,
  acceptedComparisons: number,
  evidence: Pick<RankingEvidenceSummary, "pairMass" | "itemEffectiveWeight">
    = summarizeRankingEvidence(history, sessionId),
): PairSelectionCache {
  const pairMass = new Map(Object.entries(evidence.pairMass));
  const pairEffectiveWeight = new Map(
    [...pairMass].map(([key, mass]) => [key, repeatedPairEffectiveSampleSize(mass)]),
  );
  const itemEffectiveWeight = new Map(items.map((item) => [item.subjectId, 0]));
  for (const [subjectId, weight] of Object.entries(evidence.itemEffectiveWeight)) {
    itemEffectiveWeight.set(Number(subjectId), weight);
  }
  const cooled = new Set<string>();
  let nonCalibrationCount = 0;
  let currentSessionResponseCount = 0;
  const calibrationTargetIds = new Set(
    history.map((entry) => entry.calibrationOfComparisonId).filter((value): value is string => Boolean(value)),
  );
  const calibrationCandidates = history
    .filter((entry) => entry.outcome !== "skip" && entry.queryKind !== "calibration")
    .sort(compareCalibrationCandidate);
  for (const entry of history) {
    if (entry.sessionId !== sessionId) continue;
    currentSessionResponseCount += 1;
    if (entry.outcome === "skip") {
      if (acceptedComparisons - entry.acceptedCountAtAnswer < 20) {
        cooled.add(pairKey(entry.leftSubjectId, entry.rightSubjectId));
      }
      continue;
    }
    if (entry.queryKind !== "calibration") nonCalibrationCount += 1;
  }
  return {
    sessionId,
    pairMass,
    pairEffectiveWeight,
    itemEffectiveWeight,
    cooled,
    nonCalibrationCount,
    currentSessionResponseCount,
    calibrationTargetIds,
    calibrationCandidates,
  };
}

function appendPairSelectionHistory(cache: PairSelectionCache, entry: RankingHistoryInput) {
  if (entry.sessionId === cache.sessionId) cache.currentSessionResponseCount += 1;
  if (entry.calibrationOfComparisonId) cache.calibrationTargetIds.add(entry.calibrationOfComparisonId);
  if (entry.outcome !== "skip" && entry.queryKind !== "calibration") {
    const last = cache.calibrationCandidates.at(-1);
    if (!last || compareCalibrationCandidate(last, entry) <= 0) {
      cache.calibrationCandidates.push(entry);
    } else {
      let low = 0;
      let high = cache.calibrationCandidates.length;
      while (low < high) {
        const middle = Math.floor((low + high) / 2);
        if (compareCalibrationCandidate(cache.calibrationCandidates[middle], entry) <= 0) low = middle + 1;
        else high = middle;
      }
      cache.calibrationCandidates.splice(low, 0, entry);
    }
    if (entry.sessionId === cache.sessionId) cache.nonCalibrationCount += 1;
  }
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

export interface ForecastPosteriorCheckpoint {
  fit: FitResult;
  evidence: RankingEvidenceSummary;
}

function fitForecastPosteriorAtCheckpoint(
  input: StoppingForecastRolloutInput,
  comparisons: RankingComparisonInput[],
  previousAbilities: Record<number, number>,
  rolloutSeed: number,
  answerIndex: number,
) {
  return fitModel(input.items, comparisons, previousAbilities, {
    priorStrength: input.priorStrength,
    priorScale: input.priorScale,
    posteriorSampleCount: Math.max(8, input.forecastSamples.length),
    randomSeed: hash([
      input.posteriorRandomSeed,
      rolloutSeed,
      answerIndex,
      "exact-forecast-checkpoint",
    ].join(":")),
  });
}

/**
 * Rebuild a rollout's global MAP and Laplace posterior before evaluating a
 * stopping event. Sequential pairwise moment updates remain useful between
 * checkpoints for question selection, but their covariance approximation is
 * not sufficiently stable to authorize stopping.
 */
export function rebuildForecastPosteriorAtCheckpoint(
  input: StoppingForecastRolloutInput,
  history: RankingHistoryInput[],
  previousAbilities: Record<number, number>,
  rolloutSeed: number,
  answerIndex: number,
): ForecastPosteriorCheckpoint {
  const evidence = summarizeRankingEvidence(history, input.sessionId);
  const fit = fitForecastPosteriorAtCheckpoint(
    input, evidence.comparisons, previousAbilities, rolloutSeed, answerIndex,
  );
  return { fit, evidence };
}

function simulateForecastRollout(
  input: StoppingForecastRolloutInput,
  truth: Float64Array,
  truthTieLogStrength: number,
  rolloutSeed: number,
) {
  const random = seededRandom(rolloutSeed);
  let posteriorSamples: Float64Array[] = input.forecastSamples.map((sample) => sample.slice());
  let tieLogSamples: Float64Array = input.forecastTieLogSamples.slice();
  const posteriorUpdateScratch = createForecastClusterPosteriorScratch(
    posteriorSamples.length,
    input.items.length,
  );
  const indexById = new Map(input.items.map((item, index) => [item.subjectId, index]));
  const history = input.history.slice();
  const forecastEvidence = createForecastEvidenceCache(history, input.sessionId);
  let acceptedComparisons = input.acceptedComparisons;
  const selectionCache = createPairSelectionCache(
    input.items, history, input.sessionId, acceptedComparisons,
    { pairMass: input.pairMass, itemEffectiveWeight: input.itemEffectiveWeight },
  );
  let evidenceCount = input.evidenceCount;
  const pairMass = selectionCache.pairMass;
  const itemEffectiveWeight = selectionCache.itemEffectiveWeight;
  const pairOutcomeMass = new Map(
    Object.entries(input.pairOutcomeMass).map(([key, outcomeMass]) => [key, { ...outcomeMass }]),
  );
  let uniquePairCount = [...pairMass.values()]
    .filter((mass) => repeatedPairEffectiveSampleSize(mass) >= MINIMUM_COVERAGE_WEIGHT).length;
  let coveredItemCount = [...itemEffectiveWeight.values()]
    .filter((weight) => weight >= MINIMUM_COVERAGE_WEIGHT).length;
  let fit = fitFromForecastEnsemble(
    input.items, posteriorSamples, tieLogSamples, acceptedComparisons, evidenceCount,
    input.tieStrength, input.optimizerConverged,
  );
  const abilities = input.currentAbilities.slice();
  input.items.forEach((item, index) => { fit.abilities[item.subjectId] = abilities[index]; });
  let diagnostics = input.initialDiagnostics;
  let optimizerConverged = input.optimizerConverged;
  let answersSinceExactRefresh = 0;
  const diagnosticStride = Math.max(1, Math.round(input.diagnosticStride));
  const stoppingCheckStride = Math.max(8, diagnosticStride);
  const stoppingTimes = Object.fromEntries(STOPPING_MODE_ORDER.map((mode) => [mode, Number.POSITIVE_INFINITY])) as Record<ComparisonBudgetMode, number>;
  if (input.optimizerConverged && evidenceCount >= input.evidenceRequired) {
    for (const mode of STOPPING_MODE_ORDER) {
      if (input.initialDiagnostics.stoppingChecks?.find((check) => check.mode === mode)?.ready) {
        stoppingTimes[mode] = 0;
      }
    }
  }
  if (STOPPING_MODE_ORDER.every((mode) => Number.isFinite(stoppingTimes[mode]))) return stoppingTimes;

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
        selectionCache,
        candidateLimit: input.items.length > 80 ? 96 : (input.selectionOptions.candidateLimit ?? 64),
        posteriorSampleStride: input.items.length > 80 ? 16 : (input.selectionOptions.posteriorSampleStride ?? 4),
      },
    );
    if (!pair) return stoppingTimes;
    const leftIndex = indexById.get(pair.leftSubjectId);
    const rightIndex = indexById.get(pair.rightSubjectId);
    if (leftIndex === undefined || rightIndex === undefined || leftIndex === rightIndex) {
      return stoppingTimes;
    }
    const selectedKey = pairKey(pair.leftSubjectId, pair.rightSubjectId);
    const previousMass = pairMass.get(selectedKey) ?? 0;
    const previousEffectiveWeight = repeatedPairEffectiveSampleSize(previousMass);
    const nextMass = previousMass + 1;
    const nextEffectiveWeight = repeatedPairEffectiveSampleSize(nextMass);
    const effectiveIncrement = nextEffectiveWeight - previousEffectiveWeight;
    const outcome = simulatedOutcome(
      truth[leftIndex] - truth[rightIndex], random, tieStrengthFromLog(truthTieLogStrength),
    );
    const lowerSubjectId = Math.min(pair.leftSubjectId, pair.rightSubjectId);
    const higherSubjectId = Math.max(pair.leftSubjectId, pair.rightSubjectId);
    const lowerIndex = indexById.get(lowerSubjectId);
    const higherIndex = indexById.get(higherSubjectId);
    if (lowerIndex === undefined || higherIndex === undefined) return stoppingTimes;
    const previousOutcomeMass = pairOutcomeMass.get(selectedKey)
      ?? { lowerWin: 0, tie: 0, higherWin: 0 };
    const canonicalOutcome = canonicalPairOutcome(
      pair.leftSubjectId, pair.rightSubjectId, outcome,
    );
    const posteriorUpdate = updateForecastClusterPosterior(
      posteriorSamples,
      tieLogSamples,
      lowerIndex,
      higherIndex,
      previousOutcomeMass,
      canonicalOutcome,
      posteriorUpdateScratch,
    );
    for (let itemIndex = 0; itemIndex < input.items.length; itemIndex += 1) {
      const shift = posteriorUpdate.abilityMeanShifts[itemIndex];
      fit.abilities[input.items[itemIndex].subjectId] += shift;
      abilities[itemIndex] += shift;
    }
    fit.tieStrength = tieStrengthFromLog(
      Math.log(fit.tieStrength ?? input.tieStrength) + posteriorUpdate.tieLogMeanShift,
    );
    acceptedComparisons += 1;
    fit.acceptedComparisons = acceptedComparisons;
    pairMass.set(selectedKey, nextMass);
    const nextOutcomeMass = { ...previousOutcomeMass };
    nextOutcomeMass[canonicalOutcome] += 1;
    pairOutcomeMass.set(selectedKey, nextOutcomeMass);
    selectionCache.pairEffectiveWeight.set(selectedKey, nextEffectiveWeight);
    evidenceCount += effectiveIncrement;
    fit.effectiveComparisons = evidenceCount;
    if (previousEffectiveWeight < MINIMUM_COVERAGE_WEIGHT
      && nextEffectiveWeight >= MINIMUM_COVERAGE_WEIGHT) uniquePairCount += 1;
    for (const subjectId of [pair.leftSubjectId, pair.rightSubjectId]) {
      const previousItemWeight = itemEffectiveWeight.get(subjectId) ?? 0;
      const nextItemWeight = previousItemWeight + effectiveIncrement;
      itemEffectiveWeight.set(subjectId, nextItemWeight);
      if (previousItemWeight < MINIMUM_COVERAGE_WEIGHT
        && nextItemWeight >= MINIMUM_COVERAGE_WEIGHT) coveredItemCount += 1;
    }
    const historyRecord = forecastHistoryRecord(
      input, pair, outcome, acceptedComparisons, rolloutSeed, answerIndex,
    );
    history.push(historyRecord);
    appendPairSelectionHistory(selectionCache, historyRecord);
    appendForecastEvidence(forecastEvidence, historyRecord);
    answersSinceExactRefresh += 1;
    const checkNow = shouldCheckForecastStopping(
      answerIndex,
      stoppingCheckStride,
      input.simulationHorizon,
      evidenceCount,
      input.evidenceRequired,
    );
    if (checkNow) {
      if (answerIndex !== input.simulationHorizon
        && answersSinceExactRefresh < FORECAST_MAX_EXACT_REFRESH_GAP
        && !forecastScreenCanTriggerExactRefresh(
          input.items,
          abilities,
          posteriorSamples,
          input.scoreByRank,
          evidenceCount,
          input.evidenceRequired,
          uniquePairCount,
          input.uniquePairRequired,
          coveredItemCount,
          optimizerConverged,
          stoppingTimes,
        )) continue;
      fit = fitForecastPosteriorAtCheckpoint(
        input,
        forecastEvidenceComparisons(forecastEvidence),
        fit.abilities,
        rolloutSeed,
        answerIndex,
      );
      fit.acceptedComparisons = acceptedComparisons;
      fit.effectiveComparisons = evidenceCount;
      posteriorSamples = fit.posteriorSamples;
      tieLogSamples = fit.tieLogSamples?.length === posteriorSamples.length
        ? fit.tieLogSamples
        : new Float64Array(posteriorSamples.length).fill(
          Math.log(fit.tieStrength ?? input.tieStrength),
        );
      fit.tieLogSamples = tieLogSamples;
      optimizerConverged = fit.converged;
      answersSinceExactRefresh = 0;
      input.items.forEach((item, itemIndex) => {
        abilities[itemIndex] = fit.abilities[item.subjectId] ?? 0;
      });
      const stoppingEventLows = forecastStoppingEventLows(
        input.items,
        abilities,
        posteriorSamples,
        input.scoreByRank,
        evidenceCount,
        input.evidenceRequired,
        uniquePairCount,
        input.uniquePairRequired,
        coveredItemCount,
        optimizerConverged,
      );
      for (const mode of STOPPING_MODE_ORDER) {
        if (!Number.isFinite(stoppingTimes[mode])
          && stoppingEventLows[mode] >= STOPPING_PROBABILITY_TARGET) {
          stoppingTimes[mode] = answerIndex;
        }
      }
      if (STOPPING_MODE_ORDER.every((mode) => Number.isFinite(stoppingTimes[mode]))) return stoppingTimes;
    }
  }
  return stoppingTimes;
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
  const truthTieLogSamples = new Float64Array(rolloutCount);
  const rolloutSeeds = new Uint32Array(rolloutCount);
  const fallbackTieLogStrength = Math.log(fit.tieStrength ?? DEFAULT_TIE_STRENGTH);
  const hasAlignedTieSamples = fit.tieLogSamples?.length === fit.posteriorSamples.length;
  for (let rollout = 0; rollout < rolloutCount && fit.posteriorSamples.length > 0; rollout += 1) {
    const truthSampleIndex = Math.floor(random() * fit.posteriorSamples.length);
    truthSamples.push(fit.posteriorSamples[truthSampleIndex].slice());
    truthTieLogSamples[rollout] = hasAlignedTieSamples
      ? fit.tieLogSamples![truthSampleIndex]
      : fallbackTieLogStrength;
    rolloutSeeds[rollout] = Math.floor(random() * 0x100000000) >>> 0;
  }
  const selectedSampleIndices = Array.from({ length: forecastSampleCount }, (_, index) =>
    Math.floor(index * fit.posteriorSamples.length / forecastSampleCount));
  const selectedSamples = selectedSampleIndices.map((index) => fit.posteriorSamples[index].slice());
  const forecastTieLogSamples = Float64Array.from(selectedSampleIndices, (index) =>
    hasAlignedTieSamples ? fit.tieLogSamples![index] : fallbackTieLogStrength);
  const currentAbilities = new Float64Array(items.map((item) => fit.abilities[item.subjectId] ?? 0));
  recenterSamples(selectedSamples, currentAbilities);
  recenterScalarSamples(forecastTieLogSamples, fallbackTieLogStrength);
  const evidence = summarizeRankingEvidence(history, sessionId);
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
    selectionOptions: { ...(options.pairSelection ?? {}), allowCalibration: true },
    initialDiagnostics: diagnostics,
    currentAbilities,
    forecastSamples: selectedSamples,
    forecastTieLogSamples,
    truthSamples,
    truthTieLogSamples,
    rolloutSeeds,
    scoreByRank: forecastScoreByRank(items, distribution),
    acceptedComparisons: fit.acceptedComparisons,
    tieStrength: fit.tieStrength ?? DEFAULT_TIE_STRENGTH,
    optimizerConverged: fit.converged,
    priorStrength: fit.priorStrength ?? DEFAULT_PRIOR_STRENGTH,
    priorScale: fit.priorScale ?? DEFAULT_PRIOR_SCALE,
    posteriorRandomSeed: fit.posteriorRandomSeed ?? options.randomSeed,
    evidenceRequired: diagnostics.evidenceRequired,
    uniquePairRequired: diagnostics.uniquePairRequired ?? minimumUniquePairs(items.length),
    pairMass: evidence.pairMass,
    pairOutcomeMass: evidence.pairOutcomeMass,
    itemEffectiveWeight: evidence.itemEffectiveWeight,
    diagnosticStride: Math.max(1, Math.round(options.diagnosticStride ?? FORECAST_DEFAULT_DIAGNOSTIC_STRIDE)),
    simulationHorizon,
    projectionHorizon: simulationHorizon,
    evidenceCount: evidence.evidenceCount,
    stoppingMode: options.stoppingMode ?? "standard",
  };
}

/** Calculate an independently seeded slice; each path records all ordered thresholds. */
export function forecastStoppingTimeRolloutsByMode(
  input: StoppingForecastRolloutInput,
  rolloutStart: number,
  rolloutCount: number,
) {
  const stoppingTimes = Object.fromEntries(STOPPING_MODE_ORDER.map((mode) => [mode, [] as number[]])) as StoppingTimesByMode;
  if (rolloutCount <= 0) return stoppingTimes;
  if (!input.optimizerConverged || input.forecastSamples.length === 0) {
    for (const mode of STOPPING_MODE_ORDER) stoppingTimes[mode] = Array<number>(rolloutCount).fill(Number.POSITIVE_INFINITY);
    return stoppingTimes;
  }

  for (let offset = 0; offset < rolloutCount; offset += 1) {
    const absoluteIndex = rolloutStart + offset;
    const truth = input.truthSamples[absoluteIndex];
    if (!truth) {
      for (const mode of STOPPING_MODE_ORDER) stoppingTimes[mode].push(Number.POSITIVE_INFINITY);
      continue;
    }
    const seed = input.rolloutSeeds[absoluteIndex] ?? hash(`${absoluteIndex}:forecast`);
    const truthTieLogStrength = input.truthTieLogSamples[absoluteIndex]
      ?? Math.log(input.tieStrength);
    const result = simulateForecastRollout(input, truth, truthTieLogStrength, seed);
    for (const mode of STOPPING_MODE_ORDER) stoppingTimes[mode].push(result[mode]);
  }
  return stoppingTimes;
}

/** Backwards-compatible active-mode projection helper. */
export function forecastStoppingTimeRollouts(
  input: StoppingForecastRolloutInput,
  rolloutStart: number,
  rolloutCount: number,
) {
  return forecastStoppingTimeRolloutsByMode(input, rolloutStart, rolloutCount)[input.stoppingMode];
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
    method: "posterior-contraction-mc-v15" as const,
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
    forecasts: {
      quick: forecast,
      standard: forecast,
      thorough: forecast,
    },
    stoppingTimesByMode: {
      quick: stoppingTimes,
      standard: stoppingTimes,
      thorough: stoppingTimes,
    },
  };
}

export function summarizeStoppingTimeRolloutsByMode(
  stoppingTimesByMode: StoppingTimesByMode,
  projectionHorizon: number,
  diagnostics: Pick<RankingDiagnostics,
    "evidenceCount" | "evidenceRequired" | "coverageTargetStabilityLow" | "stoppingChecks">,
  posteriorAvailable = true,
) {
  return Object.fromEntries(STOPPING_MODE_ORDER.map((mode) => {
    const check = diagnostics.stoppingChecks?.find((entry) => entry.mode === mode);
    const ready = check?.ready ?? (diagnostics.evidenceCount >= diagnostics.evidenceRequired
      && mode === "standard"
      && diagnostics.coverageTargetStabilityLow >= STOPPING_PROBABILITY_TARGET);
    return [mode, summarizeStoppingTimeRollouts(
      stoppingTimesByMode[mode], projectionHorizon,
      { ...diagnostics, ready }, posteriorAvailable,
    ).forecast];
  })) as Record<ComparisonBudgetMode, StoppingForecast>;
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
  const stoppingMode = options.stoppingMode ?? "standard";
  const input = prepareStoppingForecastRollouts(
    items, fit, distribution, history, sessionId, diagnostics, options, rolloutCount,
  );
  const stoppingTimesByMode = forecastStoppingTimeRolloutsByMode(input, 0, rolloutCount);
  const forecasts = summarizeStoppingTimeRolloutsByMode(
    stoppingTimesByMode, input.projectionHorizon, diagnostics, fit.posteriorSamples.length > 0,
  );
  return {
    forecast: forecasts[stoppingMode],
    stoppingTimes: stoppingTimesByMode[stoppingMode],
    forecasts,
    stoppingTimesByMode,
  };
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
    effectiveComparisons: result.effectiveComparisons,
    tieStrength: result.tieStrength,
    initialMeanUncertainty: initialMeanUncertainty ?? result.meanUncertainty,
    currentMeanUncertainty: result.meanUncertainty,
    converged: result.converged,
    iterations: result.iterations,
    optimizationStatus: result.optimizationStatus,
    diagnostics,
    updatedAt: new Date().toISOString(),
  };
}
