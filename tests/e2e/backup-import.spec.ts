import { expect, test, type Page } from "@playwright/test";

type BackupOverrides = {
  username?: string;
  nickname?: string;
  snapshotId?: string;
  sessionId?: string;
  sessionTitle?: string;
  syncedAt?: string;
};

function backupPayload(overrides: BackupOverrides = {}) {
  const username = overrides.username ?? "Alice";
  const profileId = username.toLowerCase();
  const snapshotId = overrides.snapshotId ?? `${profileId}-snapshot`;
  const sessionId = overrides.sessionId ?? `${profileId}-session`;
  const timestamp = overrides.syncedAt ?? "2026-08-19T02:00:00.000Z";
  const subjectIds = [710001, 710002];
  return {
    schemaVersion: 1,
    appVersion: "0.16.0",
    exportedAt: "2026-08-19T03:00:00.000Z",
    profile: {
      id: profileId,
      username,
      nickname: overrides.nickname ?? `${username} Backup`,
      createdAt: "2026-08-18T00:00:00.000Z",
      updatedAt: timestamp,
    },
    snapshots: [{
      id: snapshotId, profileId, username, syncedAt: timestamp, itemCount: subjectIds.length, containsPrivate: false,
    }],
    items: subjectIds.map((subjectId, index) => ({
      snapshotId, subjectId, subjectType: 2, collectionType: 2, rate: 9 - index,
      name: `${username} Work ${index + 1}`, nameCn: `${username} 作品 ${index + 1}`,
      private: false, tags: ["备份"],
    })),
    sessions: [{
      id: sessionId, profileId, snapshotId, subjectType: 2, collectionTypes: [2],
      title: overrides.sessionTitle ?? `${username} 的备份会话`, status: "active",
      distribution: { preset: "uniform", levelCount: 10, weights: Array(10).fill(10) },
      randomSeed: 1, modelVersion: 0, budgetMode: "quick",
      comparisonReusePolicy: "session", comparisonHistoryMode: "local",
      createdAt: timestamp, updatedAt: timestamp,
    }],
    sessionItems: subjectIds.map((subjectId) => ({ id: `${sessionId}:${subjectId}`, sessionId, subjectId })),
    comparisons: [],
    importBatches: [],
    models: [],
  };
}

function dependentBackupPayload() {
  const payload = backupPayload({ sessionTitle: "父会话" });
  const parent = payload.sessions[0];
  const childId = "alice-dependent-child";
  payload.sessions.push({
    ...parent,
    id: childId,
    title: "依赖父会话的子会话",
    upgradedFromSessionId: parent.id,
  } as typeof parent);
  payload.sessionItems.push(...payload.sessionItems.map((entry) => ({
    ...entry,
    id: `${childId}:${entry.subjectId}`,
    sessionId: childId,
  })));
  return payload;
}

async function ready(page: Page) {
  await page.goto("/");
  await page.locator("html[data-resorter-ready='true']").waitFor();
}

