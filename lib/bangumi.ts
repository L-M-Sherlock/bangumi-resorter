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
  nickname?: string | null;
  avatar?: { large?: string; medium?: string; small?: string } | null;
}

interface BangumiSubject {
  id: number;
  type: number;
  name: string;
  name_cn?: string | null;
  date?: string | null;
  platform?: string | null;
  images?: SubjectImages | null;
}

interface BangumiCollection {
  subject_id: number;
  subject_type: number;
  rate: number;
  type: number;
  private: boolean;
  tags?: string[] | null;
  updated_at?: string | null;
  subject?: BangumiSubject | null;
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

export interface RatingWriteTarget {
  subjectId: number;
  name: string;
  snapshotRate: number;
  targetRate: number;
}

export type RatingWriteCandidateStatus = "ready" | "unchanged" | "conflict" | "missing";

export interface RatingWriteCandidate extends RatingWriteTarget {
  liveRate?: number;
  status: RatingWriteCandidateStatus;
}

export interface RatingWritePreview {
  username: string;
  subjectType: SubjectType;
  checkedAt: string;
  candidates: RatingWriteCandidate[];
}

export interface RatingWriteProgress {
  completed: number;
  total: number;
  subjectId: number;
}

export interface RatingWriteFailure {
  candidate: RatingWriteCandidate;
  message: string;
}

export interface RatingWriteResult {
  succeeded: RatingWriteCandidate[];
  failed: RatingWriteFailure[];
  pending: RatingWriteCandidate[];
  skipped: RatingWriteCandidate[];
  unchanged: RatingWriteCandidate[];
  unverified: RatingWriteCandidate[];
  message?: string;
}

interface RequestOptions {
  method?: "GET" | "PATCH";
  token?: string;
  body?: unknown;
  signal?: AbortSignal;
  notFoundMessage?: string;
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

async function request(
  path: string,
  { method = "GET", token, body, signal, notFoundMessage }: RequestOptions = {},
): Promise<Response> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    let response: Response;
    try {
      response = await fetch(`${API_BASE}${path}`, {
        method,
        headers: {
          Accept: "application/json",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
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

    if (response.ok) return response;
    if ((response.status === 429 || response.status >= 500) && attempt < 3) {
      const retryAfter = Number(response.headers.get("Retry-After"));
      await wait(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 2 ** attempt * 1000, signal);
      continue;
    }
    if (response.status === 401 || response.status === 403) {
      throw new AppError("AUTH", "个人令牌无效、已过期，或没有所需权限。", false);
    }
    if (response.status === 404) {
      throw new AppError("NOT_FOUND", notFoundMessage ?? "没有找到请求的 Bangumi 数据。", false);
    }
    throw new AppError("BANGUMI_API", `Bangumi API 返回了 ${response.status}。`, response.status >= 500);
  }
  throw new AppError("BANGUMI_API", "Bangumi API 暂时不可用。", true);
}

async function requestJson<T>(
  path: string,
  token?: string,
  signal?: AbortSignal,
  notFoundMessage?: string,
): Promise<T> {
  const response = await request(path, { token, signal, notFoundMessage });
  return response.json() as Promise<T>;
}

function normalizedToken(tokenInput: string) {
  const token = tokenInput.trim();
  if (!token) throw new AppError("TOKEN_REQUIRED", "写回评分需要提供 Bangumi 个人令牌。", false);
  return token;
}

async function authenticatedUser(usernameInput: string, token: string, signal?: AbortSignal) {
  const username = usernameInput.trim();
  if (!username) throw new AppError("USERNAME_REQUIRED", "缺少当前 Bangumi 用户名。", false);
  const user = await requestJson<BangumiUser>("/me", token, signal);
  if (user.username.toLowerCase() !== username.toLowerCase()) {
    throw new AppError("TOKEN_USER_MISMATCH", `这个令牌属于 ${user.username}，与当前账号 ${username} 不一致。`, false);
  }
  return user;
}

async function collectionPageMap(
  username: string,
  token: string,
  subjectType: SubjectType,
  signal?: AbortSignal,
) {
  const collections = new Map<number, BangumiCollection>();
  let offset = 0;
  let total = 0;
  do {
    const page = await requestJson<CollectionPage>(
      `/users/${encodeURIComponent(username)}/collections?subject_type=${subjectType}&limit=50&offset=${offset}`,
      token,
      signal,
      "没有找到这个 Bangumi 用户。",
    );
    total = page.total;
    page.data.forEach((item) => collections.set(item.subject_id, item));
    offset += page.data.length;
    if (page.data.length === 0) break;
  } while (offset < total);
  return collections;
}

function validateRatingWriteTargets(targets: RatingWriteTarget[]) {
  const seen = new Set<number>();
  for (const target of targets) {
    if (!Number.isInteger(target.subjectId) || target.subjectId <= 0 || seen.has(target.subjectId)) {
      throw new AppError("INVALID_WRITE_TARGET", "写回列表包含无效或重复的 Bangumi 条目。", false);
    }
    if (!Number.isInteger(target.snapshotRate) || target.snapshotRate < 0 || target.snapshotRate > 10
      || !Number.isInteger(target.targetRate) || target.targetRate < 1 || target.targetRate > 10) {
      throw new AppError("INVALID_WRITE_RATE", "Bangumi 写回评分必须是 1–10 的整数。", false);
    }
    seen.add(target.subjectId);
  }
}

function classifyRatingWriteTargets(
  targets: RatingWriteTarget[],
  liveCollections: Map<number, BangumiCollection>,
): RatingWriteCandidate[] {
  return targets.map((target) => {
    const live = liveCollections.get(target.subjectId);
    if (!live) return { ...target, status: "missing" };
    if (live.rate === target.targetRate) return { ...target, liveRate: live.rate, status: "unchanged" };
    if (live.rate !== target.snapshotRate) return { ...target, liveRate: live.rate, status: "conflict" };
    return { ...target, liveRate: live.rate, status: "ready" };
  });
}

export async function previewBangumiRatingWrite(
  usernameInput: string,
  tokenInput: string,
  subjectType: SubjectType,
  targets: RatingWriteTarget[],
  signal?: AbortSignal,
): Promise<RatingWritePreview> {
  const token = normalizedToken(tokenInput);
  validateRatingWriteTargets(targets);
  const user = await authenticatedUser(usernameInput, token, signal);
  const liveCollections = await collectionPageMap(user.username, token, subjectType, signal);
  return {
    username: user.username,
    subjectType,
    checkedAt: new Date().toISOString(),
    candidates: classifyRatingWriteTargets(targets, liveCollections),
  };
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Bangumi API 未能完成这次写入。";
}

export async function writeBangumiRatings(
  usernameInput: string,
  tokenInput: string,
  preview: RatingWritePreview,
  onProgress?: (progress: RatingWriteProgress) => void,
  signal?: AbortSignal,
): Promise<RatingWriteResult> {
  const token = normalizedToken(tokenInput);
  if (preview.username.toLowerCase() !== usernameInput.trim().toLowerCase()) {
    throw new AppError("PREVIEW_USER_MISMATCH", "写回预览不属于当前 Bangumi 账号，请重新检查。", false);
  }
  const allTargets = preview.candidates.map(({ subjectId, name, snapshotRate, targetRate }) => ({ subjectId, name, snapshotRate, targetRate }));
  validateRatingWriteTargets(allTargets);
  const targets = preview.candidates
    .filter((candidate) => candidate.status === "ready")
    .map(({ subjectId, name, snapshotRate, targetRate }) => ({ subjectId, name, snapshotRate, targetRate }));
  const user = await authenticatedUser(usernameInput, token, signal);

  // Re-check live values immediately before the first mutation so a stale preview
  // cannot overwrite changes made on Bangumi in another tab or device.
  const beforeWrite = await collectionPageMap(user.username, token, preview.subjectType, signal);
  const refreshed = classifyRatingWriteTargets(targets, beforeWrite);
  const ready = refreshed.filter((candidate) => candidate.status === "ready");
  const skipped = [
    ...preview.candidates.filter((candidate) => candidate.status === "conflict" || candidate.status === "missing"),
    ...refreshed.filter((candidate) => candidate.status === "conflict" || candidate.status === "missing"),
  ];
  const alreadyTarget = [
    ...preview.candidates.filter((candidate) => candidate.status === "unchanged"),
    ...refreshed.filter((candidate) => candidate.status === "unchanged"),
  ];
  const attempted: RatingWriteCandidate[] = [];
  let pending: RatingWriteCandidate[] = [];
  let writeError: RatingWriteFailure | undefined;

  for (let index = 0; index < ready.length; index += 1) {
    const candidate = ready[index];
    attempted.push(candidate);
    try {
      await request(`/users/-/collections/${candidate.subjectId}`, {
        method: "PATCH",
        token,
        body: { rate: candidate.targetRate },
        signal,
        notFoundMessage: `${candidate.name} 已不在当前账号的收藏中。`,
      });
      onProgress?.({ completed: index + 1, total: ready.length, subjectId: candidate.subjectId });
    } catch (error) {
      writeError = { candidate, message: errorMessage(error) };
      pending = ready.slice(index + 1);
      break;
    }
  }

  let verifiedCollections: Map<number, BangumiCollection>;
  try {
    verifiedCollections = await collectionPageMap(user.username, token, preview.subjectType, signal);
  } catch (error) {
    return {
      succeeded: [], failed: [], pending, skipped, unchanged: alreadyTarget, unverified: attempted,
      message: writeError?.message ?? `写入已提交，但重新读取验证失败：${errorMessage(error)}`,
    };
  }

  const succeeded: RatingWriteCandidate[] = [];
  const failed: RatingWriteFailure[] = [];
  const unverified: RatingWriteCandidate[] = [];
  for (const candidate of attempted) {
    if (verifiedCollections.get(candidate.subjectId)?.rate === candidate.targetRate) succeeded.push(candidate);
    else failed.push({
      candidate,
      message: candidate.subjectId === writeError?.candidate.subjectId
        ? writeError.message
        : "Bangumi 返回成功，但重新读取后评分未变为目标值。",
    });
  }
  return {
    succeeded, failed, pending, skipped, unchanged: alreadyTarget, unverified,
    message: writeError && failed.some((entry) => entry.candidate.subjectId === writeError.candidate.subjectId)
      ? writeError.message
      : undefined,
  };
}

function imageOf(images?: SubjectImages | null) {
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
    date: subject.date ?? undefined,
    platform: subject.platform ?? undefined,
    image: imageOf(subject.images),
    private: raw.private,
    tags: raw.tags ?? [],
    updatedAt: raw.updated_at ?? undefined,
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
      nickname: user.nickname ?? undefined,
      avatar: (user.avatar?.large ?? user.avatar?.medium ?? user.avatar?.small)?.replace(/^http:\/\//, "https://"),
    },
    items,
  };
}
