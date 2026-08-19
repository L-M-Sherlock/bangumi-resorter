"use client";
/* eslint-disable @next/next/no-img-element -- Bangumi cover hosts are user-data dependent; static export cannot preconfigure every remote host. */

import { FormEvent, KeyboardEvent as ReactKeyboardEvent, ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { Term } from "@/app/Term";
import { ThemeToggle } from "@/app/ThemeToggle";
import {
  previewBangumiRatingWrite,
  RatingWriteCandidate,
  RatingWritePreview,
  RatingWriteProgress,
  RatingWriteResult,
  syncBangumi,
  SyncProgress,
  writeBangumiRatings,
} from "@/lib/bangumi";
import { createDemoItems } from "@/lib/demo";
import {
  commitComparisonDeletion,
  commitSessionBudgetMode,
  commitSessionDistribution,
  commitResponse,
  commitUndo,
  createSession,
  db,
  deleteSession,
  deriveSessionWithTagFilter,
  exportProject,
  getSessionBundle,
  getSnapshotItems,
  importProject,
  initializeModel,
  lastActiveResponse,
  latestSnapshot,
  listSessions,
  markExported,
  previewComparisonImport,
  previewSessionTagDerivation,
  previewSessionUpgrade,
  saveSnapshot,
  upgradeSessionToSnapshot,
} from "@/lib/db";
import { downloadJson, downloadText, readBackup, requestPersistentStorage, resultsCsv, storageStatus } from "@/lib/export";
import {
  DEFAULT_SCORE_LEVELS,
  MAX_SCORE_LEVELS,
  MIN_SCORE_LEVELS,
  distributionConfig,
  distributionWithLevelCount,
  normalizeScoreLevelCount,
  resampleDistributionWeights,
  scoreDistributionStats,
} from "@/lib/distribution";
import { bangumiCoverVariant } from "@/lib/images";
import { LOCAL_PROJECT_MARKER_KEY, PRINCIPLES_RETURN_PENDING_KEY, PRINCIPLES_RETURN_TARGET_KEY, sitePath } from "@/lib/site-path";
import type { TermKey } from "@/lib/terminology";
import { buildRankedItems } from "@/lib/ranking/engine";
import {
  BUDGET_MODE_COPY,
  allowedCrossTwoBucketCount,
  rankingTuning,
  recommendedDistribution,
  sessionBudgetMode,
} from "@/lib/ranking/strategy";
import { RankingWorkerClient } from "@/lib/ranking/worker-client";
import {
  collectionTagFilter,
  collectionTagOptions,
  filterBaseItems,
  filterScopeItems,
  itemMatchesTagFilter,
  normalizeCollectionTag,
  sameTagFilter,
  tagFilterSummary,
} from "@/lib/scope";
import {
  COLLECTION_TYPES,
  CollectionItem,
  CollectionType,
  ComparisonBudgetMode,
  ComparisonImportPreview,
  ComparisonOutcome,
  ComparisonRecord,
  DistributionConfig,
  DistributionPreset,
  ModelState,
  NextPair,
  Profile,
  RankedItem,
  RankingHistoryInput,
  Snapshot,
  SortingSession,
  StoppingForecast,
  SUBJECT_TYPES,
  SubjectType,
  SessionTagFilter,
} from "@/lib/types";

type View = "connect" | "library" | "compare" | "results" | "backup";

interface CompareState {
  session: SortingSession;
  items: CollectionItem[];
  history: ComparisonRecord[];
  model: ModelState;
  nextPair?: NextPair;
}

const subjectEntries = Object.entries(SUBJECT_TYPES).map(([id, label]) => [Number(id) as SubjectType, label] as const);
const collectionEntries = Object.entries(COLLECTION_TYPES).map(([id, label]) => [Number(id) as CollectionType, label] as const);

function toRankingComparisons(history: ComparisonRecord[]) {
  return history
    .filter((record) => record.active && record.outcome !== "skip")
    .map((record) => ({ leftSubjectId: record.leftSubjectId, rightSubjectId: record.rightSubjectId, outcome: record.outcome as "left" | "tie" | "right" }));
}

function toRankingHistory(history: ComparisonRecord[]): RankingHistoryInput[] {
  return history
    .filter((record) => record.active)
    .map((record) => ({
      recordId: record.id,
      sessionId: record.sessionId,
      leftSubjectId: record.leftSubjectId,
      rightSubjectId: record.rightSubjectId,
      outcome: record.outcome,
      acceptedCountAtAnswer: record.acceptedCountAtAnswer,
      queryKind: record.queryKind ?? "adaptive",
      calibrationOfComparisonId: record.calibrationOfComparisonId,
      createdAt: record.createdAt,
    }));
}

function percent(value?: number) {
  return `${Math.round((value ?? 0) * 100)}%`;
}

function expectedCrossTwoBucketCount(diagnostics?: ModelState["diagnostics"]) {
  if (diagnostics?.expectedCrossTwoBucketCount !== undefined) return diagnostics.expectedCrossTwoBucketCount;
  if (!diagnostics?.adjacentBucketStabilityByItem) return undefined;
  return Object.values(diagnostics.adjacentBucketStabilityByItem)
    .reduce((sum, stability) => sum + 1 - stability, 0);
}

function countValue(value?: number) {
  return value === undefined ? "—" : `${Math.round(value)} 部`;
}

function crossTwoBucketValue(diagnostics?: ModelState["diagnostics"]) {
  return countValue(diagnostics?.crossTwoBucketCountMedian ?? expectedCrossTwoBucketCount(diagnostics));
}

function crossTwoBucketInterval(diagnostics?: ModelState["diagnostics"]) {
  const mean = expectedCrossTwoBucketCount(diagnostics);
  if (mean === undefined) return "正在估计";
  const low = diagnostics?.crossTwoBucketCountLow;
  const high = diagnostics?.crossTwoBucketCountHigh;
  const interval = low === undefined || high === undefined ? "" : `80% 后验区间 ${Math.round(low)}–${Math.round(high)} 部 · `;
  return `${interval}均值 ${mean.toFixed(mean >= 10 ? 0 : 1)} 部`;
}

function maxBucketDisplacementValue(diagnostics?: ModelState["diagnostics"]) {
  const value = diagnostics?.maxBucketDisplacementMedian;
  return value === undefined ? "—" : `${Math.round(value)} 档`;
}

function maxBucketDisplacementInterval(diagnostics?: ModelState["diagnostics"]) {
  const median = diagnostics?.maxBucketDisplacementMedian;
  const high = diagnostics?.maxBucketDisplacementHigh;
  if (median === undefined || high === undefined) return "正在估计";
  return `P50 ${Math.round(median)} 档 · P90 ${Math.round(high)} 档`;
}

function forecastRange(diagnostics?: ModelState["diagnostics"]) {
  const forecast = diagnostics?.forecast;
  if (!forecast) return "正在建立预测";
  if (forecast.status === "ready") return "无需追加";
  if (forecast.lowerAdditional !== undefined && forecast.upperAdditional !== undefined) {
    return `约 ${forecast.lowerAdditional}–${forecast.upperAdditional} 次`;
  }
  if (forecast.medianAdditional !== undefined) return `约 ${forecast.medianAdditional} 次，上界未定`;
  if ((forecast.withinProjectionSuccesses ?? forecast.beforeLimitSuccesses ?? -1) === 0) return "尚未观察到达标路径";
  if (forecast.status === "uncertain") return "暂时无法可靠估计";
  return "正在扩大预测窗口";
}

function forecastProjectionProbability(forecast: StoppingForecast | undefined) {
  if (!forecast) return "正在估计";
  const successes = forecast.withinProjectionSuccesses ?? forecast.beforeLimitSuccesses;
  const probability = forecast.probabilityWithinProjection ?? forecast.probabilityBeforeLimit;
  const low = forecast.probabilityWithinProjectionLow ?? forecast.probabilityBeforeLimitLow;
  const high = forecast.probabilityWithinProjectionHigh ?? forecast.probabilityBeforeLimitHigh;
  if (successes === undefined || low === undefined || high === undefined) return percent(probability);
  return `${successes}/${forecast.rolloutCount} · ${percent(probability)}（90% MC ${percent(low)}–${percent(high)}）`;
}

function stoppingStability(diagnostics?: ModelState["diagnostics"]) {
  if (!diagnostics) return "正在估计";
  const bottleneck = diagnostics.stoppingChecks?.find((check) =>
    check.mode === diagnostics.stoppingBottleneckMode);
  if (bottleneck) {
    return `${bottleneck.stableSamples}/${bottleneck.sampleCount} · ${percent(bottleneck.probability)}（90% MC ${percent(bottleneck.low)}–${percent(bottleneck.high)}）`;
  }
  const successes = diagnostics.coverageTargetStableSamples
    ?? diagnostics.adjacentBucketStableSamples
    ?? diagnostics.jointBucketStableSamples;
  const probability = diagnostics.coverageTargetStability
    ?? diagnostics.adjacentBucketStability
    ?? diagnostics.jointBucketStability;
  const low = diagnostics.coverageTargetStabilityLow
    ?? diagnostics.adjacentBucketStabilityLow
    ?? diagnostics.jointBucketStabilityLow;
  const high = diagnostics.coverageTargetStabilityHigh
    ?? diagnostics.adjacentBucketStabilityHigh
    ?? diagnostics.jointBucketStabilityHigh;
  return `${successes}/${diagnostics.sampleCount} · ${percent(probability)}（90% MC ${percent(low)}–${percent(high)}）`;
}

function StoppingCriterionDetail({ diagnostics }: { diagnostics?: ModelState["diagnostics"] }) {
  if (!diagnostics) return <>正在估计停止条件</>;
  const allowance = diagnostics.allowedCrossTwoBucketCount;
  const allowanceCopy = allowance === undefined ? "至多 10% 作品" : `最多 ${allowance} 部作品`;
  return <>达标样本 <Term term="monte-carlo">{stoppingStability(diagnostics)}</Term>
    {diagnostics.stoppingChecks && diagnostics.stoppingChecks.length > 1 && <>；<Term term="inference-mode">嵌套模式下界</Term> {diagnostics.stoppingChecks.map((check) => `${BUDGET_MODE_COPY[check.mode].label} ${percent(check.low)}`).join("、")}</>}
    ；每个样本允许{allowanceCopy}<Term term="cross-two-buckets">跨两档</Term>，停止要求所有模式检查的 <Term term="mc-lower-bound">90% MC 下界</Term>达到 90%</>;
}

function formatDate(date?: string) {
  if (!date) return "日期未知";
  return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "short", day: "numeric" }).format(new Date(date));
}

function formatDateTime(date: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  }).format(new Date(date));
}