async function seedLegacyCloneDatabase(page: Page) {
  await page.goto("/principles");
  await page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      // Dexie stores declared version 5 as native IndexedDB version 50.
      const request = indexedDB.open("bangumi-resorter", 50);
      request.onerror = () => reject(request.error);
      request.onupgradeneeded = () => {
        const created = request.result;
        const store = (name: string, keyPath: string | string[], indexes: Array<string | string[]> = []) => {
          const objectStore = created.createObjectStore(name, { keyPath });
          for (const index of indexes) objectStore.createIndex(Array.isArray(index) ? `[${index.join("+")}]` : index, index);
        };
        store("profiles", "id", ["username", "updatedAt"]);
        store("snapshots", "id", ["profileId", "syncedAt"]);
        store("items", ["snapshotId", "subjectId"], ["snapshotId", "subjectId", "subjectType", "collectionType", "rate"]);
        store("sessions", "id", ["profileId", "snapshotId", "subjectType", "status", "updatedAt"]);
        store("sessionItems", "id", ["sessionId", "subjectId", ["sessionId", "subjectId"]]);
        store("comparisons", "id", ["profileId", "sessionId", "subjectType", "active", "createdAt", "importBatchId", "importedFromSessionId"]);
        store("models", "sessionId", ["version", "updatedAt"]);
        store("importBatches", "id", ["profileId", "targetSessionId", "sourceSessionId", "createdAt", "type"]);
        store("meta", "key");
      };
      request.onsuccess = () => resolve(request.result);
    });
    const timestamp = "2026-08-19T02:00:00.000Z";
    const transaction = database.transaction([
      "profiles", "snapshots", "items", "sessions", "sessionItems", "comparisons", "models", "importBatches", "meta",
    ], "readwrite");
    const put = (store: string, value: object) => transaction.objectStore(store).put(value);
    put("profiles", { id: "alice-real", username: "Alice", nickname: "当前账号", createdAt: "2026-08-16T00:00:00.000Z", updatedAt: timestamp });
    put("profiles", { id: "alice-real:import:1234abcd", username: "Alice（导入）", nickname: "旧导入", createdAt: "2026-08-17T00:00:00.000Z", updatedAt: timestamp });
    put("snapshots", { id: "alice-current", profileId: "alice-real", username: "Alice", syncedAt: "2026-08-19T03:00:00.000Z", itemCount: 2, containsPrivate: false });
    put("snapshots", { id: "alice-legacy", profileId: "alice-real:import:1234abcd", username: "Alice（导入）", syncedAt: "2026-08-18T03:00:00.000Z", itemCount: 2, containsPrivate: false });
    for (const [snapshotId, base] of [["alice-current", 720000], ["alice-legacy", 730000]] as const) {
      for (let index = 1; index <= 2; index += 1) {
        put("items", {
          snapshotId, subjectId: base + index, subjectType: 2, collectionType: 2, rate: 10 - index,
          name: `${snapshotId} work ${index}`, nameCn: `${snapshotId} 作品 ${index}`, private: false, tags: [],
        });
      }
    }
    put("sessions", {
      id: "alice-legacy-session", profileId: "alice-real:import:1234abcd", snapshotId: "alice-legacy",
      subjectType: 2, collectionTypes: [2], title: "旧导入会话", status: "complete",
      distribution: { preset: "uniform", levelCount: 10, weights: Array(10).fill(10) }, randomSeed: 1,
      modelVersion: 1, budgetMode: "quick", comparisonReusePolicy: "session", comparisonHistoryMode: "local",
      createdAt: timestamp, updatedAt: timestamp,
    });
    for (const subjectId of [730001, 730002]) {
      put("sessionItems", { id: `alice-legacy-session:${subjectId}`, sessionId: "alice-legacy-session", subjectId });
    }
    put("comparisons", {
      id: "alice-legacy-comparison", profileId: "alice-real:import:1234abcd", sessionId: "alice-legacy-session",
      subjectType: 2, leftSubjectId: 730001, rightSubjectId: 730002, outcome: "left", queryKind: "adaptive",
      acceptedCountAtAnswer: 1, active: true, createdAt: timestamp,
    });
    put("models", {
      sessionId: "alice-legacy-session", version: 1, abilities: {}, uncertainty: {}, acceptedComparisons: 1,
      initialMeanUncertainty: 1, currentMeanUncertainty: 1, converged: true, iterations: 1, updatedAt: timestamp,
    });
    put("importBatches", {
      id: "alice-legacy-batch", profileId: "alice-real:import:1234abcd", targetSessionId: "alice-legacy-session",
      targetSnapshotId: "alice-legacy", type: "migration", createdAt: timestamp, importedCount: 1,
      duplicateOriginalCount: 0, duplicatePairCount: 0, outOfScopeCount: 0, skippedCount: 0, invalidCalibrationCount: 0,
    });
    put("meta", { key: "active-snapshot", value: JSON.stringify({ profileId: "alice-real:import:1234abcd", snapshotId: "alice-legacy" }) });
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
    database.close();
  });
}

