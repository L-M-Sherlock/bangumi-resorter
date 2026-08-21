import { expect, test } from "@playwright/test";

test("ranking and the next pair unblock while only the newest forecast continues in background", async ({ page }) => {
  await page.addInitScript(() => {
    const NativeWorker = window.Worker;
    class DelayedForecastWorker extends NativeWorker {
      private delayed = false;
      private timers = new Set<number>();

      constructor(scriptURL: string | URL, options?: WorkerOptions) {
        super(scriptURL, options);
        this.delayed = String(scriptURL).includes("ranking-forecast.worker");
      }

      override postMessage(message: unknown, options?: StructuredSerializeOptions | Transferable[]) {
        const send = () => {
          if (Array.isArray(options)) super.postMessage(message, options);
          else super.postMessage(message, options);
        };
        if (!this.delayed) {
          send();
          return;
        }
        const timer = window.setTimeout(() => {
          this.timers.delete(timer);
          send();
        }, 750);
        this.timers.add(timer);
      }

      override terminate() {
        for (const timer of this.timers) window.clearTimeout(timer);
        this.timers.clear();
        super.terminate();
      }
    }
    Object.defineProperty(window, "Worker", { configurable: true, value: DelayedForecastWorker });
  });

  await page.goto("/");
  await page.locator("html[data-resorter-ready='true']").waitFor();
  await page.getByRole("button", { name: "先用演示数据体验" }).click();
  await page.getByRole("button", { name: /开始快速比较/ }).click();

  const firstChoice = page.getByRole("button", { name: /更喜欢这部/ }).first();
  await firstChoice.click();
  await expect(page.locator(".progress-copy")).toContainText("有效证据 1 次");
  await expect(firstChoice).toBeEnabled();
  await expect(page.locator(".forecast-row")).toContainText("正在建立预测");

  // A second answer arrives before the delayed version-1 forecast starts. The
  // client must terminate that job and keep only the version-2 request.
  await firstChoice.click();
  await expect(page.locator(".progress-copy")).toContainText("有效证据 2 次");
  await expect(firstChoice).toBeEnabled();
  await expect(page.locator(".forecast-row")).toContainText("正在建立预测");
  await expect(page.locator(".forecast-row")).not.toContainText("正在建立预测", { timeout: 30_000 });

  const stored = await page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("bangumi-resorter");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const models = await new Promise<Array<{ version: number; diagnostics?: { forecast?: unknown } }>>((resolve, reject) => {
      const transaction = database.transaction("models", "readonly");
      const request = transaction.objectStore("models").getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    database.close();
    return { version: models[0]?.version, hasForecast: Boolean(models[0]?.diagnostics?.forecast) };
  });
  expect(stored).toEqual({ version: 2, hasForecast: true });
});
