import { describe, expect, it } from "vitest";
import {
  collectionTagFilter,
  collectionTagOptions,
  filterScopeItems,
  normalizeCollectionTag,
  sameTagFilter,
} from "../lib/scope";
import type { CollectionItem } from "../lib/types";

function item(subjectId: number, tags: string[]): CollectionItem {
  return {
    snapshotId: "snapshot",
    subjectId,
    subjectType: 2,
    collectionType: 2,
    rate: 8,
    name: `Item ${subjectId}`,
    nameCn: "",
    private: false,
    tags,
  };
}

describe("personal collection tag scopes", () => {
  it("normalizes labels while preserving a stable display value", () => {
    expect(normalizeCollectionTag("  ＤＥＭＯ  ")).toBe("demo");
    expect(collectionTagFilter([" 百合 ", "百合", "原创"])).toEqual({
      source: "collection",
      match: "all",
      tags: ["原创", "百合"],
    });
    expect(collectionTagFilter(["  "])).toBeUndefined();
  });

  it("requires every selected tag and treats an empty selection as the full base scope", () => {
    const items = [
      item(1, ["百合", "原创"]),
      item(2, ["百合"]),
      item(3, ["原创", " 百合 "]),
      { ...item(4, ["百合", "原创"]), collectionType: 1 as const },
    ];
    const base = { subjectType: 2 as const, collectionTypes: [2 as const] };
    expect(filterScopeItems({ ...base, tagFilter: undefined }, items).map((entry) => entry.subjectId)).toEqual([1, 2, 3]);
    expect(filterScopeItems({ ...base, tagFilter: collectionTagFilter(["原创", "百合"]) }, items).map((entry) => entry.subjectId)).toEqual([1, 3]);
  });

  it("counts each subject once and compares filters independent of order, case, and width", () => {
    const options = collectionTagOptions([
      item(1, ["Demo", "ＤＥＭＯ", "经典"]),
      item(2, ["demo"]),
      item(3, ["经典"]),
    ]);
    expect(options).toEqual([
      { key: "demo", label: "Demo", count: 2 },
      { key: "经典", label: "经典", count: 2 },
    ]);
    expect(sameTagFilter(collectionTagFilter(["经典", "DEMO"]), collectionTagFilter(["ｄｅｍｏ", "经典"]))).toBe(true);
    expect(sameTagFilter(collectionTagFilter(["经典"]), undefined)).toBe(false);
  });
});
