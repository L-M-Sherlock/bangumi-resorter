"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  analysisCheckpoints,
  analysisPointFromModel,
  analysisSeriesPoints,
  sessionAnalysisContext,
  type SessionAnalysisContext,
} from "@/lib/analysis";
import { readReconciledSessionAnalysis as readStoredSeries } from "@/lib/db";
import {
  BUDGET_MODE_COPY,
  PRIOR_MODE_COPY,
  sessionBudgetMode,
  sessionPriorMode,
  STOPPING_MODE_ORDER,
  STOPPING_PROBABILITY_TARGET,
} from "@/lib/ranking/strategy";
import type {
  CollectionItem,
  ComparisonBudgetMode,
  ComparisonRecord,
  ModelState,
  PriorMode,
  SortingSession,
} from "@/lib/types";
import type {
  SessionAnalysisPoint,
  SessionAnalysisSeries,
} from "@/lib/analysis/types";

// Keep chart copy and colors centralized: mode lines retain the same identity
// in both stopping and forecast panels, while shared diagnostics use pink/purple.
const MODE_STYLE: Record<ComparisonBudgetMode, { color: string; dash?: string; symbol: ChartSeries["symbol"] }> = {
  quick: { color: "var(--analysis-blue)", symbol: "circle" },
  standard: { color: "var(--analysis-orange)", dash: "8 4", symbol: "square" },
  thorough: { color: "var(--analysis-green)", dash: "3 4", symbol: "diamond" },
};
const DISTRIBUTION_LABELS: Record<SortingSession["distribution"]["preset"], string> = {
  uniform: "均匀",
  preserve: "保持原分布",
  "high-tail": "高分辨率尾部",
  "reverse-j": "反 J",
  custom: "自定义",
};

export interface AnalysisTaskState {
  status: "idle" | "running" | "complete" | "error" | "cancelled";
  sessionId?: string;
  seriesId?: string;
  completed: number;
  total: number;
  message?: string;
}

interface SessionAnalysisViewProps {
  session: SortingSession;
  items: CollectionItem[];
  history: ComparisonRecord[];
  model: ModelState;
  busy: boolean;
  cacheRevision: number;
  task: AnalysisTaskState;
  storageWarning?: string;
  onBuildHistory: (context: SessionAnalysisContext, checkpoints: number[]) => Promise<void>;
  onCancelHistory: () => void;
  onPriorMode: (mode: PriorMode) => Promise<void>;
  onMode: (mode: ComparisonBudgetMode) => Promise<void>;
  onResults: () => void;
  onCompare: () => void;
}

interface ChartSeries {
  key: string;
  label: string;
  color: string;
  dash?: string;
  emphasized?: boolean;
  symbol: "circle" | "square" | "diamond" | "triangle";
  value: (point: SessionAnalysisPoint) => number | undefined;
  low?: (point: SessionAnalysisPoint) => number | undefined;
  high?: (point: SessionAnalysisPoint) => number | undefined;
  format?: (value: number) => string;
}

function finite(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value);
}

