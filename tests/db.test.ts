import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { createDemoItems } from "../lib/demo";
import { fitModel, toModelState } from "../lib/ranking/engine";
import {
  commitResponse, commitSessionDistribution, createSession, db, exportProject, getSessionBundle, importProject,
  initializeModel, lastActiveResponse, saveSnapshot,
} from "../lib/db";
import type { ComparisonRecord } from "../lib/types";

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
    expect(session.budgetMode).toBe("quick");
    expect(session.comparisonReusePolicy).toBe("snapshot");
    expect(session.stoppingTarget).toBeUndefined();
    expect(session.suggestedComparisons).toBeUndefined();
    expect(session.maxComparisons).toBe(200);
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
    payload.sessions[0].stoppingTarget = "top-tail";
    payload.sessions[0].status = "complete";
    const imported = await importProject(payload);
    expect(imported.id).not.toBe("demo");
    expect(imported.username).toContain("导入");
    expect(await db.profiles.count()).toBe(2);
    expect(await db.snapshots.count()).toBe(2);
    expect(await db.sessions.count()).toBe(2);
    const importedSession = await db.sessions.where("profileId").equals(imported.id).first();
    expect(importedSession?.stoppingTarget).toBeUndefined();
    expect(importedSession?.status).toBe("active");
  });

  it("scopes reusable comparisons to the session, snapshot, or whole profile", async () => {
    const snapshotOneId = crypto.randomUUID();
    const firstItems = createDemoItems(snapshotOneId).slice(0, 2);
    const snapshotOne = await saveSnapshot({ username: "demo", nickname: "Demo" }, snapshotOneId, firstItems);
    const first = await createSession(snapshotOne, 2, [2], { preset: "uniform", weights: Array(10).fill(10) });
    const second = await createSession(snapshotOne, 2, [2], { preset: "uniform", weights: Array(10).fill(10) });

    const snapshotTwoId = crypto.randomUUID();
    const secondItems = firstItems.map((entry) => ({ ...entry, snapshotId: snapshotTwoId }));
    const snapshotTwo = await saveSnapshot({ username: "demo", nickname: "Demo" }, snapshotTwoId, secondItems);
    const snapshotOnly = await createSession(snapshotTwo, 2, [2], { preset: "uniform", weights: Array(10).fill(10) });
    const sessionOnly = await createSession(snapshotTwo, 2, [2], { preset: "uniform", weights: Array(10).fill(10) }, "quick", "session");
    const wholeProfile = await createSession(snapshotTwo, 2, [2], { preset: "uniform", weights: Array(10).fill(10) }, "quick", "profile");

    const pair = { leftSubjectId: firstItems[0].subjectId, rightSubjectId: firstItems[1].subjectId };
    const records: ComparisonRecord[] = [first, second, snapshotOnly, sessionOnly, wholeProfile].map((session, index) => ({
      id: `record-${index}`,
      profileId: "demo",
      sessionId: session.id,
      subjectType: 2,
      ...pair,
      outcome: "left",
      queryKind: "adaptive",
      acceptedCountAtAnswer: index + 1,
      active: true,
      createdAt: new Date(index * 1000).toISOString(),
    }));
    await db.comparisons.bulkAdd(records);

    expect((await getSessionBundle(second.id))?.history.map((entry) => entry.id).sort()).toEqual(["record-0", "record-1"]);
    expect((await getSessionBundle(snapshotOnly.id))?.history.map((entry) => entry.id).sort()).toEqual(["record-2", "record-3", "record-4"]);
    expect((await getSessionBundle(sessionOnly.id))?.history.map((entry) => entry.id)).toEqual(["record-3"]);
    expect((await getSessionBundle(wholeProfile.id))?.history).toHaveLength(5);

    await db.sessions.update(snapshotOnly.id, { comparisonReusePolicy: undefined });
    expect((await getSessionBundle(snapshotOnly.id))?.history).toHaveLength(5);
  });

  it("remaps calibration references when importing a backup", async () => {
    const snapshotId = crypto.randomUUID();
    const items = createDemoItems(snapshotId).slice(0, 2);
    const snapshot = await saveSnapshot({ username: "demo", nickname: "Demo" }, snapshotId, items);
    const session = await createSession(snapshot, 2, [2], { preset: "uniform", weights: Array(10).fill(10) });
    const original: ComparisonRecord = {
      id: "original", profileId: "demo", sessionId: session.id, subjectType: 2,
      leftSubjectId: items[0].subjectId, rightSubjectId: items[1].subjectId, outcome: "left",
      queryKind: "adaptive", acceptedCountAtAnswer: 1, active: true, createdAt: new Date(0).toISOString(),
    };
    const calibration: ComparisonRecord = {
      ...original, id: "calibration", leftSubjectId: original.rightSubjectId,
      rightSubjectId: original.leftSubjectId, outcome: "right", queryKind: "calibration",
      calibrationOfComparisonId: original.id, acceptedCountAtAnswer: 2, createdAt: new Date(1000).toISOString(),
    };
    await db.comparisons.bulkAdd([original, calibration]);
    await importProject(await exportProject("demo"));
    const imported = (await db.comparisons.toArray()).filter((entry) => entry.profileId !== "demo");
    const importedCalibration = imported.find((entry) => entry.queryKind === "calibration")!;
    const importedOriginal = imported.find((entry) => entry.queryKind === "adaptive")!;
    expect(importedCalibration.calibrationOfComparisonId).toBe(importedOriginal.id);
    expect(importedCalibration.calibrationOfComparisonId).not.toBe("original");
  });

  it("atomically versions distribution-dependent model diagnostics", async () => {
    const snapshotId = crypto.randomUUID();
    const items = createDemoItems(snapshotId).slice(0, 2);
    const snapshot = await saveSnapshot({ username: "demo", nickname: "Demo" }, snapshotId, items);
    const session = await createSession(snapshot, 2, [2], { preset: "uniform", weights: Array(10).fill(10) });
    const fit = fitModel(items.map(({ subjectId, rate }) => ({ subjectId, rate })), []);
    const initial = toModelState(session.id, 0, fit);
    await initializeModel(session.id, initial);
    const next = toModelState(session.id, 1, fit, initial.initialMeanUncertainty);
    const distribution = { preset: "reverse-j" as const, weights: [50, 25, 14, 4, 2, 1, 1, 1, 1, 1] };
    await commitSessionDistribution(session.id, 0, distribution, next);
    await expect(commitSessionDistribution(session.id, 0, distribution, next)).rejects.toThrow(/其他页面更新/);
    const bundle = await getSessionBundle(session.id);
    expect(bundle?.session.modelVersion).toBe(1);
    expect(bundle?.session.distribution.preset).toBe("reverse-j");
    expect(bundle?.model?.version).toBe(1);
  });
});