function formatBytes(bytes: number) {
  if (!bytes) return "0 KB";
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function primaryName(item: CollectionItem) { return item.nameCn || item.name; }

function downloadName(prefix: string, username: string, extension: string) {
  const date = new Date().toISOString().slice(0, 10);
  return `${prefix}-${username}-${date}.${extension}`;
}

const pendingImageWarmups = new Map<string, HTMLImageElement>();

function warmImage(source: string) {
  if (typeof Image === "undefined" || pendingImageWarmups.has(source)) return;
  const image = new Image();
  pendingImageWarmups.set(source, image);
  const release = () => pendingImageWarmups.delete(source);
  image.addEventListener("load", release, { once: true });
  image.addEventListener("error", release, { once: true });
  image.decoding = "async";
  image.fetchPriority = "high";
  image.src = source;
}

function warmComparisonImages(items: CollectionItem[], pair?: NextPair) {
  if (!pair) return;
  for (const subjectId of [pair.leftSubjectId, pair.rightSubjectId]) {
    const source = items.find((item) => item.subjectId === subjectId)?.image;
    if (!source) continue;
    warmImage(bangumiCoverVariant(source, "c"));
    warmImage(source);
  }
}

function WidePoster({ item, source }: { item: CollectionItem; source: string }) {
  const [loadedSource, setLoadedSource] = useState("");
  const placeholder = bangumiCoverVariant(source, "c");
  if (placeholder === source) {
    return <img className="poster-image wide" src={source} alt={`${primaryName(item)} 封面`} loading="eager" decoding="async" fetchPriority="high" />;
  }
  return <div className={`poster-frame wide ${loadedSource === source ? "loaded" : ""}`}>
    <img key={`placeholder-${placeholder}`} className="poster-image poster-placeholder" src={placeholder} alt="" aria-hidden="true" loading="eager" decoding="async" fetchPriority="high" />
    <img key={source} className="poster-image poster-full" src={source} alt={`${primaryName(item)} 封面`} loading="eager" decoding="async" fetchPriority="high" onLoad={() => setLoadedSource(source)} />
  </div>;
}

function Poster({ item, wide = false }: { item: CollectionItem; wide?: boolean }) {
  if (item.image && wide) return <WidePoster item={item} source={item.image} />;
  if (item.image) {
    const medium = bangumiCoverVariant(item.image, "m");
    const common = bangumiCoverVariant(item.image, "c");
    const hasResponsiveVariants = medium !== item.image || common !== item.image;
    return <img className="poster-image" src={hasResponsiveVariants ? common : item.image} srcSet={hasResponsiveVariants ? `${medium} 100w, ${common} 150w` : undefined} sizes="48px" alt={`${primaryName(item)} 封面`} loading="lazy" decoding="async" fetchPriority="low" />;
  }
  return <div className={`poster-fallback tone-${item.subjectId % 4} ${wide ? "wide" : ""}`} aria-label={`${primaryName(item)} 无封面`}><span>{primaryName(item).slice(0, 1)}</span></div>;
}

function Brand() {
  return (
    <span className="brand">
      <span className="brand-mark">R</span>
      <span><strong>Resorter</strong><small>for Bangumi</small></span>
    </span>
  );
}

const GITHUB_REPOSITORY_URL = "https://github.com/L-M-Sherlock/bangumi-resorter";

function Shell({ view, onNavigate, profile, children }: { view: View; onNavigate: (view: View) => void; profile?: Profile; children: ReactNode }) {
  const nav: Array<[View, string, string]> = [
    ["library", "⌂", "收藏概览"], ["compare", "⇄", "两两比较"], ["results", "≋", "排序结果"], ["backup", "↓", "备份与导出"],
  ];
  return (
    <main className="app-shell">
      <aside className="sidebar">
        <button className="brand-button" aria-label="返回主页" title="收藏概览" onClick={() => onNavigate("library")}><Brand /></button>
        <nav aria-label="主要导航">
          {nav.map(([target, icon, label]) => (
            <button key={target} aria-label={label} title={label} className={view === target ? "active" : ""} onClick={() => onNavigate(target)}>
              <span className="nav-icon" aria-hidden="true">{icon}</span><span className="nav-label">{label}</span>
            </button>
          ))}
          <a className="desktop-nav-link" aria-label="排序原理" href={sitePath("/principles")}><span className="nav-icon" aria-hidden="true">§</span><span className="nav-label">原理</span></a>
          <a className="desktop-nav-link" href={GITHUB_REPOSITORY_URL} target="_blank" rel="noreferrer" title="在 GitHub 上打开项目并 Star"><span className="nav-icon" aria-hidden="true">★</span><span className="nav-label">GitHub Star</span></a>
          <details className="mobile-nav-more">
            <summary role="button" aria-label="更多导航" title="更多导航"><span className="nav-icon" aria-hidden="true">•••</span><span className="nav-label">更多</span></summary>
            <div className="mobile-nav-menu">
              <a href={sitePath("/principles")}><span aria-hidden="true">§</span><span>排序原理</span></a>
              <a href={GITHUB_REPOSITORY_URL} target="_blank" rel="noreferrer"><span aria-hidden="true">★</span><span>GitHub Star</span></a>
            </div>
          </details>
        </nav>
        {profile && <div className="profile-mini">
          {profile.avatar ? <img src={profile.avatar} alt="" /> : <span className="avatar-fallback">{profile.username[0]?.toUpperCase()}</span>}
          <div><strong>{profile.nickname || profile.username}</strong><small>@{profile.username}</small></div>
        </div>}
        <div className="sidebar-note"><span className="status-dot" /><div><strong>排序数据仅存于本机</strong><small>默认只读；确认后才会写回</small></div></div>
        <ThemeToggle />
      </aside>
      <section className="workspace">{children}</section>
    </main>
  );
}

function Notice({ tone = "info", children }: { tone?: "info" | "warning" | "error" | "success"; children: ReactNode }) {
  return <div className={`notice notice-${tone}`} role={tone === "error" ? "alert" : "status"}>{children}</div>;
}

function RestoreSplash() {
  return <div className="restore-splash" role="status"><span className="brand-mark">R</span><strong>正在恢复本地排序…</strong></div>;
}

function ConnectView({ onConnected, onCancel, currentUsername }: {
  onConnected: (snapshot: Snapshot) => Promise<void>;
  onCancel?: () => void;
  currentUsername?: string;
}) {
  const [username, setUsername] = useState("");
  const [token, setToken] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<SyncProgress>();
  const [error, setError] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault(); setError(""); setBusy(true); setProgress(undefined);
    const snapshotId = crypto.randomUUID();
    try {
      const result = await syncBangumi(username, token, snapshotId, setProgress);
      const snapshot = await saveSnapshot(result.profile, snapshotId, result.items);
      await onConnected(snapshot);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "同步失败，请重试。"); }
    finally { setBusy(false); }
  }

  async function demo() {
    setBusy(true); setError("");
    try {
      const snapshotId = crypto.randomUUID();
      const snapshot = await saveSnapshot({ username: "demo", nickname: "演示项目" }, snapshotId, createDemoItems(snapshotId));
      await onConnected(snapshot);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "无法创建演示项目。"); }
    finally { setBusy(false); }
  }

  const progressPercent = progress?.total ? Math.min(100, Math.round(progress.loaded / progress.total * 100)) : 0;
  return (
    <main className="connect-page">
      <section className="connect-intro">
        <div className="connect-header"><Brand /><ThemeToggle /></div>
        <span className="hero-kicker">PERSONAL MEDIA RANKING</span>
        <h1>让你的评分，<br />重新变得有意义。</h1>
        <p>不再纠结“它值 8 分还是 9 分”。只需回答哪一部更喜欢，Resorter 会用 <Term term="bradley-terry">Bradley–Terry 模型</Term>得到可检查、逐步稳定的个人偏好顺序。</p>
        <div className="hero-links">
          <a className="principles-entry" href={sitePath("/principles")}>为什么这样排序？阅读方法、证据与限制 <span aria-hidden="true">→</span></a>
          <a className="github-star-button" href={GITHUB_REPOSITORY_URL} target="_blank" rel="noreferrer"><span aria-hidden="true">★</span>在 GitHub 上 Star</a>
        </div>
        <div className="method-steps">
          <span><b>01</b>同步已评分收藏</span><i />
          <span><b>02</b>两两比较</span><i />
          <span><b>03</b>导出或写回结果</span>
        </div>
      </section>
      <section className="connect-panel">
        <div className="connect-card">
          <span className="eyebrow">{currentUsername ? "切换账号" : "开始使用"}</span>
          <h2>{currentUsername ? "连接其他 Bangumi 账号" : "连接 Bangumi 收藏"}</h2>
          <p>{currentUsername ? `当前账号 @${currentUsername} 的本地数据会完整保留。` : "同步阶段只读取你的收藏和评分；只有在结果页 Danger Zone 明确确认后才会写回。"}</p>
          <form onSubmit={submit}>
            <label>Bangumi 用户名<input required value={username} onChange={(event) => setUsername(event.target.value)} placeholder="例如：sai" autoComplete="username" /></label>
            <label>个人令牌 <span>可选，用于私有收藏</span>
              <div className="token-field"><input value={token} onChange={(event) => setToken(event.target.value)} type={showToken ? "text" : "password"} placeholder="仅保存在当前页面内存" autoComplete="off" /><button type="button" onClick={() => setShowToken((value) => !value)}>{showToken ? "隐藏" : "显示"}</button></div>
            </label>
            {error && <Notice tone="error">{error}</Notice>}
            {busy && progress && <div className="sync-progress"><span>{progress.phase === "collections" ? "正在读取收藏" : "正在补全条目信息"} · {progress.loaded}/{progress.total}</span><div><i style={{ width: `${progressPercent}%` }} /></div></div>}
            <button className="primary-button" disabled={busy}>{busy ? "正在同步…" : "同步我的收藏"}<span>→</span></button>
          </form>
          <div className="or-divider"><span>或者</span></div>
          <button className="demo-button" onClick={demo} disabled={busy}>先用演示数据体验</button>
          <small className="privacy-copy">令牌不会写入浏览器存储、日志或导出文件，刷新页面后即消失。</small>
          {onCancel && <button className="outline-button full connect-return" type="button" disabled={busy} onClick={onCancel}>返回当前账号 · @{currentUsername}</button>}
        </div>
      </section>
    </main>
  );
}

function ResyncDialog({ snapshot, onCancel, onConnected }: {
  snapshot: Snapshot;
  onCancel: () => void;
  onConnected: (snapshot: Snapshot) => Promise<void>;
}) {
  const [token, setToken] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<SyncProgress>();
  const [error, setError] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError(""); setProgress(undefined);
    const snapshotId = crypto.randomUUID();
    try {
      const result = await syncBangumi(snapshot.username, token, snapshotId, setProgress);
      const saved = await saveSnapshot(result.profile, snapshotId, result.items);
      await onConnected(saved);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "重新同步失败，请重试。"); }
    finally { setBusy(false); }
  }

  const progressPercent = progress?.total ? Math.min(100, Math.round(progress.loaded / progress.total * 100)) : 0;
  return <div className="scope-modal-backdrop">
    <section className="scope-modal resync-modal" role="dialog" aria-modal="true" aria-labelledby="resync-modal-title">
      <div className="scope-modal-header"><div><span className="eyebrow">当前账号</span><h2 id="resync-modal-title">重新同步 {snapshot.username}</h2></div><button type="button" aria-label="关闭重新同步窗口" disabled={busy} onClick={onCancel}>×</button></div>
      <p>系统会创建当前账号的新<Term term="snapshot">收藏快照</Term>；旧快照、排序会话和判断记录都会保留。</p>
      <form onSubmit={submit}>
        <div className="resync-account"><span>Bangumi 用户名</span><strong>@{snapshot.username}</strong></div>
        <label className="field-label">个人令牌 <small>{snapshot.containsPrivate ? "必填，用于继续同步私有收藏" : "可选，用于私有收藏"}</small>
          <div className="token-field"><input required={snapshot.containsPrivate} value={token} onChange={(event) => setToken(event.target.value)} type={showToken ? "text" : "password"} placeholder="仅保存在当前页面内存" autoComplete="off" /><button type="button" onClick={() => setShowToken((value) => !value)}>{showToken ? "隐藏" : "显示"}</button></div>
        </label>
        {snapshot.containsPrivate && <Notice tone="warning">上次<Term term="snapshot">快照</Term>包含私有收藏。为避免新快照遗漏这些条目，请重新提供个人令牌。</Notice>}
        {error && <Notice tone="error">{error}</Notice>}
        {busy && progress && <div className="sync-progress"><span>{progress.phase === "collections" ? "正在读取收藏" : "正在补全条目信息"} · {progress.loaded}/{progress.total}</span><div><i style={{ width: `${progressPercent}%` }} /></div></div>}
        <div className="scope-modal-actions"><button className="outline-button" type="button" disabled={busy} onClick={onCancel}>取消</button><button className="primary-button compact" disabled={busy}>{busy ? "正在同步…" : "同步当前账号"}</button></div>
      </form>
    </section>
  </div>;
}

function DistributionStats({ counts, label }: { counts: number[]; label: string }) {
  const stats = scoreDistributionStats(counts);
  const mean = stats?.mean.toFixed(1) ?? "—";
  const standardDeviation = stats?.standardDeviation.toFixed(1) ?? "—";
  return <span
    className="distribution-stats"
    data-series={label}
    aria-label={`${label}：平均值 ${mean}，标准差 ${standardDeviation}`}
  >
    <b>{label}</b>
    <span>平均值 <strong>{mean}</strong></span>
    <span>标准差 <strong>{standardDeviation}</strong></span>
  </span>;
}

function ScoreHistogram({ counts, tone, label, statsLabel }: { counts: number[]; tone: "old" | "new"; label: string; statsLabel: string }) {
  const max = Math.max(1, ...counts);
  return <div className="score-histogram">
    <DistributionStats counts={counts} label={statsLabel} />
    <div className="histogram-scroll">
      <div
        className={`histogram single-series ${tone}`}
        aria-label={label}
        data-level-count={counts.length}
        style={{ gridTemplateColumns: `repeat(${counts.length}, minmax(16px, 1fr))`, minWidth: `${Math.max(0, counts.length * 28)}px` }}
      >
        {counts.map((count, index) => <div className="histogram-column" key={index} title={`${index + 1} 分：${count} 个`}>
          <div className="bar-space"><i className={`bar-${tone}`} style={{ height: `${count / max * 100}%` }} /></div><span>{index + 1}</span>
        </div>)}
      </div>
    </div>
  </div>;
}

function OriginalScoreHistogram({ items }: { items: CollectionItem[] }) {
  const counts = Array.from({ length: DEFAULT_SCORE_LEVELS }, (_, index) => items.filter((item) => item.rate === index + 1).length);
  return <ScoreHistogram counts={counts} tone="old" label="原评分 1 至 10 分布图" statsLabel="原评分" />;
}

function NewScoreHistogram({ result, levelCount }: { result: RankedItem[]; levelCount: number }) {
  const counts = Array.from({ length: levelCount }, (_, index) => result.filter((item) => item.newRate === index + 1).length);
  return <ScoreHistogram counts={counts} tone="new" label={`新评分 1 至 ${levelCount} 分布图`} statsLabel="新评分" />;
}

function TenLevelComparisonHistogram({ items, result }: { items: CollectionItem[]; result: RankedItem[] }) {
  const original = Array.from({ length: DEFAULT_SCORE_LEVELS }, (_, index) => items.filter((item) => item.rate === index + 1).length);
  const updated = Array.from({ length: DEFAULT_SCORE_LEVELS }, (_, index) => result.filter((item) => item.newRate === index + 1).length);
  const max = Math.max(1, ...original, ...updated);
  return <div className="score-histogram comparison-histogram">
    <div className="distribution-stats-row">
      <DistributionStats counts={original} label="原评分" />
      <DistributionStats counts={updated} label="新评分" />
    </div>
    <div className="histogram-scroll">
      <div
        className="histogram"
        aria-label="原评分与新评分 1 至 10 分布对比图"
        data-level-count={DEFAULT_SCORE_LEVELS}
        style={{ gridTemplateColumns: `repeat(${DEFAULT_SCORE_LEVELS}, minmax(16px, 1fr))` }}
      >
        {original.map((count, index) => <div className="histogram-column" key={index} title={`${index + 1} 分：原评分 ${count} 个，新评分 ${updated[index]} 个`}>
          <div className="bar-space">
            <i className="bar-new" style={{ height: `${updated[index] / max * 100}%` }} />
            <i className="bar-old" style={{ height: `${count / max * 100}%` }} />
          </div><span>{index + 1}</span>
        </div>)}
      </div>
    </div>
  </div>;
}

function DistributionWeights({ weights, onChange }: { weights: number[]; onChange: (weights: number[]) => void }) {
  return <div className="weight-editor" aria-label="自定义评分权重">
    {weights.map((weight, index) => <label key={index}><span>{index + 1} 分</span><input type="number" min="0" max="100" step="0.1" value={weight} onChange={(event) => {
      const next = [...weights];
      next[index] = Math.max(0, Number(event.target.value) || 0);
      onChange(next);
    }} /></label>)}
  </div>;
}

function CustomDistributionEditor({ weights, busy, onApply }: { weights: number[]; busy: boolean; onApply: (weights: number[]) => Promise<void> }) {
  const [draft, setDraft] = useState([...weights]);
  return <div className="custom-distribution-editor">
    <DistributionWeights weights={draft} onChange={setDraft} />
    <button className="outline-button full" disabled={busy} onClick={() => void onApply(draft)}>应用自定义权重</button>
  </div>;
}

const SCORE_LEVEL_OPTIONS = Array.from(
  { length: MAX_SCORE_LEVELS - MIN_SCORE_LEVELS + 1 },
  (_, index) => MIN_SCORE_LEVELS + index,
);

interface ThemedSelectOption<Value extends string> {
  value: Value;
  label: string;
}

