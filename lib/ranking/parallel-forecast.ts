import {
  forecastStoppingTimeSimulation,
  forecastStoppingTimeRollouts,
  prepareStoppingForecastRollouts,
  summarizeStoppingTimeRollouts,
  type StoppingForecastRolloutInput,
} from "./engine";
import type { PreparedRanking } from "./compute";

export interface ForecastWorkerLike {
  onmessage: ((event: MessageEvent<ForecastWorkerResponse>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  postMessage(message: ForecastWorkerTask): void;
  terminate(): void;
}

export interface ForecastWorkerTask {
  taskId: string;
  input: StoppingForecastRolloutInput;
  rolloutStart: number;
  rolloutCount: number;
  forecastIndex: number;
}

export interface ForecastWorkerResponse {
  taskId: string;
  stoppingTimes?: number[];
  error?: string;
}

export interface ParallelForecastOptions {
  hardwareConcurrency?: number;
  mobile?: boolean;
  createWorker?: () => ForecastWorkerLike;
  workerPool?: ForecastWorkerPool;
  rolloutCount?: number;
}

export class ForecastWorkerPool {
  private workers: ForecastWorkerLike[] = [];
  private usable = true;
  private active = false;

  constructor(
    readonly size: number,
    private readonly createWorker: () => ForecastWorkerLike,
  ) {}

  async run(tasks: ForecastWorkerTask[], stoppingTimes: number[][]) {
    if (!this.usable) throw new Error("停止预测 Worker 池不可用。");
    if (this.active) throw new Error("停止预测 Worker 池正在处理其他任务。");
    if (tasks.length === 0) return;
    this.active = true;
    let nextTask = 0;
    try {
      while (this.workers.length < Math.min(this.size, tasks.length)) {
        this.workers.push(this.createWorker());
      }
      await new Promise<void>((resolve, reject) => {
        let completed = 0;
        const dispatch = (worker: ForecastWorkerLike) => {
          const task = tasks[nextTask++];
          if (!task) return;
          worker.onmessage = (event) => {
            const response = event.data;
            if (response.taskId !== task.taskId) {
              reject(new Error("停止预测 Worker 返回了错位结果。"));
              return;
            }
            if (response.error || !response.stoppingTimes) {
              reject(new Error(response.error ?? "停止预测 Worker 返回了空结果。"));
              return;
            }
            stoppingTimes[task.forecastIndex].splice(
              task.rolloutStart,
              response.stoppingTimes.length,
              ...response.stoppingTimes,
            );
            completed += 1;
            if (completed === tasks.length) resolve();
            else dispatch(worker);
          };
          worker.onerror = (event) => reject(new Error(event.message || "停止预测 Worker 发生错误。"));
          worker.postMessage(task);
        };
        for (const worker of this.workers) dispatch(worker);
      });
    } catch (error) {
      this.terminate();
      throw error;
    } finally {
      this.active = false;
      for (const worker of this.workers) {
        worker.onmessage = null;
        worker.onerror = null;
      }
    }
  }

  terminate() {
    this.usable = false;
    for (const worker of this.workers) worker.terminate();
    this.workers = [];
  }
}

export function forecastWorkerCount(
  hardwareConcurrency: number | undefined,
  itemCount: number,
  rolloutCount: number,
  mobile = false,
) {
  if ((hardwareConcurrency ?? 1) < 2 || itemCount < 80 || rolloutCount < 32) return 0;
  return Math.min(mobile ? 2 : 4, Math.max(2, Math.floor(hardwareConcurrency ?? 2)));
}

export async function computePreparedForecasts(
  prepared: PreparedRanking,
  options: ParallelForecastOptions = {},
) {
  const rolloutCount = Math.max(16, Math.round(options.rolloutCount ?? 64));
  const workerCount = forecastWorkerCount(
    options.hardwareConcurrency,
    prepared.request.items.length,
    rolloutCount,
    options.mobile,
  );
  const sequential = () => prepared.forecasts.map(({ fit, diagnostics, options: forecastOptions }) =>
    forecastStoppingTimeSimulation(
      prepared.request.items,
      fit,
      prepared.request.distribution,
      prepared.request.history,
      prepared.request.sessionId,
      diagnostics,
      { ...forecastOptions, rolloutCount },
    ));
  const parallelForecastIndexes = prepared.forecasts
    .map((forecast, index) => !forecast.diagnostics.ready && forecast.fit.posteriorSamples.length > 0 ? index : -1)
    .filter((index) => index >= 0);
  if (parallelForecastIndexes.length === 0 || workerCount === 0 || (!options.workerPool && !options.createWorker)) {
    return sequential();
  }

  const inputs = prepared.forecasts.map((forecast, index) =>
    parallelForecastIndexes.includes(index) ? prepareStoppingForecastRollouts(
      prepared.request.items,
      forecast.fit,
      prepared.request.distribution,
      prepared.request.history,
      prepared.request.sessionId,
      forecast.diagnostics,
      { ...forecast.options, rolloutCount },
      rolloutCount,
    ) : undefined);
  const tasks: ForecastWorkerTask[] = [];
  const pool = options.workerPool ?? new ForecastWorkerPool(workerCount, options.createWorker!);
  const ownsPool = !options.workerPool;
  const chunkSize = Math.ceil(rolloutCount / Math.min(workerCount, pool.size));
  for (const forecastIndex of parallelForecastIndexes) {
    for (let rolloutStart = 0; rolloutStart < rolloutCount; rolloutStart += chunkSize) {
      tasks.push({
        taskId: `${forecastIndex}:${rolloutStart}`,
        input: inputs[forecastIndex]!,
        rolloutStart,
        rolloutCount: Math.min(chunkSize, rolloutCount - rolloutStart),
        forecastIndex,
      });
    }
  }

  const stoppingTimes = inputs.map(() => Array<number>(rolloutCount));
  let parallelFailed = false;
  try {
    await pool.run(tasks, stoppingTimes);
  } catch (error) {
    console.warn("并行停止预测不可用，已回退单 Worker。", error);
    parallelFailed = true;
  } finally {
    if (ownsPool) pool.terminate();
  }
  if (parallelFailed) return sequential();

  return inputs.map((input, index) => input
    ? summarizeStoppingTimeRollouts(
      stoppingTimes[index],
      input.projectionHorizon,
      prepared.forecasts[index].diagnostics,
      true,
    )
    : forecastStoppingTimeSimulation(
      prepared.request.items,
      prepared.forecasts[index].fit,
      prepared.request.distribution,
      prepared.request.history,
      prepared.request.sessionId,
      prepared.forecasts[index].diagnostics,
      { ...prepared.forecasts[index].options, rolloutCount },
    ));
}

/** Synchronous helper for tests and environments that emulate workers. */
export function runForecastWorkerTask(task: ForecastWorkerTask): ForecastWorkerResponse {
  return {
    taskId: task.taskId,
    stoppingTimes: forecastStoppingTimeRollouts(task.input, task.rolloutStart, task.rolloutCount),
  };
}
