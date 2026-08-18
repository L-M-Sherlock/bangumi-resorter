import { expect, test, type Page } from "@playwright/test";

const mobileViewports = [
  { width: 360, height: 800 },
  { width: 390, height: 844 },
  { width: 412, height: 915 },
];

async function expectNoHorizontalOverflow(page: Page) {
  const metrics = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth);
}

test.describe("移动端 UI/UX", () => {
  test("连接首屏在常见窄视口可操作", async ({ page }) => {
    await page.goto("/");
    await page.locator("html[data-resorter-ready='true']").waitFor();

    for (const viewport of mobileViewports) {
      await page.setViewportSize(viewport);
      await expect(page.getByRole("heading", { name: /让你的评分.*重新变得有意义/ })).toBeVisible();
      await expectNoHorizontalOverflow(page);
      const metrics = await page.evaluate(() => {
        const cta = [...document.querySelectorAll(".connect-card .primary-button")][0];
        const input = document.querySelector<HTMLInputElement>(".connect-card input");
        const tokenToggle = document.querySelector<HTMLElement>(".token-field button");
        const rect = cta?.getBoundingClientRect();
        return {
          ctaBottom: rect?.bottom ?? Number.POSITIVE_INFINITY,
          ctaWidth: rect?.width ?? 0,
          inputFontSize: input ? getComputedStyle(input).fontSize : "",
          tokenToggleHeight: tokenToggle?.getBoundingClientRect().height ?? 0,
          fixedThemes: [...document.querySelectorAll(".theme-toggle")].filter((element) => getComputedStyle(element).position === "fixed").length,
        };
      });
      expect(metrics.ctaBottom).toBeLessThanOrEqual(viewport.height);
      expect(metrics.ctaWidth).toBeGreaterThanOrEqual(280);
      expect(metrics.inputFontSize).toBe("16px");
      expect(metrics.tokenToggleHeight).toBeGreaterThanOrEqual(44);
      expect(metrics.fixedThemes).toBe(0);
    }
  });

  test("导航、比较和结果在移动端保持可达", async ({ page }) => {
    await page.goto("/");
    await page.locator("html[data-resorter-ready='true']").waitFor();
    await page.getByRole("button", { name: "先用演示数据体验" }).click();
    await expect(page.getByRole("heading", { name: /demo 的已评分收藏/ })).toBeVisible();

    for (const viewport of mobileViewports) {
      await page.setViewportSize(viewport);
      await expectNoHorizontalOverflow(page);
      const navMetrics = await page.locator(".sidebar nav").evaluate((nav) => [...nav.querySelectorAll<HTMLElement>("button, summary")].map((element) => {
        const rect = element.getBoundingClientRect();
        return { width: rect.width, height: rect.height, right: rect.right };
      }));
      expect(navMetrics).toHaveLength(5);
      for (const metric of navMetrics) {
        expect(metric.height).toBeGreaterThanOrEqual(44);
        expect(metric.right).toBeLessThanOrEqual(viewport.width);
      }
      await expect(page.getByRole("button", { name: "重新同步" })).toBeVisible();
      await expect(page.getByRole("button", { name: "切换账号" })).toBeVisible();
    }

    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: /开始快速比较 · 动态停止/ }).click();
    await expect(page.getByRole("heading", { name: "哪一部在你的偏好中更靠前？" })).toBeVisible();
    await expect(page.getByRole("button", { name: "查看诊断" })).toBeVisible();
    await expect(page.locator("#compare-diagnostics")).toBeHidden();
    await page.getByRole("button", { name: "查看诊断" }).click();
    await expect(page.getByRole("button", { name: "收起诊断" })).toBeVisible();
    await expect(page.locator("#compare-diagnostics")).toBeVisible();
    await page.getByRole("button", { name: "收起诊断" }).click();

    const compareMetrics = await page.evaluate(() => {
      const cards = [...document.querySelectorAll<HTMLElement>(".media-card")].map((element) => {
        const rect = element.getBoundingClientRect();
        return { left: rect.left, right: rect.right, bottom: rect.bottom };
      });
      const choices = [...document.querySelectorAll<HTMLElement>(".choice-button")].map((element) => {
        const rect = element.getBoundingClientRect();
        return { left: rect.left, right: rect.right, bottom: rect.bottom, height: rect.height };
      });
      return { cards, choices, clientWidth: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth };
    });
    expect(compareMetrics.scrollWidth).toBeLessThanOrEqual(compareMetrics.clientWidth);
    expect(compareMetrics.cards).toHaveLength(2);
    for (const card of compareMetrics.cards) {
      expect(card.left).toBeGreaterThanOrEqual(0);
      expect(card.right).toBeLessThanOrEqual(compareMetrics.clientWidth);
    }
    for (const choice of compareMetrics.choices) {
      expect(choice.left).toBeGreaterThanOrEqual(0);
      expect(choice.right).toBeLessThanOrEqual(compareMetrics.clientWidth);
      expect(choice.height).toBeGreaterThanOrEqual(44);
      expect(choice.bottom).toBeLessThanOrEqual(844);
    }

    await page.getByRole("button", { name: /更喜欢这部/ }).first().click();
    await expect(page.getByText(/本次已完成/)).toContainText("1");
    await page.getByRole("button", { name: "查看当前结果" }).click();
    await expect(page.getByRole("heading", { name: "你的偏好序列" })).toBeVisible();
    await expect(page.locator(".ranking-cards")).toBeVisible();
    await expect(page.locator(".ranking-table-wrap")).toBeHidden();
    await expectNoHorizontalOverflow(page);
    const rankingPlacement = await page.evaluate(() => ({
      cardsTop: document.querySelector<HTMLElement>(".ranking-cards")?.getBoundingClientRect().top ?? Infinity,
      managerTop: document.querySelector<HTMLElement>(".comparison-manager")?.getBoundingClientRect().top ?? Infinity,
      externalLinkHeight: document.querySelector<HTMLElement>(".ranking-card-main > a")?.getBoundingClientRect().height ?? 0,
      detailsHeight: document.querySelector<HTMLElement>(".ranking-card details summary")?.getBoundingClientRect().height ?? 0,
    }));
    expect(rankingPlacement.cardsTop).toBeLessThan(rankingPlacement.managerTop);
    expect(rankingPlacement.externalLinkHeight).toBeGreaterThanOrEqual(44);
    expect(rankingPlacement.detailsHeight).toBeGreaterThanOrEqual(44);

    await page.getByRole("button", { name: "继续比较" }).click();
    await page.getByRole("button", { name: "暂停并返回收藏" }).click();
    await expect(page.getByRole("heading", { name: /demo 的已评分收藏/ })).toBeVisible();
    await page.getByRole("button", { name: "调整标签范围" }).click();
    await expect(page.getByRole("dialog", { name: "调整标签范围" })).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await page.getByRole("button", { name: "关闭标签范围窗口" }).click();

    await page.locator(".session-open").click();
    await expect(page.getByRole("heading", { name: "哪一部在你的偏好中更靠前？" })).toBeVisible();

    await page.getByRole("button", { name: "更多导航" }).click();
    await expect(page.getByRole("link", { name: /排序原理/ })).toBeVisible();
    await expect(page.getByRole("link", { name: "GitHub Star" })).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });
});