function ThemedSelect<Value extends string>({
  id,
  value,
  options,
  ariaLabel,
  menuLabel,
  disabled = false,
  compact = false,
  alignMenu = "start",
  rootClassName,
  triggerClassName,
  title,
  onChange,
}: {
  id: string;
  value: Value;
  options: readonly ThemedSelectOption<Value>[];
  ariaLabel: string;
  menuLabel?: string;
  disabled?: boolean;
  compact?: boolean;
  alignMenu?: "start" | "end";
  rootClassName?: string;
  triggerClassName?: string;
  title?: string;
  onChange: (value: Value) => void | Promise<void>;
}) {
  const selectedIndex = Math.max(0, options.findIndex((option) => option.value === value));
  const selectedOption = options[selectedIndex];
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(selectedIndex);
  const [opensUpward, setOpensUpward] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const listboxId = `${id}-options`;

  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => optionRefs.current[activeIndex]?.focus());
    return () => cancelAnimationFrame(frame);
  }, [activeIndex, open]);

  useEffect(() => {
    if (!open) return;
    function handlePointerDown(event: PointerEvent) {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) setOpen(false);
    }
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [open]);

  function normalizedIndex(index: number) {
    return (index + options.length) % options.length;
  }

  function focusOption(index: number) {
    setActiveIndex(normalizedIndex(index));
  }

  function openMenu(index = selectedIndex) {
    if (disabled || options.length === 0) return;
    const bounds = rootRef.current?.getBoundingClientRect();
    if (bounds) {
      const estimatedHeight = Math.min(360, options.length * 44 + 12);
      const spaceBelow = window.innerHeight - bounds.bottom - 12;
      const spaceAbove = bounds.top - 12;
      setOpensUpward(spaceBelow < estimatedHeight && spaceAbove > spaceBelow);
    }
    setActiveIndex(normalizedIndex(index));
    setOpen(true);
  }

  function closeMenu(restoreFocus = false) {
    setOpen(false);
    if (restoreFocus) requestAnimationFrame(() => triggerRef.current?.focus());
  }

  function choose(option: ThemedSelectOption<Value>) {
    closeMenu(true);
    if (option.value !== value) void onChange(option.value);
  }

  function handleTriggerKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (open) focusOption(activeIndex + (event.key === "ArrowDown" ? 1 : -1));
      else openMenu(selectedIndex);
    } else if ((event.key === "Enter" || event.key === " ") && !open) {
      event.preventDefault();
      openMenu(selectedIndex);
    } else if (event.key === "Home") {
      event.preventDefault();
      openMenu(0);
    } else if (event.key === "End") {
      event.preventDefault();
      openMenu(options.length - 1);
    } else if (event.key === "Escape" && open) {
      event.preventDefault();
      closeMenu();
    }
  }

  function handleOptionKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>, index: number) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      focusOption(index + 1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      focusOption(index - 1);
    } else if (event.key === "Home") {
      event.preventDefault();
      focusOption(0);
    } else if (event.key === "End") {
      event.preventDefault();
      focusOption(options.length - 1);
    } else if (event.key === "Escape") {
      event.preventDefault();
      closeMenu(true);
    } else if (event.key === "Tab") {
      closeMenu();
    }
  }

  if (!selectedOption) return null;

  const rootClasses = [
    "themed-select",
    compact ? "compact" : "",
    alignMenu === "end" ? "align-end" : "",
    opensUpward ? "opens-upward" : "",
    open ? "open" : "",
    rootClassName ?? "",
  ].filter(Boolean).join(" ");

  return <div
    ref={rootRef}
    className={rootClasses}
    data-themed-select={id}
    onBlur={(event) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) closeMenu();
    }}
  >
    <button
      id={id}
      ref={triggerRef}
      className={`themed-select-trigger${triggerClassName ? ` ${triggerClassName}` : ""}`}
      type="button"
      data-value={value}
      aria-label={ariaLabel}
      aria-haspopup="listbox"
      aria-expanded={open}
      aria-controls={listboxId}
      disabled={disabled}
      title={title}
      onClick={() => open ? closeMenu() : openMenu()}
      onKeyDown={handleTriggerKeyDown}
    >
      <span className="themed-select-value">{selectedOption.label}</span>
      <span className="themed-select-chevron" aria-hidden="true">⌄</span>
    </button>
    {open && <div id={listboxId} className="themed-select-menu" role="listbox" aria-label={menuLabel ?? `${ariaLabel}选项`}>
      {options.map((option, index) => <button
        key={option.value}
        ref={(element) => { optionRefs.current[index] = element; }}
        className={`themed-select-option${activeIndex === index ? " active" : ""}`}
        type="button"
        data-value={option.value}
        role="option"
        aria-selected={option.value === value}
        tabIndex={activeIndex === index ? 0 : -1}
        onMouseEnter={() => setActiveIndex(index)}
        onClick={() => choose(option)}
        onKeyDown={(event) => handleOptionKeyDown(event, index)}
      >
        <span>{option.label}</span>
        <span className="themed-select-check" aria-hidden="true">{option.value === value ? "✓" : ""}</span>
      </button>)}
    </div>}
  </div>;
}

const SCORE_LEVEL_SELECT_OPTIONS = SCORE_LEVEL_OPTIONS.map((levelCount) => ({
  value: String(levelCount),
  label: `${levelCount} 档`,
}));

function ScoreLevelSelect({ id, value, disabled, compact, alignMenu, className, onChange }: {
  id: string;
  value: number;
  disabled?: boolean;
  compact?: boolean;
  alignMenu?: "start" | "end";
  className?: string;
  onChange: (levelCount: number) => void;
}) {
  return <ThemedSelect
    id={id}
    value={String(normalizeScoreLevelCount(value))}
    options={SCORE_LEVEL_SELECT_OPTIONS}
    ariaLabel="评分档数"
    menuLabel="评分档数选项"
    disabled={disabled}
    compact={compact}
    alignMenu={alignMenu}
    rootClassName="score-level-select"
    triggerClassName={className}
    onChange={(nextValue) => onChange(normalizeScoreLevelCount(nextValue))}
  />;
}

const TAG_OPTION_LIMIT = 50;

function TagFilterSelector({ id, items, selectedTags, onChange }: {
  id: string;
  items: CollectionItem[];
  selectedTags: string[];
  onChange: (tags: string[]) => void;
}) {
  const [query, setQuery] = useState("");
  const options = collectionTagOptions(items);
  const selectedKeys = new Set(selectedTags.map(normalizeCollectionTag));
  const normalizedQuery = normalizeCollectionTag(query);
  const matchingOptions = options.filter((option) => !normalizedQuery || option.key.includes(normalizedQuery));
  const visibleOptions = matchingOptions.slice(0, TAG_OPTION_LIMIT);
  const filter = collectionTagFilter(selectedTags);
  const matchedCount = items.filter((item) => itemMatchesTagFilter(item, filter)).length;

  function updateTag(label: string) {
    const key = normalizeCollectionTag(label);
    const next = selectedKeys.has(key)
      ? selectedTags.filter((tag) => normalizeCollectionTag(tag) !== key)
      : [...selectedTags, label];
    onChange(collectionTagFilter(next)?.tags ?? []);
  }

  return <div className="tag-filter-control">
    {selectedTags.length > 0 && <div className="tag-filter-selected" aria-label="已选择标签">
      {selectedTags.map((tag) => <button key={normalizeCollectionTag(tag)} type="button" onClick={() => updateTag(tag)}>{tag}<span aria-hidden="true">×</span></button>)}
    </div>}
    <input
      id={id}
      type="search"
      value={query}
      onChange={(event) => setQuery(event.target.value)}
      placeholder="搜索个人收藏标签"
      autoComplete="off"
    />
    <div className="tag-filter-options" role="listbox" aria-label="个人收藏标签">
      {visibleOptions.map((option) => {
        const selected = selectedKeys.has(option.key);
        return <button
          key={option.key}
          type="button"
          role="option"
          aria-selected={selected}
          className={selected ? "selected" : ""}
          onClick={() => updateTag(option.label)}
        ><span>{option.label}</span><small>{option.count}</small></button>;
      })}
      {visibleOptions.length === 0 && <span className="tag-filter-empty">没有匹配的标签</span>}
    </div>
    {matchingOptions.length > TAG_OPTION_LIMIT && <small className="field-help">仅显示前 {TAG_OPTION_LIMIT} 个结果，请继续输入以缩小范围。</small>}
    <small className="tag-filter-summary">{selectedTags.length === 0
      ? `未选择标签，包含当前基础范围的全部 ${items.length} 部作品`
      : `同时包含 ${selectedTags.length} 个标签，匹配 ${matchedCount} 部作品`}</small>
  </div>;
}

interface TagDerivationDraft {
  session: SortingSession;
  baseItems: CollectionItem[];
  previousItemCount: number;
  selectedTags: string[];
}

const NEW_SESSION_INFERENCE_OPTIONS: Array<ThemedSelectOption<ComparisonBudgetMode>> = [
  { value: "quick", label: "快速（推荐）" },
  { value: "standard", label: "标准" },
  { value: "thorough", label: "精细" },
];

const MANUAL_OUTCOME_OPTIONS: Array<ThemedSelectOption<Exclude<ComparisonOutcome, "skip">>> = [
  { value: "left", label: "更喜欢左侧" },
  { value: "tie", label: "差不多喜欢" },
  { value: "right", label: "更喜欢右侧" },
];

function distributionPresetOptions(levelCount: number): Array<ThemedSelectOption<DistributionPreset>> {
  return [
    { value: "uniform", label: `均匀 ${levelCount} 档` },
    { value: "preserve", label: "保持原分布" },
    { value: "high-tail", label: "高分辨率尾部" },
    { value: "reverse-j", label: "反 J 分布" },
    { value: "custom", label: "自定义权重" },
  ];
}

