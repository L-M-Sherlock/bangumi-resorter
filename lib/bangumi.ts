import {
  AppError,
  CollectionItem,
  CollectionType,
  Profile,
  SubjectImages,
  SubjectType,
} from "./types";

const API_BASE = "https://api.bgm.tv/v0";

interface BangumiUser {
  username: string;
  nickname?: string;
  avatar?: { large?: string; medium?: string; small?: string };
}

interface BangumiSubject {
  id: number;
  type: number;
  name: string;
  name_cn?: string;
  date?: string;
  platform?: string;
  images?: SubjectImages;
}

interface BangumiCollection {
  subject_id: number;
  subject_type: number;
  rate: number;
  type: number;
  private: boolean;
  tags?: string[];
  updated_at?: string;
  subject?: BangumiSubject;
}

interface CollectionPage {
  total: number;
  limit: number;
  offset: number;
  data: BangumiCollection[];
}

export interface SyncProgress {
  loaded: number;
  total: number;
  phase: "collections" | "details";
}

function wait(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const id = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(id);
      reject(new DOMException("Aborted", "AbortError"));
    }, { once: true });
  });
}

async function requestJson<T>(
  path: string,
  token?: string,
  signal?: AbortSignal,
): Promise<T> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    let response: Response;
    try {
      response = await fetch(`${API_BASE}${path}`, {
        method: "GET",
        headers: {
          Accept: "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        signal,
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      if (attempt < 3) {
        await wait(2 ** attempt * 1000, signal);
        continue;
      }
      throw new AppError("NETWORK", "无法连接 Bangumi API，请检查网络后重试。", true);
    }

    if (response.ok) return response.json() as Promise<T>;
    if ((response.status === 429 || response.status >= 500) && attempt < 3) {
      const retryAfter = Number(response.headers.get("Retry-After"));
      await wait(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 2 ** attempt * 1000, signal);
      continue;
    }
    if (response.status === 401 || response.status === 403) {
      throw new AppError("AUTH", "个人令牌无效、已过期，或没有读取该收藏的权限。", false);
    }
    if (response.status === 404) {
      throw new AppError("NOT_FOUND", "没有找到这个 Bangumi 用户。", false);
    }
    throw new AppError("BANGUMI_API", `Bangumi API 返回了 ${response.status}。`, response.status >= 500);
  }
  throw new AppError("BANGUMI_API", "Bangumi API 暂时不可用。", true);
}

function imageOf(images?: SubjectImages) {
  const image = images?.large ?? images?.common ?? images?.medium ?? images?.grid ?? images?.small;
  return image?.replace(/^http:\/\//, "https://");
}

async function mapWithConcurrency<T, R>(items: T[], concurrency: number, mapper: (item: T) => Promise<R>): Promise<R[]> {
  const result = new Array<R>(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor++;
      result[index] = await mapper(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return result;
}

function normalize(snapshotId: string, raw: BangumiCollection, subject: BangumiSubject): CollectionItem {
  return {
    snapshotId,
    subjectId: raw.subject_id,
    subjectType: raw.subject_type as SubjectType,
    collectionType: raw.type as CollectionType,
    rate: raw.rate,
    name: subject.name || `条目 #${raw.subject_id}`,
    nameCn: subject.name_cn ?? "",
    date: subject.date,
    platform: subject.platform,
    image: imageOf(subject.images),
    private: raw.private,
    tags: raw.tags ?? [],
    updatedAt: raw.updated_at,
  };
}

export async function syncBangumi(
  usernameInput: string,
  tokenInput: string,
  snapshotId: string,
  onProgress?: (progress: SyncProgress) => void,
  signal?: AbortSignal,
): Promise<{ profile: Omit<Profile, "id" | "createdAt" | "updatedAt">; items: CollectionItem[] }> {
  const username = usernameInput.trim();
  const token = tokenInput.trim() || undefined;
  if (!username) throw new AppError("USERNAME_REQUIRED", "请输入 Bangumi 用户名。", false);

  const user = await requestJson<BangumiUser>(token ? "/me" : `/users/${encodeURIComponent(username)}`, token, signal);
  if (token && user.username.toLowerCase() !== username.toLowerCase()) {
    throw new AppError("TOKEN_USER_MISMATCH", `这个令牌属于 ${user.username}，与输入的用户名不一致。`, false);
  }

  const collections: BangumiCollection[] = [];
  let offset = 0;
  let total = 0;
  do {
    const page = await requestJson<CollectionPage>(
      `/users/${encodeURIComponent(username)}/collections?limit=50&offset=${offset}`,
      token,
      signal,
    );
    total = page.total;
    collections.push(...page.data);
    offset += page.data.length;
    onProgress?.({ loaded: collections.length, total, phase: "collections" });
    if (page.data.length === 0) break;
  } while (offset < total);

  const rated = collections.filter((item) => item.rate > 0);
  let detailLoaded = 0;
  const items = await mapWithConcurrency(rated, 4, async (raw) => {
    const subject = raw.subject ?? await requestJson<BangumiSubject>(`/subjects/${raw.subject_id}`, token, signal);
    detailLoaded += 1;
    onProgress?.({ loaded: detailLoaded, total: rated.length, phase: "details" });
    return normalize(snapshotId, raw, subject);
  });

  return {
    profile: {
      username: user.username,
      nickname: user.nickname,
      avatar: (user.avatar?.large ?? user.avatar?.medium ?? user.avatar?.small)?.replace(/^http:\/\//, "https://"),
    },
    items,
  };
}
