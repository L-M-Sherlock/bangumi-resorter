import { afterEach, describe, expect, it } from "vitest";
import { sitePath } from "../lib/site-path";
import { TERM_DEFINITIONS } from "../lib/terminology";

const sectionIds = new Set([
  "rating-problem",
  "pairwise-comparisons",
  "preference-model",
  "inference-modes",
  "question-selection",
  "score-buckets",
  "stopping-rule",
  "remaining-forecast",
  "collection-drift",
]);

describe("terminology", () => {
  const originalBasePath = process.env.NEXT_PUBLIC_BASE_PATH;

  afterEach(() => {
    if (originalBasePath === undefined) delete process.env.NEXT_PUBLIC_BASE_PATH;
    else process.env.NEXT_PUBLIC_BASE_PATH = originalBasePath;
  });

  it("keeps every glossary entry complete and linked to a real principles section", () => {
    expect(Object.keys(TERM_DEFINITIONS).length).toBeGreaterThanOrEqual(30);
    for (const definition of Object.values(TERM_DEFINITIONS)) {
      expect(definition.label.trim().length).toBeGreaterThan(0);
      expect(definition.summary.trim().length).toBeGreaterThan(10);
      expect(sectionIds.has(definition.sectionId)).toBe(true);
    }
  });

  it("builds root and subpath-safe links", () => {
    delete process.env.NEXT_PUBLIC_BASE_PATH;
    expect(sitePath("/principles")).toBe("/principles");
    process.env.NEXT_PUBLIC_BASE_PATH = "/bangumi-resorter";
    expect(sitePath("/principles#stopping-rule")).toBe("/bangumi-resorter/principles#stopping-rule");
    expect(sitePath("/")).toBe("/bangumi-resorter/");
  });
});