function LibraryView({ snapshot, items, sessions, onStart, onResume, onUpgradeSession, onDeriveSession, onDeleteSession, onSyncAgain, onSwitchAccount }: {
  snapshot: Snapshot; items: CollectionItem[]; sessions: SortingSession[];
  onStart: (
    type: SubjectType,
    statuses: CollectionType[],
    distribution: DistributionConfig,
    budgetMode: ComparisonBudgetMode,
    tagFilter?: SessionTagFilter,
    sourceSessionId?: string,
    expectedSourceVersion?: number,
  ) => Promise<void>;
  onResume: (sessionId: string) => Promise<void>;
  onUpgradeSession: (sessionId: string) => Promise<void>;
  onDeriveSession: (sessionId: string, tagFilter?: SessionTagFilter) => Promise<void>;
  onDeleteSession: (sessionId: string) => Promise<void>;
  onSyncAgain: () => void;
  onSwitchAccount: () => void;
}) {
  const availableTypes = subjectEntries.filter(([type]) => items.some((item) => item.subjectType === type));
  const initialType = availableTypes[0]?.[0] ?? 2;
  const [selectedType, setSelectedType] = useState<SubjectType>(initialType);
  const [statuses, setStatuses] = useState<CollectionType[]>(collectionEntries.map(([type]) => type));
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [manualPreset, setManualPreset] = useState<DistributionPreset>();
  const [scoreLevelCount, setScoreLevelCount] = useState(DEFAULT_SCORE_LEVELS);
  const [customWeights, setCustomWeights] = useState(distributionConfig("uniform", DEFAULT_SCORE_LEVELS).weights);
  const [budgetMode, setBudgetMode] = useState<ComparisonBudgetMode>("quick");
  const [sourceSessionId, setSourceSessionId] = useState("");
  const [importPreview, setImportPreview] = useState<ComparisonImportPreview>();
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewError, setPreviewError] = useState("");
  const [previewSignature, setPreviewSignature] = useState("");
  const [previewErrorSignature, setPreviewErrorSignature] = useState("");
  const [previewRevision, setPreviewRevision] = useState(0);
  const [snapshotDates, setSnapshotDates] = useState<Record<string, string>>({});
  const [importCounts, setImportCounts] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState(false);
  const [upgradingSessionId, setUpgradingSessionId] = useState<string>();
  const [derivingSessionId, setDerivingSessionId] = useState<string>();
  const [deletingSessionId, setDeletingSessionId] = useState<string>();
  const [derivationDraft, setDerivationDraft] = useState<TagDerivationDraft>();
  const [error, setError] = useState("");
  const baseItems = filterBaseItems(selectedType, statuses, items);
  const tagFilter = collectionTagFilter(selectedTags);
  const selectedItems = filterScopeItems({ subjectType: selectedType, collectionTypes: statuses, tagFilter }, items);
  const selectedSubjectIdSignature = selectedItems.map((entry) => entry.subjectId).sort((left, right) => left - right).join(",");
  const previewKey = `${snapshot.id}:${selectedType}:${selectedSubjectIdSignature}:${sourceSessionId}`;
  const sourceCandidates = sessions.filter((session) => session.subjectType === selectedType);
  const sourceCandidateExists = sourceCandidates.some((session) => session.id === sourceSessionId);
  const preset = manualPreset ?? recommendedDistribution();
  const derivationTagFilter = collectionTagFilter(derivationDraft?.selectedTags ?? []);
  const derivationItems = derivationDraft
    ? filterScopeItems({ ...derivationDraft.session, tagFilter: derivationTagFilter }, derivationDraft.baseItems)
    : [];
  const derivationUnchanged = derivationDraft
    ? sameTagFilter(derivationDraft.session.tagFilter, derivationTagFilter)
    : true;

  useEffect(() => {
    let active = true;
    void db.snapshots.where("profileId").equals(snapshot.profileId).toArray().then((entries) => {
      if (active) setSnapshotDates(Object.fromEntries(entries.map((entry) => [entry.id, entry.syncedAt])));
    });
    return () => { active = false; };
  }, [snapshot.profileId]);

  useEffect(() => {
    let active = true;
    const sessionIds = sessions.map((session) => session.id);
    if (sessionIds.length === 0) {
      return () => { active = false; };
    }
    void db.comparisons.toArray().then((records) => {
      if (!active) return;
      const counts: Record<string, number> = {};
      const allowed = new Set(sessionIds);
      for (const record of records) {
        if (record.importBatchId && allowed.has(record.sessionId) && record.active && record.outcome !== "skip") {
          counts[record.sessionId] = (counts[record.sessionId] ?? 0) + 1;
        }
      }
      setImportCounts(counts);
    });
    return () => { active = false; };
  }, [sessions]);

  function clearImportPreview() {
    setImportPreview(undefined);
    setPreviewSignature("");
    setPreviewError("");
    setPreviewErrorSignature("");
    setPreviewBusy(false);
  }

  function changeSource(nextSourceSessionId: string) {
    clearImportPreview();
    setSourceSessionId(nextSourceSessionId);
  }

  useEffect(() => {
    let active = true;
    if (!sourceSessionId) {
      return () => { active = false; };
    }
    const source = sessions.find((session) => session.id === sourceSessionId);
    if (!source || source.subjectType !== selectedType) {
      return () => { active = false; };
    }
    async function loadPreview() {
      setPreviewBusy(true);
      try {
        const preview = await previewComparisonImport(sourceSessionId, {
          profileId: snapshot.profileId,
          snapshotId: snapshot.id,
          subjectType: selectedType,
          allowedSubjectIds: selectedSubjectIdSignature ? selectedSubjectIdSignature.split(",").map(Number) : [],
          targetVersion: 0,
        });
        if (active) {
          setImportPreview(preview);
          setPreviewSignature(previewKey);
          setPreviewError("");
          setPreviewErrorSignature("");
        }
      } catch (cause) {
        if (active) {
          setImportPreview(undefined);
          setPreviewSignature("");
          setPreviewError(cause instanceof Error ? cause.message : "无法预览历史判断导入。");
          setPreviewErrorSignature(previewKey);
        }
      } finally {
        if (active) setPreviewBusy(false);
      }
    }
    void loadPreview();
    return () => { active = false; };
  }, [previewKey, previewRevision, selectedSubjectIdSignature, selectedType, sessions, snapshot.id, snapshot.profileId, sourceSessionId]);

  const currentImportPreview = sourceCandidateExists && importPreview && previewSignature === previewKey
    ? importPreview
    : undefined;
  const currentPreviewError = sourceSessionId && !sourceCandidateExists
    ? "来源会话不存在，可能已经被删除。"
    : previewErrorSignature === previewKey ? previewError : "";
  const currentPreviewBusy = previewBusy && sourceCandidateExists;

  async function start() {
    setBusy(true); setError("");
    try {
      await onStart(
        selectedType,
        statuses,
        distributionConfig(preset, scoreLevelCount, customWeights),
        budgetMode,
        tagFilter,
        sourceSessionId || undefined,
        currentImportPreview?.sourceVersion,
      );
    }
    catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法创建会话。");
      if (sourceSessionId) {
        clearImportPreview();
        setPreviewRevision((value) => value + 1);
      }
    }
    finally { setBusy(false); }
  }

  async function removeSession(session: SortingSession) {
    const confirmed = window.confirm(`删除会话“${session.title}”？\n\n该会话的所有判断记录和模型都会永久删除；收藏快照不会受影响。此操作无法撤销。`);
    if (!confirmed) return;
    setDeletingSessionId(session.id); setError("");
    try {
      await onDeleteSession(session.id);
      if (session.id === sourceSessionId) changeSource("");
    }
    catch (cause) { setError(cause instanceof Error ? cause.message : "无法删除会话。"); }
    finally { setDeletingSessionId(undefined); }
  }

  async function upgradeSession(session: SortingSession) {
    setUpgradingSessionId(session.id); setError("");
    try {
      const preview = await previewSessionUpgrade(session.id, snapshot.id);
      const confirmed = window.confirm([
        `把会话“${session.title}”升级到当前收藏？`,
        "",
        `作品：${preview.previousItemCount} → ${preview.currentItemCount}`,
        `新增 ${preview.addedSubjectIds.length} · 移除 ${preview.removedSubjectIds.length} · 原评分变化 ${preview.ratingChangedSubjectIds.length}`,
        `导入 ${preview.inheritedComparisonCount} 条有效判断 · 排除 ${preview.droppedComparisonCount} 条涉及已移除作品的判断`,
        "",
        "系统会创建一个新会话并保留旧会话；分桶、后验和停止预测会全部重算。",
      ].join("\n"));
      if (!confirmed) return;
      await onUpgradeSession(session.id);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "无法升级这个会话。"); }
    finally { setUpgradingSessionId(undefined); }
  }

  async function beginTagDerivation(session: SortingSession) {
    setDerivingSessionId(session.id); setError("");
    try {
      const [snapshotItems, links] = await Promise.all([
        getSnapshotItems(session.snapshotId),
        db.sessionItems.where("sessionId").equals(session.id).toArray(),
      ]);
      setDerivationDraft({
        session,
        baseItems: filterBaseItems(session.subjectType, session.collectionTypes, snapshotItems),
        previousItemCount: links.length,
        selectedTags: collectionTagFilter(session.tagFilter?.tags ?? [])?.tags ?? [],
      });
    } catch (cause) { setError(cause instanceof Error ? cause.message : "无法读取这个会话的范围。"); }
    finally { setDerivingSessionId(undefined); }
  }

  async function confirmTagDerivation() {
    if (!derivationDraft || derivationUnchanged || derivationItems.length < 2) return;
    setDerivingSessionId(derivationDraft.session.id); setError("");
    try {
      const preview = await previewSessionTagDerivation(derivationDraft.session.id, derivationTagFilter);
      const confirmed = window.confirm([
        `按新标签范围派生会话“${derivationDraft.session.title}”？`,
        "",
        `标签：${tagFilterSummary(derivationDraft.session.tagFilter)} → ${tagFilterSummary(derivationTagFilter)}`,
        `作品：${preview.previousItemCount} → ${preview.currentItemCount}`,
        `新增 ${preview.addedSubjectIds.length} · 移除 ${preview.removedSubjectIds.length}`,
        `导入 ${preview.inheritedComparisonCount} 条有效判断 · 排除 ${preview.droppedComparisonCount} 条范围外判断`,
        "",
        "系统会创建一个新会话并保留原会话；分桶、后验和停止预测会全部重算。",
      ].join("\n"));
      if (!confirmed) return;
      await onDeriveSession(derivationDraft.session.id, derivationTagFilter);
      setDerivationDraft(undefined);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "无法派生这个会话。"); }
    finally { setDerivingSessionId(undefined); }
  }

  return <>
    <header className="page-header library-header"><div><span className="eyebrow">收藏概览</span><h1>{snapshot.username} 的已评分收藏</h1><p>上次同步于 {formatDate(snapshot.syncedAt)} · 共 {items.length} 个条目</p></div><div className="header-actions"><button className="outline-button" onClick={onSyncAgain}>重新同步</button><button className="outline-button" onClick={onSwitchAccount}>切换账号</button></div></header>
    <section className="metric-grid">
      {availableTypes.map(([type, label]) => { const count = items.filter((item) => item.subjectType === type).length; const mean = items.filter((item) => item.subjectType === type).reduce((sum, item) => sum + item.rate, 0) / count; return <button key={type} className={`metric-card ${selectedType === type ? "selected" : ""}`} onClick={() => { clearImportPreview(); setSelectedType(type); setSelectedTags([]); setSourceSessionId(""); }}><span>{label}</span><strong>{count}</strong><small>平均 {mean.toFixed(1)} 分</small></button>; })}
    </section>
    <section className="dashboard-grid">
      <article className="panel start-panel">
        <span className="eyebrow">新建排序会话</span>
        <h2>开始一次新的排序</h2>
        <p>直接使用推荐设置开始，或展开下方选项调整范围、模型和<Term term="history-reuse">历史判断导入</Term>。</p>
        {error && <Notice tone="error">{error}</Notice>}
        <div className="start-action" aria-label="开始新的排序会话">
          <div className="start-action-copy">
            <span>当前将排序</span>
            <strong>{SUBJECT_TYPES[selectedType]} · {selectedItems.length} 部</strong>
            <small>{tagFilterSummary(tagFilter)} · {BUDGET_MODE_COPY[budgetMode].label}模式 · {scoreLevelCount} 档 · 动态停止 · {sourceSessionId ? (currentImportPreview ? `导入 ${currentImportPreview.importableCount} 条历史判断` : "已选择历史来源") : "不导入历史判断"}</small>
          </div>
          <button className="primary-button" onClick={start} disabled={busy || currentPreviewBusy || Boolean(currentPreviewError) || Boolean(sourceSessionId && !currentImportPreview) || selectedItems.length < 2}>{busy ? "正在准备模型…" : `开始${BUDGET_MODE_COPY[budgetMode].label}比较`}<span>→</span></button>
        </div>
        <details className="start-settings">
          <summary><span><strong>调整范围与模型设置</strong><small>收藏状态、个人标签、推断模式、评分档数与历史导入</small></span><b aria-hidden="true">⌄</b></summary>
          <div className="start-settings-body">
            <div className="field-group"><span className="field-label" id="collection-status-label">收藏状态</span><div className="chip-row" role="group" aria-labelledby="collection-status-label">{collectionEntries.map(([type, label]) => <button key={type} className={statuses.includes(type) ? "selected" : ""} onClick={() => { clearImportPreview(); setStatuses((value) => value.includes(type) ? value.filter((item) => item !== type) : [...value, type]); }}>{label}</button>)}</div></div>
            <div className="field-group"><label htmlFor="new-session-tag-search">个人标签（全部匹配）</label><TagFilterSelector id="new-session-tag-search" items={baseItems} selectedTags={selectedTags} onChange={(next) => { clearImportPreview(); setSelectedTags(next); }} /><small className="field-help">标签来自你的 Bangumi 收藏；选择多个标签时，作品必须同时包含全部标签。</small></div>
            <div className="field-group"><label htmlFor="comparison-budget">推断模式</label><ThemedSelect id="comparison-budget" value={budgetMode} options={NEW_SESSION_INFERENCE_OPTIONS} ariaLabel="推断模式" menuLabel="推断模式选项" onChange={setBudgetMode} /><small className="field-help"><Term term="inference-mode">模式说明</Term>：{BUDGET_MODE_COPY[budgetMode].description} · 每次回答后<Term term="dynamic-forecast">动态重估剩余区间</Term></small></div>
            <div className="field-group"><label htmlFor="score-level-count">评分档数</label><ScoreLevelSelect id="score-level-count" value={scoreLevelCount} onChange={(nextLevelCount) => { setScoreLevelCount(nextLevelCount); setCustomWeights((weights) => resampleDistributionWeights(weights, nextLevelCount)); }} /><small className="field-help">可选择 <Term term="score-bucket">3–20 档</Term>；档数越多，一档越窄，通常需要更多判断才能稳定。</small></div>
            <div className="field-group"><label htmlFor="distribution-preset">新评分分布</label><ThemedSelect id="distribution-preset" value={preset} options={distributionPresetOptions(scoreLevelCount)} ariaLabel="新评分分布" menuLabel="新评分分布选项" onChange={(nextPreset) => setManualPreset(nextPreset)} /><small className="field-help"><Term term="score-distribution">目标分布</Term> · {manualPreset === undefined ? `已按 ${selectedItems.length} 个条目的规模自动推荐` : "已使用手动选择"}</small>{preset === "reverse-j" && <small className="field-help"><Term term="reverse-j">反 J 分布</Term>把最多作品放在低分档，越高分档越稀疏；系统会按当前档数保持累计分布形状。</small>}{preset === "high-tail" && <small className="field-help"><Term term="high-tail">高分辨率尾部</Term>会把高分区域切得更细，方便区分真正偏爱的作品。</small>}{preset === "custom" && <DistributionWeights weights={customWeights} onChange={setCustomWeights} />}</div>
            <div className="field-group"><label htmlFor="history-source">历史判断来源</label><ThemedSelect id="history-source" value={sourceSessionId} options={[{ value: "", label: "不导入历史判断（默认）" }, ...sourceCandidates.map((session) => ({ value: session.id, label: `${session.title} · ${session.snapshotId === snapshot.id ? "当前快照" : `快照 ${formatDate(snapshotDates[session.snapshotId])}`} · 更新 ${formatDate(session.updatedAt)}` }))]} ariaLabel="历史判断来源" menuLabel="历史判断来源选项" onChange={changeSource} /><small className="field-help"><Term term="history-reuse">历史判断导入</Term>只在创建时复制一次；之后来源会话的变化不会影响本会话。</small>{currentPreviewBusy && <small className="field-help">正在计算可导入判断…</small>}{currentPreviewError && <small className="comparison-form-error">{currentPreviewError}</small>}{currentImportPreview && <div className="scope-preview"><span>{currentImportPreview.crossSnapshot ? "跨快照导入" : "同快照导入"}</span><strong>可导入 {currentImportPreview.importableCount} 条</strong><small>已存在根判断 {currentImportPreview.duplicateOriginalCount} · 范围外 {currentImportPreview.outOfScopeCount} · 跳过 {currentImportPreview.skippedCount} · 无效校准 {currentImportPreview.invalidCalibrationCount}{currentImportPreview.crossSnapshot ? " · 来源属于不同收藏快照，请确认旧判断仍适用" : ""}</small></div>}</div>
            <div className="field-group"><span className="field-label">停止标准</span><small className="field-help">至少 90% 的作品相对当前 <Term term="score-bucket">{scoreLevelCount} 档分桶</Term>最多偏移一档；在当前 {selectedItems.length} 部作品中，允许最多 {allowedCrossTwoBucketCount(selectedItems.length)} 部<Term term="cross-two-buckets">跨两档</Term>。该事件的<Term term="posterior">后验概率</Term>之 <Term term="mc-lower-bound">90% MC 下界</Term>须达到 90%。</small></div>
          </div>
        </details>
      </article>
      <article className="panel distribution-panel"><div className="panel-title"><div><span className="eyebrow"><Term term="score-distribution">当前范围评分分布</Term></span><h2>{SUBJECT_TYPES[selectedType]} · {selectedItems.length} 部</h2></div><span className="legend"><i />原评分 · 10 档</span></div><OriginalScoreHistogram items={selectedItems} /></article>
    </section>
    <section className="sessions-section"><div className="section-title"><div><span className="eyebrow">排序会话</span><h2>继续或管理已有判断</h2></div></div>{sessions.length === 0 ? <div className="empty-row">还没有会话，选择范围后开始第一次比较。</div> : <div className="session-list">{sessions.map((session) => {
      const usesCurrentSnapshot = session.snapshotId === snapshot.id;
      const upgradedAlready = sessions.some((candidate) =>
        candidate.snapshotId === snapshot.id && candidate.upgradedFromSessionId === session.id);
      const actionBusy = Boolean(deletingSessionId || upgradingSessionId || derivingSessionId);
      const importedCount = importCounts[session.id] ?? 0;
      const historyLabel = importedCount > 0 ? `本地历史 · 导入 ${importedCount} 条` : "本地历史 · 未导入";
      return <article className="session-row" key={session.id}>
        <button className="session-open" disabled={actionBusy} onClick={() => onResume(session.id)}>
          <span className="session-type">{SUBJECT_TYPES[session.subjectType]}</span>
          <div><strong>{session.title}</strong><small>{BUDGET_MODE_COPY[sessionBudgetMode(session)].label}模式 · {normalizeScoreLevelCount(session.distribution.levelCount)} 档 · {usesCurrentSnapshot ? "当前收藏" : "旧收藏"} · {historyLabel} · 更新于 {formatDate(session.updatedAt)}</small><small>标签范围：{tagFilterSummary(session.tagFilter)}</small></div>
          <span className={`session-status ${session.status}`}>{session.status === "complete" ? "已稳定" : "进行中"}</span><b>→</b>
        </button>
        <div className="session-actions">
          {!usesCurrentSnapshot && !upgradedAlready && <button className="session-upgrade" disabled={actionBusy} onClick={() => void upgradeSession(session)}>{upgradingSessionId === session.id ? "升级中…" : "升级到当前收藏"}</button>}
          <button className="session-derive" disabled={actionBusy} onClick={() => void beginTagDerivation(session)}>{derivingSessionId === session.id ? "读取中…" : "调整标签范围"}</button>
          <button className="session-delete" disabled={actionBusy} aria-label={`删除会话 ${session.title}`} onClick={() => void removeSession(session)}>{deletingSessionId === session.id ? "删除中…" : "删除"}</button>
        </div>
      </article>;
    })}</div>}</section>
    {derivationDraft && <div className="scope-modal-backdrop" role="presentation">
      <section className="scope-modal" role="dialog" aria-modal="true" aria-labelledby="scope-modal-title">
        <div className="scope-modal-header"><div><span className="eyebrow">派生新会话</span><h2 id="scope-modal-title">调整标签范围</h2></div><button type="button" aria-label="关闭标签范围窗口" onClick={() => setDerivationDraft(undefined)}>×</button></div>
        <p>原会话及其判断不会被修改。新会话会使用同一<Term term="snapshot">收藏快照</Term>，并一次性导入新范围内仍然有效的判断；来源之后的变化不会影响新会话。</p>
        <div className="field-group"><label htmlFor="derived-session-tag-search">个人标签（全部匹配）</label><TagFilterSelector id="derived-session-tag-search" items={derivationDraft.baseItems} selectedTags={derivationDraft.selectedTags} onChange={(selectedTags) => setDerivationDraft((current) => current ? { ...current, selectedTags } : current)} /></div>
        <div className="scope-preview"><span>作品范围</span><strong>{derivationDraft.previousItemCount} → {derivationItems.length}</strong><small>{tagFilterSummary(derivationDraft.session.tagFilter)} → {tagFilterSummary(derivationTagFilter)}</small></div>
        {derivationUnchanged && <Notice>请选择与原会话不同的标签范围。</Notice>}
        {!derivationUnchanged && derivationItems.length < 2 && <Notice tone="error">筛选后不足两部作品，无法创建比较会话。</Notice>}
        <div className="scope-modal-actions"><button className="outline-button" type="button" disabled={Boolean(derivingSessionId)} onClick={() => setDerivationDraft(undefined)}>取消</button><button className="primary-button compact" type="button" disabled={Boolean(derivingSessionId) || derivationUnchanged || derivationItems.length < 2} onClick={() => void confirmTagDerivation()}>{derivingSessionId ? "正在计算…" : "预览并创建"}</button></div>
      </section>
    </div>}
  </>;
}

const INFERENCE_MODE_OPTIONS: Array<ThemedSelectOption<ComparisonBudgetMode>> = [
  { value: "quick", label: "快速模式" },
  { value: "standard", label: "标准模式" },
  { value: "thorough", label: "精细模式" },
];

function InferenceModeSelect({ id, value, busy, onChange }: {
  id: string;
  value: ComparisonBudgetMode;
  busy: boolean;
  onChange: (mode: ComparisonBudgetMode) => Promise<void>;
}) {
  return <ThemedSelect
    id={id}
    value={value}
    options={INFERENCE_MODE_OPTIONS}
    ariaLabel={`当前推断模式：${INFERENCE_MODE_OPTIONS.find((option) => option.value === value)?.label ?? value}`}
    menuLabel="推断模式选项"
    disabled={busy}
    compact
    alignMenu="end"
    rootClassName="inference-mode-select"
    triggerClassName="header-select"
    title={BUDGET_MODE_COPY[value].description}
    onChange={onChange}
  />;
}

