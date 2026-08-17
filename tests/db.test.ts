import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { createDemoItems } from "../lib/demo";
import { fitModel, toModelState } from "../lib/ranking/engine";
import {
  commitResponse, createSession, db, exportProject, getSessionBundle, importProject,
  initializeModel, lastActiveResponse, saveSnapshot,
} from "../lib/db";

beforeEach(async () => {
  db.close();
  await db.delete();
  await db.open();
});

describe("IndexedDB project persistence", () => {
  it("atomically saves responses and rejects stale model versions", async () => {
    const snapshotId = crypto.randomUUID();
    const items = createDemoItems(snapshotId).slice(0, 3);
    const snapshot = await saveSnapshot({ username: "demo", nickname: "Demo" }, snapshotId, items);
    const session = await createSession(snapshot, 2, [2], { preset: "uniform", weights: Array(10).fill(10) });
    const fitted = fitModel(items.map(({ subjectId, rate }) => ({ subjectId, rate })), []);
    const model = toModelState(session.id, 0, fitted);
    await initializeModel(session.id, model);
    const pair = { leftSubjectId: items[0].subjectId, rightSubjectId: items[1].subjectId };
    const nextFit = fitModel(items.map(({ subjectId, rate }) => ({ subjectId, rate })), [{ ...pair, outcome: "left" }]);
    const nextModel = toModelState(session.id, 1, nextFit, model.initialMeanUncertainty);
    await commitResponse(session.id, 0, pair, "left", nextModel);
    await expect(commitResponse(session.id, 0, pair, "right", nextModel)).rejects.toThrow(/其他页面更新/);
    const bundle = await getSessionBundle(session.id);
    expect(bundle?.history).toHaveLength(1);
    expect(bundle?.session.modelVersion).toBe(1);
    expect((await lastActiveResponse(session.id))?.outcome).toBe("left");
  });

  it("round-trips a backup as a non-destructive new project", async () => {
    const snapshotId = crypto.randomUUID();
    const items = createDemoItems(snapshotId).slice(0, 2);
    const snapshot = await saveSnapshot({ username: "demo", nickname: "Demo" }, snapshotId, items);
    await createSession(snapshot, 2, [2], { preset: "uniform", weights: Array(10).fill(10) });
    const payload = await exportProject("demo");
    const imported = await importProject(payload);
    expect(imported.id).not.toBe("demo");
    expect(imported.username).toContain("导入");
    expect(await db.profiles.count()).toBe(2);
    expect(await db.snapshots.count()).toBe(2);
    expect(await db.sessions.count()).toBe(2);
  });
});
