import { expect, test } from "@playwright/test";

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