function SessionPicker({ purpose, sessions, currentSnapshotId, busy, onResume, onBack }: {
  purpose: "compare" | "results";
  sessions: SortingSession[];
  currentSnapshotId: string;
  busy: boolean;
  onResume: (sessionId: string) => Promise<void>;
  onBack: () => void;
}) {
  const orderedSessions = [...sessions].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  const hasSessions = orderedSessions.length > 0;
  const isResults = purpose === "results";
  const actionLabel = isResults ? "查看结果" : "进入会话";

  return <section className="center-message session-picker" aria-labelledby="session-picker-title" aria-busy={busy}>
    <div className="session-picker-header">
      <span className="eyebrow">{isResults ? "排序结果" : "两两比较"}</span>
      <h1 id="session-picker-title">{hasSessions ? (isResults ? "选择一个排序会话查看结果" : "选择一个排序会话继续比较") : "还没有排序会话"}</h1>
      <p>{hasSessions
        ? (isResults ? "选择最近的会话即可直接查看排序结果；每个会话会保留自己的范围和推断设置。" : "选择最近的会话即可恢复判断；每个会话会保留自己的范围和推断设置。")
        : "先在收藏概览创建一个排序会话，之后就可以从这里直接进入。"}</p>
    </div>
    {hasSessions ? <div className="session-picker-list" role="list" aria-label="可进入的排序会话">
      {orderedSessions.map((session) => {
        const budgetMode = sessionBudgetMode(session);
        const statusLabel = session.status === "complete" ? "已稳定" : "进行中";
        return <div key={session.id} role="listitem">
          <button
            type="button"
            className="session-picker-open"
            disabled={busy}
            onClick={() => void onResume(session.id)}
            aria-label={`${actionLabel} ${session.title}`}
          >
            <span className="session-type">{SUBJECT_TYPES[session.subjectType]}</span>
            <span className="session-picker-copy">
              <strong>{session.title}</strong>
              <small>{BUDGET_MODE_COPY[budgetMode].label}模式 · {normalizeScoreLevelCount(session.distribution.levelCount)} 档 · {session.snapshotId === currentSnapshotId ? "当前收藏" : "旧收藏"} · {statusLabel}</small>
              <small>更新于 {formatDateTime(session.updatedAt)} · 标签范围：{tagFilterSummary(session.tagFilter)}</small>
            </span>
            <span className={`session-status ${session.status}`}>{statusLabel}</span>
            <b className="session-picker-arrow" aria-hidden="true">{busy ? "…" : "→"}</b>
          </button>
        </div>;
      })}
    </div> : <div className="session-picker-empty" role="status"><span aria-hidden="true">⇄</span><strong>暂无可恢复的会话</strong><small>返回收藏概览后，选择范围并开始第一次比较。</small></div>}
    {busy && <p className="session-picker-status" role="status">正在准备排序模型…</p>}
    <button className="outline-button session-picker-back" type="button" onClick={onBack}>返回收藏概览</button>
  </section>;
}

function CompareView({ state, busy, scoresVisible, onToggleScores, onMode, onAnswer, onUndo, onPause, onResults }: {
  state: CompareState; busy: boolean; scoresVisible: boolean; onToggleScores: () => void;
  onMode: (mode: ComparisonBudgetMode) => Promise<void>;
  onAnswer: (outcome: ComparisonOutcome) => void; onUndo: () => void; onPause: () => void; onResults: () => void;
}) {
  const left = state.items.find((item) => item.subjectId === state.nextPair?.leftSubjectId);
  const right = state.items.find((item) => item.subjectId === state.nextPair?.rightSubjectId);
  const currentSessionAccepted = state.history.filter((item) => item.sessionId === state.session.id && item.active && item.outcome !== "skip").length;
  const importedAccepted = state.history.filter((item) => item.sessionId === state.session.id && item.active && item.outcome !== "skip" && item.importBatchId).length;
  const newlyAnswered = currentSessionAccepted - importedAccepted;
  const budgetMode = sessionBudgetMode(state.session);
  const scoreLevelCount = normalizeScoreLevelCount(state.session.distribution.levelCount);
  const diagnostics = state.model.diagnostics;
  const targetReady = diagnostics?.ready;
  const expectedViolations = expectedCrossTwoBucketCount(diagnostics);
  const toleranceCoverage = expectedViolations === undefined
    ? 0
    : 100 * (1 - expectedViolations / Math.max(1, state.items.length));
  const calibrationAvailable = (diagnostics?.calibration.completed ?? 0) > 0;
  const forecast = diagnostics?.forecast;
  const projectionSuccesses = forecast?.withinProjectionSuccesses ?? forecast?.beforeLimitSuccesses;
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  if (!left || !right) return <div className="center-message"><h2>暂时没有可比较的条目</h2><p>你可以查看当前结果，或返回收藏调整范围。</p><button className="primary-button" onClick={onResults}>查看结果</button></div>;
  return <>
    <header className="topbar compare-header"><div><span className="eyebrow">{SUBJECT_TYPES[state.session.subjectType]} · {BUDGET_MODE_COPY[budgetMode].label}模式 · <Term term="score-bucket">{scoreLevelCount} 档</Term> · {state.session.title}</span><h1>哪一部在你的偏好中更靠前？</h1></div><div className="header-actions"><InferenceModeSelect id="compare-budget-mode" value={budgetMode} busy={busy} onChange={onMode} /><button className="ghost-button" onClick={onToggleScores}>{scoresVisible ? "隐藏原评分" : "显示原评分"}</button></div></header>
    <button className="mobile-diagnostics-toggle" type="button" aria-expanded={diagnosticsOpen} aria-controls="compare-diagnostics" onClick={() => setDiagnosticsOpen((value) => !value)}><span>有效证据 {currentSessionAccepted} 次 · 覆盖 {Math.round(toleranceCoverage)}%</span><span>{diagnosticsOpen ? "收起诊断" : "查看诊断"}</span></button>
    <div className="progress-row dynamic-progress" id="compare-diagnostics"><div className="progress-copy"><span>有效证据 <strong>{currentSessionAccepted}</strong> 次（新回答 {newlyAnswered} · 导入 {importedAccepted}）</span><span><Term term="adjacent-tolerance">后验期望相邻容差覆盖</Term> <strong>{Math.round(toleranceCoverage)}%</strong></span><span><Term term="maximum-displacement">最坏偏移中位数</Term> <strong>{maxBucketDisplacementValue(diagnostics)}</strong></span></div><div className="progress-track" aria-label={`后验期望相邻容差覆盖 ${Math.round(toleranceCoverage)}%`}><span style={{ width: `${toleranceCoverage}%` }} /></div><div className="forecast-row"><span><Term term="cross-two-buckets">跨两档作品分布</Term> <strong><Term term="posterior-interval">{crossTwoBucketInterval(diagnostics)}</Term></strong></span><span><Term term="maximum-displacement">最坏偏移分布</Term> <strong>{maxBucketDisplacementInterval(diagnostics)}</strong></span><span><Term term="dynamic-forecast">动态剩余预测</Term> <strong>{forecastRange(diagnostics)}</strong></span></div></div>
    {newlyAnswered > 0 && newlyAnswered % 20 === 0 && <Notice tone="warning">你已经在本会话新完成 {newlyAnswered} 次判断，建议现在下载一次 JSON 备份。</Notice>}
    {targetReady && <Notice tone="success">当前{BUDGET_MODE_COPY[budgetMode].label}模式要求的嵌套<Term term="posterior">后验检查</Term>均已达标：在 <Term term="score-bucket">{scoreLevelCount} 档评分</Term>中，至少 90% 的作品最多偏移一档。可以导出结果，也可以继续比较。</Notice>}
    {!targetReady && projectionSuccesses === 0 && <Notice>本轮预测窗口内<Term term="monte-carlo">达标模拟</Term>为 {forecastProjectionProbability(forecast)}；未观察到成功不是不可达证明。再完成 {forecast?.nextCheckpoint} 次后会用新证据重估。</Notice>}
    {!targetReady && diagnostics && diagnostics.evidenceCount < diagnostics.evidenceRequired && <Notice>至少需要 {diagnostics.evidenceRequired} 次本会话有效判断；目前为 {diagnostics.evidenceCount} 次。</Notice>}
    {calibrationAvailable && <Notice><Term term="calibration-repeat">校准复问</Term> {diagnostics?.calibration.consistent}/{diagnostics?.calibration.completed} 次一致；<Term term="posterior">后验一致率</Term> {percent(diagnostics?.calibration.posteriorMean)}，<Term term="posterior-interval">80% 区间</Term> {percent(diagnostics?.calibration.credibleLow)}–{percent(diagnostics?.calibration.credibleHigh)}。该指标仅反映判断波动，不影响停止。</Notice>}
    <section className={`comparison-stage ${busy ? "busy" : ""}`} aria-busy={busy}>
      <MediaCard item={left} side="left" showScore={scoresVisible} disabled={busy} onChoose={() => onAnswer("left")} />
      <div className="versus" aria-hidden="true"><span>{busy ? "…" : "VS"}</span></div>
      <MediaCard item={right} side="right" showScore={scoresVisible} disabled={busy} onChoose={() => onAnswer("right")} />
    </section>
    <div className="secondary-actions"><button disabled={busy} onClick={() => onAnswer("tie")}><span>＝</span>差不多喜欢 <kbd>↑</kbd></button><button disabled={busy} onClick={() => onAnswer("skip")}><span>↷</span>这次跳过 <kbd>↓</kbd></button><button disabled={busy} onClick={onUndo} title="快捷键：Ctrl+Z（Windows / Linux）或 ⌘Z（macOS）"><span>↶</span>撤销上次 <kbd>⌘/Ctrl Z</kbd></button></div>
    <footer className="session-footer"><span><Term term="inference-mode">{BUDGET_MODE_COPY[budgetMode].label}模式</Term>：{BUDGET_MODE_COPY[budgetMode].description}</span><div><button onClick={onResults}>查看当前结果</button><button onClick={onPause}>暂停并返回收藏</button></div></footer>
  </>;
}

function MediaCard({ item, side, showScore, disabled, onChoose }: { item: CollectionItem; side: "left" | "right"; showScore: boolean; disabled: boolean; onChoose: () => void }) {
  return <article className="media-card"><Poster item={item} wide /><div className="media-copy"><span className="media-kicker">{item.platform || SUBJECT_TYPES[item.subjectType]} · {item.date?.slice(0, 4) || "年份未知"}</span><h2>{primaryName(item)}</h2>{item.nameCn && <p>{item.name}</p>}{showScore && <span className="old-score">原评分 {item.rate}</span>}</div><button className="choice-button" disabled={disabled} onClick={onChoose}>{side === "left" && <span aria-hidden="true">←</span>} 更喜欢这部 {side === "right" && <span aria-hidden="true">→</span>}<kbd>{side === "left" ? "←" : "→"}</kbd></button></article>;
}

const ITEM_PICKER_RESULT_LIMIT = 50;

function itemPickerLabel(item: RankedItem) {
  return `#${item.rank} · ${primaryName(item)}`;
}

function normalizedSearch(value: string) {
  return value.normalize("NFKC").toLocaleLowerCase().trim();
}

function SearchableItemPicker({ id, label, items, value, excludeSubjectId, disabled, onChange }: {
  id: string;
  label: string;
  items: RankedItem[];
  value: number;
  excludeSubjectId?: number;
  disabled: boolean;
  onChange: (subjectId: number) => void;
}) {
  const selected = items.find((item) => item.subjectId === value);
  const selectedLabel = selected ? itemPickerLabel(selected) : "";
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const listboxId = `${id}-results`;
  const tokens = normalizedSearch(query).split(/\s+/).filter(Boolean);
  const matches = items.filter((item) => {
    if (item.subjectId === excludeSubjectId) return false;
    const searchable = normalizedSearch([
      `#${item.rank}`, item.rank, item.subjectId, item.name, item.nameCn, primaryName(item),
    ].filter(Boolean).join(" "));
    return tokens.every((token) => searchable.includes(token));
  });
  const visibleMatches = matches.slice(0, ITEM_PICKER_RESULT_LIMIT);
  const effectiveActiveIndex = Math.min(activeIndex, Math.max(visibleMatches.length - 1, 0));

  function choose(item: RankedItem) {
    onChange(item.subjectId);
    setQuery("");
    setOpen(false);
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setOpen(true);
      setActiveIndex((index) => Math.min(index + 1, Math.max(visibleMatches.length - 1, 0)));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setOpen(true);
      setActiveIndex((index) => Math.max(index - 1, 0));
    } else if (event.key === "Enter" && open && visibleMatches[effectiveActiveIndex]) {
      event.preventDefault();
      choose(visibleMatches[effectiveActiveIndex]);
    } else if (event.key === "Escape") {
      event.preventDefault();
      setQuery("");
      setOpen(false);
    }
  }

  return <div className={`item-picker${open ? " open" : ""}`} onBlur={(event) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
      setQuery("");
      setOpen(false);
    }
  }}>
    <label htmlFor={id}><span>{label}</span></label>
    <input
      id={id}
      type="search"
      role="combobox"
      aria-autocomplete="list"
      aria-expanded={open}
      aria-controls={listboxId}
      aria-activedescendant={open && visibleMatches[effectiveActiveIndex] ? `${id}-option-${visibleMatches[effectiveActiveIndex].subjectId}` : undefined}
      autoComplete="off"
      spellCheck={false}
      value={open ? query : selectedLabel}
      disabled={disabled}
      placeholder="搜索标题、原名、排名或 Bangumi ID"
      onFocus={(event) => { setQuery(""); setActiveIndex(0); setOpen(true); event.currentTarget.select(); }}
      onChange={(event) => { setQuery(event.target.value); setActiveIndex(0); setOpen(true); }}
      onKeyDown={handleKeyDown}
    />
    {open && <div className="item-picker-menu">
      <div className="item-picker-meta">{matches.length > ITEM_PICKER_RESULT_LIMIT ? `显示前 ${ITEM_PICKER_RESULT_LIMIT} 项，共 ${matches.length} 项；继续输入可缩小范围` : `找到 ${matches.length} 项`}</div>
      <div id={listboxId} className="item-picker-results" role="listbox" aria-label={`${label}搜索结果`}>
        {visibleMatches.length === 0
          ? <div className="item-picker-empty">没有匹配条目</div>
          : visibleMatches.map((item, index) => {
            const alternateName = primaryName(item) === item.name ? item.nameCn : item.name;
            return <button
              id={`${id}-option-${item.subjectId}`}
              className={`item-picker-option${index === effectiveActiveIndex ? " active" : ""}`}
              type="button"
              role="option"
              aria-selected={item.subjectId === value}
              key={item.subjectId}
              onPointerDown={(event) => event.preventDefault()}
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => choose(item)}
            >
              <span><b>#{item.rank}</b><strong>{primaryName(item)}</strong></span>
              <small>{alternateName ? `${alternateName} · ` : ""}原评分 {item.rate} · ID {item.subjectId}</small>
            </button>;
          })}
      </div>
    </div>}
  </div>;
}

