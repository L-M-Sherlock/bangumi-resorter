import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { createDemoItems } from "../lib/demo";
import { fitModel, toModelState } from "../lib/ranking/engine";
import {
  commitComparisonDeletion, commitResponse, commitSessionBudgetMode, commitSessionDistribution, createSession, db, deleteSession, deriveSessionWithTagFilter, exportProject, getSessionBundle, importProject,
  initializeModel, lastActiveResponse, previewSessionTagDerivation, previewSessionUpgrade, saveSnapshot, upgradeSessionToSnapshot,
} from "../lib/db";
import type { ComparisonRecord, DistributionConfig } from "../lib/types";

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
    const session = await createSession(snapshot, 2, [2], { preset: "uniform", levelCount: 10, weights: Array(10).fill(10) });
    expect(session.budgetMode).toBe("quick");
    expect(session.comparisonReusePolicy).toBe("snapshot");
    expect(session.stoppingTarget).toBeUndefined();
    expect(session.suggestedComparisons).toBeUndefined();
    expect(session.maxComparisons).toBeUndefined();
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

  it("adds manual comparisons and permanently deletes one with a recomputed model", async () => {
    const snapshotId = crypto.randomUUID();
    const items = createDemoItems(snapshotId).slice(0, 3);
    const snapshot = await saveSnapshot({ username: "demo", nickname: "Demo" }, snapshotId, items);
    const session = await createSession(snapshot, 2, [2], { preset: "uniform", levelCount: 10, weights: Array(10).fill(10) });
    const inputs = items.map(({ subjectId, rate }) => ({ subjectId, rate }));
    const initialFit = fitModel(inputs, []);
    const initialModel = toModelState(session.id, 0, initialFit);
    await initializeModel(session.id, initialModel);

    const pair = { recordId: "manual-record", leftSubjectId: items[0].subjectId, rightSubjectId: items[2].subjectId, queryKind: "manual" as const };
    const answeredFit = fitModel(inputs, [{ ...pair, outcome: "tie" }]);
    const answeredModel = toModelState(session.id, 1, answeredFit, initialModel.initialMeanUncertainty);
    await commitResponse(session.id, 0, pair, "tie", answeredModel);
    expect((await db.comparisons.get("manual-record"))?.queryKind).toBe("manual");

    const recomputedModel = toModelState(session.id, 2, initialFit, initialModel.initialMeanUncertainty);
    await commitComparisonDeletion(session.id, 1, "manual-record", recomputedModel);
    expect(await db.comparisons.get("manual-record")).toBeUndefined();
    const bundle = await getSessionBundle(session.id);
    expect(bundle?.history).toHaveLength(0);
    expect(bundle?.session.modelVersion).toBe(2);
    expect(bundle?.model?.version).toBe(2);
    await expect(commitComparisonDeletion(session.id, 1, "manual-record", recomputedModel)).rejects.toThrow(/其他页面更新/);
  });

  it("deletes a session and its dependent data without deleting the collection snapshot", async () => {
    const snapshotId = crypto.randomUUID();
    const items = createDemoItems(snapshotId).slice(0, 2);
    const snapshot = await saveSnapshot({ username: "demo", nickname: "Demo" }, snapshotId, items);
    const session = await createSession(snapshot, 2, [2], { preset: "uniform", levelCount: 10, weights: Array(10).fill(10) });
    const fit = fitModel(items.map(({ subjectId, rate }) => ({ subjectId, rate })), []);
    const initial = toModelState(session.id, 0, fit);
    await initializeModel(session.id, initial);
    const pair = { recordId: "session-record", leftSubjectId: items[0].subjectId, rightSubjectId: items[1].subjectId };
    await commitResponse(session.id, 0, pair, "left", toModelState(session.id, 1, fit, initial.initialMeanUncertainty));

    await deleteSession(session.id);
    expect(await db.sessions.get(session.id)).toBeUndefined();
    expect(await db.sessionItems.where("sessionId").equals(session.id).count()).toBe(0);
    expect(await db.comparisons.where("sessionId").equals(session.id).count()).toBe(0);
    expect(await db.models.get(session.id)).toBeUndefined();
    expect(await db.snapshots.get(snapshot.id)).toBeDefined();
    expect(await db.items.where("snapshotId").equals(snapshot.id).count()).toBe(items.length);
  });

  it("round-trips a backup as a non-destructive new project", async () => {
    const snapshotId = crypto.randomUUID();
    const items = createDemoItems(snapshotId).slice(0, 4);
    const snapshot = await saveSnapshot({ username: "demo", nickname: "Demo" }, snapshotId, items);
    const source = await createSession(snapshot, 2, [2], { preset: "uniform", levelCount: 5, weights: Array(5).fill(20) });
    const upgraded = await createSession(snapshot, 2, [2], { preset: "uniform", levelCount: 10, weights: Array(10).fill(10) });
    const derived = await deriveSessionWithTagFilter(source.id, { source: "collection", match: "all", tags: ["经典"] });
    await db.sessions.update(upgraded.id, { upgradedFromSessionId: source.id });
    const payload = await exportProject("demo");
    payload.sessions.forEach((session) => {
      session.stoppingTarget = "top-tail";
      session.maxComparisons = 1000;
      session.status = "complete";
      delete (session.distribution as Partial<DistributionConfig>).levelCount;
    });
    const imported = await importProject(payload);
    expect(imported.id).not.toBe("demo");
    expect(imported.username).toContain("导入");
    expect(await db.profiles.count()).toBe(2);
    expect(await db.snapshots.count()).toBe(2);
    expect(await db.sessions.count()).toBe(6);
    const importedSessions = await db.sessions.where("profileId").equals(imported.id).toArray();
    expect(importedSessions.every((session) => session.stoppingTarget === undefined)).toBe(true);
    expect(importedSessions.every((session) => session.maxComparisons === undefined)).toBe(true);
    expect(importedSessions.every((session) => session.status === "active")).toBe(true);
    expect(importedSessions.every((session) => session.distribution.levelCount === 10)).toBe(true);
    const importedUpgrade = importedSessions.find((session) => session.upgradedFromSessionId);
    expect(importedUpgrade).toBeDefined();
    const importedSource = importedSessions.find((session) => session.id === importedUpgrade?.upgradedFromSessionId);
    expect(importedSource).toBeDefined();
    expect(importedUpgrade?.id).not.toBe(upgraded.id);
    expect(importedUpgrade?.upgradedFromSessionId).not.toBe(source.id);
    const importedDerived = importedSessions.find((session) => session.derivedFromSessionId);
    expect(importedDerived?.derivedFromSessionId).not.toBe(source.id);
    expect(importedSessions.some((session) => session.id === importedDerived?.derivedFromSessionId)).toBe(true);
    expect(importedDerived?.tagFilter).toEqual({ source: "collection", match: "all", tags: ["经典"] });
    expect(derived.session.tagFilter?.tags).toEqual(["经典"]);
  });

  it("scopes reusable comparisons to the session, snapshot, or whole profile", async () => {
    const snapshotOneId = crypto.randomUUID();
    const firstItems = createDemoItems(snapshotOneId).slice(0, 2);
    const snapshotOne = await saveSnapshot({ username: "demo", nickname: "Demo" }, snapshotOneId, firstItems);
    const first = await createSession(snapshotOne, 2, [2], { preset: "uniform", levelCount: 10, weights: Array(10).fill(10) });
    const second = await createSession(snapshotOne, 2, [2], { preset: "uniform", levelCount: 10, weights: Array(10).fill(10) });

    const snapshotTwoId = crypto.randomUUID();
    const secondItems = firstItems.map((entry) => ({ ...entry, snapshotId: snapshotTwoId }));
    const snapshotTwo = await saveSnapshot({ username: "demo", nickname: "Demo" }, snapshotTwoId, secondItems);
    const snapshotOnly = await createSession(snapshotTwo, 2, [2], { preset: "uniform", levelCount: 10, weights: Array(10).fill(10) });
    const sessionOnly = await createSession(snapshotTwo, 2, [2], { preset: "uniform", levelCount: 10, weights: Array(10).fill(10) }, "quick", "session");
    const wholeProfile = await createSession(snapshotTwo, 2, [2], { preset: "uniform", levelCount: 10, weights: Array(10).fill(10) }, "quick", "profile");

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

  it("derives an immutable tag-scoped child and inherits only comparisons inside the new scope", async () => {
    const snapshotId = crypto.randomUUID();
    const items = createDemoItems(snapshotId).slice(0, 4);
    const snapshot = await saveSnapshot({ username: "demo", nickname: "Demo" }, snapshotId, items);
    const source = await createSession(snapshot, 2, [2], { preset: "uniform", levelCount: 5, weights: Array(5).fill(20) });
    const records: ComparisonRecord[] = [
      {
        id: "tag-kept", profileId: "demo", sessionId: source.id, subjectType: 2,
        leftSubjectId: items[0].subjectId, rightSubjectId: items[3].subjectId,
        outcome: "left", queryKind: "adaptive", acceptedCountAtAnswer: 1, active: true,
        createdAt: new Date(1).toISOString(),
      },
      {
        id: "tag-calibration", profileId: "demo", sessionId: source.id, subjectType: 2,
        leftSubjectId: items[3].subjectId, rightSubjectId: items[0].subjectId,
        outcome: "right", queryKind: "calibration", calibrationOfComparisonId: "tag-kept",
        acceptedCountAtAnswer: 2, active: true, createdAt: new Date(2).toISOString(),
      },
      {
        id: "tag-dropped", profileId: "demo", sessionId: source.id, subjectType: 2,
        leftSubjectId: items[0].subjectId, rightSubjectId: items[1].subjectId,
        outcome: "left", queryKind: "manual", acceptedCountAtAnswer: 3, active: true,
        createdAt: new Date(3).toISOString(),
      },
      {
        id: "tag-skip", profileId: "demo", sessionId: source.id, subjectType: 2,
        leftSubjectId: items[3].subjectId, rightSubjectId: items[2].subjectId,
        outcome: "skip", queryKind: "adaptive", acceptedCountAtAnswer: 3, active: true,
        createdAt: new Date(4).toISOString(),
      },
    ];
    await db.comparisons.bulkAdd(records);
    const tagFilter = { source: "collection" as const, match: "all" as const, tags: ["经典"] };

    const preview = await previewSessionTagDerivation(source.id, tagFilter);
    expect(preview).toMatchObject({
      previousItemCount: 4,
      currentItemCount: 2,
      addedSubjectIds: [],
      removedSubjectIds: [items[1].subjectId, items[2].subjectId],
      inheritedComparisonCount: 2,
      droppedComparisonCount: 1,
    });
    const derived = await deriveSessionWithTagFilter(source.id, tagFilter);
    expect(derived.preview).toEqual(preview);
    expect(derived.session).toMatchObject({
      snapshotId,
      derivedFromSessionId: source.id,
      comparisonReusePolicy: "session",
      modelVersion: 0,
      status: "active",
      tagFilter,
    });
    expect(derived.session.distribution.levelCount).toBe(5);
    expect((await getSessionBundle(source.id))?.items).toHaveLength(4);
    const bundle = await getSessionBundle(derived.session.id);
    expect(bundle?.items.map((entry) => entry.subjectId).sort((a, b) => a - b)).toEqual([items[0].subjectId, items[3].subjectId]);
    expect(bundle?.history).toHaveLength(2);
    const inheritedCalibration = bundle?.history.find((entry) => entry.queryKind === "calibration");
    const inheritedOriginal = bundle?.history.find((entry) => entry.queryKind === "adaptive");
    expect(inheritedCalibration?.calibrationOfComparisonId).toBe(inheritedOriginal?.id);
    expect(inheritedOriginal?.id).not.toBe("tag-kept");
    expect(inheritedOriginal?.inheritedFromComparisonId).toBe("tag-kept");
    expect(inheritedCalibration?.inheritedFromComparisonId).toBe("tag-calibration");

    // The source's snapshot-wide reuse must not count its own answers again via
    // the materialized child copies.
    expect((await getSessionBundle(source.id))?.history.map((entry) => entry.id).sort())
      .toEqual(records.map((entry) => entry.id).sort());

    // Pre-provenance backups have no lineage marker. Their exact copied
    // judgment is still collapsed by the legacy logical fingerprint.
    await db.comparisons.update(inheritedOriginal!.id, { inheritedFromComparisonId: undefined });
    expect((await getSessionBundle(source.id))?.history.map((entry) => entry.id).sort())
      .toEqual(records.map((entry) => entry.id).sort());

    // A genuinely new judgment made in the child remains reusable once.
    const childOnly: ComparisonRecord = {
      id: "tag-child-new", profileId: "demo", sessionId: derived.session.id, subjectType: 2,
      leftSubjectId: items[3].subjectId, rightSubjectId: items[0].subjectId,
      outcome: "left", queryKind: "manual", acceptedCountAtAnswer: 3, active: true,
      createdAt: new Date(5).toISOString(),
    };
    await db.comparisons.add(childOnly);
    expect((await getSessionBundle(source.id))?.history.map((entry) => entry.id).sort())
      .toEqual([...records.map((entry) => entry.id), childOnly.id].sort());

    const broadened = await previewSessionTagDerivation(derived.session.id, undefined);
    expect(broadened).toMatchObject({ previousItemCount: 2, currentItemCount: 4, inheritedComparisonCount: 3, droppedComparisonCount: 0 });
    expect(broadened.addedSubjectIds).toEqual([items[1].subjectId, items[2].subjectId]);
    await expect(previewSessionTagDerivation(source.id, undefined)).rejects.toThrow(/没有变化/);
    await expect(previewSessionTagDerivation(source.id, { ...tagFilter, tags: ["不存在"] })).rejects.toThrow(/不足两个/);
  });

  it("forks a session onto a newer snapshot and inherits only valid comparisons", async () => {
    const firstSnapshotId = crypto.randomUUID();
    const firstItems = createDemoItems(firstSnapshotId).slice(0, 3);
    const firstSnapshot = await saveSnapshot({ username: "demo", nickname: "Demo" }, firstSnapshotId, firstItems);
    const source = await createSession(firstSnapshot, 2, [2], { preset: "preserve", levelCount: 5, weights: Array(5).fill(20) });
    const records: ComparisonRecord[] = [
      {
        id: "kept", profileId: "demo", sessionId: source.id, subjectType: 2,
        leftSubjectId: firstItems[0].subjectId, rightSubjectId: firstItems[1].subjectId,
        outcome: "left", queryKind: "adaptive", acceptedCountAtAnswer: 1, active: true,
        createdAt: new Date(1).toISOString(),
      },
      {
        id: "removed-item", profileId: "demo", sessionId: source.id, subjectType: 2,
        leftSubjectId: firstItems[1].subjectId, rightSubjectId: firstItems[2].subjectId,
        outcome: "right", queryKind: "manual", acceptedCountAtAnswer: 2, active: true,
        createdAt: new Date(2).toISOString(),
      },
      {
        id: "calibration", profileId: "demo", sessionId: source.id, subjectType: 2,
        leftSubjectId: firstItems[1].subjectId, rightSubjectId: firstItems[0].subjectId,
        outcome: "right", queryKind: "calibration", calibrationOfComparisonId: "kept",
        acceptedCountAtAnswer: 3, active: true, createdAt: new Date(3).toISOString(),
      },
      {
        id: "skipped", profileId: "demo", sessionId: source.id, subjectType: 2,
        leftSubjectId: firstItems[0].subjectId, rightSubjectId: firstItems[2].subjectId,
        outcome: "skip", queryKind: "adaptive", acceptedCountAtAnswer: 3, active: true,
        createdAt: new Date(4).toISOString(),
      },
    ];
    await db.comparisons.bulkAdd(records);

    const secondSnapshotId = crypto.randomUUID();
    const added = { ...firstItems[2], snapshotId: secondSnapshotId, subjectId: 999999, name: "New item", rate: 7 };
    const secondItems = [
      { ...firstItems[0], snapshotId: secondSnapshotId, rate: firstItems[0].rate - 1 },
      { ...firstItems[1], snapshotId: secondSnapshotId },
      added,
    ];
    const secondSnapshot = await saveSnapshot({ username: "demo", nickname: "Demo" }, secondSnapshotId, secondItems);

    const preview = await previewSessionUpgrade(source.id, secondSnapshot.id);
    expect(preview).toMatchObject({
      previousItemCount: 3,
      currentItemCount: 3,
      addedSubjectIds: [added.subjectId],
      removedSubjectIds: [firstItems[2].subjectId],
      ratingChangedSubjectIds: [firstItems[0].subjectId],
      inheritedComparisonCount: 2,
      droppedComparisonCount: 1,
    });

    const upgraded = await upgradeSessionToSnapshot(source.id, secondSnapshot.id);
    expect(upgraded.preview).toEqual(preview);
    expect(upgraded.session).toMatchObject({
      snapshotId: secondSnapshot.id,
      upgradedFromSessionId: source.id,
      comparisonReusePolicy: "session",
      modelVersion: 0,
      status: "active",
    });
    expect(upgraded.session.distribution.levelCount).toBe(5);
    expect(await db.sessions.get(source.id)).toBeDefined();
    const bundle = await getSessionBundle(upgraded.session.id);
    expect(bundle?.items.map((entry) => entry.subjectId).sort((a, b) => a - b))
      .toEqual([firstItems[0].subjectId, firstItems[1].subjectId, added.subjectId].sort((a, b) => a - b));
    expect(bundle?.history).toHaveLength(2);
    expect(bundle?.history.every((entry) => entry.sessionId === upgraded.session.id)).toBe(true);
    expect(bundle?.history.map((entry) => entry.acceptedCountAtAnswer).sort((a, b) => a - b)).toEqual([1, 2]);
    const inheritedCalibration = bundle?.history.find((entry) => entry.queryKind === "calibration");
    const inheritedOriginal = bundle?.history.find((entry) => entry.queryKind === "adaptive");
    expect(inheritedCalibration?.calibrationOfComparisonId).toBe(inheritedOriginal?.id);
    expect(inheritedOriginal?.id).not.toBe("kept");
    expect(inheritedOriginal?.inheritedFromComparisonId).toBe("kept");
    expect(inheritedCalibration?.inheritedFromComparisonId).toBe("calibration");
    await expect(previewSessionUpgrade(upgraded.session.id, secondSnapshot.id)).rejects.toThrow(/已经使用当前收藏/);
  });

  it("reapplies the stored personal-tag rule when upgrading to a newer snapshot", async () => {
    const firstSnapshotId = crypto.randomUUID();
    const firstItems = createDemoItems(firstSnapshotId).slice(0, 4);
    const firstSnapshot = await saveSnapshot({ username: "demo", nickname: "Demo" }, firstSnapshotId, firstItems);
    const tagFilter = { source: "collection" as const, match: "all" as const, tags: ["经典"] };
    const source = await createSession(
      firstSnapshot,
      2,
      [2],
      { preset: "uniform", levelCount: 10, weights: Array(10).fill(10) },
      "quick",
      "snapshot",
      tagFilter,
    );
    expect((await getSessionBundle(source.id))?.items.map((entry) => entry.subjectId)).toEqual([firstItems[0].subjectId, firstItems[3].subjectId]);

    const secondSnapshotId = crypto.randomUUID();
    const added = { ...firstItems[1], snapshotId: secondSnapshotId, subjectId: 999999, name: "New classic", tags: ["demo", "经典"] };
    const secondItems = [
      { ...firstItems[0], snapshotId: secondSnapshotId, tags: ["demo"] },
      { ...firstItems[1], snapshotId: secondSnapshotId },
      { ...firstItems[3], snapshotId: secondSnapshotId },
      added,
    ];
    const secondSnapshot = await saveSnapshot({ username: "demo", nickname: "Demo" }, secondSnapshotId, secondItems);
    const preview = await previewSessionUpgrade(source.id, secondSnapshot.id);
    expect(preview).toMatchObject({
      previousItemCount: 2,
      currentItemCount: 2,
      addedSubjectIds: [added.subjectId],
      removedSubjectIds: [firstItems[0].subjectId],
    });
    const upgraded = await upgradeSessionToSnapshot(source.id, secondSnapshot.id);
    expect(upgraded.session.tagFilter).toEqual(tagFilter);
    expect((await getSessionBundle(upgraded.session.id))?.items.map((entry) => entry.subjectId).sort((a, b) => a - b))
      .toEqual([firstItems[3].subjectId, added.subjectId].sort((a, b) => a - b));
  });

  it("remaps calibration and inheritance references when importing a backup", async () => {
    const snapshotId = crypto.randomUUID();
    const items = createDemoItems(snapshotId).slice(0, 2);
    const snapshot = await saveSnapshot({ username: "demo", nickname: "Demo" }, snapshotId, items);
    const session = await createSession(snapshot, 2, [2], { preset: "uniform", levelCount: 10, weights: Array(10).fill(10) });
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
    const inherited: ComparisonRecord = {
      ...original, id: "inherited", inheritedFromComparisonId: original.id,
      acceptedCountAtAnswer: 3, createdAt: new Date(2000).toISOString(),
    };
    const orphanedInheritance: ComparisonRecord = {
      ...original, id: "orphaned-inherited", inheritedFromComparisonId: "deleted-source",
      acceptedCountAtAnswer: 4, createdAt: new Date(3000).toISOString(),
    };
    await db.comparisons.bulkAdd([original, calibration, inherited, orphanedInheritance]);
    await importProject(await exportProject("demo"));
    const imported = (await db.comparisons.toArray()).filter((entry) => entry.profileId !== "demo");
    const importedCalibration = imported.find((entry) => entry.queryKind === "calibration")!;
    const importedOriginal = imported.find((entry) =>
      entry.queryKind === "adaptive" && !entry.inheritedFromComparisonId)!;
    expect(importedCalibration.calibrationOfComparisonId).toBe(importedOriginal.id);
    expect(importedCalibration.calibrationOfComparisonId).not.toBe("original");
    const importedInherited = imported.find((entry) => entry.createdAt === inherited.createdAt)!;
    expect(importedInherited.inheritedFromComparisonId).toBe(importedOriginal.id);
    expect(importedInherited.inheritedFromComparisonId).not.toBe("original");
    expect(imported.find((entry) => entry.createdAt === orphanedInheritance.createdAt)
      ?.inheritedFromComparisonId).toBe("deleted-source");
  });

  it("atomically versions distribution-dependent model diagnostics", async () => {
    const snapshotId = crypto.randomUUID();
    const items = createDemoItems(snapshotId).slice(0, 2);
    const snapshot = await saveSnapshot({ username: "demo", nickname: "Demo" }, snapshotId, items);
    const session = await createSession(snapshot, 2, [2], { preset: "uniform", levelCount: 10, weights: Array(10).fill(10) });
    const fit = fitModel(items.map(({ subjectId, rate }) => ({ subjectId, rate })), []);
    const initial = toModelState(session.id, 0, fit);
    await initializeModel(session.id, initial);
    const pair = { leftSubjectId: items[0].subjectId, rightSubjectId: items[1].subjectId };
    const answeredFit = fitModel(items.map(({ subjectId, rate }) => ({ subjectId, rate })), [{ ...pair, outcome: "left" }]);
    const answered = toModelState(session.id, 1, answeredFit, initial.initialMeanUncertainty);
    await commitResponse(session.id, 0, pair, "left", answered);
    const next = toModelState(session.id, 2, answeredFit, initial.initialMeanUncertainty);
    const distribution = { preset: "reverse-j" as const, levelCount: 5, weights: [89, 6, 2, 1.5, 1.5] };
    await commitSessionDistribution(session.id, 1, distribution, next);
    await expect(commitSessionDistribution(session.id, 1, distribution, next)).rejects.toThrow(/其他页面更新/);
    const bundle = await getSessionBundle(session.id);
    expect(bundle?.session.modelVersion).toBe(2);
    expect(bundle?.session.distribution.preset).toBe("reverse-j");
    expect(bundle?.session.distribution.levelCount).toBe(5);
    expect(bundle?.history).toHaveLength(1);
    expect(bundle?.model?.version).toBe(2);
  });

  it("atomically changes inference mode without replacing session history", async () => {
    const snapshotId = crypto.randomUUID();
    const items = createDemoItems(snapshotId).slice(0, 2);
    const snapshot = await saveSnapshot({ username: "demo", nickname: "Demo" }, snapshotId, items);
    const session = await createSession(snapshot, 2, [2], { preset: "uniform", levelCount: 10, weights: Array(10).fill(10) });
    const fit = fitModel(items.map(({ subjectId, rate }) => ({ subjectId, rate })), []);
    const initial = toModelState(session.id, 0, fit);
    await initializeModel(session.id, initial);
    const next = toModelState(session.id, 1, fit, initial.initialMeanUncertainty);

    await commitSessionBudgetMode(session.id, 0, "thorough", next);
    await expect(commitSessionBudgetMode(session.id, 0, "standard", next)).rejects.toThrow(/其他页面更新/);

    const bundle = await getSessionBundle(session.id);
    expect(bundle?.session.id).toBe(session.id);
    expect(bundle?.session.budgetMode).toBe("thorough");
    expect(bundle?.session.modelVersion).toBe(1);
    expect(bundle?.history).toHaveLength(0);
    expect(bundle?.model?.version).toBe(1);
  });
});