function formatCount(value: number) {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

function formatPercent(value: number) {
  return `${Math.round(value * 100)}%`;
}

function formatDecimal(value: number) {
  return value.toFixed(value >= 10 ? 1 : 3).replace(/\.0+$/u, "");
}

function useObservedWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(640);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const update = () => setWidth(Math.max(280, element.getBoundingClientRect().width));
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

function segmentsFor(
  points: SessionAnalysisPoint[],
  expectedIndex: Map<number, number>,
  available: (point: SessionAnalysisPoint) => boolean,
) {
  const segments: SessionAnalysisPoint[][] = [];
  let current: SessionAnalysisPoint[] = [];
  for (const point of points) {
    if (!available(point)) {
      if (current.length > 0) segments.push(current);
      current = [];
      continue;
    }
    const previous = current.at(-1);
    if (previous && (expectedIndex.get(point.checkpoint) ?? -1) !== (expectedIndex.get(previous.checkpoint) ?? -2) + 1) {
      segments.push(current);
      current = [];
    }
    current.push(point);
  }
  if (current.length > 0) segments.push(current);
  return segments;
}

function symbolElement(symbol: ChartSeries["symbol"], x: number, y: number, color: string, key: string) {
  if (symbol === "square") return <rect key={key} x={x - 4} y={y - 4} width="8" height="8" rx="1" fill={color} />;
  if (symbol === "diamond") return <path key={key} d={`M ${x} ${y - 5} L ${x + 5} ${y} L ${x} ${y + 5} L ${x - 5} ${y} Z`} fill={color} />;
  if (symbol === "triangle") return <path key={key} d={`M ${x} ${y - 5} L ${x + 5} ${y + 4} L ${x - 5} ${y + 4} Z`} fill={color} />;
  return <circle key={key} cx={x} cy={y} r="4.2" fill={color} />;
}

function AnalysisChart({
  title,
  description,
  points,
  expectedCheckpoints,
  selected,
  series,
  onSelect,
  fixedDomain,
  wide = false,
  reference,
  footer,
}: {
  title: string;
  description: string;
  points: SessionAnalysisPoint[];
  expectedCheckpoints: number[];
  selected: SessionAnalysisPoint;
  series: ChartSeries[];
  onSelect: (checkpoint: number) => void;
  fixedDomain?: [number, number];
  wide?: boolean;
  reference?: { value: number; label: string };
  footer?: string;
}) {
  const [containerRef, observedWidth] = useObservedWidth<HTMLDivElement>();
  const viewWidth = 720;
  const viewHeight = 278;
  const margin = { left: 52, right: 18, top: 20, bottom: 38 };
  const plotWidth = viewWidth - margin.left - margin.right;
  const plotHeight = viewHeight - margin.top - margin.bottom;
  const endpoint = Math.max(1, expectedCheckpoints.at(-1) ?? points.at(-1)?.checkpoint ?? 1);
  const allValues = series.flatMap((entry) => points.flatMap((point) => [entry.value(point), entry.low?.(point), entry.high?.(point)]))
    .filter(finite);
  const rawMin = fixedDomain?.[0] ?? Math.min(0, ...allValues);
  const rawMax = fixedDomain?.[1] ?? Math.max(1, ...allValues, reference?.value ?? -Infinity);
  const padding = fixedDomain ? 0 : Math.max(0.02, (rawMax - rawMin) * 0.08);
  const yMin = rawMin;
  const yMax = rawMax + padding;
  const x = (checkpoint: number) => margin.left + checkpoint / endpoint * plotWidth;
  const y = (value: number) => margin.top + (1 - (value - yMin) / Math.max(1e-9, yMax - yMin)) * plotHeight;
  const expectedIndex = new Map(expectedCheckpoints.map((checkpoint, index) => [checkpoint, index]));
  const tickCount = observedWidth < 430 ? 3 : 5;
  const xTicks = [...new Set(Array.from({ length: tickCount }, (_, index) => {
    const expectedPosition = index * (expectedCheckpoints.length - 1) / Math.max(1, tickCount - 1);
    return expectedCheckpoints[Math.round(expectedPosition)] ?? 0;
  }))];
  const yTicks = Array.from({ length: 5 }, (_, index) => yMin + (yMax - yMin) * index / 4);

  function selectFromPointer(event: ReactPointerEvent<SVGSVGElement>) {
    const bounds = event.currentTarget.getBoundingClientRect();
    const svgX = (event.clientX - bounds.left) / Math.max(1, bounds.width) * viewWidth;
    const checkpoint = Math.max(0, Math.min(endpoint, (svgX - margin.left) / plotWidth * endpoint));
    const closest = points.reduce((best, point) =>
      Math.abs(point.checkpoint - checkpoint) < Math.abs(best.checkpoint - checkpoint) ? point : best, points[0]);
    onSelect(closest.checkpoint);
  }

  return <article className={`analysis-chart-card${wide ? " analysis-chart-wide" : ""}`}>
    <header><div><h2>{title}</h2><p>{description}</p></div></header>
    <div className="analysis-chart-legend" aria-label={`${title}图例`}>{series.map((entry) => <span className={entry.emphasized ? "active" : ""} key={entry.key}><i style={{ color: entry.color, borderTopStyle: entry.dash ? "dashed" : "solid" }} />{entry.label}</span>)}</div>
    <div className="analysis-svg-wrap" ref={containerRef}>
      <svg viewBox={`0 0 ${viewWidth} ${viewHeight}`} role="img" aria-label={`${title}，当前选择第 ${selected.checkpoint} 条判断`} onPointerDown={selectFromPointer}>
        <title>{title}</title><desc>{description}。点击图中真实检查点可同步选择。</desc>
        {yTicks.map((tick) => <g key={`y-${tick}`}>
          <line x1={margin.left} y1={y(tick)} x2={viewWidth - margin.right} y2={y(tick)} className="analysis-grid-line" />
          <text x={margin.left - 9} y={y(tick) + 4} textAnchor="end" className="analysis-axis-label">{fixedDomain ? formatPercent(tick) : formatCount(tick)}</text>
        </g>)}
        {xTicks.map((tick) => <g key={`x-${tick}`}>
          <line x1={x(tick)} y1={margin.top} x2={x(tick)} y2={viewHeight - margin.bottom} className="analysis-grid-line vertical" />
          <text x={x(tick)} y={viewHeight - 13} textAnchor="middle" className="analysis-axis-label">{tick}</text>
        </g>)}
        {reference && <g><line x1={margin.left} y1={y(reference.value)} x2={viewWidth - margin.right} y2={y(reference.value)} className="analysis-reference-line" /><text x={viewWidth - margin.right - 4} y={y(reference.value) - 6} textAnchor="end" className="analysis-reference-label">{reference.label}</text></g>}
        {series.map((entry) => segmentsFor(points, expectedIndex, (point) => finite(entry.low?.(point)) && finite(entry.high?.(point))).map((segment, index) => {
          if (!entry.low || !entry.high || segment.length < 2) return null;
          const upper = segment.map((point) => `${x(point.checkpoint)},${y(entry.high!(point)!)}`).join(" L ");
          const lower = [...segment].reverse().map((point) => `${x(point.checkpoint)},${y(entry.low!(point)!)}`).join(" L ");
          return <path key={`${entry.key}-area-${index}`} d={`M ${upper} L ${lower} Z`} fill={entry.color} className="analysis-band" />;
        }))}
        {series.map((entry) => segmentsFor(points, expectedIndex, (point) => finite(entry.value(point))).map((segment, index) => {
          const path = segment.map((point, pointIndex) => `${pointIndex ? "L" : "M"} ${x(point.checkpoint)} ${y(entry.value(point)!)}`).join(" ");
          return <path key={`${entry.key}-line-${index}`} d={path} fill="none" stroke={entry.color} strokeWidth={entry.emphasized ? "3.8" : "2.5"} strokeDasharray={entry.dash} vectorEffect="non-scaling-stroke" />;
        }))}
        <g opacity=".58">{series.flatMap((entry) => points.flatMap((point) => {
          const value = entry.value(point);
          return finite(value)
            ? [symbolElement(entry.symbol, x(point.checkpoint), y(value), entry.color, `${entry.key}-${point.checkpoint}`)]
            : [];
        }))}</g>
        <line x1={x(selected.checkpoint)} y1={margin.top} x2={x(selected.checkpoint)} y2={viewHeight - margin.bottom} className="analysis-crosshair" />
        {series.flatMap((entry) => {
          const value = entry.value(selected);
          return finite(value) ? [symbolElement(entry.symbol, x(selected.checkpoint), y(value), entry.color, `${entry.key}-selected`)] : [];
        })}
      </svg>
    </div>
    <div className="analysis-chart-tooltip" role="status"><strong>第 {selected.checkpoint} 条</strong>{series.map((entry) => {
      const value = entry.value(selected);
      return <span key={entry.key}><i style={{ background: entry.color }} />{entry.label} <b>{finite(value) ? (entry.format ?? formatCount)(value) : "未计算"}</b></span>;
    })}</div>
    {footer && <p className="analysis-chart-footer">{footer}</p>}
  </article>;
}

function pointSummary(point: SessionAnalysisPoint, itemCount: number) {
  const efficiency = point.rawEvidence > 0 ? point.effectiveEvidence / point.rawEvidence : 0;
  return [
    ["原始判断", `${point.rawEvidence}`],
    ["有效证据", formatCount(point.effectiveEvidence)],
    ["作品覆盖", `${point.coveredItemCount}/${itemCount}`],
    ["证据效率", formatPercent(efficiency)],
  ];
}

export function SessionAnalysisView({
  session,
  items,
  history,
  model,
  busy,
  cacheRevision,
  task,
  storageWarning,
  onBuildHistory,
  onCancelHistory,
  onPriorMode,
  onMode,
  onResults,
  onCompare,
}: SessionAnalysisViewProps) {
  const priorMode = sessionPriorMode(session);
  const budgetMode = sessionBudgetMode(session);
  const context = useMemo(() => sessionAnalysisContext(session, items, history, priorMode, budgetMode), [session, items, history, priorMode, budgetMode]);
  const live = useMemo(() => analysisPointFromModel(context.history, model), [context, model]);
  const [series, setSeries] = useState<SessionAnalysisSeries>();
  const [cacheWarning, setCacheWarning] = useState("");
  const selectionKey = `${context.identity.id}:${context.inputDigest}`;
  const [selection, setSelection] = useState({ key: selectionKey, checkpoint: live.checkpoint });
  const selectedCheckpoint = selection.key === selectionKey ? selection.checkpoint : live.checkpoint;
  const selectCheckpoint = (checkpoint: number) => setSelection({ key: selectionKey, checkpoint });

  useEffect(() => {
    let active = true;
    void readStoredSeries(context).then((stored) => {
      if (!active) return;
      setSeries(stored);
      setCacheWarning("");
    }).catch((cause) => {
      if (!active) return;
      setSeries(undefined);
      setCacheWarning(cause instanceof Error ? cause.message : "无法读取历史分析缓存。");
    });
    return () => { active = false; };
  }, [context, cacheRevision]);

  const compatibleSeries = series?.id === context.identity.id ? series : undefined;
  const points = useMemo(() => analysisSeriesPoints(compatibleSeries, live), [compatibleSeries, live]);
  const expected = useMemo(() => analysisCheckpoints(items.length, context.history.length), [items.length, context.history.length]);
  const selected = points.find((point) => point.checkpoint === selectedCheckpoint) ?? live;
  const selectedIndex = Math.max(0, points.findIndex((point) => point.checkpoint === selected.checkpoint));
  const presentMilestones = new Set(compatibleSeries?.milestones.map((point) => point.checkpoint) ?? []);
  const missing = expected.filter((checkpoint) => checkpoint !== live.checkpoint && !presentMilestones.has(checkpoint));
  const activeTask = task.sessionId === session.id && task.seriesId === context.identity.id;
  const taskRunning = activeTask && task.status === "running";
  const canBuild = context.history.length > 0 && missing.length > 0 && !taskRunning;
  const anyReadyZero = STOPPING_MODE_ORDER.some((mode) => {
    const forecast = selected.forecasts[mode];
    return forecast?.status === "ready" && forecast.lowerAdditional === 0 && forecast.upperAdditional === 0;
  });
  const forecastHitFooter = STOPPING_MODE_ORDER.map((mode) => {
    const forecast = selected.forecasts[mode];
    if (!forecast) return `${BUDGET_MODE_COPY[mode].label}：未计算`;
    const successes = forecast.withinProjectionSuccesses;
    return `${BUDGET_MODE_COPY[mode].label}：${successes === undefined ? formatPercent(forecast.probabilityWithinProjection) : `${successes}/${forecast.rolloutCount}`} 窗口命中`;
  }).join(" · ");
  const evidenceBreakdownFooter = `时间折损 ${formatCount(selected.sourceAgeLoss)} · 同作品对相关性折损 ${formatCount(selected.repeatedPairLoss)} · 校准复问 ${selected.calibrationRaw}→${formatCount(selected.calibrationEffective)} · 导入判断 ${selected.importedRaw}→${formatCount(selected.importedEffective)}`;

  const evidenceSeries: ChartSeries[] = [
    { key: "raw", label: "原始判断", color: "var(--analysis-pink)", symbol: "circle", value: (point) => point.rawEvidence },
    { key: "effective", label: "有效证据", color: "var(--analysis-purple)", dash: "8 4", symbol: "square", value: (point) => point.effectiveEvidence },
    { key: "pairs", label: "唯一作品对", color: "var(--analysis-teal)", dash: "3 4", symbol: "diamond", value: (point) => point.uniquePairCount },
  ];
  const efficiencySeries: ChartSeries[] = [
    { key: "coverage", label: "作品覆盖率", color: "var(--analysis-pink)", symbol: "circle", value: (point) => point.coveredItemCount / Math.max(1, items.length), format: formatPercent },
    { key: "efficiency", label: "证据效率", color: "var(--analysis-purple)", dash: "8 4", symbol: "square", value: (point) => point.rawEvidence ? point.effectiveEvidence / point.rawEvidence : 0, format: formatPercent },
    { key: "unique-rate", label: "唯一配对率", color: "var(--analysis-teal)", dash: "3 4", symbol: "diamond", value: (point) => point.rawEvidence ? point.uniquePairCount / point.rawEvidence : 0, format: formatPercent },
  ];
  const uncertaintySeries: ChartSeries[] = [
    { key: "uncertainty", label: "平均后验标准差", color: "var(--analysis-pink)", symbol: "circle", value: (point) => point.meanUncertainty, format: formatDecimal },
    { key: "ties", label: "Davidson 平局强度", color: "var(--analysis-purple)", dash: "8 4", symbol: "square", value: (point) => point.tieStrength, format: formatDecimal },
  ];
  const crossSeries: ChartSeries[] = [
    { key: "cross", label: "预期跨两档作品数", color: "var(--analysis-purple)", symbol: "diamond", value: (point) => point.expectedCrossTwoBucketCount, low: (point) => point.crossTwoBucketCountLow, high: (point) => point.crossTwoBucketCountHigh },
  ];
  const stoppingSeries = STOPPING_MODE_ORDER.map<ChartSeries>((mode) => ({
    key: `stopping-${mode}`,
    label: `${BUDGET_MODE_COPY[mode].label}${mode === budgetMode ? "（当前）" : ""}`,
    ...MODE_STYLE[mode],
    emphasized: mode === budgetMode,
    value: (point) => point.stoppingChecks[mode]?.low,
    format: formatPercent,
  }));
  const forecastSeries = STOPPING_MODE_ORDER.map<ChartSeries>((mode) => ({
    key: `forecast-${mode}`,
    label: `${BUDGET_MODE_COPY[mode].label}${mode === budgetMode ? "（当前）" : ""}`,
    ...MODE_STYLE[mode],
    emphasized: mode === budgetMode,
    value: (point) => point.forecasts[mode]?.medianAdditional,
    low: (point) => point.forecasts[mode]?.lowerAdditional,
    high: (point) => point.forecasts[mode]?.upperAdditional,
  }));

  return <section className="analysis-page" aria-labelledby="analysis-title">
    <header className="page-header analysis-header">
      <div><span className="eyebrow">当前会话 · 会话分析</span><h1 id="analysis-title">{session.title}</h1><p>{items.length} 部作品 · {live.rawEvidence} 条原始判断 · {formatCount(live.effectiveEvidence)} 条有效证据</p><p>{PRIOR_MODE_COPY[priorMode].label} · {session.distribution.levelCount} 档 {DISTRIBUTION_LABELS[session.distribution.preset]}分布 · 实际后验样本 {live.posteriorSampleCount}</p></div>
      <div className="header-actions analysis-header-actions">
        <label><span>旧评分先验</span><select className="header-select" value={priorMode} disabled={busy} onChange={(event) => void onPriorMode(event.target.value as PriorMode)}><option value="weak">弱先验</option><option value="strong">强先验</option></select></label>
        <label><span>停止模式</span><select className="header-select" value={budgetMode} disabled={busy} onChange={(event) => void onMode(event.target.value as ComparisonBudgetMode)}>{STOPPING_MODE_ORDER.map((mode) => <option key={mode} value={mode}>{BUDGET_MODE_COPY[mode].label}</option>)}</select></label>
        <button type="button" className="outline-button" onClick={onResults}>返回结果</button>
        <button type="button" className="primary-button compact" onClick={onCompare}>继续比较</button>
      </div>
    </header>

    {(cacheWarning || storageWarning) && <div className="notice notice-warning" role="status">当前端点仍可查看；历史缓存不可用：{cacheWarning || storageWarning}</div>}
    {activeTask && task.status === "error" && <div className="notice notice-error" role="alert">历史补算中断：{task.message}<button type="button" className="text-button" disabled={!canBuild} onClick={() => void onBuildHistory(context, missing)}>重试缺失点</button></div>}
    {anyReadyZero && <div className="notice notice-info">预测的 0–0 表示对应停止规则已经满足；它不表示后验分布或模型不确定性消失。</div>}

    <section className="analysis-control-panel" aria-label="历史检查点控制">
      <div className="analysis-selected-summary"><span>当前选择</span><strong>第 {selected.checkpoint} 条判断</strong><small>{selected.checkpoint === live.checkpoint ? "当前权威端点" : `历史里程碑 · ${new Date(selected.computedAt).toLocaleString("zh-CN")}`}</small></div>
      <dl>{pointSummary(selected, items.length).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
      <div className="analysis-slider-row"><button type="button" aria-label="上一个真实检查点" disabled={selectedIndex <= 0} onClick={() => selectCheckpoint(points[Math.max(0, selectedIndex - 1)].checkpoint)}>←</button><input type="range" min="0" max={Math.max(0, points.length - 1)} step="1" value={selectedIndex} aria-label="选择真实分析检查点" onChange={(event) => selectCheckpoint(points[Number(event.target.value)].checkpoint)} /><button type="button" aria-label="下一个真实检查点" disabled={selectedIndex >= points.length - 1} onClick={() => selectCheckpoint(points[Math.min(points.length - 1, selectedIndex + 1)].checkpoint)}>→</button></div>
      <div className="analysis-build-controls">
        <button type="button" className="outline-button" disabled={!canBuild} onClick={() => void onBuildHistory(context, missing)}>{missing.length === 0 ? "历史检查点已齐全" : `补算历史检查点（${missing.length}）`}</button>
        {taskRunning && <button type="button" className="ghost-button" onClick={onCancelHistory}>取消补算</button>}
        {taskRunning && <div className="analysis-task-progress" role="status" aria-live="polite"><span style={{ width: `${task.total ? task.completed / task.total * 100 : 0}%` }} /><b>{task.completed}/{task.total}</b></div>}
        {!taskRunning && context.history.length === 0 && <small>当前没有可形成历史检查点的判断。</small>}
      </div>
    </section>

    <div className="analysis-chart-grid">
      <AnalysisChart title="证据折算" description="原始判断经来源时间衰减和同作品对相关性修正后形成有效证据。" points={points} expectedCheckpoints={expected} selected={selected} series={evidenceSeries} onSelect={selectCheckpoint} footer={evidenceBreakdownFooter} />
      <AnalysisChart title="覆盖与效率" description="覆盖作品、有效证据和唯一作品对相对原始判断的比例。" points={points} expectedCheckpoints={expected} selected={selected} series={efficiencySeries} onSelect={selectCheckpoint} fixedDomain={[0, 1]} />
      <AnalysisChart title="后验不确定性与平局强度" description="平均后验标准差与模型拟合的 Davidson 共享平局参数。" points={points} expectedCheckpoints={expected} selected={selected} series={uncertaintySeries} onSelect={selectCheckpoint} />
      <AnalysisChart title="跨两档作品数" description="作品跨越两档或以上的后验期望，以及中央 80% 后验区间。" points={points} expectedCheckpoints={expected} selected={selected} series={crossSeries} onSelect={selectCheckpoint} />
      <AnalysisChart wide title="三档停止下界" description="快速、标准、精细覆盖事件的 90% Monte Carlo 下界；当前停止模式在图例中标出。" points={points} expectedCheckpoints={expected} selected={selected} series={stoppingSeries} onSelect={selectCheckpoint} fixedDomain={[0, 1]} reference={{ value: STOPPING_PROBABILITY_TARGET, label: "90% 门槛" }} />
      <AnalysisChart wide title="三档动态剩余预测" description="共享模拟路径得到的剩余题量 P50 与 P10–P90；区间未闭合时阴影会断开。" points={points} expectedCheckpoints={expected} selected={selected} series={forecastSeries} onSelect={selectCheckpoint} footer={forecastHitFooter} />
    </div>
    <p className="analysis-disclaimer">64 路径条件情景区间，未经经验覆盖率校准。历史检查点是使用当前生产配置重建的派生缓存；当前模型结果始终是权威端点。</p>
  </section>;
}