function ComparisonManager({ items, history, sessionId, sessions, busy, onAdd, onDelete }: {
  items: RankedItem[];
  history: ComparisonRecord[];
  sessionId: string;
  sessions: SortingSession[];
  busy: boolean;
  onAdd: (leftSubjectId: number, rightSubjectId: number, outcome: Exclude<ComparisonOutcome, "skip">) => Promise<void>;
  onDelete: (recordId: string) => Promise<void>;
}) {
  const [leftSubjectId, setLeftSubjectId] = useState(items[0]?.subjectId ?? 0);
  const [rightSubjectId, setRightSubjectId] = useState(items[1]?.subjectId ?? 0);
  const [outcome, setOutcome] = useState<Exclude<ComparisonOutcome, "skip">>("left");
  const itemById = new Map(items.map((item) => [item.subjectId, item]));
  const currentRecords = history
    .filter((record) => record.active && record.sessionId === sessionId)
    .sort((left, right) => right.acceptedCountAtAnswer - left.acceptedCountAtAnswer
      || right.createdAt.localeCompare(left.createdAt)
      || right.id.localeCompare(left.id));
  const importedCount = currentRecords.filter((record) => record.importBatchId).length;
  const localCount = currentRecords.length - importedCount;
  const sessionById = new Map(sessions.map((session) => [session.id, session]));
  const kindCopy: Record<NonNullable<ComparisonRecord["queryKind"]>, string> = {
    adaptive: "自适应", exploration: "覆盖探索", calibration: "校准复问", manual: "手动添加",
  };
  const kindTerm: Record<NonNullable<ComparisonRecord["queryKind"]>, TermKey | undefined> = {
    adaptive: "adaptive-comparison", exploration: "coverage-exploration", calibration: "calibration-repeat", manual: undefined,
  };

  function queryKindLabel(kind: NonNullable<ComparisonRecord["queryKind"]>) {
    return kindTerm[kind] ? <Term term={kindTerm[kind]}>{kindCopy[kind]}</Term> : kindCopy[kind];
  }

  function recordCopy(record: ComparisonRecord) {
    const left = itemById.get(record.leftSubjectId);
    const right = itemById.get(record.rightSubjectId);
    const symbol = record.outcome === "left" ? ">" : record.outcome === "right" ? "<" : record.outcome === "tie" ? "≈" : "↷";
    return `${left ? primaryName(left) : `条目 ${record.leftSubjectId}`} ${symbol} ${right ? primaryName(right) : `条目 ${record.rightSubjectId}`}`;
  }

  function remove(record: ComparisonRecord) {
    const confirmed = window.confirm(`永久删除这条判断？\n\n${recordCopy(record)}\n\n删除后会立即重算本会话，且无法撤销。`);
    if (confirmed) void onDelete(record.id);
  }

  return <section className="panel comparison-manager" aria-labelledby="comparison-manager-title">
    <div className="panel-title"><div><span className="eyebrow">判断管理</span><h2 id="comparison-manager-title">手动添加或删除比较</h2></div><span className="record-count">总计 {currentRecords.length} 条 · 本地新增 {localCount} · 导入 {importedCount}</span></div>
    <p>搜索并选择当前会话中的两个条目；可按中文标题、原名、当前排名或 Bangumi ID 查找。保存后，排名、可信度与<Term term="dynamic-forecast">动态剩余预测</Term>都会立即重算。</p>
    <form className="manual-comparison-form" onSubmit={(event) => { event.preventDefault(); if (leftSubjectId !== rightSubjectId) void onAdd(leftSubjectId, rightSubjectId, outcome); }}>
      <SearchableItemPicker id="manual-left-item" label="左侧条目" items={items} value={leftSubjectId} excludeSubjectId={rightSubjectId} disabled={busy} onChange={setLeftSubjectId} />
      <div className="manual-comparison-field"><label htmlFor="manual-comparison-outcome"><span>判断</span></label><ThemedSelect id="manual-comparison-outcome" value={outcome} options={MANUAL_OUTCOME_OPTIONS} ariaLabel="手动比较结果" menuLabel="手动比较结果选项" disabled={busy} onChange={setOutcome} /></div>
      <SearchableItemPicker id="manual-right-item" label="右侧条目" items={items} value={rightSubjectId} excludeSubjectId={leftSubjectId} disabled={busy} onChange={setRightSubjectId} />
      <button className="primary-button compact" type="submit" disabled={busy || !leftSubjectId || !rightSubjectId || leftSubjectId === rightSubjectId}>{busy ? "正在重算…" : "添加比较"}</button>
    </form>
    {leftSubjectId === rightSubjectId && <small className="comparison-form-error">左右两侧不能选择同一个条目。</small>}
    <details className="comparison-history" open>
      <summary>本会话判断记录（{currentRecords.length}）</summary>
      {importedCount > 0 && <p className="reuse-note">导入判断已经复制到本会话，可以独立删除；来源之后变化或删除都不会影响这里。</p>}
      {currentRecords.length === 0 ? <div className="empty-row">本会话还没有判断记录。</div> : <div className="comparison-records">{currentRecords.map((record) => { const source = record.importedFromSessionId ? sessionById.get(record.importedFromSessionId) : undefined; return <article className={`comparison-record ${record.queryKind ?? "adaptive"}`} data-record-id={record.id} key={record.id}><div><strong>{recordCopy(record)}</strong><small><span className="record-kind">{queryKindLabel(record.queryKind ?? "adaptive")}</span> · {record.importBatchId ? `导入自 ${source?.title ?? `已删除来源 ${record.importedFromSessionId?.slice(0, 8) ?? "未知"}`} · 原判断 ${formatDateTime(record.sourceCreatedAt ?? record.createdAt)}` : formatDateTime(record.createdAt)}</small></div><button className="record-delete" disabled={busy} aria-label={`删除判断 ${recordCopy(record)}`} onClick={() => remove(record)}>删除</button></article>; })}</div>}
    </details>
  </section>;
}

const RATING_WRITE_STATUS_COPY: Record<RatingWriteCandidate["status"], string> = {
  ready: "将写回",
  unchanged: "已一致",
  conflict: "线上已变化",
  missing: "已移出收藏",
};

function RatingWriteDangerZone({
  username,
  subjectType,
  items,
  scoreLevelCount,
  stoppingReady,
  externalBusy,
  onResync,
}: {
  username: string;
  subjectType: SubjectType;
  items: RankedItem[];
  scoreLevelCount: number;
  stoppingReady: boolean;
  externalBusy: boolean;
  onResync: () => void;
}) {
  const [token, setToken] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [preview, setPreview] = useState<RatingWritePreview>();
  const [writeResult, setWriteResult] = useState<RatingWriteResult>();
  const [progress, setProgress] = useState<RatingWriteProgress>();
  const [stage, setStage] = useState<"preview" | "write">();
  const [error, setError] = useState("");
  const abortRef = useRef<AbortController | undefined>(undefined);
  const busy = externalBusy || Boolean(stage);
  const tenLevel = scoreLevelCount === DEFAULT_SCORE_LEVELS;
  const confirmationMatches = confirmation.trim().toLowerCase() === username.toLowerCase();
  const readyCount = preview?.candidates.filter((candidate) => candidate.status === "ready").length ?? 0;
  const unchangedCount = preview?.candidates.filter((candidate) => candidate.status === "unchanged").length ?? 0;
  const conflictCount = preview?.candidates.filter((candidate) => candidate.status === "conflict").length ?? 0;
  const missingCount = preview?.candidates.filter((candidate) => candidate.status === "missing").length ?? 0;
  const writeOutcomeRows = writeResult ? [
    ...writeResult.succeeded.map((candidate) => ({ candidate, status: "已验证写回" })),
    ...writeResult.unchanged.map((candidate) => ({ candidate, status: "原本已一致" })),
    ...writeResult.skipped.map((candidate) => ({ candidate, status: `已跳过：${RATING_WRITE_STATUS_COPY[candidate.status]}` })),
    ...writeResult.failed.map(({ candidate, message }) => ({ candidate, status: `失败：${message}` })),
    ...writeResult.pending.map((candidate) => ({ candidate, status: "尚未执行" })),
    ...writeResult.unverified.map((candidate) => ({ candidate, status: "已提交，未能验证" })),
  ] : [];

  useEffect(() => () => abortRef.current?.abort(), []);

  function clearSensitiveState() {
    abortRef.current?.abort();
    abortRef.current = undefined;
    setToken("");
    setShowToken(false);
    setConfirmation("");
    setPreview(undefined);
    setWriteResult(undefined);
    setProgress(undefined);
    setStage(undefined);
    setError("");
  }

  function changeToken(value: string) {
    setToken(value);
    setConfirmation("");
    setPreview(undefined);
    setWriteResult(undefined);
    setProgress(undefined);
    setError("");
  }

  async function checkPreview(event: FormEvent) {
    event.preventDefault();
    if (!tenLevel || busy) return;
    const controller = new AbortController();
    abortRef.current?.abort();
    abortRef.current = controller;
    setStage("preview");
    setError("");
    setPreview(undefined);
    setWriteResult(undefined);
    setConfirmation("");
    setProgress(undefined);
    try {
      const checked = await previewBangumiRatingWrite(
        username,
        token,
        subjectType,
        items.map((item) => ({
          subjectId: item.subjectId,
          name: primaryName(item),
          snapshotRate: item.rate,
          targetRate: item.newRate,
        })),
        controller.signal,
      );
      if (!controller.signal.aborted) setPreview(checked);
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "无法生成写回预览。");
    } finally {
      if (abortRef.current === controller) abortRef.current = undefined;
      if (!controller.signal.aborted) setStage(undefined);
    }
  }

  async function commitWrite() {
    if (!preview || !confirmationMatches || readyCount === 0 || busy) return;
    const controller = new AbortController();
    abortRef.current?.abort();
    abortRef.current = controller;
    setStage("write");
    setError("");
    setWriteResult(undefined);
    setProgress({ completed: 0, total: readyCount, subjectId: 0 });
    try {
      const completed = await writeBangumiRatings(username, token, preview, setProgress, controller.signal);
      if (!controller.signal.aborted) {
        setWriteResult(completed);
        setPreview(undefined);
        setToken("");
        setShowToken(false);
        setConfirmation("");
      }
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "无法写回 Bangumi 评分。");
    } finally {
      if (abortRef.current === controller) abortRef.current = undefined;
      if (!controller.signal.aborted) setStage(undefined);
    }
  }

  return <details
    className="rating-write-danger"
    onToggle={(event) => {
      if (event.currentTarget.open || busy) return;
      clearSensitiveState();
    }}
  >
    <summary onClick={(event) => { if (busy) event.preventDefault(); }}>
      <span><b>Danger Zone</b><strong>写回 Bangumi 评分</strong></span>
      <small>永久修改当前账号中本会话的收藏评分</small>
    </summary>
    <div className="rating-write-body">
      <p>这里只会提交当前会话的 10 档新评分。操作不会修改本地快照，也不会创建已经移出收藏的条目。</p>
      {!tenLevel && <Notice tone="warning">当前结果是 {scoreLevelCount} 档。Bangumi 只接受 1–10 的整数评分；请先把结果切换回 10 档，系统不会自动映射。</Notice>}
      {tenLevel && !stoppingReady && <Notice tone="warning">当前会话尚未达到停止条件。你仍可写回，但这些评分的模型内稳定度还没有达到当前模式的要求。</Notice>}
      {tenLevel && <form className="rating-write-auth" onSubmit={checkPreview}>
        <label className="field-label">Bangumi 个人令牌 <small>必须属于 @{username}，仅保存在当前页面内存</small>
          <div className="token-field"><input required value={token} onChange={(event) => changeToken(event.target.value)} type={showToken ? "text" : "password"} placeholder="需要 write:collection 权限" autoComplete="off" /><button type="button" disabled={busy} onClick={() => setShowToken((value) => !value)}>{showToken ? "隐藏" : "显示"}</button></div>
        </label>
        <button className="outline-button danger-outline" disabled={busy || !token.trim()}>{stage === "preview" ? "正在读取线上评分…" : "检查写回变更"}</button>
      </form>}
      {error && <Notice tone="error">{error}</Notice>}
      {preview && <section className="rating-write-preview" aria-labelledby="rating-write-preview-title">
        <div className="panel-title"><div><span className="eyebrow">线上检查完成</span><h2 id="rating-write-preview-title">写回预览</h2></div><small>@{preview.username} · {formatDateTime(preview.checkedAt)}</small></div>
        <div className="rating-write-counts"><span><b>{readyCount}</b> 将写回</span><span><b>{unchangedCount}</b> 已一致</span><span><b>{conflictCount}</b> 线上冲突</span><span><b>{missingCount}</b> 已移出</span></div>
        {(conflictCount > 0 || missingCount > 0) && <Notice tone="warning">线上发生变化或已经移出收藏的条目将被跳过。请重新同步后再处理这些条目。</Notice>}
        <div className="rating-write-table-wrap"><table className="rating-write-table"><thead><tr><th>条目</th><th>快照评分</th><th>线上评分</th><th>目标评分</th><th>处理</th></tr></thead><tbody>{preview.candidates.map((candidate) => <tr className={candidate.status} key={candidate.subjectId}><td><strong>{candidate.name}</strong><small>ID {candidate.subjectId}</small></td><td>{candidate.snapshotRate}</td><td>{candidate.liveRate ?? "—"}</td><td>{candidate.targetRate}</td><td>{RATING_WRITE_STATUS_COPY[candidate.status]}</td></tr>)}</tbody></table></div>
        {readyCount > 0 ? <div className="rating-write-confirm">
          {!stoppingReady && <strong>注意：当前排序尚未达到停止条件。</strong>}
          <label className="field-label">输入账号名 <code>{username}</code> 以确认<input value={confirmation} disabled={busy} onChange={(event) => setConfirmation(event.target.value)} autoComplete="off" /></label>
          <button className="danger-button" type="button" disabled={busy || !confirmationMatches} onClick={() => void commitWrite()}>{stage === "write" ? `正在写回 ${progress?.completed ?? 0}/${progress?.total ?? readyCount}` : `永久写回 ${readyCount} 条评分`}</button>
        </div> : <Notice tone="info">当前没有可以安全写回的评分。</Notice>}
      </section>}
      {stage === "write" && progress && <div className="write-progress" role="status"><span>正在逐条写入并验证 · {progress.completed}/{progress.total}</span><div><i style={{ width: `${progress.total ? progress.completed / progress.total * 100 : 0}%` }} /></div></div>}
      {writeResult && <section className="rating-write-result" aria-live="polite">
        <Notice tone={writeResult.failed.length || writeResult.pending.length || writeResult.unverified.length ? "warning" : "success"}>已验证写回 {writeResult.succeeded.length} 条；原本已一致 {writeResult.unchanged.length} 条；跳过 {writeResult.skipped.length} 条。{writeResult.failed.length > 0 && `失败 ${writeResult.failed.length} 条。`}{writeResult.pending.length > 0 && `尚未执行 ${writeResult.pending.length} 条。`}{writeResult.unverified.length > 0 && `有 ${writeResult.unverified.length} 条无法验证。`}</Notice>
        {writeResult.message && <Notice tone="error">{writeResult.message}</Notice>}
        <details className="write-outcomes"><summary>查看逐条执行结果（{writeOutcomeRows.length}）</summary><div className="rating-write-table-wrap"><table className="rating-write-table"><thead><tr><th>条目</th><th>目标评分</th><th>结果</th></tr></thead><tbody>{writeOutcomeRows.map(({ candidate, status }) => <tr key={`${candidate.subjectId}:${status}`}><td><strong>{candidate.name}</strong><small>ID {candidate.subjectId}</small></td><td>{candidate.targetRate}</td><td>{status}</td></tr>)}</tbody></table></div></details>
        <div className="rating-write-result-actions"><button className="outline-button" type="button" onClick={() => { setWriteResult(undefined); setError(""); }}>重新输入令牌并检查</button><button className="primary-button compact" type="button" onClick={() => { clearSensitiveState(); onResync(); }}>重新同步当前账号</button></div>
      </section>}
    </div>
  </details>;
}

