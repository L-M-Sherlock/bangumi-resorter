"use client";
/* eslint-disable @next/next/no-img-element -- Bangumi cover hosts are user-data dependent; static export cannot preconfigure every remote host. */

import { FormEvent, ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { syncBangumi, SyncProgress } from "@/lib/bangumi";
import { createDemoItems } from "@/lib/demo";
import {
  commitResponse,
  commitUndo,
  createSession,
  db,
  exportProject,
  getSessionBundle,
  getSnapshotItems,
  importProject,
  initializeModel,
  lastActiveResponse,
  latestSnapshot,
  listSessions,
  markExported,
  saveSnapshot,
  updateSessionDistribution,
} from "@/lib/db";
import { downloadJson, downloadText, readBackup, requestPersistentStorage, resultsCsv, storageStatus } from "@/lib/export";
import { buildRankedItems } from "@/lib/ranking/engine";
import { BUDGET_MODE_COPY, comparisonBudget, rankingTuning, sessionBudgetMode } from "@/lib/ranking/strategy";
import { RankingWorkerClient } from "@/lib/ranking/worker-client";
import {
  COLLECTION_TYPES,
  CollectionItem,
  CollectionType,
  ComparisonBudgetMode,
  ComparisonOutcome,
  ComparisonRecord,
  DISTRIBUTIONS,
  DistributionConfig,
  DistributionPreset,
  ModelState,
  NextPair,
  Profile,
  RankedItem,
  Snapshot,
  SortingSession,
  SUBJECT_TYPES,
  SubjectType,
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

function toSkips(history: ComparisonRecord[]) {
  return history
    .filter((record) => record.active && record.outcome === "skip")
    .map((record) => ({ leftSubjectId: record.leftSubjectId, rightSubjectId: record.rightSubjectId, acceptedCountAtAnswer: record.acceptedCountAtAnswer }));
}

function uncertaintyReduction(model: Pick<ModelState, "initialMeanUncertainty" | "currentMeanUncertainty">) {
  if (model.initialMeanUncertainty <= 0) return 0;
  return Math.min(1, Math.max(0, 1 - model.currentMeanUncertainty / model.initialMeanUncertainty));
}

function formatDate(date?: string) {
  if (!date) return "日期未知";
  return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "short", day: "numeric" }).format(new Date(date));
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

function Poster({ item, wide = false }: { item: CollectionItem; wide?: boolean }) {
  if (item.image) return <img className={wide ? "poster-image wide" : "poster-image"} src={item.image} alt={`${primaryName(item)} 封面`} />;
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

function Shell({ view, onNavigate, profile, children }: { view: View; onNavigate: (view: View) => void; profile?: Profile; children: ReactNode }) {
  const nav: Array<[View, string, string]> = [
    ["library", "⌂", "收藏概览"], ["compare", "⇄", "两两比较"], ["results", "≋", "排序结果"], ["backup", "↓", "备份与导出"],
  ];
  return (
    <main className="app-shell">
      <aside className="sidebar">
        <button className="brand-button" onClick={() => onNavigate("library")}><Brand /></button>
        <nav aria-label="主要导航">
          {nav.map(([target, icon, label]) => (
            <button key={target} className={view === target ? "active" : ""} onClick={() => onNavigate(target)}>
              <span className="nav-icon">{icon}</span><span className="nav-label">{label}</span>
            </button>
          ))}
        </nav>
        {profile && <div className="profile-mini">
          {profile.avatar ? <img src={profile.avatar} alt="" /> : <span className="avatar-fallback">{profile.username[0]?.toUpperCase()}</span>}
          <div><strong>{profile.nickname || profile.username}</strong><small>@{profile.username}</small></div>
        </div>}
        <div className="sidebar-note"><span className="status-dot" /><div><strong>所有数据仅存于本机</strong><small>不会修改 Bangumi 评分</small></div></div>
      </aside>
      <section className="workspace">{children}</section>
    </main>
  );
}

function Notice({ tone = "info", children }: { tone?: "info" | "warning" | "error" | "success"; children: ReactNode }) {
  return <div className={`notice notice-${tone}`} role={tone === "error" ? "alert" : "status"}>{children}</div>;
}

function ConnectView({ onConnected }: { onConnected: (snapshot: Snapshot) => Promise<void> }) {
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
        <Brand />
        <span className="hero-kicker">PERSONAL MEDIA RANKING</span>
        <h1>让你的评分，<br />重新变得有意义。</h1>
        <p>不再纠结“它值 8 分还是 9 分”。只需回答哪一部更喜欢，Resorter 会用 Bradley–Terry 模型逐步还原你的真实偏好。</p>
        <div className="method-steps">
          <span><b>01</b>同步已评分收藏</span><i />
          <span><b>02</b>两两比较</span><i />
          <span><b>03</b>导出新排名</span>
        </div>
      </section>
      <section className="connect-panel">
        <div className="connect-card">
          <span className="eyebrow">开始使用</span>
          <h2>连接 Bangumi 收藏</h2>
          <p>只读取你的收藏和评分，不会向 Bangumi 写入任何内容。</p>
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
        </div>
      </section>
    </main>
  );
}

function Histogram({ items, result }: { items: CollectionItem[]; result?: RankedItem[] }) {
  const original = Array.from({ length: 10 }, (_, index) => items.filter((item) => item.rate === index + 1).length);
  const updated = result ? Array.from({ length: 10 }, (_, index) => result.filter((item) => item.newRate === index + 1).length) : undefined;
  const max = Math.max(1, ...original, ...(updated ?? []));
  return <div className="histogram" aria-label="评分分布图">
    {original.map((count, index) => <div className="histogram-column" key={index} title={`${index + 1} 分：${count} 个`}>
      <div className="bar-space">
        {updated && <i className="bar-new" style={{ height: `${updated[index] / max * 100}%` }} />}
        <i className="bar-old" style={{ height: `${count / max * 100}%` }} />
      </div><span>{index + 1}</span>
    </div>)}
  </div>;
}

function DistributionWeights({ weights, onChange }: { weights: number[]; onChange: (weights: number[]) => void }) {
  return <div className="weight-editor" aria-label="自定义评分权重">
    {Array.from({ length: 10 }, (_, index) => <label key={index}><span>{index + 1} 分</span><input type="number" min="0" max="100" step="1" value={weights[index] ?? 0} onChange={(event) => {
      const next = [...weights];
      next[index] = Math.max(0, Number(event.target.value) || 0);
      onChange(next);
    }} /></label>)}
  </div>;
}

function LibraryView({ snapshot, items, sessions, onStart, onResume, onSyncAgain }: {
  snapshot: Snapshot; items: CollectionItem[]; sessions: SortingSession[];
  onStart: (type: SubjectType, statuses: CollectionType[], distribution: DistributionConfig, budgetMode: ComparisonBudgetMode) => Promise<void>;
  onResume: (sessionId: string) => Promise<void>; onSyncAgain: () => void;
}) {
  const availableTypes = subjectEntries.filter(([type]) => items.some((item) => item.subjectType === type));
  const [selectedType, setSelectedType] = useState<SubjectType>(availableTypes[0]?.[0] ?? 2);
  const [statuses, setStatuses] = useState<CollectionType[]>(collectionEntries.map(([type]) => type));
  const [preset, setPreset] = useState<DistributionPreset>("uniform");
  const [customWeights, setCustomWeights] = useState([...DISTRIBUTIONS.uniform]);
  const [budgetMode, setBudgetMode] = useState<ComparisonBudgetMode>("quick");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const selectedItems = items.filter((item) => item.subjectType === selectedType && statuses.includes(item.collectionType));
  const suggestedComparisons = comparisonBudget(selectedItems.length, budgetMode);

  async function start() {
    setBusy(true); setError("");
    try { await onStart(selectedType, statuses, { preset, weights: preset === "custom" ? customWeights : preset === "preserve" ? DISTRIBUTIONS.preserve : preset === "high-tail" ? DISTRIBUTIONS["high-tail"] : DISTRIBUTIONS.uniform }, budgetMode); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "无法创建会话。"); }
    finally { setBusy(false); }
  }

  return <>
    <header className="page-header"><div><span className="eyebrow">收藏概览</span><h1>{snapshot.username} 的已评分收藏</h1><p>上次同步于 {formatDate(snapshot.syncedAt)} · 共 {items.length} 个条目</p></div><button className="outline-button" onClick={onSyncAgain}>重新同步</button></header>
    <section className="metric-grid">
      {availableTypes.map(([type, label]) => { const count = items.filter((item) => item.subjectType === type).length; const mean = items.filter((item) => item.subjectType === type).reduce((sum, item) => sum + item.rate, 0) / count; return <button key={type} className={`metric-card ${selectedType === type ? "selected" : ""}`} onClick={() => setSelectedType(type)}><span>{label}</span><strong>{count}</strong><small>平均 {mean.toFixed(1)} 分</small></button>; })}
    </section>
    <section className="dashboard-grid">
      <article className="panel distribution-panel"><div className="panel-title"><div><span className="eyebrow">当前评分分布</span><h2>{SUBJECT_TYPES[selectedType]}</h2></div><span className="legend"><i />原评分</span></div><Histogram items={items.filter((item) => item.subjectType === selectedType)} /></article>
      <article className="panel start-panel"><span className="eyebrow">新建排序会话</span><h2>选择本次范围</h2><p>不同媒介会分别建立模型，比较记录可在后续会话中复用。</p>
        <div className="field-group"><span className="field-label" id="collection-status-label">收藏状态</span><div className="chip-row" role="group" aria-labelledby="collection-status-label">{collectionEntries.map(([type, label]) => <button key={type} className={statuses.includes(type) ? "selected" : ""} onClick={() => setStatuses((value) => value.includes(type) ? value.filter((item) => item !== type) : [...value, type])}>{label}</button>)}</div></div>
        <div className="field-group"><label htmlFor="comparison-budget">比较预算</label><select id="comparison-budget" value={budgetMode} onChange={(event) => setBudgetMode(event.target.value as ComparisonBudgetMode)}><option value="quick">快速（推荐）</option><option value="standard">标准</option><option value="thorough">精细</option></select><small className="field-help">{BUDGET_MODE_COPY[budgetMode].description} · 建议约 {suggestedComparisons} 次</small></div>
        <div className="field-group"><label htmlFor="distribution-preset">新评分分布</label><select id="distribution-preset" value={preset} onChange={(event) => setPreset(event.target.value as DistributionPreset)}><option value="uniform">均匀 1–10（推荐）</option><option value="preserve">保持原分布</option><option value="high-tail">高分辨率尾部</option><option value="custom">自定义权重</option></select>{preset === "custom" && <DistributionWeights weights={customWeights} onChange={setCustomWeights} />}</div>
        {error && <Notice tone="error">{error}</Notice>}
        <button className="primary-button" onClick={start} disabled={busy || selectedItems.length < 2}>{busy ? "正在准备模型…" : `开始${BUDGET_MODE_COPY[budgetMode].label}比较 · 建议 ${suggestedComparisons} 次`}<span>→</span></button>
      </article>
    </section>
    <section className="sessions-section"><div className="section-title"><div><span className="eyebrow">排序会话</span><h2>继续上次的判断</h2></div></div>{sessions.length === 0 ? <div className="empty-row">还没有会话，选择范围后开始第一次比较。</div> : <div className="session-list">{sessions.slice(0, 5).map((session) => <button key={session.id} onClick={() => onResume(session.id)}><span className="session-type">{SUBJECT_TYPES[session.subjectType]}</span><div><strong>{session.title}</strong><small>{BUDGET_MODE_COPY[sessionBudgetMode(session)].label}模式 · 建议 {session.suggestedComparisons} 次 · 更新于 {formatDate(session.updatedAt)}</small></div><span className={`session-status ${session.status}`}>{session.status === "complete" ? "已完成" : "进行中"}</span><b>→</b></button>)}</div>}</section>
  </>;
}

