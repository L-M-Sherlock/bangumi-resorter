import { expect, test, type Page } from "@playwright/test";

async function expectThemedSelect(page: Page, id: string, value: string) {
  await expect(page.locator(`#${id}`)).toHaveAttribute("data-value", value);
}

async function selectThemedOption(page: Page, id: string, label: string) {
  const root = page.locator(`[data-themed-select="${id}"]`);
  const menu = root.getByRole("listbox");
  if (!await menu.isVisible()) await page.locator(`#${id}`).click();
  await menu.getByRole("option", { name: label, exact: true }).click();
}

test("demo project can filter, compare, derive, upgrade, edit records, and delete sessions", async ({ page }) => {
  await page.goto("/");
  await page.locator("html[data-resorter-ready='true']").waitFor();
  const landingStar = page.getByRole("link", { name: "在 GitHub 上 Star" });
  await expect(landingStar).toHaveAttribute("href", "https://github.com/L-M-Sherlock/bangumi-resorter");
  await expect(landingStar).toHaveAttribute("target", "_blank");
  await page.getByRole("button", { name: "先用演示数据体验" }).click();
  await expect(page.getByRole("heading", { name: /demo 的已评分收藏/ })).toBeVisible();
  const startButton = page.getByRole("button", { name: /开始快速比较/ });
  await expect(startButton).toBeVisible();
  expect(await startButton.evaluate((button) => button.getBoundingClientRect().bottom <= innerHeight)).toBe(true);
  expect(await startButton.evaluate((button) => getComputedStyle(button).whiteSpace)).toBe("nowrap");
  await expect(page.locator(".start-settings")).not.toHaveAttribute("open", "");
  await page.locator(".start-settings > summary").click();
  await expect(page.getByRole("link", { name: "GitHub Star" })).toHaveAttribute("href", "https://github.com/L-M-Sherlock/bangumi-resorter");
  await expect(page.getByRole("link", { name: /原理/ })).toHaveAttribute("href", "/principles");
  await expectThemedSelect(page, "prior-mode", "weak");
  await expect(page.getByText(/只保留很弱的零均值正则.*两两判断主导排序结果/)).toBeVisible();
  await expect(page.locator(".field-help").filter({ hasText: /快速停止.*80%.*作品.*90% MC 下界.*90%/ })).toBeVisible();
  await expect(page.getByText(/每次回答后动态重估剩余区间/)).toBeVisible();
  await expect(page.getByText(/答题次数上限/)).toHaveCount(0);
  await expect(page.getByText(/疲劳安全上限/)).toHaveCount(0);
  await expect(page.locator(".distribution-panel .distribution-stats")).toHaveCount(1);
  await expect(page.locator(".distribution-panel .distribution-stats")).toContainText(/平均值 .*标准差/);
  expect(await page.locator(".dashboard-grid").evaluate((grid) => getComputedStyle(grid).alignItems)).toBe("start");
  expect(await page.locator(".distribution-panel").evaluate((panel) => {
    const chart = panel.querySelector(".histogram");
    return chart ? panel.getBoundingClientRect().bottom - chart.getBoundingClientRect().bottom : Infinity;
  })).toBeLessThan(30);
  await expectThemedSelect(page, "score-level-count", "10");
  await page.locator("#distribution-preset").click();
  await expect(page.locator('[data-themed-select="distribution-preset"]').getByRole("option")).toHaveText(["均匀 10 档", "保持原分布", "高分辨率尾部✓", "反 J 分布", "自定义权重"]);
  await expectThemedSelect(page, "distribution-preset", "high-tail");
  await selectThemedOption(page, "score-level-count", "5 档");
  await page.locator("#distribution-preset").click();
  await expect(page.locator('[data-themed-select="distribution-preset"]').getByRole("option").first()).toHaveText("均匀 5 档");
  await selectThemedOption(page, "distribution-preset", "反 J 分布");
  await expect(page.getByText(/把最多作品放在低分档.*保持累计分布形状/)).toBeVisible();
  await page.locator("#new-session-tag-search").fill("经典");
  await page.getByRole("option", { name: /经典/ }).click();
  await expect(page.getByText("同时包含 1 个标签，匹配 6 部作品")).toBeVisible();
  await expect(page.getByText(/当前快速模式要求至少 80%.*当前 6 部作品中，允许最多 1 部跨两档/)).toBeVisible();
  await page.getByRole("button", { name: /开始快速比较/ }).click();
  await expect(page.getByRole("heading", { name: "哪一部在你的偏好中更靠前？" })).toBeVisible();
  await page.setViewportSize({ width: 375, height: 812 });
  for (const shortcut of [page.locator(".choice-button kbd"), page.locator(".secondary-actions kbd")]) {
    const count = await shortcut.count();
    for (let index = 0; index < count; index += 1) await expect(shortcut.nth(index)).toBeHidden();
  }
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(page.locator(".choice-button kbd").first()).toBeVisible();
  await expect(page.locator(".secondary-actions kbd").first()).toBeVisible();
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
  await expect(page.locator(".progress-copy")).toContainText("有效证据 1 次（新回答 1 · 导入 0）");
  await expectThemedSelect(page, "compare-budget-mode", "quick");
  await expectThemedSelect(page, "compare-prior-mode", "weak");
  await selectThemedOption(page, "compare-budget-mode", "标准模式 · 90% 覆盖");
  await expectThemedSelect(page, "compare-budget-mode", "standard");
  await expect(page.locator(".topbar .eyebrow")).toContainText("标准停止");
  await selectThemedOption(page, "compare-prior-mode", "强先验");
  await expectThemedSelect(page, "compare-prior-mode", "strong");
  await expect(page.locator(".topbar .eyebrow")).toContainText("强先验");
  await selectThemedOption(page, "compare-prior-mode", "弱先验");
  await expectThemedSelect(page, "compare-prior-mode", "weak");
  await expect(page.locator(".progress-copy")).toContainText("有效证据 1 次（新回答 1 · 导入 0）");
  await expect(page.getByText("动态剩余预测")).toBeVisible();
  await expect(page.getByText(/后验期望相邻容差覆盖 \d+%/)).toBeVisible();
  await expect(page.getByText("跨两档作品分布")).toBeVisible();
  await expect(page.getByText("最坏偏移分布")).toBeVisible();
  await expect(page.getByText("相邻容差可信度")).toHaveCount(0);
  await expect(page.getByText("未来 20 次内达标")).toHaveCount(0);
  await expect(page.getByText("安全余量")).toHaveCount(0);
  await expect(page.getByText(/\/ 参考/)).toHaveCount(0);
  const undoButton = page.getByRole("button", { name: /撤销上次.*⌘\/Ctrl Z/ });
  await expect(undoButton).toHaveAttribute("title", /Ctrl\+Z.*⌘Z/);
  await undoButton.click();
  await expect(page.locator(".progress-copy")).toContainText("有效证据 0 次（新回答 0 · 导入 0）");
  await expect(page.locator(".media-card h2").nth(0)).toHaveText(originalPair[0]);
  await expect(page.locator(".media-card h2").nth(1)).toHaveText(originalPair[1]);
  await page.getByRole("button", { name: /更喜欢这部/ }).first().click();
  await expect(page.locator(".progress-copy")).toContainText("有效证据 1 次（新回答 1 · 导入 0）");
  await page.getByRole("button", { name: "查看当前结果" }).click();
  await expect(page.getByRole("heading", { name: "你的偏好序列" })).toBeVisible();
  await expectThemedSelect(page, "result-budget-mode", "standard");
  await expectThemedSelect(page, "result-prior-mode", "weak");
  await selectThemedOption(page, "result-budget-mode", "精细模式 · 95% 覆盖");
  await expectThemedSelect(page, "result-budget-mode", "thorough");
  await expect(page.locator(".page-header .eyebrow")).toContainText("精细停止");
  await expect(page.getByText("本会话判断记录（1）")).toBeVisible();
  await expectThemedSelect(page, "result-distribution-preset", "reverse-j");
  await expectThemedSelect(page, "result-score-level-count", "5");
  await expect(page.locator('.distribution-chart .histogram[data-level-count="10"]')).toHaveCount(1);
  await expect(page.locator('.distribution-chart .histogram[data-level-count="5"]')).toHaveCount(1);
  await expect(page.locator('.distribution-chart .distribution-stats[data-series="原评分"]')).toHaveCount(1);
  await expect(page.locator('.distribution-chart .distribution-stats[data-series="新评分"]')).toHaveCount(1);
  await expect(page.getByText("预计跨两档作品")).toBeVisible();
  await expect(page.getByText(/80% 后验区间/)).toBeVisible();
  await expect(page.getByText("最坏偏移")).toBeVisible();
  await expect(page.getByText(/仅作尾部诊断/)).toBeVisible();
  await expect(page.getByText(/达标样本 .*每个样本允许最多 \d+ 部作品跨两档/)).toBeVisible();
  await expect(page.locator(".summary-stat")).toContainText(/三档覆盖目标依次为 快速 80%、标准 90%、精细 95%.*各自事件的.*均需达到 90%/);
  await expect(page.getByText(/仅保留弱零均值正则/)).toBeVisible();
  await expect(page.getByText("完全零错桶概率")).toHaveCount(0);
  await expect(page.getByText("未来 20 次内达标")).toHaveCount(0);
  await expect(page.getByText(/区间仅代表模型内近似/)).toBeVisible();
  let dangerZone = page.locator(".rating-write-danger");
  await expect(dangerZone).toBeVisible();
  await expect(page.locator(".comparison-manager + .rating-write-danger + .ranking-cards + .ranking-table-wrap")).toHaveCount(1);
  expect(await dangerZone.locator(":scope > summary strong").evaluate((element) => getComputedStyle(element).fontSize)).toBe("14px");
  await dangerZone.locator(":scope > summary").click();
  await expect(dangerZone.getByText(/当前结果是 5 档/)).toBeVisible();
  await expect(dangerZone.getByRole("button", { name: "检查写回变更" })).toHaveCount(0);
  await dangerZone.locator(":scope > summary").click();
  await selectThemedOption(page, "result-score-level-count", "12 档");
  await expectThemedSelect(page, "result-score-level-count", "12");
  await expect(page.getByText("本会话判断记录（1）")).toBeVisible();
  await expect(page.locator('.distribution-chart .histogram[data-level-count="12"]')).toHaveCount(1);
  await expect(page.getByRole("columnheader", { name: "新评分（12 档）" })).toBeVisible();
  await expect(page.locator(".score-pill.new.changed")).toHaveCount(0);
  expect(await page.getByRole("columnheader", { name: "精确分桶稳定度" }).evaluate((header) => getComputedStyle(header).whiteSpace)).toBe("nowrap");
  await selectThemedOption(page, "result-score-level-count", "10 档");
  await expectThemedSelect(page, "result-score-level-count", "10");
  await expect(page.getByRole("heading", { name: "原评分 → 新评分" })).toBeVisible();
  await expect(page.locator('.result-summary .histogram[data-level-count="10"]')).toHaveCount(1);
  await expect(page.locator('.comparison-histogram .distribution-stats')).toHaveCount(2);
  await expect(page.locator(".result-summary .histogram .bar-old")).toHaveCount(10);
  await expect(page.locator(".result-summary .histogram .bar-new")).toHaveCount(10);
  expect(await page.locator(".score-pill.new.changed").count()).toBeGreaterThan(0);
  const ratingRows = await page.locator(".ranking-table tbody tr").evaluateAll((rows) => rows.map((row) => {
    const href = row.querySelector<HTMLAnchorElement>("a[href*='/subject/']")?.href ?? "";
    return {
      subjectId: Number(href.split("/").pop()),
      snapshotRate: Number(row.querySelector(".score-pill.old")?.textContent),
      targetRate: Number(row.querySelector(".score-pill.new")?.textContent),
    };
  }));
  const readyCandidate = ratingRows.find((entry) => entry.snapshotRate !== entry.targetRate);
  expect(readyCandidate).toBeDefined();
  const unchangedCandidate = ratingRows.find((entry) => entry.subjectId !== readyCandidate?.subjectId)!;
  const conflictCandidate = ratingRows.find((entry) => ![readyCandidate?.subjectId, unchangedCandidate.subjectId].includes(entry.subjectId))!;
  const missingCandidate = ratingRows.find((entry) => ![readyCandidate?.subjectId, unchangedCandidate.subjectId, conflictCandidate.subjectId].includes(entry.subjectId))!;
  const conflictRate = Array.from({ length: 10 }, (_, index) => index + 1).find((rate) => rate !== conflictCandidate.snapshotRate && rate !== conflictCandidate.targetRate)!;
  const liveRatings = new Map(ratingRows.map((entry) => [entry.subjectId, entry.snapshotRate]));
  liveRatings.set(unchangedCandidate.subjectId, unchangedCandidate.targetRate);
  liveRatings.set(conflictCandidate.subjectId, conflictRate);
  liveRatings.delete(missingCandidate.subjectId);
  const patchedSubjectIds: number[] = [];
  await page.route("https://api.bgm.tv/v0/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname.endsWith("/me")) {
      await route.fulfill({ json: { username: "demo" } });
      return;
    }
    if (request.method() === "GET" && url.pathname.endsWith("/users/demo/collections")) {
      const data = ratingRows
        .filter((entry) => liveRatings.has(entry.subjectId))
        .map((entry) => ({ subject_id: entry.subjectId, subject_type: 2, rate: liveRatings.get(entry.subjectId), type: 2, private: false }));
      await route.fulfill({ json: { total: data.length, limit: 50, offset: 0, data } });
      return;
    }
    if (request.method() === "PATCH" && url.pathname.includes("/users/-/collections/")) {
      const subjectId = Number(url.pathname.split("/").pop());
      const body = request.postDataJSON() as { rate: number };
      patchedSubjectIds.push(subjectId);
      liveRatings.set(subjectId, body.rate);
      await route.fulfill({ status: 204, body: "" });
      return;
    }
    await route.abort();
  });
  dangerZone = page.locator(".rating-write-danger");
  await dangerZone.locator(":scope > summary").click();
  await expect(dangerZone.getByText(/尚未达到停止条件/)).toBeVisible();
  await dangerZone.getByLabel(/Bangumi 个人令牌/).fill("write-token");
  await dangerZone.getByRole("button", { name: "检查写回变更" }).click();
  await expect(dangerZone.getByRole("heading", { name: "写回预览" })).toBeVisible();
  await expect(dangerZone).toContainText("1 线上冲突");
  await expect(dangerZone).toContainText("1 已移出");
  const confirmInput = dangerZone.getByLabel(/输入账号名/);
  const writeButton = dangerZone.getByRole("button", { name: /永久写回/ });
  await confirmInput.fill("someone-else");
  await expect(writeButton).toBeDisabled();
  await confirmInput.fill("DEMO");
  await expect(writeButton).toBeEnabled();
  await writeButton.click();
  await expect(dangerZone.getByText(/已验证写回 \d+ 条/)).toBeVisible();
  await expect(dangerZone.getByRole("button", { name: "重新同步当前账号" })).toBeVisible();
  expect(patchedSubjectIds.length).toBeGreaterThan(0);
  expect(patchedSubjectIds).not.toContain(conflictCandidate.subjectId);
  expect(patchedSubjectIds).not.toContain(missingCandidate.subjectId);
  await expect(dangerZone.getByLabel(/Bangumi 个人令牌/)).toHaveValue("");
  await selectThemedOption(page, "result-score-level-count", "12 档");
  await expectThemedSelect(page, "result-score-level-count", "12");
  await expect(page.locator(".rating-write-danger")).not.toHaveAttribute("open", "");
  await expect(page.getByRole("heading", { name: "写回预览" })).toHaveCount(0);
  await selectThemedOption(page, "result-budget-mode", "快速模式 · 80% 覆盖");
  await expectThemedSelect(page, "result-budget-mode", "quick");
  const quickSummary = await page.locator(".summary-stat").textContent();
  await selectThemedOption(page, "result-budget-mode", "标准模式 · 90% 覆盖");
  await expectThemedSelect(page, "result-budget-mode", "standard");
  await selectThemedOption(page, "result-budget-mode", "精细模式 · 95% 覆盖");
  await expectThemedSelect(page, "result-budget-mode", "thorough");
  await selectThemedOption(page, "result-budget-mode", "快速模式 · 80% 覆盖");
  await expectThemedSelect(page, "result-budget-mode", "quick");
  await expect(page.locator(".summary-stat")).toHaveText(quickSummary ?? "");
  await expect(page.locator("tbody tr")).toHaveCount(6);
  await expect(page.locator("#stopping-target")).toHaveCount(0);
  await expect(page.getByText("本会话判断记录（1）")).toBeVisible();
  const leftItemPicker = page.getByRole("combobox", { name: "左侧条目" });
  const rightItemPicker = page.getByRole("combobox", { name: "右侧条目" });
  const leftItemLabel = await leftItemPicker.inputValue();
  const searchTitle = (await page.locator(".ranking-table tbody .title-cell > div > strong").allTextContents())
    .find((title) => !leftItemLabel.includes(title));
  expect(searchTitle).toBeDefined();
  await rightItemPicker.fill(searchTitle!);
  await expect(page.getByRole("option", { name: new RegExp(searchTitle!) })).toBeVisible();
  await rightItemPicker.press("Enter");
  await expect(rightItemPicker).toHaveValue(new RegExp(searchTitle!));
  await selectThemedOption(page, "manual-comparison-outcome", "差不多喜欢");
  await page.getByRole("button", { name: "添加比较" }).click();
  await expect(page.getByText("本会话判断记录（2）")).toBeVisible();
  await expect(page.locator(".comparison-record.manual")).toHaveCount(1);
  page.once("dialog", (dialog) => dialog.accept());
  await page.locator(".comparison-record.manual").getByRole("button", { name: /删除判断/ }).click();
  await expect(page.getByText("本会话判断记录（1）")).toBeVisible();
  await expect(page.locator(".comparison-record.manual")).toHaveCount(0);
  await selectThemedOption(page, "result-distribution-preset", "均匀 12 档");
  await expectThemedSelect(page, "result-distribution-preset", "uniform");
  await page.getByRole("button", { name: /两两比较/ }).click();
  await expect(page.locator(".progress-copy")).toContainText("有效证据 1 次");
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
    expect(dialog.message()).toContain("导入 1 条有效判断");
    await dialog.accept();
  });
  await page.getByRole("button", { name: "预览并创建" }).click();
  await expect(page.getByRole("heading", { name: "哪一部在你的偏好中更靠前？" })).toBeVisible();
  await expect(page.locator(".progress-copy")).toContainText("有效证据 1 次（新回答 0 · 导入 1）");
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
    expect(dialog.message()).toContain("导入 1 条有效判断");
    await dialog.accept();
  });
  await page.getByRole("button", { name: "升级到当前收藏" }).first().click();
  await expect(page.getByRole("heading", { name: "哪一部在你的偏好中更靠前？" })).toBeVisible();
  await expect(page.locator(".progress-copy")).toContainText("有效证据 1 次（新回答 0 · 导入 1）");
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

test("custom distribution weights allow replacing zero without creating a leading zero", async ({ page }) => {
  await page.goto("/");
  await page.locator("html[data-resorter-ready='true']").waitFor();
  await page.getByRole("button", { name: "先用演示数据体验" }).click();
  await page.locator(".start-settings > summary").click();
  await selectThemedOption(page, "distribution-preset", "自定义权重");

  const firstWeight = page.getByRole("spinbutton", { name: "1 分" });
  await firstWeight.fill("0");
  await expect(firstWeight).toHaveValue("0");
  await firstWeight.press("ControlOrMeta+A");
  await firstWeight.press("Backspace");
  await expect(firstWeight).toHaveValue("");
  await firstWeight.pressSequentially("1");
  await expect(firstWeight).toHaveValue("1");
  await firstWeight.press("Tab");
  await expect(firstWeight).toHaveValue("1");
});
