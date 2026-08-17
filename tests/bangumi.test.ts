import { afterEach, describe, expect, it, vi } from "vitest";
import { syncBangumi } from "../lib/bangumi";

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