async function uploadBackup(page: Page, payload: object, name = "backup.json") {
  await page.locator(".connect-card .file-input, .backup-card .file-input").last().setInputFiles({
    name,
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(payload)),
  });
}

test("blank landing page imports a complete project and restores it after refresh", async ({ page }) => {
  await ready(page);
  const payload = backupPayload();
  await uploadBackup(page, payload);
  const dialog = page.getByRole("dialog", { name: "恢复 @Alice" });
  await expect(dialog).toContainText("本机没有这个账号");
  await expect(dialog).toContainText("SHA-256");
  await dialog.getByRole("button", { name: "继续最终确认" }).click();
  await dialog.getByRole("button", { name: "创建完整项目" }).click();

  await expect(page.getByRole("heading", { name: "Alice 的已评分收藏" })).toBeVisible();
  await expect(page.getByText(/项目创建完成：导入 1 个会话/)).toBeVisible();
  await expect(page.locator(".session-row")).toContainText("Alice 的备份会话");

  await page.reload();
  await page.locator("html[data-resorter-ready='true']").waitFor();
  await expect(page.getByRole("heading", { name: "Alice 的已评分收藏" })).toBeVisible();
});

test("same-account import defaults to merge, becomes idempotent, and replace requires the username", async ({ page }) => {
  await ready(page);
  const original = backupPayload({ sessionTitle: "原始会话" });
  await uploadBackup(page, original, "original.json");
  let dialog = page.getByRole("dialog", { name: "恢复 @Alice" });
  await dialog.getByRole("button", { name: "继续最终确认" }).click();
  await dialog.getByRole("button", { name: "创建完整项目" }).click();
  await expect(page.getByRole("heading", { name: "Alice 的已评分收藏" })).toBeVisible();

  await page.getByRole("button", { name: "备份与导出" }).click();
  const changed = backupPayload({ sessionTitle: "备份中的冲突副本", nickname: "Restored nickname" });
  await uploadBackup(page, changed, "changed.json");
  dialog = page.getByRole("dialog", { name: "恢复 @Alice" });
  await expect(dialog.getByRole("radio", { name: "选择性合并" })).toBeChecked();
  await expect(dialog).toContainText("冲突另存");
  await dialog.getByRole("button", { name: "继续最终确认" }).click();
  await dialog.getByRole("button", { name: "确认合并 1 个会话" }).click();
  await expect(page.getByText(/选择性合并完成：导入 1 个会话.*冲突 1 个/)).toBeVisible();
  await expect(page.locator(".session-row")).toHaveCount(2);

  await page.getByRole("button", { name: "备份与导出" }).click();
  await uploadBackup(page, changed, "changed-again.json");
  dialog = page.getByRole("dialog", { name: "恢复 @Alice" });
  await expect(dialog).toContainText("已存在");
  await expect(dialog.getByRole("button", { name: "继续最终确认" })).toBeDisabled();
  await dialog.getByRole("button", { name: "关闭导入向导" }).click();

  const replacement = backupPayload({ sessionTitle: "覆盖后的会话", nickname: "覆盖后的昵称" });
  await uploadBackup(page, replacement, "replacement.json");
  dialog = page.getByRole("dialog", { name: "恢复 @Alice" });
  await dialog.getByRole("radio", { name: "覆盖恢复" }).check();
  await dialog.getByRole("button", { name: "继续最终确认" }).click();
  const replaceButton = dialog.getByRole("button", { name: "覆盖并恢复" });
  await expect(replaceButton).toBeDisabled();
  await dialog.getByLabel(/输入账号名/).fill("wrong");
  await expect(replaceButton).toBeDisabled();
  await dialog.getByLabel(/输入账号名/).fill("Alice");
  await replaceButton.click();
  await expect(page.getByText(/覆盖恢复完成：导入 1 个会话/)).toBeVisible();
  await expect(page.locator(".session-row")).toHaveCount(1);
  await expect(page.locator(".session-row")).toContainText("覆盖后的会话");
});

