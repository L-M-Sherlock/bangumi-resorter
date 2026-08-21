import { chromium } from "playwright";
import { createServer } from "vite";

const parsedIterations = Number.parseInt(process.env.COMPARISON_BENCH_ITERATIONS ?? "3", 10);
const iterations = Number.isFinite(parsedIterations)
  ? Math.min(10, Math.max(1, parsedIterations))
  : 3;
const server = await createServer({
  configFile: false,
  root: process.cwd(),
  appType: "mpa",
  logLevel: "error",
  server: { host: "127.0.0.1", port: 0 },
});

let browser;
try {
  await server.listen();
  const address = server.httpServer?.address();
  if (!address || typeof address === "string") throw new Error("Benchmark Vite server did not expose a TCP port.");
  try {
    browser = await chromium.launch({ channel: "chrome", headless: true });
  } catch {
    browser = await chromium.launch({ headless: true });
  }
  const page = await browser.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(`http://127.0.0.1:${address.port}/benchmarks/comparison-browser.html?iterations=${iterations}`);
  await page.waitForFunction(
    () => window.comparisonBenchmarkResult?.status === "complete"
      || window.comparisonBenchmarkResult?.status === "error",
    undefined,
    { timeout: 10 * 60_000 },
  );
  const result = await page.evaluate(() => window.comparisonBenchmarkResult);
  if (!result || result.status === "error") {
    throw new Error(result?.error ?? pageErrors.join("\n") ?? "Browser benchmark returned no result.");
  }
  const milliseconds = (value) => `${value.toFixed(1)} ms`;
  console.log("Browser Worker benchmark · production Worker topology");
  console.log(`  fixture: ${result.fixture.items} items, ${result.fixture.existingHistory} existing judgments + 1 answer`);
  console.log(`  browser hardwareConcurrency / forecast Workers: ${result.environment.hardwareConcurrency} / ${result.environment.forecastWorkers}`);
  console.log(`  warm-up calculation: ${milliseconds(result.warmupMs)}`);
  console.log(`  steady-state samples: ${result.samplesMs.map(milliseconds).join(", ")}`);
  console.log(`  steady-state median: ${milliseconds(result.medianMs)}`);
  console.log(`  posterior / rollout: ${result.diagnostics.posteriorSamples} samples / ${result.diagnostics.forecastRollouts} paths`);
  console.log(`  forecast horizon / status: ${result.diagnostics.forecastHorizon} / ${result.diagnostics.forecastStatus}`);
  console.log(`  raw / effective evidence: ${result.diagnostics.rawEvidence} / ${result.diagnostics.effectiveEvidence.toFixed(1)}`);
} finally {
  await browser?.close();
  await server.close();
}
