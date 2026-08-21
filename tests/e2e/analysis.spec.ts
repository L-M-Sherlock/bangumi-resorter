import { expect, test, type Page } from "@playwright/test";

async function expectNoHorizontalOverflow(page: Page) {
  const metrics = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth);
}

test("current session analysis exposes six linked charts and resumable history cache", async ({ page }) => {
  let blockAnalysisWorker = true;
  await page.goto("/");
  await page.locator("html[data-resorter-ready='true']").waitFor();
  await page.getByRole("button", { name: "先用演示数据体验" }).click();
  await page.getByRole("button", { name: /开始快速比较/ }).click();
  await expect(page.getByRole("heading", { name: "哪一部在你的偏好中更靠前？" })).toBeVisible();
  await page.route(/analysis\.worker/u, async (route) => {
    if (blockAnalysisWorker) await route.abort();
    else await route.continue();
  });
  await page.getByRole("button", { name: /更喜欢这部/ }).first().click();
  await page.getByRole("button", { name: "查看当前结果" }).click();
  // Simulate a pre-v8/external-import session whose rebuildable analysis cache
  // has not been populated yet; the current model endpoint must still render.
  await page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("bangumi-resorter");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction("analysisSeries", "readwrite");
      transaction.objectStore("analysisSeries").clear();
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
    database.close();
  });
  await page.locator(".results-header").getByRole("button", { name: "会话分析", exact: true }).click();

  await expect(page).toHaveURL(/#analysis$/);
  await expect(page.getByRole("heading", { name: "demo 的排序" })).toBeVisible();
  await expect(page.getByText(/16 部作品 · 1 条原始判断/)).toBeVisible();
  await expect(page.getByText(/实际后验样本 64|实际后验样本 128/)).toBeVisible();
  await expect(page.locator(".analysis-chart-card")).toHaveCount(6);
  for (const title of ["证据折算", "覆盖与效率", "后验不确定性与平局强度", "跨两档作品数与占比", "三档停止下界", "三档动态剩余预测"]) {
    await expect(page.getByRole("heading", { name: title })).toBeVisible();
  }
  const crossBucketChart = page.locator(".analysis-chart-card").filter({ hasText: "跨两档作品数与占比" });
  await expect(crossBucketChart.locator(".analysis-chart-tooltip")).toContainText(/\d+(?:\.\d+)? 部（\d+(?:\.\d+)?%）/u);
  await expect(crossBucketChart.locator(".analysis-axis-label").first()).toContainText(/\/ \d+(?:\.\d+)?%/u);
  await expect(crossBucketChart.locator(".analysis-chart-footer")).toContainText(/中央 80% 后验区间.*部（.*%）/u);
  await expect(page.getByText("64 路径条件情景区间，未经经验覆盖率校准。", { exact: false })).toBeVisible();
  await expect(page.getByText("第 1 条判断", { exact: true })).toBeVisible();

  const build = page.getByRole("button", { name: /补算历史检查点/ });
  await expect(build).toBeEnabled();
  await build.click();
  await expect(page.getByText(/历史补算中断/)).toBeVisible();
  blockAnalysisWorker = false;
  await page.getByRole("button", { name: "重试缺失点" }).click();
  await expect(page.getByRole("button", { name: "历史检查点已齐全" })).toBeDisabled({ timeout: 30_000 });
  await expect(page.locator("input[type='range']")).toHaveAttribute("max", "1");
  await page.locator("input[type='range']").fill("0");
  await expect(page.getByText("第 0 条判断", { exact: true })).toBeVisible();

  await expect(page.locator(".analysis-header-actions select")).toHaveCount(0);
  await page.locator("#analysis-budget-mode").click();
  await page.getByRole("listbox", { name: "停止模式选项" }).getByRole("option", { name: "精细", exact: true }).click();
  await expect(page.locator("#analysis-budget-mode")).toHaveAttribute("data-value", "thorough");
  await expect(page.locator(".analysis-chart-card").filter({ hasText: "三档停止下界" })).toContainText("精细（当前）");
  await page.locator("#analysis-prior-mode").click();
  await page.getByRole("listbox", { name: "旧评分先验选项" }).getByRole("option", { name: "强先验", exact: true }).click();
  await expect(page.locator("#analysis-prior-mode")).toHaveAttribute("data-value", "strong");
  await expect(page.getByText(/强先验 · 10 档/)).toBeVisible();

  await page.getByRole("button", { name: "返回结果" }).click();
  await expect(page.locator("#result-prior-mode")).toHaveAttribute("data-value", "strong");
  await page.locator(".results-header").getByRole("button", { name: "会话分析", exact: true }).click();
  await expect(page.getByRole("heading", { name: "demo 的排序" })).toBeVisible();

  const stoppingChart = page.locator(".analysis-chart-card").filter({ hasText: "三档停止下界" });
  const stoppingAxisLabel = stoppingChart.locator(".analysis-axis-label").first();
  await page.setViewportSize({ width: 736, height: 900 });
  await expect.poll(() => stoppingChart.locator("svg").evaluate((element) => {
    const svg = element as SVGSVGElement;
    const containerWidth = svg.parentElement?.getBoundingClientRect().width ?? 0;
    return Math.abs(svg.viewBox.baseVal.width - containerWidth);
  })).toBeLessThan(1);
  const compactAxisLabelHeight = await stoppingAxisLabel.evaluate((label) => label.getBoundingClientRect().height);
  await page.setViewportSize({ width: 1920, height: 1080 });
  await expect.poll(() => stoppingChart.locator("svg").evaluate((element) => {
    const svg = element as SVGSVGElement;
    const containerWidth = svg.parentElement?.getBoundingClientRect().width ?? 0;
    return Math.abs(svg.viewBox.baseVal.width - containerWidth);
  })).toBeLessThan(1);
  const wideAxisLabelHeight = await stoppingAxisLabel.evaluate((label) => label.getBoundingClientRect().height);
  expect(Math.abs(wideAxisLabelHeight - compactAxisLabelHeight)).toBeLessThan(1);

  for (const viewport of [{ width: 1024, height: 800 }, { width: 736, height: 900 }, { width: 390, height: 844 }, { width: 360, height: 800 }]) {
    await page.setViewportSize(viewport);
    await expectNoHorizontalOverflow(page);
    await expect(page.locator(".analysis-chart-card")).toHaveCount(6);
    if (viewport.width <= 736) {
      const columns = await page.locator(".analysis-chart-grid").evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(" ").length);
      expect(columns).toBe(1);
    }
    if (viewport.width <= 390) {
      const touchTargets = await page.locator(".analysis-slider-row button, .analysis-build-controls button").evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().height));
      for (const height of touchTargets) expect(height).toBeGreaterThanOrEqual(44);
    }
  }

  await page.evaluate(() => localStorage.setItem("bangumi-resorter:theme", "dark"));
  await page.reload();
  await page.locator("html[data-resorter-ready='true']").waitFor();
  await expect(page).toHaveURL(/#analysis$/);
  await expect(page.getByRole("heading", { name: "选择一个排序会话查看分析" })).toBeVisible();
  await page.getByRole("button", { name: /查看分析 demo 的排序/ }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.locator(".analysis-chart-card")).toHaveCount(6);
  await expectNoHorizontalOverflow(page);
});