function MobileRankingCards({ items, scoreLevelCount }: { items: RankedItem[]; scoreLevelCount: number }) {
  return <ol className="ranking-cards" aria-label="移动端排名结果">{items.map((item) =>
    <li className="ranking-card" key={item.subjectId}>
      <div className="ranking-card-main">
        <strong className="ranking-card-rank">#{item.rank}</strong>
        <div className="title-cell"><Poster item={item} /><div><strong>{primaryName(item)}</strong><small>{item.nameCn ? item.name : (item.date?.slice(0, 4) || "") + " · " + SUBJECT_TYPES[item.subjectType]}</small></div></div>
        <a href={"https://bgm.tv/subject/" + item.subjectId} target="_blank" rel="noreferrer" aria-label={"在 Bangumi 打开 " + primaryName(item)}>↗</a>
      </div>
      <div className="ranking-card-scores">
        <span>原评分 <b className="score-pill old">{item.rate}</b></span>
        <span>新评分 <b className={"score-pill new " + (scoreLevelCount === DEFAULT_SCORE_LEVELS && item.newRate !== item.rate ? "changed" : "")}>{item.newRate}</b></span>
        <span>稳定度 <strong>{item.bucketStability === undefined ? "—" : percent(item.bucketStability)}</strong></span>
      </div>
      <details><summary>模型细节</summary><dl><div><dt>连续潜在分数</dt><dd>{item.ability.toFixed(3)}</dd></div><div><dt>后验标准差</dt><dd>{item.uncertainty.toFixed(3)}</dd></div></dl></details>
    </li>)}</ol>;
}

