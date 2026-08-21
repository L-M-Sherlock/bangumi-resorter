import { spawnSync } from "node:child_process";

for (const rolloutCount of [16, 32, 64]) {
  const result = spawnSync(process.execPath, [
    "node_modules/vitest/vitest.mjs",
    "run",
    "--config",
    "vitest.optimization.config.ts",
    "--maxWorkers=1",
  ], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      FORECAST_OPTIMIZATION_ROLLOUT_COUNT: String(rolloutCount),
    },
    stdio: "inherit",
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
