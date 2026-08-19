import { expect, test, type Page } from "@playwright/test";

async function openNewSessionSettings(page: Page) {
  const settings = page.locator(".start-settings");
  if (await settings.getAttribute("open") === null) await settings.locator(":scope > summary").click();
}

async function chooseHistorySource(page: Page, optionIndex: number) {
  await openNewSessionSettings(page);
  const root = page.locator('[data-themed-select="history-source"]');
  await page.locator("#history-source").click();
  await root.getByRole("option").nth(optionIndex).click();
}

async function mockDemoResync(page: Page) {
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
}

test("new sessions preview and materialize one cross-snapshot history source", async ({ page }) => {
  await page.goto("/");
  await page.locator("html[data-resorter-ready='true']").waitFor();
  await page.getByRole("button", { name: "先用演示数据体验" }).click();

  await openNewSessionSettings(page);
  await expect(page.locator("#history-source")).toHaveAttribute("data-value", "");
  await page.locator("#history-source").click();
  await expect(page.locator('[data-themed-select="history-source"]').getByRole("option"))
    .toHaveText(["不导入历史判断（默认）✓"]);
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: /开始快速比较/ }).click();
  await page.getByRole("button", { name: /更喜欢这部/ }).first().click();
  await expect(page.locator(".progress-copy")).toContainText("有效证据 1 次（新回答 1 · 导入 0）");
  await page.getByRole("button", { name: "暂停并返回收藏" }).click();

  await mockDemoResync(page);
  await page.getByRole("button", { name: "重新同步" }).click();
  await page.getByRole("dialog", { name: "重新同步 demo" })
    .getByRole("button", { name: "同步当前账号" }).click();
  await expect(page.getByRole("heading", { name: /demo 的已评分收藏/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "升级到当前收藏" })).toBeVisible();

  await chooseHistorySource(page, 1);
  await expect(page.locator(".start-panel .scope-preview")).toContainText("跨快照导入");
  await expect(page.locator(".start-panel .scope-preview")).toContainText("可导入 1 条");
  await expect(page.locator(".start-panel .scope-preview")).toContainText("已存在根判断 0");

  await chooseHistorySource(page, 0);
  await expect(page.locator(".start-panel .scope-preview")).toHaveCount(0);
  await expect(page.locator("#history-source")).toHaveAttribute("data-value", "");

  await chooseHistorySource(page, 1);
  await expect(page.locator(".start-panel .scope-preview")).toContainText("跨快照导入");
  await page.getByRole("button", { name: /开始快速比较/ }).click();
  await expect(page.locator(".progress-copy")).toContainText("有效证据 1 次（新回答 0 · 导入 1）");

  await page.getByRole("button", { name: /撤销上次/ }).click();
  await expect(page.getByText("还没有可撤销的回答。")).toBeVisible();
  await page.getByRole("button", { name: "查看当前结果" }).click();
  await expect(page.getByText("总有效证据 1 条 · 本会话新回答 0 条 · 导入证据 1 条")).toBeVisible();
  await expect(page.locator(".comparison-record")).toHaveCount(1);
  await expect(page.locator(".comparison-record")).toContainText("导入自 demo 的排序");

  await page.getByRole("button", { name: /收藏概览/ }).click();
  await expect(page.locator(".session-row")).toHaveCount(2);
  await expect(page.locator(".session-row").first()).toContainText("本地历史 · 导入 1 条");
  await expect(page.locator(".session-row").first()).toContainText("已有判断 1 条");
  page.once("dialog", (dialog) => dialog.accept());
  await page.locator(".session-row").nth(1).locator(".session-delete").click();
  await expect(page.locator(".session-row")).toHaveCount(1);
  await expect(page.locator(".session-row").first()).toContainText("本地历史 · 导入 1 条");

  await page.locator(".session-open").click();
  await expect(page.locator(".progress-copy")).toContainText("有效证据 1 次（新回答 0 · 导入 1）");
  await page.getByRole("button", { name: "查看当前结果" }).click();
  await expect(page.locator(".comparison-record")).toContainText("导入自 已删除来源");
  page.once("dialog", (dialog) => dialog.accept());
  await page.locator(".comparison-record .record-delete").click();
  await expect(page.getByText("本会话判断记录（0）")).toBeVisible();
  await expect(page.getByText("总有效证据 0 条 · 本会话新回答 0 条 · 导入证据 0 条")).toBeVisible();
});