test("selective merge locks required session dependencies and stays idempotent", async ({ page }) => {
  await ready(page);
  const initial = backupPayload({ sessionTitle: "父会话" });
  await uploadBackup(page, initial, "dependency-initial.json");
  let dialog = page.getByRole("dialog", { name: "恢复 @Alice" });
  await dialog.getByRole("button", { name: "继续最终确认" }).click();
  await dialog.getByRole("button", { name: "创建完整项目" }).click();

  await page.getByRole("button", { name: "备份与导出" }).click();
  const dependent = dependentBackupPayload();
  await uploadBackup(page, dependent, "dependency-child.json");
  dialog = page.getByRole("dialog", { name: "恢复 @Alice" });
  const parentOption = dialog.locator(".backup-session-option").filter({ has: page.getByText("父会话", { exact: true }) });
  const childOption = dialog.locator(".backup-session-option").filter({ has: page.getByText("依赖父会话的子会话", { exact: true }) });
  const childCheckbox = childOption.getByRole("checkbox");
  await expect(parentOption).toContainText("依赖必选");
  await expect(parentOption.getByRole("checkbox")).toBeChecked();
  await expect(parentOption.getByRole("checkbox")).toBeDisabled();

  await childCheckbox.click();
  await expect(childCheckbox).not.toBeChecked();
  await expect(parentOption).toContainText("已存在");
  await expect(parentOption.getByRole("checkbox")).not.toBeChecked();
  await expect(dialog.getByRole("button", { name: "继续最终确认" })).toBeDisabled();
  await childCheckbox.click();
  await expect(childCheckbox).toBeChecked();
  await expect(parentOption).toContainText("依赖必选");
  await dialog.getByRole("button", { name: "继续最终确认" }).click();
  await dialog.getByRole("button", { name: "确认合并 1 个会话" }).click();
  await expect(page.locator(".session-row")).toHaveCount(2);

  await page.getByRole("button", { name: "备份与导出" }).click();
  await uploadBackup(page, dependent, "dependency-child-again.json");
  dialog = page.getByRole("dialog", { name: "恢复 @Alice" });
  await expect(dialog).toContainText("已存在");
  await expect(dialog.getByRole("button", { name: "继续最终确认" })).toBeDisabled();
});

test("imports a second account, switches accounts and snapshots, and rejects invalid files without writes", async ({ page }) => {
  await ready(page);
  const aliceOld = backupPayload({ snapshotId: "alice-old", syncedAt: "2026-08-17T02:00:00.000Z", sessionId: "alice-old-session" });
  await uploadBackup(page, aliceOld, "alice-old.json");
  let dialog = page.getByRole("dialog", { name: "恢复 @Alice" });
  await dialog.getByRole("button", { name: "继续最终确认" }).click();
  await dialog.getByRole("button", { name: "创建完整项目" }).click();
  await page.getByRole("button", { name: "备份与导出" }).click();
  const aliceNew = backupPayload({ snapshotId: "alice-new", syncedAt: "2026-08-19T02:00:00.000Z", sessionId: "alice-new-session", sessionTitle: "Alice 新快照会话" });
  await uploadBackup(page, aliceNew, "alice-new.json");
  dialog = page.getByRole("dialog", { name: "恢复 @Alice" });
  await dialog.getByRole("button", { name: "继续最终确认" }).click();
  await dialog.getByRole("button", { name: "确认合并 1 个会话" }).click();
  await page.getByRole("button", { name: "备份与导出" }).click();

  const bob = backupPayload({ username: "Bob", snapshotId: "bob-snapshot", sessionId: "bob-session", sessionTitle: "Bob 会话" });
  await uploadBackup(page, bob, "bob.json");
  dialog = page.getByRole("dialog", { name: "恢复 @Bob" });
  await dialog.getByRole("button", { name: "继续最终确认" }).click();
  await dialog.getByRole("button", { name: "创建完整项目" }).click();
  await expect(page.getByRole("heading", { name: "Bob 的已评分收藏" })).toBeVisible();

  const switcher = page.locator("#local-project-switcher");
  await switcher.click();
  await expect(page.getByRole("listbox", { name: "本地项目与收藏快照选项" })).toContainText("@Alice");
  await page.getByRole("option", { name: /@Alice.*2026年8月19日/ }).click();
  await expect(page.getByRole("heading", { name: "Alice 的已评分收藏" })).toBeVisible();
  await switcher.click();
  await page.getByRole("option", { name: /@Alice.*2026年8月17日/ }).click();
  await expect(page.getByRole("heading", { name: "Alice 的已评分收藏" })).toBeVisible();
  await page.reload();
  await page.locator("html[data-resorter-ready='true']").waitFor();
  await expect(page.locator("#local-project-switcher")).toHaveAttribute("data-value", "alice-old");

  await page.getByRole("button", { name: "备份与导出" }).click();
  const historyBefore = await page.locator(".import-history-list details").count();
  await page.locator(".backup-card .file-input").setInputFiles({ name: "invalid.json", mimeType: "application/json", buffer: Buffer.from("not-json") });
  await expect(page.getByRole("alert")).toContainText("不是有效的 JSON");
  await expect(page.locator(".import-history-list details")).toHaveCount(historyBefore);
});

