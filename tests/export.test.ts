import { describe, expect, it } from "vitest";
import { resultsCsv } from "../lib/export";

describe("CSV export", () => {
  it("includes a BOM, stable columns, links, and escaped titles", () => {
    const csv = resultsCsv([{
      snapshotId: "s", subjectId: 42, subjectType: 2, collectionType: 2,
      rate: 8, name: "A, \"B\"", nameCn: "甲", private: false, tags: [],
      rank: 1, ability: 1.25, uncertainty: 0.5, newRate: 10, comparisonCount: 3,
    }]);
    expect(csv.startsWith("\uFEFFsubject_type")).toBe(true);
    expect(csv).toContain('"A, ""B"""');
    expect(csv).toContain("https://bgm.tv/subject/42");
  });
});
