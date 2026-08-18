import { expect, test } from "@playwright/test";

test("theme toggle follows the system and persists explicit choices", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/");
  await page.locator("html[data-resorter-ready='true']").waitFor();

  const toggle = page.getByRole("button", { name: /当前主题：系统/ });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe("rgb(27, 25, 23)");
  await toggle.click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe("rgb(245, 242, 235)");
  await expect(page.getByRole("button", { name: /当前主题：浅色/ })).toBeVisible();
  expect(await page.evaluate(() => window.localStorage.getItem("bangumi-resorter:theme"))).toBe("light");

  await page.reload();
  await page.locator("html[data-resorter-ready='true']").waitFor();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.getByRole("button", { name: /当前主题：浅色/ }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.getByRole("button", { name: /当前主题：深色/ }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  expect(await page.evaluate(() => window.localStorage.getItem("bangumi-resorter:theme"))).toBe("system");
});

test("principles page is public and terminology popovers are keyboard accessible", async ({ page }) => {
  await page.goto("/");
  await page.locator("html[data-resorter-ready='true']").waitFor();

  const modelTerm = page.locator('[data-term-key="bradley-terry"]').first();
  await modelTerm.focus();
  const modelPopover = page.getByRole("dialog", { name: "Bradley–Terry 模型解释" });
  await expect(modelPopover).toBeVisible();
  await expect(modelPopover).toContainText("潜在偏好差越大");
  await expect(modelPopover.getByRole("link", { name: /查看完整原理/ })).toHaveAttribute("href", /\/principles#preference-model$/);
  await page.keyboard.press("Escape");
  await expect(modelPopover).toHaveCount(0);

  await page.getByRole("link", { name: /为什么这样排序/ }).click();
  await expect(page).toHaveURL(/\/principles$/);
  await expect(page.getByRole("heading", { name: "为什么比较比打分更诚实？" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "原理页面目录" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "与 Gwern 原版的差异" })).toBeVisible();
  await expect(page.getByRole("link", { name: /Gwern · Resorting Media Ratings/ })).toHaveAttribute("href", "https://gwern.net/resorter");
  await expect(page.locator(".technical-box")).toContainText("σ 是 logistic 函数。模型用 MAP 估计寻找最符合比较与先验的一组 θ，并以 L2 正则抑制");
  await expect(page.getByText(/系统读取最优点附近的 Hessian，用 Laplace 近似/)).toBeVisible();
  const articleText = await page.locator(".principles-article").innerText();
  expect(articleText.match(/(?:[\p{Script=Han}][A-Za-z]|[A-Za-z][\p{Script=Han}])/gu) ?? []).toEqual([]);

  const priorTerm = page.locator('[data-term-key="prior"]').first();
  await priorTerm.press("Enter");
  await expect(page.getByRole("dialog", { name: "先验解释" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "先验解释" })).toHaveCount(0);
});

test("term popovers stay inside a mobile viewport", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/principles");
  const term = page.locator('[data-term-key="rating-clumping"]').first();
  await term.scrollIntoViewIfNeeded();
  await term.click();
  const popover = page.getByRole("dialog", { name: "评分聚集解释" });
  await expect(popover).toBeVisible();
  const box = await popover.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(375);
  expect(box!.y + box!.height).toBeLessThanOrEqual(812);
  await page.keyboard.press("Escape");
  await expect(popover).toHaveCount(0);
});

test("returning from principles restores the active sorter without a login flash", async ({ page }) => {
  await page.addInitScript(() => {
    const watchKey = "resorter-test:watch-return";
    const flashKey = "resorter-test:login-flashed";
    const inspectUntilReady = () => {
      if (window.sessionStorage.getItem(watchKey) !== "1") return;
      const connect = document.querySelector<HTMLElement>(".connect-page");
      if (connect && getComputedStyle(connect).visibility !== "hidden" && connect.getClientRects().length > 0) {
        window.sessionStorage.setItem(flashKey, "1");
      }
      if (!document.documentElement.dataset.resorterReady) window.requestAnimationFrame(inspectUntilReady);
    };
    window.requestAnimationFrame(inspectUntilReady);
  });
  await page.goto("/");
  await page.locator("html[data-resorter-ready='true']").waitFor();
  await page.getByRole("button", { name: "先用演示数据体验" }).click();
  await expect(page.getByRole("heading", { name: /demo 的已评分收藏/ })).toBeVisible();
  await page.evaluate(() => {
    window.sessionStorage.setItem("resorter-test:watch-return", "1");
    window.sessionStorage.removeItem("resorter-test:login-flashed");
  });

  await page.getByRole("link", { name: /原理/ }).click();
  await expect(page).toHaveURL(/\/principles$/);
  await page.locator('.principles-toc a[href="#stopping-rule"]').click();
  await expect(page).toHaveURL(/\/principles#stopping-rule$/);
  await page.getByRole("link", { name: /返回排序工具/ }).click();

  await expect(page).toHaveURL(/\/#library$/);
  await expect(page.getByRole("heading", { name: /demo 的已评分收藏/ })).toBeVisible();
  await expect(page.locator(".connect-page")).toHaveCount(0);
  expect(await page.evaluate(() => window.sessionStorage.getItem("resorter-test:login-flashed"))).toBeNull();
});

test("refreshing a saved project restores it without exposing the login page", async ({ page }) => {
  await page.addInitScript(() => {
    const flashKey = "resorter-test:refresh-login-flashed";
    const inspectUntilReady = () => {
      const connect = document.querySelector<HTMLElement>(".connect-page");
      if (connect && getComputedStyle(connect).visibility !== "hidden" && connect.getClientRects().length > 0) {
        window.sessionStorage.setItem(flashKey, "1");
      }
      if (!document.documentElement.dataset.resorterReady) window.requestAnimationFrame(inspectUntilReady);
    };
    if (window.localStorage.getItem("bangumi-resorter:has-local-project") === "1") {
      window.requestAnimationFrame(inspectUntilReady);
    }
  });
  await page.goto("/");
  await page.locator("html[data-resorter-ready='true']").waitFor();
  await page.getByRole("button", { name: "先用演示数据体验" }).click();
  await expect(page.getByRole("heading", { name: /demo 的已评分收藏/ })).toBeVisible();
  await page.evaluate(() => window.sessionStorage.removeItem("resorter-test:refresh-login-flashed"));

  await page.reload();

  await page.locator("html[data-resorter-ready='true']").waitFor();
  await expect(page).toHaveURL(/\/#library$/);
  await expect(page.getByRole("heading", { name: /demo 的已评分收藏/ })).toBeVisible();
  await expect(page.locator(".connect-page")).toHaveCount(0);
  expect(await page.evaluate(() => window.sessionStorage.getItem("resorter-test:refresh-login-flashed"))).toBeNull();
});
