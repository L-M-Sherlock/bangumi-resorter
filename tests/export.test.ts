import { describe, expect, it } from "vitest";
import { resultsCsv } from "../lib/export";

describe("CSV export", () => {
  it("includes a BOM, stable columns, links, and escaped titles", () => {
    const csv = resultsCsv([{
      snapshotId: "s", subjectId: 42, subjectType: 2, collectionType: 2,
      rate: 8, name: "A, \"B\"", nameCn: "甲", private: false, tags: [],
      rank: 1, ability: 1.25, uncertainty: 0.5, newRate: 10, bucketStability: 0.875, comparisonCount: 3,
    }], 5);
    expect(csv.startsWith("\uFEFFsubject_type")).toBe(true);
    expect(csv).toContain('"A, ""B"""');
    expect(csv).toContain("bucket_stability");
    expect(csv.split("\r\n")[0]).toContain("level_count");
    expect(csv).toContain(",8,10,5,1,");
    expect(csv).toContain("0.875000");
    expect(csv).toContain("https://bgm.tv/subject/42");
  });
});