test("analysis suppresses a historically one-sided forecast interval", async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto("/");
  await page.locator("html[data-resorter-ready='true']").waitFor();
  await page.getByRole("button", { name: "先用演示数据体验" }).click();
  await page.getByRole("button", { name: /开始快速比较/ }).click();
  for (let index = 0; index < 20; index += 1) {
    await page.getByRole("button", { name: /更喜欢这部/ }).first().click();
  }
  await page.getByRole("button", { name: "查看当前结果" }).click();
  await page.locator(".results-header").getByRole("button", { name: "会话分析", exact: true }).click();
  const buildHistory = page.getByRole("button", { name: /补算历史检查点|历史检查点已齐全/ });
  if (await buildHistory.isEnabled()) await buildHistory.click();
  await expect(page.getByRole("button", { name: "历史检查点已齐全" })).toBeDisabled({ timeout: 30_000 });

  await page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("bangumi-resorter");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction("analysisSeries", "readwrite");
      const store = transaction.objectStore("analysisSeries");
      const read = store.getAll();
      read.onsuccess = () => {
        const series = read.result.find((entry) => entry.milestones?.some((point: { checkpoint: number }) => point.checkpoint === 15));
        if (!series) {
          reject(new Error("analysis series was not created"));
          return;
        }
        series.milestones = series.milestones.map((point: Record<string, unknown> & {
          checkpoint: number;
          forecasts: Record<string, unknown>;
          stoppingChecks: Record<string, Record<string, unknown>>;
          backtestStoppingChecks?: Record<string, Record<string, unknown>>;
        }) => {
          const quickCheck = {
            ...(point.backtestStoppingChecks?.quick ?? point.stoppingChecks.quick),
            ready: point.checkpoint === 15,
            probability: point.checkpoint === 15 ? 1 : 0,
            low: point.checkpoint === 15 ? 1 : 0,
          };
          return {
            ...point,
            backtestStoppingChecks: { ...point.backtestStoppingChecks, quick: quickCheck },
            forecastImportedRaw: 0,
            forecastManualRaw: 0,
            forecasts: point.checkpoint < 15 ? {
              ...point.forecasts,
              quick: {
                mode: "quick", status: "forecast", rolloutCount: 64,
                lowerAdditional: 0, medianAdditional: 0, upperAdditional: 0,
                projectionHorizon: 100, probabilityWithinProjection: 1,
                withinProjectionSuccesses: 64,
              },
            } : point.forecasts,
          };
        });
        store.put(series);
      };
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
    database.close();
  });

  await page.getByRole("button", { name: "返回结果" }).click();
  await page.locator(".results-header").getByRole("button", { name: "会话分析", exact: true }).click();
  await expect(page.getByText(/快速档可用时间回溯显示系统性低估剩余题量/)).toBeVisible();
  await expect(page.getByText(/历史 P10–P90 阴影已抑制/)).toBeVisible();
  const forecastChart = page.locator(".analysis-chart-card").filter({ hasText: "三档动态剩余预测" });
  await expect(forecastChart.locator("path.analysis-band[data-series='forecast-quick']")).toHaveCount(0);
  await expect(forecastChart).toContainText("P10–P90 已因同方向历史失准而抑制");
});