function ResultsView({ state, sessions, username, busy, onBack, onMode, onDistribution, onExportCsv, onAddComparison, onDeleteComparison, onResync }: {
  state: CompareState;
  sessions: SortingSession[];
  username: string;
  busy: boolean;
  onBack: () => void;
  onMode: (mode: ComparisonBudgetMode) => Promise<void>;
  onDistribution: (distribution: DistributionConfig) => Promise<void>;
  onExportCsv: (result: RankedItem[]) => void;
  onAddComparison: (leftSubjectId: number, rightSubjectId: number, outcome: Exclude<ComparisonOutcome, "skip">) => Promise<void>;
  onDeleteComparison: (recordId: string) => Promise<void>;
  onResync: () => void;
}) {
  const comparisons = toRankingComparisons(state.history);
  const result = buildRankedItems(state.items, state.model, comparisons, state.session.distribution);
  const diagnostics = state.model.diagnostics;
  const budgetMode = sessionBudgetMode(state.session);
  const scoreLevelCount = normalizeScoreLevelCount(state.session.distribution.levelCount);
  const effectiveEvidence = state.history.filter((record) => record.active && record.outcome !== "skip");
  const importedEvidence = effectiveEvidence.filter((record) => record.importBatchId).length;
  const newEvidence = effectiveEvidence.length - importedEvidence;
  const priorCopy = budgetMode === "quick"
    ? "原评分作为强先验"
    : budgetMode === "standard"
      ? "原评分作为中等先验"
      : "模型未采用原评分顺序先验";
  return <>
    <header className="page-header results-header"><div><span className="eyebrow">排序结果 · {BUDGET_MODE_COPY[budgetMode].label}模式 · <Term term="score-bucket">{scoreLevelCount} 档</Term></span><h1>你的偏好序列</h1><p>{result.length} 个{SUBJECT_TYPES[state.session.subjectType]}条目 · 当前输出 <Term term="score-bucket">{scoreLevelCount} 档评分</Term> · <Term term="prior">{priorCopy}</Term></p><p>总有效证据 {effectiveEvidence.length} 条 · 本会话新回答 {newEvidence} 条 · 导入证据 {importedEvidence} 条</p></div><div className="header-actions"><InferenceModeSelect id="result-budget-mode" value={budgetMode} busy={busy} onChange={onMode} /><button className="outline-button" onClick={onBack}>继续比较</button><button className="primary-button compact" onClick={() => onExportCsv(result)}>导出 CSV</button></div></header>
    <section className="result-summary"><article className="panel"><div className="panel-title"><div><span className="eyebrow"><Term term="score-distribution">{scoreLevelCount === DEFAULT_SCORE_LEVELS ? "评分分布对比" : "评分分布"}</Term></span><h2>{scoreLevelCount === DEFAULT_SCORE_LEVELS ? "原评分 → 新评分" : `原评分与 ${scoreLevelCount} 档新评分`}</h2></div><div className="distribution-controls"><ScoreLevelSelect id="result-score-level-count" className="header-select" compact value={scoreLevelCount} disabled={busy} onChange={(levelCount) => void onDistribution(distributionWithLevelCount(state.session.distribution, levelCount))} /><ThemedSelect id="result-distribution-preset" value={state.session.distribution.preset} options={distributionPresetOptions(scoreLevelCount)} ariaLabel="评分分布预设" menuLabel="评分分布预设选项" compact alignMenu="end" triggerClassName="header-select" disabled={busy} onChange={(preset) => void onDistribution(distributionConfig(preset, scoreLevelCount, state.session.distribution.weights))} /></div></div>{state.session.distribution.preset === "custom" && <CustomDistributionEditor key={`${state.session.id}:${scoreLevelCount}`} weights={state.session.distribution.weights} busy={busy} onApply={(weights) => onDistribution(distributionConfig("custom", scoreLevelCount, weights))} />}{scoreLevelCount === DEFAULT_SCORE_LEVELS ? <><TenLevelComparisonHistogram items={state.items} result={result} /><div className="chart-legend"><span><i className="old" />原评分</span><span><i className="new" />新评分</span></div></> : <div className="distribution-charts"><div className="distribution-chart"><strong>原评分 · 1–10</strong><OriginalScoreHistogram items={state.items} /></div><div className="distribution-chart"><strong>新评分 · 1–{scoreLevelCount}</strong><NewScoreHistogram result={result} levelCount={scoreLevelCount} /></div></div>}</article><article className="summary-stat"><span><Term term="cross-two-buckets">预计跨两档作品</Term></span><strong>{crossTwoBucketValue(diagnostics)}</strong><small><Term term="posterior-interval">{crossTwoBucketInterval(diagnostics)}</Term></small><div className="summary-forecast"><span><Term term="dynamic-forecast">动态剩余预测</Term></span><b>{forecastRange(diagnostics)}</b><small><StoppingCriterionDetail diagnostics={diagnostics} /></small></div><hr /><span><Term term="maximum-displacement">最坏偏移</Term></span><strong>{maxBucketDisplacementValue(diagnostics)}</strong><small>{maxBucketDisplacementInterval(diagnostics)}；仅作尾部诊断，停止条件允许最多 10% 的作品<Term term="cross-two-buckets">跨两档</Term>。{diagnostics?.calibration.completed ? <><Term term="calibration-repeat">复问</Term> {diagnostics.calibration.consistent}/{diagnostics.calibration.completed} 次一致，<Term term="posterior">后验</Term> {percent(diagnostics.calibration.posteriorMean)}（仅作诊断）</> : "尚无校准复问；区间仅代表模型内近似"}</small></article></section>
    <ComparisonManager key={state.session.id} items={result} history={state.history} sessionId={state.session.id} sessions={sessions} busy={busy} onAdd={onAddComparison} onDelete={onDeleteComparison} />
    <RatingWriteDangerZone
      key={`${state.session.id}:${state.model.version}:${scoreLevelCount}:${state.session.distribution.preset}:${state.session.distribution.weights.join(",")}`}
      username={username}
      subjectType={state.session.subjectType}
      items={result}
      scoreLevelCount={scoreLevelCount}
      stoppingReady={Boolean(diagnostics?.ready)}
      externalBusy={busy}
      onResync={onResync}
    />
    <MobileRankingCards items={result} scoreLevelCount={scoreLevelCount} />
    <section className="ranking-table-wrap"><table className="ranking-table"><thead><tr><th>名次</th><th>条目</th><th>原评分（10 档）</th><th>新评分（{scoreLevelCount} 档）</th><th><Term term="bucket-stability">精确分桶稳定度</Term></th><th><Term term="latent-preference">连续潜在分数（仅供解释）</Term></th><th><Term term="posterior-standard-deviation">后验标准差</Term></th><th /></tr></thead><tbody>{result.map((item) => <tr key={item.subjectId}><td><strong>#{item.rank}</strong></td><td><div className="title-cell"><Poster item={item} /><div><strong>{primaryName(item)}</strong><small>{item.nameCn ? item.name : `${item.date?.slice(0, 4) || ""} · ${SUBJECT_TYPES[item.subjectType]}`}</small></div></div></td><td><span className="score-pill old">{item.rate}</span></td><td><span className={`score-pill new ${scoreLevelCount === DEFAULT_SCORE_LEVELS && item.newRate !== item.rate ? "changed" : ""}`}>{item.newRate}</span></td><td>{item.bucketStability === undefined ? "—" : percent(item.bucketStability)}</td><td>{item.ability.toFixed(3)}</td><td>{item.uncertainty.toFixed(3)}</td><td><a href={`https://bgm.tv/subject/${item.subjectId}`} target="_blank" rel="noreferrer" aria-label={`在 Bangumi 打开 ${primaryName(item)}`}>↗</a></td></tr>)}</tbody></table></section>
  </>;
}

function BackupView({ snapshot, items, profile, sessions, onImported, storage }: { snapshot: Snapshot; items: CollectionItem[]; profile: Profile; sessions: SortingSession[]; onImported: () => Promise<void>; storage: { usage: number; quota: number; persisted: boolean } }) {
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  async function backup() { setError(""); try { const payload = await exportProject(profile.id); downloadJson(downloadName("bangumi-resorter-backup", profile.username, "json"), payload); await markExported(profile.id); setMessage("备份文件已下载。"); } catch (cause) { setError(cause instanceof Error ? cause.message : "导出失败。"); } }
  async function importFile(file?: File) { if (!file) return; setError(""); try { await importProject(await readBackup(file)); setMessage("项目已作为新的本地项目导入。"); await onImported(); } catch (cause) { setError(cause instanceof Error ? cause.message : "导入失败。"); } finally { if (fileRef.current) fileRef.current.value = ""; } }
  return <><header className="page-header"><div><span className="eyebrow">备份与导出</span><h1>把判断留在自己手里</h1><p>本地数据不会上传到本站服务器，请定期下载 JSON 备份。</p></div></header>{snapshot.containsPrivate && <Notice tone="warning">当前项目包含私有收藏。备份不含令牌，但会包含私有条目的名称、评分和比较记录。</Notice>}{message && <Notice tone="success">{message}</Notice>}{error && <Notice tone="error">{error}</Notice>}<section className="backup-grid"><article className="panel backup-card"><span className="eyebrow">完整项目</span><h2>JSON 会话备份</h2><p>包含<Term term="snapshot">收藏快照</Term>、所有会话、比较记录、模型结果和分布设置，可在其他域名或设备导入。</p><dl><div><dt>条目</dt><dd>{items.length}</dd></div><div><dt>会话</dt><dd>{sessions.length}</dd></div><div><dt>格式</dt><dd>ExportV1</dd></div></dl><button className="primary-button" onClick={backup}>下载 JSON 备份<span>↓</span></button></article><article className="panel backup-card"><span className="eyebrow">恢复或迁移</span><h2>导入备份</h2><p>导入始终创建一个新项目，不会覆盖当前数据。支持最大 20 MB 的 ExportV1 JSON。</p><input ref={fileRef} className="file-input" type="file" accept="application/json,.json" onChange={(event) => importFile(event.target.files?.[0])} /><button className="outline-button full" onClick={() => fileRef.current?.click()}>选择 JSON 文件</button></article><article className="panel backup-card storage-card"><span className="eyebrow">浏览器存储</span><h2>{storage.persisted ? "已申请持久保存" : "尽力保存模式"}</h2><p>{storage.persisted ? "浏览器不会在空间压力下自动清理本项目，但手动清站点数据仍会删除。" : "浏览器可能在空间不足时清理数据，请依赖 JSON 备份。"}</p><div className="storage-meter"><i style={{ width: storage.quota ? `${Math.min(100, storage.usage / storage.quota * 100)}%` : "0%" }} /></div><small>已使用 {formatBytes(storage.usage)} / 可用约 {formatBytes(storage.quota)}</small></article></section></>;
}

export default function ResorterApp() {
  const [view, setView] = useState<View>("connect");
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [items, setItems] = useState<CollectionItem[]>([]);
  const [sessions, setSessions] = useState<SortingSession[]>([]);
  const [profile, setProfile] = useState<Profile>();
  const [compare, setCompare] = useState<CompareState>();
  const [busy, setBusy] = useState(false);
  const [scoresVisible, setScoresVisible] = useState(false);
  const [resyncOpen, setResyncOpen] = useState(false);
  const [globalError, setGlobalError] = useState("");
  const [storeStatus, setStoreStatus] = useState({ usage: 0, quota: 0, persisted: false });
  const workerRef = useRef<RankingWorkerClient | null>(null);

  const navigate = useCallback((target: View) => {
    setGlobalError("");
    setResyncOpen(false);
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    setView(target);
    window.history.replaceState(null, "", `#${target}`);
    window.scrollTo({ top: 0, left: 0 });
  }, []);

  const loadSnapshot = useCallback(async (nextSnapshot: Snapshot, target: View = "library") => {
    const [nextItems, nextSessions, nextProfile] = await Promise.all([getSnapshotItems(nextSnapshot.id), listSessions(nextSnapshot.profileId), db.profiles.get(nextSnapshot.profileId)]);
    try { window.localStorage.setItem(LOCAL_PROJECT_MARKER_KEY, "1"); } catch { /* IndexedDB remains the source of truth. */ }
    setSnapshot(nextSnapshot); setItems(nextItems); setSessions(nextSessions); setProfile(nextProfile); setStoreStatus(await storageStatus()); navigate(target);
  }, [navigate]);

  useEffect(() => {
    let active = true;
    let readyFrame = 0;
    workerRef.current = new RankingWorkerClient();
    const clearPrinciplesReturn = () => {
      try {
        window.sessionStorage.removeItem(PRINCIPLES_RETURN_PENDING_KEY);
        window.sessionStorage.removeItem(PRINCIPLES_RETURN_TARGET_KEY);
      } catch {
        // Session storage can be disabled without affecting local project recovery.
      }
    };
    const pageshow = (event: PageTransitionEvent) => {
      if (event.persisted) clearPrinciplesReturn();
    };
    window.addEventListener("pageshow", pageshow);
    void (async () => {
      try {
        const saved = await latestSnapshot();
        if (!active) return;
        if (saved) await loadSnapshot(saved, "library");
        else {
          try { window.localStorage.removeItem(LOCAL_PROJECT_MARKER_KEY); } catch { /* Storage may be disabled. */ }
          navigate("connect");
        }
      } catch {
        if (active) {
          try { window.localStorage.removeItem(LOCAL_PROJECT_MARKER_KEY); } catch { /* Storage may be disabled. */ }
          navigate("connect");
        }
      } finally {
        if (active) {
          readyFrame = window.requestAnimationFrame(() => {
            if (!active) return;
            document.documentElement.dataset.resorterReady = "true";
            delete document.documentElement.dataset.resorterRestoring;
            clearPrinciplesReturn();
          });
        }
      }
    })();
    return () => {
      active = false;
      window.cancelAnimationFrame(readyFrame);
      window.removeEventListener("pageshow", pageshow);
      delete document.documentElement.dataset.resorterReady;
      workerRef.current?.terminate();
    };
  }, [loadSnapshot, navigate]);

  useEffect(() => {
    let nestedFrame = 0;
    const frame = window.requestAnimationFrame(() => {
      nestedFrame = window.requestAnimationFrame(() => window.scrollTo({ top: 0, left: 0 }));
    });
    return () => {
      window.cancelAnimationFrame(frame);
      window.cancelAnimationFrame(nestedFrame);
    };
  }, [view]);

  async function calculate(
    session: SortingSession,
    sessionItems: CollectionItem[],
    history: ComparisonRecord[],
    previousModel?: ModelState,
    operation: "INIT_SESSION" | "APPLY_RESPONSE" | "UNDO" | "RECOMPUTE" = "RECOMPUTE",
    version = session.modelVersion,
    distribution = session.distribution,
  ) {
    if (!workerRef.current) throw new Error("排序计算尚未就绪。");
    const tuning = rankingTuning(sessionBudgetMode(session));
    const result = await workerRef.current.run({ type: operation, sessionId: session.id, version, randomSeed: session.randomSeed,
      items: sessionItems.map((item) => ({ subjectId: item.subjectId, rate: item.rate })),
      history: toRankingHistory(history), distribution, budgetMode: sessionBudgetMode(session),
      previousModel, ...tuning });
    warmComparisonImages(sessionItems, result.nextPair);
    return result;
  }

  async function openSession(sessionId: string, target: "compare" | "results" = "compare") {
    setBusy(true); setGlobalError("");
    try {
      const bundle = await getSessionBundle(sessionId); if (!bundle) throw new Error("会话不存在。");
      const calculated = await calculate(bundle.session, bundle.items, bundle.history, bundle.model, bundle.model ? "RECOMPUTE" : "INIT_SESSION");
      await initializeModel(sessionId, calculated.model);
      const refreshed = await getSessionBundle(sessionId); if (!refreshed) throw new Error("会话不存在。");
      setCompare({ session: refreshed.session, items: refreshed.items, history: refreshed.history, model: calculated.model, nextPair: calculated.nextPair });
      setSessions(await listSessions(refreshed.session.profileId));
      navigate(target);
    } catch (cause) { setGlobalError(cause instanceof Error ? cause.message : "无法打开会话。"); }
    finally { setBusy(false); }
  }

  async function startSession(
    type: SubjectType,
    statuses: CollectionType[],
    distribution: DistributionConfig,
    budgetMode: ComparisonBudgetMode,
    tagFilter?: SessionTagFilter,
    sourceSessionId?: string,
    expectedSourceVersion?: number,
  ) {
    if (!snapshot) return;
    const session = await createSession(snapshot, type, statuses, distribution, {
      budgetMode,
      tagFilter,
      sourceSessionId,
      expectedSourceVersion,
    });
    setSessions(await listSessions(snapshot.profileId));
    await openSession(session.id);
    if (!storeStatus.persisted) { await requestPersistentStorage(); setStoreStatus(await storageStatus()); }
  }

  async function upgradeSession(sourceSessionId: string) {
    if (!snapshot) return;
    const { session } = await upgradeSessionToSnapshot(sourceSessionId, snapshot.id);
    setSessions(await listSessions(snapshot.profileId));
    await openSession(session.id);
  }

  async function deriveSession(sourceSessionId: string, tagFilter?: SessionTagFilter) {
    const { session } = await deriveSessionWithTagFilter(sourceSessionId, tagFilter);
    setSessions(await listSessions(session.profileId));
    await openSession(session.id);
  }

  async function answer(outcome: ComparisonOutcome) {
    if (!compare?.nextPair || busy) return; setBusy(true); setGlobalError("");
    try {
      const current = compare;
      const pair = current.nextPair;
      if (!pair) return;
      const provisional: ComparisonRecord = {
        id: crypto.randomUUID(),
        profileId: current.session.profileId,
        sessionId: current.session.id,
        subjectType: current.session.subjectType,
        leftSubjectId: pair.leftSubjectId,
        rightSubjectId: pair.rightSubjectId,
        outcome,
        queryKind: pair.queryKind,
        calibrationOfComparisonId: pair.calibrationOfComparisonId,
        acceptedCountAtAnswer: current.model.acceptedComparisons + (outcome === "skip" ? 0 : 1),
        active: true,
        createdAt: new Date().toISOString(),
      };
      const nextHistory = [...current.history, provisional];
      const calculated = await calculate(current.session, current.items, nextHistory, current.model, "APPLY_RESPONSE", current.session.modelVersion + 1);
      await commitResponse(current.session.id, current.session.modelVersion, { ...pair, recordId: provisional.id }, outcome, calculated.model);
      const bundle = await getSessionBundle(current.session.id); if (!bundle) throw new Error("会话保存失败。");
      setCompare({ session: bundle.session, items: bundle.items, history: bundle.history, model: calculated.model, nextPair: calculated.nextPair });
      setSessions(await listSessions(current.session.profileId));
    } catch (cause) { setGlobalError(cause instanceof Error ? cause.message : "无法保存这次比较。"); }
    finally { setBusy(false); }
  }

  async function undo() {
    if (!compare || busy) return; setBusy(true); setGlobalError("");
    try {
      const record = await lastActiveResponse(compare.session.id); if (!record) throw new Error("还没有可撤销的回答。");
      const nextHistory = compare.history.filter((item) => item.id !== record.id);
      const calculated = await calculate(compare.session, compare.items, nextHistory, compare.model, "UNDO", compare.session.modelVersion + 1);
      await commitUndo(compare.session.id, compare.session.modelVersion, record.id, calculated.model);
      const bundle = await getSessionBundle(compare.session.id); if (!bundle) throw new Error("会话保存失败。");
      const retryPair: NextPair = {
        pairId: `undo-${calculated.model.version}-${record.id}`,
        leftSubjectId: record.leftSubjectId,
        rightSubjectId: record.rightSubjectId,
        modelVersion: calculated.model.version,
        informationScore: 0,
        queryKind: record.queryKind ?? "adaptive",
        calibrationOfComparisonId: record.calibrationOfComparisonId,
      };
      setCompare({ session: bundle.session, items: bundle.items, history: bundle.history, model: calculated.model, nextPair: retryPair });
    } catch (cause) { setGlobalError(cause instanceof Error ? cause.message : "无法撤销。"); }
    finally { setBusy(false); }
  }

  useEffect(() => {
    function keydown(event: KeyboardEvent) {
      const target = event.target;
      const interactiveTarget = target instanceof Element && target.closest("input, select, textarea, [contenteditable='true'], [aria-haspopup='listbox'], [role='option'], [role='combobox'], [role='listbox']");
      if (view !== "compare" || busy || event.defaultPrevented || interactiveTarget) return;
      if (event.key === "ArrowLeft") { event.preventDefault(); answer("left"); }
      else if (event.key === "ArrowRight") { event.preventDefault(); answer("right"); }
      else if (event.key === "ArrowUp") { event.preventDefault(); answer("tie"); }
      else if (event.key === "ArrowDown") { event.preventDefault(); answer("skip"); }
      else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") { event.preventDefault(); undo(); }
    }
    window.addEventListener("keydown", keydown); return () => window.removeEventListener("keydown", keydown);
  });

  async function changeDistribution(distribution: DistributionConfig) {
    if (!compare || busy) return;
    setBusy(true); setGlobalError("");
    try {
      const current = compare;
      const nextVersion = current.session.modelVersion + 1;
      const calculated = await calculate(current.session, current.items, current.history, current.model, "RECOMPUTE", nextVersion, distribution);
      await commitSessionDistribution(current.session.id, current.session.modelVersion, distribution, calculated.model);
      const bundle = await getSessionBundle(current.session.id); if (!bundle) throw new Error("会话保存失败。");
      setCompare({ session: bundle.session, items: bundle.items, history: bundle.history, model: calculated.model, nextPair: calculated.nextPair });
      setSessions(await listSessions(current.session.profileId));
    } catch (cause) { setGlobalError(cause instanceof Error ? cause.message : "无法更新评分分布。"); }
    finally { setBusy(false); }
  }

  async function changeBudgetMode(budgetMode: ComparisonBudgetMode) {
    if (!compare || busy || sessionBudgetMode(compare.session) === budgetMode) return;
    setBusy(true); setGlobalError("");
    try {
      const current = compare;
      const nextVersion = current.session.modelVersion + 1;
      const nextSession = { ...current.session, budgetMode };
      const calculated = await calculate(nextSession, current.items, current.history, current.model, "RECOMPUTE", nextVersion);
      await commitSessionBudgetMode(current.session.id, current.session.modelVersion, budgetMode, calculated.model);
      const bundle = await getSessionBundle(current.session.id); if (!bundle) throw new Error("会话保存失败。");
      setCompare({ session: bundle.session, items: bundle.items, history: bundle.history, model: calculated.model, nextPair: calculated.nextPair });
      setSessions(await listSessions(current.session.profileId));
    } catch (cause) { setGlobalError(cause instanceof Error ? cause.message : "无法更新推断模式。"); }
    finally { setBusy(false); }
  }

  async function addManualComparison(
    leftSubjectId: number,
    rightSubjectId: number,
    outcome: Exclude<ComparisonOutcome, "skip">,
  ) {
    if (!compare || busy) return;
    setBusy(true); setGlobalError("");
    try {
      const current = compare;
      const allowed = new Set(current.items.map((item) => item.subjectId));
      if (leftSubjectId === rightSubjectId) throw new Error("左右两侧不能选择同一个条目。");
      if (!allowed.has(leftSubjectId) || !allowed.has(rightSubjectId)) throw new Error("只能添加当前会话范围内的比较。");
      const provisional: ComparisonRecord = {
        id: crypto.randomUUID(),
        profileId: current.session.profileId,
        sessionId: current.session.id,
        subjectType: current.session.subjectType,
        leftSubjectId,
        rightSubjectId,
        outcome,
        queryKind: "manual",
        acceptedCountAtAnswer: current.model.acceptedComparisons + 1,
        active: true,
        createdAt: new Date().toISOString(),
      };
      const nextHistory = [...current.history, provisional];
      const calculated = await calculate(current.session, current.items, nextHistory, current.model, "APPLY_RESPONSE", current.session.modelVersion + 1);
      await commitResponse(current.session.id, current.session.modelVersion, {
        recordId: provisional.id, leftSubjectId, rightSubjectId, queryKind: "manual",
      }, outcome, calculated.model);
      const bundle = await getSessionBundle(current.session.id); if (!bundle) throw new Error("会话保存失败。");
      setCompare({ session: bundle.session, items: bundle.items, history: bundle.history, model: calculated.model, nextPair: calculated.nextPair });
      setSessions(await listSessions(current.session.profileId));
    } catch (cause) { setGlobalError(cause instanceof Error ? cause.message : "无法添加这次比较。"); }
    finally { setBusy(false); }
  }

  async function removeComparison(recordId: string) {
    if (!compare || busy) return;
    setBusy(true); setGlobalError("");
    try {
      const current = compare;
      const record = current.history.find((entry) => entry.id === recordId && entry.active && entry.sessionId === current.session.id);
      if (!record) throw new Error("这条判断记录不存在，或不属于当前会话。");
      const nextHistory = current.history.filter((entry) => entry.id !== recordId);
      const calculated = await calculate(current.session, current.items, nextHistory, current.model, "RECOMPUTE", current.session.modelVersion + 1);
      await commitComparisonDeletion(current.session.id, current.session.modelVersion, recordId, calculated.model);
      const bundle = await getSessionBundle(current.session.id); if (!bundle) throw new Error("会话保存失败。");
      setCompare({ session: bundle.session, items: bundle.items, history: bundle.history, model: calculated.model, nextPair: calculated.nextPair });
      setSessions(await listSessions(current.session.profileId));
    } catch (cause) { setGlobalError(cause instanceof Error ? cause.message : "无法删除这条判断。"); }
    finally { setBusy(false); }
  }

  async function removeSession(sessionId: string) {
    await deleteSession(sessionId);
    // Any deleted session may have supplied reusable comparisons to the cached result.
    setCompare(undefined);
    if (profile) setSessions(await listSessions(profile.id));
  }

  async function exportCsv(result: RankedItem[]) { if (!snapshot) return; downloadText(downloadName("bangumi-resorter-results", snapshot.username, "csv"), resultsCsv(result, normalizeScoreLevelCount(compare?.session.distribution.levelCount)), "text/csv;charset=utf-8"); }

  const shellContent = (() => {
    if (!snapshot || !profile) return null;
    if (view === "library") return <LibraryView snapshot={snapshot} items={items} sessions={sessions} onStart={startSession} onResume={openSession} onUpgradeSession={upgradeSession} onDeriveSession={deriveSession} onDeleteSession={removeSession} onSyncAgain={() => setResyncOpen(true)} onSwitchAccount={() => navigate("connect")} />;
    if (view === "compare" && compare) return <CompareView state={compare} busy={busy} scoresVisible={scoresVisible} onToggleScores={() => setScoresVisible((value) => !value)} onMode={changeBudgetMode} onAnswer={answer} onUndo={undo} onPause={() => navigate("library")} onResults={() => navigate("results")} />;
    if (view === "results" && compare) return <ResultsView state={compare} sessions={sessions} username={snapshot.username} busy={busy} onBack={() => navigate("compare")} onMode={changeBudgetMode} onDistribution={changeDistribution} onExportCsv={exportCsv} onAddComparison={addManualComparison} onDeleteComparison={removeComparison} onResync={() => setResyncOpen(true)} />;
    if (view === "backup") return <BackupView snapshot={snapshot} items={items} profile={profile} sessions={sessions} storage={storeStatus} onImported={async () => { const saved = await latestSnapshot(); if (saved) await loadSnapshot(saved, "backup"); }} />;
    if (view === "compare") return <SessionPicker purpose="compare" sessions={sessions} currentSnapshotId={snapshot.id} busy={busy} onResume={openSession} onBack={() => navigate("library")} />;
    if (view === "results") return <SessionPicker purpose="results" sessions={sessions} currentSnapshotId={snapshot.id} busy={busy} onResume={(sessionId) => openSession(sessionId, "results")} onBack={() => navigate("library")} />;
    return <div className="center-message"><h2>请先选择一个排序会话</h2><button className="primary-button compact" onClick={() => navigate("library")}>返回收藏概览</button></div>;
  })();

  if (view === "connect" || !snapshot || !profile) return <><RestoreSplash /><ConnectView onConnected={(saved) => loadSnapshot(saved, "library")} onCancel={snapshot && profile ? () => navigate("library") : undefined} currentUsername={snapshot && profile ? snapshot.username : undefined} /></>;
  return <Shell view={view} onNavigate={navigate} profile={profile}>{globalError && <Notice tone="error">{globalError}</Notice>}{busy && view !== "compare" && <div className="loading-line">正在准备排序模型…</div>}{shellContent}{resyncOpen && <ResyncDialog snapshot={snapshot} onCancel={() => setResyncOpen(false)} onConnected={async (saved) => { setResyncOpen(false); await loadSnapshot(saved, "library"); }} />}</Shell>;
}
