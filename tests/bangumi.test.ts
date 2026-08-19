import { afterEach, describe, expect, it, vi } from "vitest";
import {
  previewBangumiRatingWrite,
  RatingWritePreview,
  syncBangumi,
  writeBangumiRatings,
} from "../lib/bangumi";

afterEach(() => vi.unstubAllGlobals());

describe("Bangumi read-only sync", () => {
  it("paginates collections, keeps rated entries, and only sends GET", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.endsWith("/users/alice")) return Response.json({ username: "alice", nickname: "Alice" });
      if (url.includes("/collections")) return Response.json({
        total: 2, limit: 50, offset: 0,
        data: [
          { subject_id: 10, subject_type: 2, rate: 9, type: 2, private: false, subject: { id: 10, type: 2, name: "A", name_cn: "甲", images: { large: "http://lain.bgm.tv/a.jpg" } } },
          { subject_id: 11, subject_type: 2, rate: 0, type: 1, private: false, subject: { id: 11, type: 2, name: "B" } },
        ],
      });
      throw new Error(`Unexpected URL ${url}`);
    }));

    const progress: string[] = [];
    const result = await syncBangumi(" alice ", "", "snapshot", (entry) => progress.push(entry.phase));
    expect(result.profile.username).toBe("alice");
    expect(result.items).toHaveLength(1);
    expect(result.items[0].image).toBe("https://lain.bgm.tv/a.jpg");
    expect(calls.every((call) => call.init?.method === "GET")).toBe(true);
    expect(calls.every((call) => !(call.init?.headers as Record<string, string>).Authorization)).toBe(true);
    expect(progress).toContain("collections");
    expect(progress).toContain("details");
  });

  it("normalizes nullable Bangumi profile and subject metadata", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/users/alice")) return Response.json({ username: "alice", nickname: null, avatar: null });
      if (url.includes("/collections")) return Response.json({
        total: 1, limit: 50, offset: 0,
        data: [{
          subject_id: 12, subject_type: 1, rate: 8, type: 3, private: false, tags: null, updated_at: null,
          subject: { id: 12, type: 1, name: "No metadata", name_cn: null, date: null, platform: null, images: null },
        }],
      });
      throw new Error(`Unexpected URL ${url}`);
    }));

    const result = await syncBangumi("alice", "", "snapshot");
    expect(result.profile).toEqual({ username: "alice", nickname: undefined, avatar: undefined });
    expect(result.items[0]).toMatchObject({
      nameCn: "", date: undefined, platform: undefined, image: undefined,
      tags: [], updatedAt: undefined,
    });
  });

  it("rejects a token that belongs to another user before reading collections", async () => {
    const fetchMock = vi.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValue(Response.json({ username: "bob" }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(syncBangumi("alice", "secret", "snapshot")).rejects.toMatchObject({ code: "TOKEN_USER_MISMATCH" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer secret");
  });
});

describe("Bangumi rating write-back", () => {
  const targets = [
    { subjectId: 10, name: "甲", snapshotRate: 8, targetRate: 9 },
    { subjectId: 11, name: "乙", snapshotRate: 8, targetRate: 7 },
    { subjectId: 12, name: "丙", snapshotRate: 8, targetRate: 9 },
    { subjectId: 13, name: "丁", snapshotRate: 8, targetRate: 6 },
  ];

  it("checks the token account and classifies live ratings before writing", async () => {
    const calls: Array<{ input: string | URL | Request; init?: RequestInit }> = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ input, init });
      const url = String(input);
      if (url.endsWith("/me")) return Response.json({ username: "alice" });
      if (url.includes("/collections?")) {
        const offset = Number(new URL(url).searchParams.get("offset"));
        return Response.json({
          total: 3, limit: 50, offset,
          data: offset === 0
            ? [
              { subject_id: 10, subject_type: 2, rate: 8, type: 2, private: false },
              { subject_id: 11, subject_type: 2, rate: 7, type: 2, private: false },
            ]
            : [{ subject_id: 12, subject_type: 2, rate: 6, type: 2, private: false }],
        });
      }
      throw new Error(`Unexpected URL ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const preview = await previewBangumiRatingWrite("alice", " secret ", 2, targets);
    expect(preview.candidates.map((candidate) => candidate.status)).toEqual(["ready", "unchanged", "conflict", "missing"]);
    expect(calls.some(({ input }) => String(input).includes("subject_type=2"))).toBe(true);
    expect(calls.every(({ init }) => (init?.headers as Record<string, string>).Authorization === "Bearer secret")).toBe(true);
    expect(calls.every(({ init }) => init?.method === "GET")).toBe(true);
  });

  it("requires a token and rejects a token belonging to another account before previewing", async () => {
    const fetchMock = vi.fn(async () => Response.json({ username: "bob" }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(previewBangumiRatingWrite("alice", "", 2, targets)).rejects.toMatchObject({ code: "TOKEN_REQUIRED" });
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(previewBangumiRatingWrite("alice", "secret", 2, targets)).rejects.toMatchObject({ code: "TOKEN_USER_MISMATCH" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rechecks conflicts, writes only safe changes, retries, and verifies the result", async () => {
    let collectionRead = 0;
    let patchAttempts = 0;
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/me")) return Response.json({ username: "alice" });
      if (url.includes("/collections?")) {
        collectionRead += 1;
        return Response.json({
          total: 4, limit: 50, offset: 0,
          data: collectionRead === 1
            ? [
              { subject_id: 10, subject_type: 2, rate: 8, type: 2, private: false },
              { subject_id: 11, subject_type: 2, rate: 6, type: 2, private: false },
              { subject_id: 12, subject_type: 2, rate: 9, type: 2, private: false },
              { subject_id: 13, subject_type: 2, rate: 8, type: 2, private: false },
            ]
            : [
              { subject_id: 10, subject_type: 2, rate: 9, type: 2, private: false },
              { subject_id: 11, subject_type: 2, rate: 6, type: 2, private: false },
              { subject_id: 12, subject_type: 2, rate: 9, type: 2, private: false },
              { subject_id: 13, subject_type: 2, rate: 8, type: 2, private: false },
            ],
        });
      }
      if (url.endsWith("/collections/10") && init?.method === "PATCH") {
        patchAttempts += 1;
        expect(init.body).toBe(JSON.stringify({ rate: 9 }));
        expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
        if (patchAttempts === 1) return new Response(null, { status: 429, headers: { "Retry-After": "0.001" } });
        return new Response(null, { status: 204 });
      }
      throw new Error(`Unexpected ${init?.method} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const preview: RatingWritePreview = {
      username: "alice", subjectType: 2, checkedAt: new Date().toISOString(),
      candidates: [
        ...targets.slice(0, 3).map((target) => ({ ...target, liveRate: target.snapshotRate, status: "ready" as const })),
        { ...targets[3], liveRate: 5, status: "conflict" },
      ],
    };
    const progress: number[] = [];

    const result = await writeBangumiRatings("alice", "secret", preview, (entry) => progress.push(entry.completed));
    expect(patchAttempts).toBe(2);
    expect(result.succeeded.map((candidate) => candidate.subjectId)).toEqual([10]);
    expect(result.unchanged.map((candidate) => candidate.subjectId)).toEqual([12]);
    expect(result.skipped.map((candidate) => candidate.subjectId)).toEqual([13, 11]);
    expect(result.failed).toEqual([]);
    expect(progress).toEqual([1]);
  });

  it("stops after a failed write and reports verified, failed, and pending items", async () => {
    let collectionRead = 0;
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/me")) return Response.json({ username: "alice" });
      if (url.includes("/collections?")) {
        collectionRead += 1;
        return Response.json({
          total: 3, limit: 50, offset: 0,
          data: [10, 11, 12].map((subjectId) => ({
            subject_id: subjectId, subject_type: 2,
            rate: collectionRead > 1 && subjectId === 10 ? 9 : 8,
            type: 2, private: false,
          })),
        });
      }
      if (url.endsWith("/collections/10") && init?.method === "PATCH") return new Response(null, { status: 204 });
      if (url.endsWith("/collections/11") && init?.method === "PATCH") return new Response(null, { status: 400 });
      throw new Error(`Unexpected ${init?.method} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const preview: RatingWritePreview = {
      username: "alice", subjectType: 2, checkedAt: new Date().toISOString(),
      candidates: [10, 11, 12].map((subjectId) => ({
        subjectId, name: `条目 ${subjectId}`, snapshotRate: 8, targetRate: 9, liveRate: 8, status: "ready",
      })),
    };

    const result = await writeBangumiRatings("alice", "secret", preview);
    expect(result.succeeded.map((candidate) => candidate.subjectId)).toEqual([10]);
    expect(result.failed.map((entry) => entry.candidate.subjectId)).toEqual([11]);
    expect(result.pending.map((candidate) => candidate.subjectId)).toEqual([12]);
    expect(fetchMock.mock.calls.filter(([input, init]) => String(input).includes("/collections/") && init?.method === "PATCH")).toHaveLength(2);
  });
});
