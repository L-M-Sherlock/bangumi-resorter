import { expect, test } from "@playwright/test";

test("demo project can filter, compare, derive, upgrade, edit records, and delete sessions", async ({ page }) => {
  await page.goto("/");
  await page.locator("html[data-resorter-ready='true']").waitFor();
  await page.getByRole("button", { name: "先用演示数据体验" }).click();
  await expect(page.getByRole("heading", { name: /demo 的已评分收藏/ })).toBeVisible();
  await expect(page.getByText(/强依赖原评分.*低频探索全局/)).toBeVisible();
  await expect(page.getByText(/每次回答后动态重估剩余区间/)).toBeVisible();
  await expect(page.getByText(/答题次数上限/)).toHaveCount(0);
  await expect(page.getByText(/疲劳安全上限/)).toHaveCount(0);
  await expect(page.locator("#score-level-count")).toHaveValue("10");
  await expect(page.locator("#distribution-preset option")).toHaveText(["均匀 10 档", "保持原分布", "高分辨率尾部", "反 J 分布", "自定义权重"]);
  await expect(page.locator("#distribution-preset")).toHaveValue("high-tail");
  await page.locator("#score-level-count").selectOption("5");
  await expect(page.locator("#distribution-preset option").first()).toHaveText("均匀 5 档");
  await page.locator("#distribution-preset").selectOption("reverse-j");
  await expect(page.getByText(/低分档占比最高.*保持累计分布形状/)).toBeVisible();
  await page.locator("#new-session-tag-search").fill("经典");
  await page.getByRole("option", { name: /经典/ }).click();
  await expect(page.getByText("同时包含 1 个标签，匹配 6 部作品")).toBeVisible();
  await expect(page.getByText(/当前 5 档分桶.*当前 6 部作品中，允许最多 0 部跨两档/)).toBeVisible();
  await page.getByRole("button", { name: /开始快速比较 · 动态停止/ }).click();
  await expect(page.getByRole("heading", { name: "哪一部在你的偏好中更靠前？" })).toBeVisible();
  await expect(page.getByText(/原评分 \d/)).toHaveCount(0);
  const originalPair = await page.locator(".media-card h2").allTextContents();
  await page.locator(".media-card h2").nth(1).evaluate((heading) => {
    heading.textContent = "用于验证多行标题时两侧卡片仍然保持相同高度";
  });
  const cardHeights = await page.locator(".media-card").evaluateAll((cards) =>
    cards.map((card) => card.getBoundingClientRect().height));
  const buttonBottoms = await page.locator(".media-card .choice-button").evaluateAll((buttons) =>
    buttons.map((button) => button.getBoundingClientRect().bottom));
  expect(Math.abs(cardHeights[0] - cardHeights[1])).toBeLessThan(1);
  expect(Math.abs(buttonBottoms[0] - buttonBottoms[1])).toBeLessThan(1);
  await page.getByRole("button", { name: /更喜欢这部/ }).first().click();
  await expect(page.getByText(/本次已完成/)).toContainText("1");
  await expect(page.locator("#compare-budget-mode")).toHaveValue("quick");
  await page.locator("#compare-budget-mode").selectOption("standard");
  await expect(page.locator("#compare-budget-mode")).toHaveValue("standard");
  await expect(page.locator(".topbar .eyebrow")).toContainText("标准模式");
  await expect(page.getByText(/本次已完成/)).toContainText("1");
  await expect(page.getByText("动态剩余预测")).toBeVisible();
  await expect(page.getByText(/后验期望相邻容差覆盖 \d+%/)).toBeVisible();
  await expect(page.getByText("跨两档作品分布")).toBeVisible();
  await expect(page.getByText("最坏偏移分布")).toBeVisible();
  await expect(page.getByText("相邻容差可信度")).toHaveCount(0);
  await expect(page.getByText("未来 20 次内达标")).toHaveCount(0);
  await expect(page.getByText("安全余量")).toHaveCount(0);
  await expect(page.getByText(/\/ 参考/)).toHaveCount(0);
  await page.getByRole("button", { name: "撤销上次" }).click();
  await expect(page.getByText(/本次已完成/)).toContainText("0");
  await expect(page.locator(".media-card h2").nth(0)).toHaveText(originalPair[0]);
  await expect(page.locator(".media-card h2").nth(1)).toHaveText(originalPair[1]);
  await page.getByRole("button", { name: /更喜欢这部/ }).first().click();
  await expect(page.getByText(/本次已完成/)).toContainText("1");
  await page.getByRole("button", { name: "查看当前结果" }).click();
  await expect(page.getByRole("heading", { name: "你的偏好序列" })).toBeVisible();
  await expect(page.locator("#result-budget-mode")).toHaveValue("standard");
  await page.locator("#result-budget-mode").selectOption("thorough");
  await expect(page.locator("#result-budget-mode")).toHaveValue("thorough");
  await expect(page.locator(".page-header .eyebrow")).toContainText("精细模式");
  await expect(page.getByText("本会话判断记录（1）")).toBeVisible();
  await expect(page.locator("#result-distribution-preset")).toHaveValue("reverse-j");
  await expect(page.locator("#result-score-level-count")).toHaveValue("5");
  await expect(page.locator('.distribution-chart .histogram[data-level-count="10"]')).toHaveCount(1);
  await expect(page.locator('.distribution-chart .histogram[data-level-count="5"]')).toHaveCount(1);
  await expect(page.getByText("预计跨两档作品")).toBeVisible();
  await expect(page.getByText(/80% 后验区间/)).toBeVisible();
  await expect(page.getByText("最坏偏移")).toBeVisible();
  await expect(page.getByText(/仅作尾部诊断/)).toBeVisible();
  await expect(page.getByText(/达标样本 .*每个样本允许最多 0 部作品跨两档/)).toBeVisible();
  await expect(page.getByText(/嵌套下界 快速 .*标准 .*精细/)).toBeVisible();
  await expect(page.getByText(/模型未采用原评分顺序先验/)).toBeVisible();
  await expect(page.getByText("完全零错桶概率")).toHaveCount(0);
  await expect(page.getByText("未来 20 次内达标")).toHaveCount(0);
  await expect(page.getByText(/区间仅代表模型内近似/)).toBeVisible();
  await page.locator("#result-score-level-count").selectOption("12");
  await expect(page.locator("#result-score-level-count")).toHaveValue("12");
  await expect(page.getByText("本会话判断记录（1）")).toBeVisible();
  await expect(page.locator('.distribution-chart .histogram[data-level-count="12"]')).toHaveCount(1);
  await expect(page.getByRole("columnheader", { name: "新评分（12 档）" })).toBeVisible();
  await expect(page.locator(".score-pill.new.changed")).toHaveCount(0);
  expect(await page.getByRole("columnheader", { name: "精确分桶稳定度" }).evaluate((header) => getComputedStyle(header).whiteSpace)).toBe("nowrap");
  await page.locator("#result-score-level-count").selectOption("10");
  await expect(page.locator("#result-score-level-count")).toHaveValue("10");
  await expect(page.getByRole("heading", { name: "原评分 → 新评分" })).toBeVisible();
  await expect(page.locator('.result-summary .histogram[data-level-count="10"]')).toHaveCount(1);
  await expect(page.locator(".result-summary .histogram .bar-old")).toHaveCount(10);
  await expect(page.locator(".result-summary .histogram .bar-new")).toHaveCount(10);
  expect(await page.locator(".score-pill.new.changed").count()).toBeGreaterThan(0);
  await page.locator("#result-score-level-count").selectOption("12");
  await expect(page.locator("#result-score-level-count")).toHaveValue("12");
  await page.locator("#result-budget-mode").selectOption("quick");
  await expect(page.locator("#result-budget-mode")).toHaveValue("quick");
  const quickSummary = await page.locator(".summary-stat").textContent();
  await page.locator("#result-budget-mode").selectOption("standard");
  await expect(page.locator("#result-budget-mode")).toHaveValue("standard");
  await page.locator("#result-budget-mode").selectOption("thorough");
  await expect(page.locator("#result-budget-mode")).toHaveValue("thorough");
  await page.locator("#result-budget-mode").selectOption("quick");
  await expect(page.locator("#result-budget-mode")).toHaveValue("quick");
  await expect(page.locator(".summary-stat")).toHaveText(quickSummary ?? "");
  await expect(page.locator("tbody tr")).toHaveCount(6);
  await expect(page.locator("#stopping-target")).toHaveCount(0);
  await expect(page.getByText("本会话判断记录（1）")).toBeVisible();
  const rightItemPicker = page.getByRole("combobox", { name: "右侧条目" });
  await rightItemPicker.fill("电脑线圈");
  await expect(page.getByRole("option", { name: /电脑线圈/ })).toBeVisible();
  await rightItemPicker.press("Enter");
  await expect(rightItemPicker).toHaveValue(/电脑线圈/);
  await page.getByLabel("手动比较结果").selectOption("tie");
  await page.getByRole("button", { name: "添加比较" }).click();
  await expect(page.getByText("本会话判断记录（2）")).toBeVisible();
  await expect(page.locator(".comparison-record.manual")).toHaveCount(1);
  page.once("dialog", (dialog) => dialog.accept());
  await page.locator(".comparison-record.manual").getByRole("button", { name: /删除判断/ }).click();
  await expect(page.getByText("本会话判断记录（1）")).toBeVisible();
  await expect(page.locator(".comparison-record.manual")).toHaveCount(0);
  await page.locator("#result-distribution-preset").selectOption("uniform");
  await expect(page.locator("#result-distribution-preset")).toHaveValue("uniform");
  await page.getByRole("button", { name: /两两比较/ }).click();
  await expect(page.getByText(/本次已完成/)).toContainText("1");
  await page.getByRole("button", { name: /收藏概览/ }).click();
  await expect(page.getByText(/无答题上限/)).toHaveCount(0);
  await expect(page.getByText(/上限 \d+ 次/)).toHaveCount(0);
  await page.getByRole("button", { name: "调整标签范围" }).click();
  await expect(page.getByRole("heading", { name: "调整标签范围" })).toBeVisible();
  await page.locator(".scope-modal .tag-filter-selected button").filter({ hasText: "经典" }).click();
  await expect(page.getByRole("dialog", { name: "调整标签范围" }).getByText("未选择标签，包含当前基础范围的全部 16 部作品")).toBeVisible();
  await expect(page.locator(".scope-preview")).toContainText("6 → 16");
  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toContain("作品：6 → 16");
    expect(dialog.message()).toContain("继承 1 条有效判断");
    await dialog.accept();
  });
  await page.getByRole("button", { name: "预览并创建" }).click();
  await expect(page.getByRole("heading", { name: "哪一部在你的偏好中更靠前？" })).toBeVisible();
  await expect(page.getByText(/本次已完成/)).toContainText("1");
  await page.getByRole("button", { name: /收藏概览/ }).click();
  await expect(page.locator(".session-row")).toHaveCount(2);
  await expect(page.getByText("标签范围：全部标签")).toBeVisible();

  await page.getByRole("button", { name: "切换账号" }).click();
  await expect(page).toHaveURL(/#connect$/);
  await expect(page.getByRole("heading", { name: "连接其他 Bangumi 账号" })).toBeVisible();
  await expect(page.getByText("当前账号 @demo 的本地数据会完整保留。")).toBeVisible();
  await page.getByRole("button", { name: "返回当前账号 · @demo" }).click();
  await expect(page).toHaveURL(/#library$/);
  await expect(page.getByRole("heading", { name: /demo 的已评分收藏/ })).toBeVisible();

  await page.route("https://api.bgm.tv/v0/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/v0/users/demo") {
      await route.fulfill({
        json: { username: "demo", nickname: "演示项目" },
        headers: { "access-control-allow-origin": "*" },
      });
      return;
    }
    if (url.pathname === "/v0/users/demo/collections") {
      await route.fulfill({
        json: {
          total: 16,
          limit: 50,
          offset: 0,
          data: Array.from({ length: 16 }, (_, index) => ({
            subject_id: 900000 + index,
            subject_type: 2,
            rate: index < 7 ? 9 : 8,
            type: 2,
            private: false,
            tags: index % 3 === 0 ? ["demo", "经典"] : ["demo"],
            subject: {
              id: 900000 + index,
              type: 2,
              name: `同步作品 ${index + 1}`,
              name_cn: `同步作品 ${index + 1}`,
              date: `${2000 + index}-01-01`,
            },
          })),
        },
        headers: { "access-control-allow-origin": "*" },
      });
      return;
    }
    await route.abort();
  });
  await page.getByRole("button", { name: "重新同步" }).click();
  await expect(page).toHaveURL(/#library$/);
  const resyncDialog = page.getByRole("dialog", { name: "重新同步 demo" });
  await expect(resyncDialog).toBeVisible();
  await expect(resyncDialog.getByText("@demo")).toBeVisible();
  await resyncDialog.getByRole("button", { name: "同步当前账号" }).click();
  await expect(resyncDialog).toHaveCount(0);
  await expect(page).toHaveURL(/#library$/);
  await expect(page.getByText(/共 16 个条目/)).toBeVisible();
  await expect(page.getByRole("button", { name: "升级到当前收藏" }).first()).toBeVisible();
  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toContain("作品：16 → 16");
    expect(dialog.message()).toContain("继承 1 条有效判断");
    await dialog.accept();
  });
  await page.getByRole("button", { name: "升级到当前收藏" }).first().click();
  await expect(page.getByRole("heading", { name: "哪一部在你的偏好中更靠前？" })).toBeVisible();
  await expect(page.getByText(/本次已完成/)).toContainText("1");
  await page.getByRole("button", { name: /备份与导出/ }).click();
  await expect(page.getByRole("button", { name: /下载 JSON 备份/ })).toBeVisible();
  await page.getByRole("button", { name: /收藏概览/ }).click();
  const sessionCount = await page.locator(".session-row").count();
  for (let remaining = sessionCount; remaining > 0; remaining -= 1) {
    page.once("dialog", (dialog) => dialog.accept());
    await page.locator(".session-delete").first().click();
    await expect(page.locator(".session-row")).toHaveCount(remaining - 1);
  }
  await expect(page.getByText("还没有会话，选择范围后开始第一次比较。")).toBeVisible();
});