test("deletes a migrated legacy clone and switches to the remaining snapshot", async ({ page }) => {
  await seedLegacyCloneDatabase(page);
  await ready(page);
  await expect(page.locator("#local-project-switcher")).toHaveAttribute("data-value", "alice-legacy");
  await expect(page.locator(".profile-mini")).toContainText("旧导入副本");

  await page.locator(".profile-mini").getByRole("button", { name: "删除这个旧导入副本" }).click();
  const dialog = page.getByRole("dialog", { name: "删除旧导入副本" });
  await expect(dialog).toContainText("收藏条目 2");
  await expect(dialog).toContainText("会话 1");
  await expect(dialog).toContainText("判断 1");
  await expect(dialog).toContainText("导入批次 1");
  await expect(dialog).toContainText("模型 1");
  await expect(dialog).toContainText("同账号最近的剩余快照");
  const removeButton = dialog.getByRole("button", { name: "永久删除副本" });
  await expect(removeButton).toBeDisabled();
  await dialog.getByLabel(/输入账号名 Alice/).fill("wrong");
  await expect(removeButton).toBeDisabled();
  await dialog.getByLabel(/输入账号名 Alice/).fill("Alice");
  await removeButton.click();

  await expect(page.locator("#local-project-switcher")).toHaveAttribute("data-value", "alice-current");
  await expect(page.getByText(/已删除旧导入副本，以及关联的 1 个会话和 1 条判断/)).toBeVisible();
  await page.locator("#local-project-switcher").click();
  await expect(page.getByRole("listbox", { name: "本地项目与收藏快照选项" })).not.toContainText("旧导入副本");
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "备份与导出" }).click();
  await expect(page.locator(".import-history-list")).toContainText("删除旧导入副本");
  await expect(page.locator(".import-history-list")).toContainText("删除 1 个会话、1 条判断");
  await page.reload();
  await page.locator("html[data-resorter-ready='true']").waitFor();
  await expect(page.locator("#local-project-switcher")).toHaveAttribute("data-value", "alice-current");
  await expect(page.locator(".profile-mini").getByRole("button", { name: "删除这个旧导入副本" })).toHaveCount(0);
});

test("mobile backup wizard and project switcher remain usable", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await ready(page);
  await uploadBackup(page, backupPayload(), "mobile.json");
  const dialog = page.getByRole("dialog", { name: "恢复 @Alice" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "继续最终确认" }).click();
  await expect(dialog.getByRole("button", { name: "创建完整项目" })).toBeVisible();
  await dialog.getByRole("button", { name: "创建完整项目" }).click();
  await expect(page.locator("#mobile-project-switcher")).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});