function CompareView({ state, busy, scoresVisible, onToggleScores, onAnswer, onUndo, onPause, onResults }: {
  state: CompareState; busy: boolean; scoresVisible: boolean; onToggleScores: () => void;
  onAnswer: (outcome: ComparisonOutcome) => void; onUndo: () => void; onPause: () => void; onResults: () => void;
}) {
  const left = state.items.find((item) => item.subjectId === state.nextPair?.leftSubjectId);
  const right = state.items.find((item) => item.subjectId === state.nextPair?.rightSubjectId);
  const currentSessionAccepted = state.history.filter((item) => item.sessionId === state.session.id && item.active && item.outcome !== "skip").length;
  const progress = Math.min(100, currentSessionAccepted / state.session.suggestedComparisons * 100);
  const budgetMode = sessionBudgetMode(state.session);
  const uncertaintyDrop = uncertaintyReduction(state.model);
  if (!left || !right) return <div className="center-message"><h2>暂时没有可比较的条目</h2><p>你可以查看当前结果，或返回收藏调整范围。</p><button className="primary-button" onClick={onResults}>查看结果</button></div>;
  return <>
    <header className="topbar"><div><span className="eyebrow">{SUBJECT_TYPES[state.session.subjectType]} · {BUDGET_MODE_COPY[budgetMode].label}模式 · {state.session.title}</span><h1>哪一部更值得你给出高分？</h1></div><button className="ghost-button" onClick={onToggleScores}>{scoresVisible ? "隐藏原评分" : "显示原评分"}</button></header>
    <div className="progress-row"><div className="progress-copy"><span>本次已完成 <strong>{currentSessionAccepted}</strong> / 建议 {state.session.suggestedComparisons} 次</span><span>不确定性降低 <strong>{Math.round(uncertaintyDrop * 100)}%</strong></span></div><div className="progress-track"><span style={{ width: `${progress}%` }} /></div></div>
    {currentSessionAccepted > 0 && currentSessionAccepted % 20 === 0 && <Notice tone="warning">你已经完成 {currentSessionAccepted} 次判断，建议现在下载一次 JSON 备份。</Notice>}
    {currentSessionAccepted >= state.session.suggestedComparisons && <Notice tone="success">已达到{BUDGET_MODE_COPY[budgetMode].label}模式的建议预算。现在的结果已经可用，也可以继续比较来提高精度。</Notice>}
    <section className={`comparison-stage ${busy ? "busy" : ""}`} aria-busy={busy}>
      <MediaCard item={left} side="left" showScore={scoresVisible} disabled={busy} onChoose={() => onAnswer("left")} />
      <div className="versus" aria-hidden="true"><span>{busy ? "…" : "VS"}</span></div>
      <MediaCard item={right} side="right" showScore={scoresVisible} disabled={busy} onChoose={() => onAnswer("right")} />
    </section>
    <div className="secondary-actions"><button disabled={busy} onClick={() => onAnswer("tie")}><span>＝</span>差不多喜欢 <kbd>↑</kbd></button><button disabled={busy} onClick={() => onAnswer("skip")}><span>↷</span>这次跳过 <kbd>↓</kbd></button><button disabled={busy} onClick={onUndo}><span>↶</span>撤销上次</button></div>
    <footer className="session-footer"><span>{budgetMode === "quick" ? "原评分作为强先验，只重点询问同分作品与相邻分档" : "模型会优先询问最能减少不确定性的相邻条目"}</span><div><button onClick={onResults}>查看当前结果</button><button onClick={onPause}>暂停并返回收藏</button></div></footer>
  </>;
}

