import {
  CollectionItem,
  DistributionConfig,
  ModelState,
  NextPair,
  PairSkipInput,
  RankedItem,
  RankingComparisonInput,
  RankingItemInput,
} from "../types";

const LAMBDA = 0.25;
const MAX_OUTER = 50;
const GRADIENT_TOLERANCE = 1e-6;
const PCG_TOLERANCE = 1e-4;

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

function dot(a: Float64Array, b: Float64Array) {
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) sum += a[i] * b[i];
  return sum;
}

function evaluate(theta: Float64Array, prior: Float64Array, comparisons: IndexedComparison[]) {
  const gradient = new Float64Array(theta.length);
  const diagonal = new Float64Array(theta.length);
  diagonal.fill(LAMBDA);
  let objective = 0;

  for (let i = 0; i < theta.length; i += 1) {
    const diff = theta[i] - prior[i];
    objective -= 0.5 * LAMBDA * diff * diff;
    gradient[i] -= LAMBDA * diff;
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
) {
  const output = new Float64Array(vector.length);
  for (let i = 0; i < vector.length; i += 1) output[i] = LAMBDA * vector[i];
  for (let k = 0; k < comparisons.length; k += 1) {
    const { left, right } = comparisons[k];
    const weightedDifference = weights[k] * (vector[left] - vector[right]);
    output[left] += weightedDifference;
    output[right] -= weightedDifference;
  }
  return output;
}

function solvePcg(
  gradient: Float64Array,
  diagonal: Float64Array,
  comparisons: IndexedComparison[],
  weights: Float64Array,
) {
  const size = gradient.length;
  const solution = new Float64Array(size);
  const residual = gradient.slice();
  const z = new Float64Array(size);
  const direction = new Float64Array(size);
  for (let i = 0; i < size; i += 1) z[i] = direction[i] = residual[i] / diagonal[i];
  let residualDotZ = dot(residual, z);
  const initialNorm = Math.sqrt(Math.max(dot(gradient, gradient), 1e-30));
  const maxIterations = Math.max(1, Math.min(200, size));

  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    const product = hessianProduct(direction, comparisons, weights);
    const denominator = dot(direction, product);
    if (!Number.isFinite(denominator) || denominator <= 0) break;
    const alpha = residualDotZ / denominator;
    for (let i = 0; i < size; i += 1) {
      solution[i] += alpha * direction[i];
      residual[i] -= alpha * product[i];
    }
    if (Math.sqrt(dot(residual, residual)) <= PCG_TOLERANCE * initialNorm) break;
    for (let i = 0; i < size; i += 1) z[i] = residual[i] / diagonal[i];
    const nextResidualDotZ = dot(residual, z);
    const beta = nextResidualDotZ / Math.max(residualDotZ, 1e-30);
    for (let i = 0; i < size; i += 1) direction[i] = z[i] + beta * direction[i];
    residualDotZ = nextResidualDotZ;
  }
  return solution;
}

export function fitModel(
  items: RankingItemInput[],
  comparisonsInput: RankingComparisonInput[],
  previousAbilities?: Record<number, number>,
): FitResult {
  if (items.length === 0) {
    return { abilities: {}, uncertainty: {}, meanUncertainty: 0, converged: true, iterations: 0, acceptedComparisons: 0 };
  }
  const indexById = new Map(items.map((item, index) => [item.subjectId, index]));
  const comparisons: IndexedComparison[] = [];
  for (const comparison of comparisonsInput) {
    const left = indexById.get(comparison.leftSubjectId);
    const right = indexById.get(comparison.rightSubjectId);
    if (left === undefined || right === undefined || left === right) continue;
    comparisons.push({ left, right, y: comparison.outcome === "left" ? 1 : comparison.outcome === "right" ? 0 : 0.5 });
  }

  const prior = new Float64Array(items.map((item) => 0.35 * (item.rate - 5.5)));
  let theta = new Float64Array(items.map((item, index) => {
    const previous = previousAbilities?.[item.subjectId];
    return previous !== undefined && Number.isFinite(previous) ? previous : prior[index];
  }));
  let converged = false;
  let iterations = 0;

  for (iterations = 0; iterations < MAX_OUTER; iterations += 1) {
    const current = evaluate(theta, prior, comparisons);
    let gradientInfinityNorm = 0;
    for (const value of current.gradient) gradientInfinityNorm = Math.max(gradientInfinityNorm, Math.abs(value));
    if (gradientInfinityNorm < GRADIENT_TOLERANCE) {
      converged = true;
      break;
    }
    let step = solvePcg(current.gradient, current.diagonal, comparisons, current.weights);
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
      const candidateObjective = evaluate(candidate, prior, comparisons).objective;
      if (Number.isFinite(candidateObjective) && candidateObjective >= current.objective + 1e-4 * scale * directionalDerivative) {
        theta = candidate;
        accepted = true;
        break;
      }
      scale *= 0.5;
    }
    if (!accepted) break;
  }

  const finalEvaluation = evaluate(theta, prior, comparisons);
  const abilities: Record<number, number> = {};
  const uncertainty: Record<number, number> = {};
  let meanUncertainty = 0;
  items.forEach((item, index) => {
    if (!Number.isFinite(theta[index])) throw new Error("模型计算产生了无效数值。");
    abilities[item.subjectId] = theta[index];
    uncertainty[item.subjectId] = Math.sqrt(1 / finalEvaluation.diagonal[index]);
    meanUncertainty += uncertainty[item.subjectId];
  });
  meanUncertainty /= items.length;
  return { abilities, uncertainty, meanUncertainty, converged, iterations, acceptedComparisons: comparisons.length };
}

function pairKey(a: number, b: number) { return a < b ? `${a}:${b}` : `${b}:${a}`; }

