import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["benchmarks/forecast-optimization.test.ts"],
    fileParallelism: false,
    testTimeout: 120_000,
    disableConsoleIntercept: true,
  },
});