function MediaCard({ item, side, showScore, disabled, onChoose }: { item: CollectionItem; side: "left" | "right"; showScore: boolean; disabled: boolean; onChoose: () => void }) {
  return <article className="media-card"><Poster item={item} wide /><div className="media-copy"><span className="media-kicker">{item.platform || SUBJECT_TYPES[item.subjectType]} · {item.date?.slice(0, 4) || "年份未知"}</span><h2>{primaryName(item)}</h2>{item.nameCn && <p>{item.name}</p>}{showScore && <span className="old-score">原评分 {item.rate}</span>}</div><button className="choice-button" disabled={disabled} onClick={onChoose}>{side === "left" && <span aria-hidden="true">←</span>} 更喜欢这部 {side === "right" && <span aria-hidden="true">→</span>}<kbd>{side === "left" ? "←" : "→"}</kbd></button></article>;
}

function ResultsView({ state, onBack, onDistribution, onExportCsv }: { state: CompareState; onBack: () => void; onDistribution: (distribution: DistributionConfig) => Promise<void>; onExportCsv: (result: RankedItem[]) => void }) {
  const comparisons = toRankingComparisons(state.history);
  const result = buildRankedItems(state.items, state.model, comparisons, state.session.distribution);
  const changed = result.filter((item) => item.newRate !== item.rate).length;
  const uncertaintyDrop = uncertaintyReduction(state.model);
  return <>
    <header className="page-header"><div><span className="eyebrow">排序结果 · {BUDGET_MODE_COPY[sessionBudgetMode(state.session)].label}模式</span><h1>你的偏好序列</h1><p>{result.length} 个{SUBJECT_TYPES[state.session.subjectType]}条目 · {changed} 个评分发生变化 · 原评分已作为模型先验</p></div><div className="header-actions"><button className="outline-button" onClick={onBack}>继续比较</button><button className="primary-button compact" onClick={() => onExportCsv(result)}>导出 CSV</button></div></header>
    <section className="result-summary"><article className="panel"><div className="panel-title"><div><span className="eyebrow">评分分布对比</span><h2>原评分 → 新评分</h2></div><select value={state.session.distribution.preset} onChange={(event) => { const preset = event.target.value as DistributionPreset; void onDistribution({ preset, weights: preset === "custom" ? state.session.distribution.weights : preset === "high-tail" ? DISTRIBUTIONS["high-tail"] : preset === "preserve" ? DISTRIBUTIONS.preserve : DISTRIBUTIONS.uniform }); }}><option value="uniform">均匀 1–10</option><option value="preserve">保持原分布</option><option value="high-tail">高分辨率尾部</option><option value="custom">自定义权重</option></select></div>{state.session.distribution.preset === "custom" && <DistributionWeights weights={state.session.distribution.weights} onChange={(weights) => void onDistribution({ preset: "custom", weights })} />}<Histogram items={state.items} result={result} /><div className="chart-legend"><span><i className="old" />原评分</span><span><i className="new" />新评分</span></div></article><article className="summary-stat"><span>不确定性较初始降低</span><strong>{Math.round(uncertaintyDrop * 100)}%</strong><small>当前平均值 {state.model.currentMeanUncertainty.toFixed(2)} · 越低越稳定</small><hr /><span>用于本次排序的人工比较</span><strong>{state.model.acceptedComparisons}</strong><small>不含跳过，可能包含同类旧会话记录</small></article></section>
    <section className="ranking-table-wrap"><table className="ranking-table"><thead><tr><th>名次</th><th>条目</th><th>原评分</th><th>新评分</th><th>模型分</th><th>不确定性</th><th /></tr></thead><tbody>{result.map((item) => <tr key={item.subjectId}><td><strong>#{item.rank}</strong></td><td><div className="title-cell"><Poster item={item} /><div><strong>{primaryName(item)}</strong><small>{item.nameCn ? item.name : `${item.date?.slice(0, 4) || ""} · ${SUBJECT_TYPES[item.subjectType]}`}</small></div></div></td><td><span className="score-pill old">{item.rate}</span></td><td><span className={`score-pill new ${item.newRate !== item.rate ? "changed" : ""}`}>{item.newRate}</span></td><td>{item.ability.toFixed(3)}</td><td>{item.uncertainty.toFixed(3)}</td><td><a href={`https://bgm.tv/subject/${item.subjectId}`} target="_blank" rel="noreferrer" aria-label={`在 Bangumi 打开 ${primaryName(item)}`}>↗</a></td></tr>)}</tbody></table></section>
  </>;
}

function BackupView({ snapshot, items, profile, sessions, onImported, storage }: { snapshot: Snapshot; items: CollectionItem[]; profile: Profile; sessions: SortingSession[]; onImported: () => Promise<void>; storage: { usage: number; quota: number; persisted: boolean } }) {
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  async function backup() { setError(""); try { const payload = await exportProject(profile.id); downloadJson(downloadName("bangumi-resorter-backup", profile.username, "json"), payload); await markExported(profile.id); setMessage("备份文件已下载。"); } catch (cause) { setError(cause instanceof Error ? cause.message : "导出失败。"); } }
  async function importFile(file?: File) { if (!file) return; setError(""); try { await importProject(await readBackup(file)); setMessage("项目已作为新的本地项目导入。"); await onImported(); } catch (cause) { setError(cause instanceof Error ? cause.message : "导入失败。"); } finally { if (fileRef.current) fileRef.current.value = ""; } }
  return <><header className="page-header"><div><span className="eyebrow">备份与导出</span><h1>把判断留在自己手里</h1><p>本地数据不会上传到本站服务器，请定期下载 JSON 备份。</p></div></header>{snapshot.containsPrivate && <Notice tone="warning">当前项目包含私有收藏。备份不含令牌，但会包含私有条目的名称、评分和比较记录。</Notice>}{message && <Notice tone="success">{message}</Notice>}{error && <Notice tone="error">{error}</Notice>}<section className="backup-grid"><article className="panel backup-card"><span className="eyebrow">完整项目</span><h2>JSON 会话备份</h2><p>包含收藏快照、所有会话、比较记录、模型结果和分布设置，可在其他域名或设备导入。</p><dl><div><dt>条目</dt><dd>{items.length}</dd></div><div><dt>会话</dt><dd>{sessions.length}</dd></div><div><dt>格式</dt><dd>ExportV1</dd></div></dl><button className="primary-button" onClick={backup}>下载 JSON 备份<span>↓</span></button></article><article className="panel backup-card"><span className="eyebrow">恢复或迁移</span><h2>导入备份</h2><p>导入始终创建一个新项目，不会覆盖当前数据。支持最大 20 MB 的 ExportV1 JSON。</p><input ref={fileRef} className="file-input" type="file" accept="application/json,.json" onChange={(event) => importFile(event.target.files?.[0])} /><button className="outline-button full" onClick={() => fileRef.current?.click()}>选择 JSON 文件</button></article><article className="panel backup-card storage-card"><span className="eyebrow">浏览器存储</span><h2>{storage.persisted ? "已申请持久保存" : "尽力保存模式"}</h2><p>{storage.persisted ? "浏览器不会在空间压力下自动清理本项目，但手动清站点数据仍会删除。" : "浏览器可能在空间不足时清理数据，请依赖 JSON 备份。"}</p><div className="storage-meter"><i style={{ width: storage.quota ? `${Math.min(100, storage.usage / storage.quota * 100)}%` : "0%" }} /></div><small>已使用 {formatBytes(storage.usage)} / 可用约 {formatBytes(storage.quota)}</small></article></section></>;
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
  const [globalError, setGlobalError] = useState("");
  const [storeStatus, setStoreStatus] = useState({ usage: 0, quota: 0, persisted: false });
  const workerRef = useRef<RankingWorkerClient | null>(null);

  const navigate = useCallback((target: View) => { setGlobalError(""); setView(target); window.location.hash = target; }, []);

  const loadSnapshot = useCallback(async (nextSnapshot: Snapshot, target: View = "library") => {
    const [nextItems, nextSessions, nextProfile] = await Promise.all([getSnapshotItems(nextSnapshot.id), listSessions(nextSnapshot.profileId), db.profiles.get(nextSnapshot.profileId)]);
    setSnapshot(nextSnapshot); setItems(nextItems); setSessions(nextSessions); setProfile(nextProfile); setStoreStatus(await storageStatus()); navigate(target);
  }, [navigate]);

  useEffect(() => {
    workerRef.current = new RankingWorkerClient();
    document.documentElement.dataset.resorterReady = "true";
    latestSnapshot().then((saved) => saved ? loadSnapshot(saved, "library") : navigate("connect")).catch(() => navigate("connect"));
    return () => {
      delete document.documentElement.dataset.resorterReady;
      workerRef.current?.terminate();
    };
  }, [loadSnapshot, navigate]);

  async function calculate(session: SortingSession, sessionItems: CollectionItem[], history: ComparisonRecord[], previousModel?: ModelState, operation: "INIT_SESSION" | "APPLY_RESPONSE" | "UNDO" | "RECOMPUTE" = "RECOMPUTE", version = session.modelVersion) {
    if (!workerRef.current) throw new Error("排序计算尚未就绪。");
    const tuning = rankingTuning(sessionBudgetMode(session));
    return workerRef.current.run({ type: operation, sessionId: session.id, version, randomSeed: session.randomSeed,
      items: sessionItems.map((item) => ({ subjectId: item.subjectId, rate: item.rate })), comparisons: toRankingComparisons(history), skips: toSkips(history), previousModel, ...tuning });
  }

  async function openSession(sessionId: string) {
    setBusy(true); setGlobalError("");
    try {
      const bundle = await getSessionBundle(sessionId); if (!bundle) throw new Error("会话不存在。");
      const calculated = await calculate(bundle.session, bundle.items, bundle.history, bundle.model, bundle.model ? "RECOMPUTE" : "INIT_SESSION");
      if (!bundle.model) await initializeModel(sessionId, calculated.model);
      setCompare({ session: bundle.session, items: bundle.items, history: bundle.history, model: calculated.model, nextPair: calculated.nextPair });
      navigate("compare");
    } catch (cause) { setGlobalError(cause instanceof Error ? cause.message : "无法打开会话。"); }
    finally { setBusy(false); }
  }

  async function startSession(type: SubjectType, statuses: CollectionType[], distribution: DistributionConfig, budgetMode: ComparisonBudgetMode) {
    if (!snapshot) return; const session = await createSession(snapshot, type, statuses, distribution, budgetMode); setSessions(await listSessions(snapshot.profileId)); await openSession(session.id); if (!storeStatus.persisted) { await requestPersistentStorage(); setStoreStatus(await storageStatus()); }
  }

  async function answer(outcome: ComparisonOutcome) {
    if (!compare?.nextPair || busy) return; setBusy(true); setGlobalError("");
    try {
      const current = compare;
      const pair = current.nextPair;
      if (!pair) return;
      const provisional: ComparisonRecord = { id: "provisional", profileId: current.session.profileId, sessionId: current.session.id, subjectType: current.session.subjectType, leftSubjectId: pair.leftSubjectId, rightSubjectId: pair.rightSubjectId, outcome, acceptedCountAtAnswer: current.model.acceptedComparisons + (outcome === "skip" ? 0 : 1), active: true, createdAt: new Date().toISOString() };
      const nextHistory = [...current.history, provisional];
      const calculated = await calculate(current.session, current.items, nextHistory, current.model, "APPLY_RESPONSE", current.session.modelVersion + 1);
      await commitResponse(current.session.id, current.session.modelVersion, pair, outcome, calculated.model);
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
      };
      setCompare({ session: bundle.session, items: bundle.items, history: bundle.history, model: calculated.model, nextPair: retryPair });
    } catch (cause) { setGlobalError(cause instanceof Error ? cause.message : "无法撤销。"); }
    finally { setBusy(false); }
  }

  useEffect(() => {
    function keydown(event: KeyboardEvent) {
      if (view !== "compare" || busy || event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) return;
      if (event.key === "ArrowLeft") { event.preventDefault(); answer("left"); }
      else if (event.key === "ArrowRight") { event.preventDefault(); answer("right"); }
      else if (event.key === "ArrowUp") { event.preventDefault(); answer("tie"); }
      else if (event.key === "ArrowDown") { event.preventDefault(); answer("skip"); }
      else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") { event.preventDefault(); undo(); }
    }
    window.addEventListener("keydown", keydown); return () => window.removeEventListener("keydown", keydown);
  });

  async function changeDistribution(distribution: DistributionConfig) {
    if (!compare) return;
    await updateSessionDistribution(compare.session.id, distribution);
    setCompare({ ...compare, session: { ...compare.session, distribution } });
  }

  async function exportCsv(result: RankedItem[]) { if (!snapshot) return; downloadText(downloadName("bangumi-resorter-results", snapshot.username, "csv"), resultsCsv(result), "text/csv;charset=utf-8"); }

  const shellContent = (() => {
    if (!snapshot || !profile) return null;
    if (view === "library") return <LibraryView snapshot={snapshot} items={items} sessions={sessions} onStart={startSession} onResume={openSession} onSyncAgain={() => navigate("connect")} />;
    if (view === "compare" && compare) return <CompareView state={compare} busy={busy} scoresVisible={scoresVisible} onToggleScores={() => setScoresVisible((value) => !value)} onAnswer={answer} onUndo={undo} onPause={() => navigate("library")} onResults={() => navigate("results")} />;
    if (view === "results" && compare) return <ResultsView state={compare} onBack={() => navigate("compare")} onDistribution={changeDistribution} onExportCsv={exportCsv} />;
    if (view === "backup") return <BackupView snapshot={snapshot} items={items} profile={profile} sessions={sessions} storage={storeStatus} onImported={async () => { const saved = await latestSnapshot(); if (saved) await loadSnapshot(saved, "backup"); }} />;
    return <div className="center-message"><h2>请先选择一个排序会话</h2><button className="primary-button compact" onClick={() => navigate("library")}>返回收藏概览</button></div>;
  })();

  if (view === "connect" || !snapshot || !profile) return <ConnectView onConnected={(saved) => loadSnapshot(saved, "library")} />;
  return <Shell view={view} onNavigate={navigate} profile={profile}>{globalError && <Notice tone="error">{globalError}</Notice>}{busy && view !== "compare" && <div className="loading-line">正在准备排序模型…</div>}{shellContent}</Shell>;
}
