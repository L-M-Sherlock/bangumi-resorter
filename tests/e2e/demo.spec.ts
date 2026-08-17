import { expect, test } from "@playwright/test";

test("demo project can compare, resume, and show ranked results", async ({ page }) => {
  await page.goto("/");
  await page.locator("html[data-resorter-ready='true']").waitFor();
  await page.getByRole("button", { name: "先用演示数据体验" }).click();
  await expect(page.getByRole("heading", { name: /demo 的已评分收藏/ })).toBeVisible();
  await page.getByRole("button", { name: /开始比较 16 个条目/ }).click();
  await expect(page.getByRole("heading", { name: "哪一部更值得你给出高分？" })).toBeVisible();
  await expect(page.getByText(/原评分 \d/)).toHaveCount(0);
  await page.getByRole("button", { name: /更喜欢这部/ }).first().click();
  await expect(page.getByText(/本次已完成/)).toContainText("1");
  await page.getByRole("button", { name: "查看当前结果" }).click();
  await expect(page.getByRole("heading", { name: "你的偏好序列" })).toBeVisible();
  await expect(page.locator("tbody tr")).toHaveCount(16);
  await page.getByRole("button", { name: /两两比较/ }).click();
  await expect(page.getByText(/本次已完成/)).toContainText("1");
  await page.getByRole("button", { name: /备份与导出/ }).click();
  await expect(page.getByRole("button", { name: /下载 JSON 备份/ })).toBeVisible();
});