function hash(value: string) {
  let result = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    result ^= value.charCodeAt(i);
    result = Math.imul(result, 16777619);
  }
  return result >>> 0;
}

export function chooseNextPair(
  items: RankingItemInput[],
  comparisons: RankingComparisonInput[],
  skips: PairSkipInput[],
  model: Pick<ModelState, "abilities" | "uncertainty" | "acceptedComparisons" | "version">,
  randomSeed: number,
): NextPair | undefined {
  if (items.length < 2) return undefined;
  const ordered = [...items].sort((a, b) =>
    (model.abilities[b.subjectId] ?? 0) - (model.abilities[a.subjectId] ?? 0) || b.rate - a.rate || a.subjectId - b.subjectId,
  );
  const counts = new Map<string, number>();
  for (const entry of comparisons) counts.set(pairKey(entry.leftSubjectId, entry.rightSubjectId), (counts.get(pairKey(entry.leftSubjectId, entry.rightSubjectId)) ?? 0) + 1);
  const cooled = new Set(skips
    .filter((entry) => model.acceptedComparisons - entry.acceptedCountAtAnswer < 20)
    .map((entry) => pairKey(entry.leftSubjectId, entry.rightSubjectId)));

  function select(ignoreCooldown: boolean) {
    let best: { first: number; second: number; score: number } | undefined;
    for (let distance = 1; distance <= Math.min(3, ordered.length - 1); distance += 1) {
      for (let i = 0; i + distance < ordered.length; i += 1) {
        const first = ordered[i].subjectId;
        const second = ordered[i + distance].subjectId;
        const key = pairKey(first, second);
        if (!ignoreCooldown && cooled.has(key)) continue;
        const probability = sigmoid((model.abilities[first] ?? 0) - (model.abilities[second] ?? 0));
        const variance = (model.uncertainty[first] ?? 2) ** 2 + (model.uncertainty[second] ?? 2) ** 2;
        const score = probability * (1 - probability) * variance / (1 + (counts.get(key) ?? 0));
        if (!best || score > best.score || (score === best.score && key < pairKey(best.first, best.second))) best = { first, second, score };
      }
    }
    return best;
  }

  const best = select(false) ?? select(true);
  if (!best) return undefined;
  const flip = hash(`${randomSeed}:${model.version}:${pairKey(best.first, best.second)}`) % 2 === 1;
  const leftSubjectId = flip ? best.second : best.first;
  const rightSubjectId = flip ? best.first : best.second;
  return {
    pairId: `${model.version}-${hash(`${leftSubjectId}:${rightSubjectId}:${randomSeed}`).toString(36)}`,
    leftSubjectId, rightSubjectId, modelVersion: model.version, informationScore: best.score,
  };
}

function mappedRates(ordered: CollectionItem[], config: DistributionConfig) {
  const output = new Map<number, number>();
  if (config.preset === "preserve") {
    const counts = Array.from({ length: 10 }, (_, index) => ordered.filter((item) => item.rate === index + 1).length);
    let cursor = 0;
    for (let score = 10; score >= 1; score -= 1) {
      for (let count = 0; count < counts[score - 1] && cursor < ordered.length; count += 1) output.set(ordered[cursor++].subjectId, score);
    }
    return output;
  }
  let weights = config.weights.length === 10 ? config.weights.map((value) => Math.max(0, value)) : Array(10).fill(10);
  let total = weights.reduce((sum, value) => sum + value, 0);
  if (total === 0) {
    weights = Array(10).fill(10);
    total = 100;
  }
  const topDown = [...weights].reverse().map((value) => value / total);
  ordered.forEach((item, rankIndex) => {
    const quantile = (rankIndex + 0.5) / ordered.length;
    let cumulative = 0;
    let score = 1;
    for (let index = 0; index < topDown.length; index += 1) {
      cumulative += topDown[index];
      if (quantile <= cumulative + 1e-12) { score = 10 - index; break; }
    }
    output.set(item.subjectId, score);
  });
  return output;
}

export function buildRankedItems(
  items: CollectionItem[],
  model: Pick<ModelState, "abilities" | "uncertainty">,
  comparisons: RankingComparisonInput[],
  distribution: DistributionConfig,
): RankedItem[] {
  const ordered = [...items].sort((a, b) =>
    (model.abilities[b.subjectId] ?? 0) - (model.abilities[a.subjectId] ?? 0) || b.rate - a.rate || a.subjectId - b.subjectId,
  );
  const rates = mappedRates(ordered, distribution);
  const counts = new Map<number, number>();
  for (const comparison of comparisons) {
    counts.set(comparison.leftSubjectId, (counts.get(comparison.leftSubjectId) ?? 0) + 1);
    counts.set(comparison.rightSubjectId, (counts.get(comparison.rightSubjectId) ?? 0) + 1);
  }
  return ordered.map((item, index) => ({
    ...item, rank: index + 1, ability: model.abilities[item.subjectId] ?? 0,
    uncertainty: model.uncertainty[item.subjectId] ?? 2,
    newRate: rates.get(item.subjectId) ?? item.rate,
    comparisonCount: counts.get(item.subjectId) ?? 0,
  }));
}

export function toModelState(
  sessionId: string,
  version: number,
  result: FitResult,
  initialMeanUncertainty?: number,
): ModelState {
  return {
    sessionId, version, abilities: result.abilities, uncertainty: result.uncertainty,
    acceptedComparisons: result.acceptedComparisons,
    initialMeanUncertainty: initialMeanUncertainty ?? result.meanUncertainty,
    currentMeanUncertainty: result.meanUncertainty,
    converged: result.converged, iterations: result.iterations, updatedAt: new Date().toISOString(),
  };
}
