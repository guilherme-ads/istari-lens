import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ComposedChart,
  LineChart as ReLineChart, Line, LabelList, Legend, PieChart as RePieChart, Pie, Cell,
} from "recharts";
import { ArrowUpDown, Download, ChevronLeft, ChevronRight, TrendingUp, TrendingDown } from "lucide-react";
import type { DashboardWidget, MetricOp, TableColumnAggregation } from "@/types/dashboard";
import { api, type ApiDashboardWidgetDataResponse, type ApiQuerySpec } from "@/lib/api";
import { cn } from "@/lib/utils";

const aggLabelMap = {
  count: "CONTAGEM",
  distinct_count: "CONTAGEM ÚNICA",
  sum: "SOMA",
  avg: "MÉDIA",
  max: "MÁXIMO",
  min: "MÍNIMO",
} as const;

const defaultPalette = [
  "hsl(250, 78%, 75%)",
  "hsl(17, 84%, 63%)",
  "hsl(142, 50%, 46%)",
  "hsl(205, 78%, 60%)",
  "hsl(330, 72%, 62%)",
  "hsl(45, 92%, 54%)",
  "hsl(188, 72%, 46%)",
  "hsl(12, 72%, 54%)",
];
const paletteByName: Record<"default" | "warm" | "cool" | "mono" | "vivid", string[]> = {
  default: defaultPalette,
  warm: ["#ef4444", "#f97316", "#eab308", "#f59e0b", "#dc2626", "#fb7185", "#f43f5e", "#facc15"],
  cool: ["#3b82f6", "#06b6d4", "#8b5cf6", "#6366f1", "#0ea5e9", "#14b8a6", "#22d3ee", "#60a5fa"],
  mono: ["#111827", "#374151", "#4b5563", "#6b7280", "#9ca3af", "#52525b", "#71717a", "#a1a1aa"],
  vivid: ["#ec4899", "#8b5cf6", "#06b6d4", "#10b981", "#f59e0b", "#ef4444", "#84cc16", "#14b8a6"],
};

const formatFullNumber = (value: unknown): string => {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number)) return "0";
  return new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 2 }).format(number);
};

const formatCompactNumber = (value: unknown): string => {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number)) return "0";
  const abs = Math.abs(number);

  const formatShort = (base: number, suffix: string) => {
    const scaled = number / base;
    const digits = Math.abs(scaled) >= 100 ? 0 : Math.abs(scaled) >= 10 ? 1 : 2;
    const text = new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 0, maximumFractionDigits: digits }).format(scaled);
    return `${text} ${suffix}`;
  };

  if (abs >= 1_000_000_000) return formatShort(1_000_000_000, "Bi");
  if (abs >= 1_000_000) return formatShort(1_000_000, "Mi");
  if (abs >= 1_000) return formatShort(1_000, "Mil");

  return formatFullNumber(number);
};

const formatPercent = (value: number): string => {
  const safe = Number.isFinite(value) ? value : 0;
  return `${new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(safe)}%`;
};

const toFiniteNumber = (value: unknown): number => {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : 0;
  }
  if (typeof value !== "string") return 0;

  const trimmed = value.trim();
  if (!trimmed) return 0;

  const compact = trimmed.replace(/\s+/g, "");
  let normalized = compact;

  const isPtBr = /^-?\d{1,3}(\.\d{3})+(,\d+)?$/.test(compact);
  const isEnUs = /^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(compact);

  if (isPtBr) {
    normalized = compact.replace(/\./g, "").replace(",", ".");
  } else if (isEnUs) {
    normalized = compact.replace(/,/g, "");
  } else if (compact.includes(",") && !compact.includes(".")) {
    normalized = compact.replace(",", ".");
  }

  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
};

const getMetricLabel = (widget: DashboardWidget): string => {
  if (widget.config.composite_metric) {
    const cfg = widget.config.composite_metric;
    const innerAgg = cfg.inner_agg || cfg.agg || "sum";
    const outerAgg = cfg.outer_agg || "avg";
    const compositeInnerLabel = innerAgg === "count"
      ? `CONTAGEM(${cfg.value_column || "*"})`
      : `${aggLabelMap[innerAgg]}(${cfg.value_column || "*"})`;
    return `${aggLabelMap[outerAgg]}(${compositeInnerLabel} por ${cfg.granularity})`;
  }
  if (widget.config.kpi_type === "derived" && widget.config.formula) {
    return `FÓRMULA(${widget.config.formula})`;
  }
  const metric = widget.config.metrics[0];
  if (!metric) return "Metrica";
  if (metric.alias && metric.alias.trim()) return metric.alias.trim();
  if (metric.op === "count") {
    return metric.column ? `CONTAGEM(${metric.column})` : "CONTAGEM(*)";
  }
  if (metric.op === "distinct_count") {
    return `CONTAGEM ÚNICA(${metric.column || "*"})`;
  }
  return `${aggLabelMap[metric.op]}(${metric.column || "*"})`;
};

const resolvePrimaryMetricKey = (widget: DashboardWidget, rows: Record<string, unknown>[]): string => {
  const firstMetricAlias = widget.config.metrics[0]?.alias?.trim();
  if (firstMetricAlias && rows.some((row) => Object.prototype.hasOwnProperty.call(row, firstMetricAlias))) {
    return firstMetricAlias;
  }
  if (rows.some((row) => Object.prototype.hasOwnProperty.call(row, "m0"))) {
    return "m0";
  }
  const dimKey = widget.config.dimensions[0];
  const firstRow = rows[0] || {};
  const candidate = Object.keys(firstRow).find((key) => {
    if (key === dimKey) return false;
    return key.startsWith("m");
  });
  return candidate || "m0";
};

const formatKpiValueFull = (
  value: number,
  showAs: "currency_brl" | "number_2" | "integer" | "percent",
  decimals = 2,
  prefix?: string,
  suffix?: string,
): string => {
  const safeDecimals = Math.max(0, Math.min(8, decimals));
  const decorate = (text: string) => `${prefix || ""}${text}${suffix || ""}`;
  if (showAs === "currency_brl") {
    return decorate(new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(value));
  }
  if (showAs === "integer") {
    return decorate(Math.trunc(value).toLocaleString("pt-BR"));
  }
  if (showAs === "percent") {
    return decorate(`${new Intl.NumberFormat("pt-BR", { minimumFractionDigits: safeDecimals, maximumFractionDigits: safeDecimals }).format(value)}%`);
  }
  return decorate(new Intl.NumberFormat("pt-BR", { minimumFractionDigits: safeDecimals, maximumFractionDigits: safeDecimals }).format(value));
};

const formatKpiValueCompact = (
  value: number,
  showAs: "currency_brl" | "number_2" | "integer" | "percent",
  _decimals = 2,
  prefix?: string,
  suffix?: string,
): string => {
  const decorate = (text: string) => `${prefix || ""}${text}${suffix || ""}`;
  if (showAs === "currency_brl") {
    const sign = value < 0 ? "-" : "";
    return decorate(`${sign}R$ ${formatCompactNumber(Math.abs(value))}`);
  }
  if (showAs === "integer") {
    return decorate(formatCompactNumber(Math.trunc(value)));
  }
  if (showAs === "percent") {
    return decorate(`${formatCompactNumber(value)}%`);
  }
  return decorate(formatCompactNumber(value));
};

const formatCurrencyBRL = (value: number): string =>
  new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(value);

const formatPercentOfTotal = (value: number, total: number): string => {
  if (!Number.isFinite(total) || total === 0) return "0,0%";
  const percent = (value / total) * 100;
  return `${new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(percent)}%`;
};

const splitLabelIntoTwoLines = (value: unknown, maxCharsPerLine: number): { lines: string[]; full: string } => {
  const full = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!full) return { lines: [""], full: "" };
  if (full.length <= maxCharsPerLine) return { lines: [full], full };

  const words = full.split(" ");
  const lines: string[] = [];
  let current = "";

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= maxCharsPerLine) {
      current = candidate;
      continue;
    }
    if (current) {
      lines.push(current);
      current = word;
    } else {
      lines.push(word.slice(0, maxCharsPerLine));
      current = word.slice(maxCharsPerLine);
    }
    if (lines.length >= 2) break;
  }
  if (lines.length < 2 && current) lines.push(current);

  const trimmed = lines.slice(0, 2).map((line) => line.trim());
  const joinedLength = trimmed.join(" ").length;
  if (joinedLength < full.length && trimmed.length > 0) {
    const last = trimmed[trimmed.length - 1];
    trimmed[trimmed.length - 1] = last.length >= maxCharsPerLine
      ? `${last.slice(0, Math.max(1, maxCharsPerLine - 1))}…`
      : `${last}…`;
  }
  return { lines: trimmed.filter((line) => !!line), full };
};

const GlassTooltip = ({
  active,
  payload,
  label,
  categoryLabel,
  metricLabel,
  valueLabel,
}: {
  active?: boolean;
  payload?: Array<{ value?: unknown }>;
  label?: unknown;
  categoryLabel: (value: unknown) => string;
  metricLabel: string;
  valueLabel: (value: unknown) => string;
}) => {
  if (!active || !payload || payload.length === 0) return null;
  const point = payload[0];
  const category = categoryLabel(label);
  const value = valueLabel(point.value);
  return (
    <div
      className="min-w-[160px] rounded-xl border border-border/60 bg-[hsl(var(--card)/0.72)] px-3 py-2 shadow-xl backdrop-blur-md"
      style={{ boxShadow: "0 14px 30px -16px rgba(2,6,23,0.65)" }}
    >
      <p className="text-[11px] font-semibold text-foreground/95">{category}</p>
      <div className="mt-1 flex items-center justify-between gap-3 text-[11px]">
        <span className="text-muted-foreground">{metricLabel}</span>
        <span className="font-semibold tabular-nums text-foreground">{value}</span>
      </div>
    </div>
  );
};

const computePeakValleyEvents = (params: {
  series: number[];
  sensitivityPercent: number;
  windowSize: number;
  minGap: number;
  mode: "peak" | "valley" | "both";
}): Set<number> => {
  const { series, sensitivityPercent, windowSize, minGap, mode } = params;
  const events: Array<{ index: number; score: number }> = [];
  if (series.length < 3) return new Set();
  const globalMax = Math.max(...series);
  const globalMin = Math.min(...series);
  const globalAmp = globalMax - globalMin;
  if (globalAmp <= 0) return new Set();

  const safeSensitivity = Math.max(25, Math.min(100, sensitivityPercent));
  const w = Math.max(1, windowSize);
  const minProminenceAbs = globalAmp * 0.01;

  for (let i = 0; i < series.length; i += 1) {
    const leftStart = Math.max(0, i - w);
    const rightEnd = Math.min(series.length - 1, i + w);
    const windowValues = series.slice(leftStart, rightEnd + 1);
    if (windowValues.length < 3) continue;

    const current = series[i];
    const localMax = Math.max(...windowValues);
    const localMin = Math.min(...windowValues);
    const ampLocal = localMax - localMin;
    if (ampLocal <= 0) continue;
    const threshold = ampLocal * (1 - (safeSensitivity / 100));
    const effectiveThreshold = Math.max(threshold, minProminenceAbs);

    const leftValues = series.slice(leftStart, i);
    const rightValues = series.slice(i + 1, rightEnd + 1);
    if (leftValues.length === 0 || rightValues.length === 0) continue;

    const candidatePeak = current === localMax;
    const candidateValley = current === localMin;

    if (candidatePeak && (mode === "both" || mode === "peak")) {
      const leftMin = Math.min(...leftValues);
      const rightMin = Math.min(...rightValues);
      const prominence = current - Math.max(leftMin, rightMin);
      if (prominence > 0 && prominence >= effectiveThreshold) {
        events.push({ index: i, score: prominence });
      }
    }

    if (candidateValley && (mode === "both" || mode === "valley")) {
      const leftMax = Math.max(...leftValues);
      const rightMax = Math.max(...rightValues);
      const prominence = Math.min(leftMax, rightMax) - current;
      if (prominence > 0 && prominence >= effectiveThreshold) {
        events.push({ index: i, score: prominence });
      }
    }
  }

  if (events.length === 0) return new Set();
  events.sort((a, b) => a.index - b.index);
  const kept: Array<{ index: number; score: number }> = [];
  for (const event of events) {
    const prev = kept[kept.length - 1];
    if (!prev || event.index - prev.index >= minGap) {
      kept.push(event);
      continue;
    }
    if (event.score > prev.score) {
      kept[kept.length - 1] = event;
    }
  }
  return new Set(kept.map((item) => item.index));
};

const renderGlassLabel = (params: { x: number; y: number; text: string; fontSize?: number }) => {
  const { x, y, text, fontSize = 10 } = params;
  const labelWidth = Math.max(34, Math.ceil(text.length * (fontSize * 0.62) + 14));
  const labelHeight = Math.max(18, Math.ceil(fontSize + 8));
  const left = x - (labelWidth / 2);
  const top = y - (labelHeight / 2);
  return (
    <g>
      <rect
        x={left}
        y={top}
        width={labelWidth}
        height={labelHeight}
        rx={7}
        ry={7}
        fill="hsl(var(--card) / 0.62)"
        stroke="hsl(var(--border) / 0.55)"
        strokeWidth={0.8}
      />
      <text
        x={x}
        y={y}
        dy={Math.ceil(fontSize * 0.34)}
        fill="hsl(var(--foreground) / 0.72)"
        fontSize={fontSize}
        fontWeight={500}
        textAnchor="middle"
      >
        {text}
      </text>
    </g>
  );
};

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));

type KpiComparisonData = {
  previousData?: ApiDashboardWidgetDataResponse;
  label?: string;
};

type RendererProps = {
  widget: DashboardWidget;
  dashboardId?: string;
  datasetId?: number;
  nativeFilters?: Array<{ column: string; op: string; value?: unknown; visible?: boolean }>;
  disableFetch?: boolean;
  builderMode?: boolean;
  heightMultiplier?: 0.5 | 1 | 2;
  layoutRows?: number;
  preloadedData?: ApiDashboardWidgetDataResponse;
  kpiComparison?: KpiComparisonData;
  preloadedLoading?: boolean;
  preloadedError?: string | null;
  hideTableExport?: boolean;
  forcedLoading?: boolean;
};

const EmptyWidgetState = ({ text }: { text: string }) => (
  <div className="flex h-full w-full items-center justify-center px-3 text-center text-xs text-muted-foreground">{text}</div>
);

const parseTemporalDimensionToken = (value: string): { column: string; granularity: "day" | "month" | "week" | "weekday" | "hour" } | null => {
  if (value.startsWith("__time_day__:")) return { column: value.slice("__time_day__:".length), granularity: "day" };
  if (value.startsWith("__time_month__:")) return { column: value.slice("__time_month__:".length), granularity: "month" };
  if (value.startsWith("__time_week__:")) return { column: value.slice("__time_week__:".length), granularity: "week" };
  if (value.startsWith("__time_weekday__:")) return { column: value.slice("__time_weekday__:".length), granularity: "weekday" };
  if (value.startsWith("__time_hour__:")) return { column: value.slice("__time_hour__:".length), granularity: "hour" };
  return null;
};

const buildTemporalDimensionToken = (column: string, granularity: "day" | "week" | "month" | "hour"): string => (
  `__time_${granularity}__:${column}`
);

const toYmd = (date: Date): string => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

const shiftDays = (date: Date, days: number): Date => {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
};

const resolveRelativeBetweenValue = (rawValue: unknown): [string, string] | null => {
  if (!rawValue || typeof rawValue !== "object") return null;
  const relativeRaw = (rawValue as { relative?: unknown }).relative;
  if (typeof relativeRaw !== "string") return null;
  const preset = relativeRaw as
    | "today"
    | "yesterday"
    | "last_7_days"
    | "last_30_days"
    | "this_year"
    | "this_month"
    | "last_month";
  const today = new Date();
  const end = new Date(today.getFullYear(), today.getMonth(), today.getDate());

  if (preset === "today") return [toYmd(end), toYmd(end)];
  if (preset === "yesterday") {
    const day = shiftDays(end, -1);
    return [toYmd(day), toYmd(day)];
  }
  if (preset === "last_7_days") {
    const start = shiftDays(end, -6);
    return [toYmd(start), toYmd(end)];
  }
  if (preset === "last_30_days") {
    const start = shiftDays(end, -29);
    return [toYmd(start), toYmd(end)];
  }
  if (preset === "this_year") {
    const start = new Date(end.getFullYear(), 0, 1);
    return [toYmd(start), toYmd(end)];
  }
  if (preset === "this_month") {
    const start = new Date(end.getFullYear(), end.getMonth(), 1);
    return [toYmd(start), toYmd(end)];
  }
  if (preset === "last_month") {
    const start = new Date(end.getFullYear(), end.getMonth() - 1, 1);
    const lastDayPrevMonth = new Date(end.getFullYear(), end.getMonth(), 0);
    return [toYmd(start), toYmd(lastDayPrevMonth)];
  }
  return null;
};

const normalizePreviewFilterValue = (op: string, rawValue: unknown): unknown[] | undefined | null => {
  if (op === "is_null" || op === "not_null") return undefined;
  if (op === "between") {
    if (Array.isArray(rawValue) && rawValue.length === 2) return [rawValue[0], rawValue[1]];
    const relativeRange = resolveRelativeBetweenValue(rawValue);
    if (relativeRange) return [relativeRange[0], relativeRange[1]];
    return null;
  }
  if (op === "in" || op === "not_in") {
    if (Array.isArray(rawValue)) return rawValue;
    if (rawValue === undefined || rawValue === null || rawValue === "") return null;
    return [rawValue];
  }
  if (rawValue === undefined || rawValue === null || rawValue === "") return null;
  return [rawValue];
};

const getTableColumnAggregation = (widget: DashboardWidget, columnName: string): TableColumnAggregation => {
  const rawValue = widget.config.table_column_aggs?.[columnName];
  if (rawValue === "count" || rawValue === "sum" || rawValue === "avg" || rawValue === "min" || rawValue === "max") {
    return rawValue;
  }
  return "none";
};

const getTableColumnLabel = (widget: DashboardWidget, columnName: string): string => {
  const rawLabel = widget.config.table_column_labels?.[columnName];
  return typeof rawLabel === "string" && rawLabel.trim() ? rawLabel.trim() : columnName;
};

const getTableColumnPrefix = (widget: DashboardWidget, columnName: string): string => {
  const rawPrefix = widget.config.table_column_prefixes?.[columnName];
  return typeof rawPrefix === "string" ? rawPrefix : "";
};

const getTableColumnSuffix = (widget: DashboardWidget, columnName: string): string => {
  const rawSuffix = widget.config.table_column_suffixes?.[columnName];
  return typeof rawSuffix === "string" ? rawSuffix : "";
};

type DraftPreviewPlan = {
  spec: ApiQuerySpec;
  lineTimeColumn?: string;
  dimensionAliasMap?: Record<string, string>;
  dreRowMetricKeys?: Record<string, string[]>;
  tableMetricKeyByColumn?: Record<string, string>;
  tableHiddenMetricKeys?: string[];
};

type ComparableDateWindow = {
  key: string;
  currentStart: string;
  currentEnd: string;
  previousStart: string;
  previousEnd: string;
};

const parseYmdLocal = (value: string): Date | null => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
  date.setHours(0, 0, 0, 0);
  return date;
};

const resolveBetweenDateRange = (rawValue: unknown): [string, string] | null => {
  if (Array.isArray(rawValue) && rawValue.length === 2) {
    const start = String(rawValue[0] || "").trim();
    const end = String(rawValue[1] || "").trim();
    if (!start || !end) return null;
    return [start, end];
  }
  return resolveRelativeBetweenValue(rawValue);
};

const buildPreviousPeriodFilters = <T extends { op: string; value?: unknown }>(
  filters: T[],
  getKey: (filter: T) => string | undefined,
  setRangeValue: (filter: T, value: [string, string]) => T,
): { window: ComparableDateWindow; filters: T[] } | null => {
  const DAY_MS = 24 * 60 * 60 * 1000;
  let selected: {
    key: string;
    currentRange: [string, string];
    durationDays: number;
    previousRange: [string, string];
  } | null = null;

  for (const filter of filters) {
    if (filter.op !== "between") continue;
    const key = (getKey(filter) || "").trim();
    if (!key) continue;
    const currentRange = resolveBetweenDateRange(filter.value);
    if (!currentRange) continue;
    const currentStartDate = parseYmdLocal(currentRange[0]);
    const currentEndDate = parseYmdLocal(currentRange[1]);
    if (!currentStartDate || !currentEndDate) continue;
    if (currentEndDate.getTime() < currentStartDate.getTime()) continue;
    const durationDays = Math.floor((currentEndDate.getTime() - currentStartDate.getTime()) / DAY_MS) + 1;
    if (durationDays <= 0) continue;

    const previousEndDate = new Date(currentStartDate.getTime() - DAY_MS);
    const previousStartDate = new Date(previousEndDate.getTime() - ((durationDays - 1) * DAY_MS));
    const previousRange: [string, string] = [toYmd(previousStartDate), toYmd(previousEndDate)];
    if (selected && durationDays >= selected.durationDays) continue;
    selected = { key, currentRange, durationDays, previousRange };
  }
  if (!selected) return null;

  let replaced = false;
  const previousFilters = filters.map((item) => {
    if (replaced || item.op !== "between") return item;
    const itemKey = (getKey(item) || "").trim();
    if (itemKey !== selected.key) return item;
    const itemRange = resolveBetweenDateRange(item.value);
    if (!itemRange) return item;
    if (itemRange[0] !== selected.currentRange[0] || itemRange[1] !== selected.currentRange[1]) return item;
    replaced = true;
    return setRangeValue(item, selected.previousRange);
  });
  if (!replaced) return null;

  return {
    window: {
      key: selected.key,
      currentStart: selected.currentRange[0],
      currentEnd: selected.currentRange[1],
      previousStart: selected.previousRange[0],
      previousEnd: selected.previousRange[1],
    },
    filters: previousFilters,
  };
};

const normalizeDraftRowsForWidget = (
  baseRows: Record<string, unknown>[],
  draftPreviewPlan: DraftPreviewPlan | null,
): Record<string, unknown>[] => {
  if (!draftPreviewPlan) return baseRows;
  return baseRows.map((item) => {
    if (typeof item !== "object" || item === null) return item;
    const row = { ...item } as Record<string, unknown>;
    if (draftPreviewPlan.lineTimeColumn && !Object.prototype.hasOwnProperty.call(row, "time_bucket")) {
      row.time_bucket = row[draftPreviewPlan.lineTimeColumn];
    }
    Object.entries(draftPreviewPlan.dimensionAliasMap || {}).forEach(([target, source]) => {
      if (Object.prototype.hasOwnProperty.call(row, target)) return;
      row[target] = row[source];
    });
    Object.entries(draftPreviewPlan.dreRowMetricKeys || {}).forEach(([target, sourceKeys]) => {
      row[target] = sourceKeys.reduce((acc, sourceKey) => acc + toFiniteNumber(row[sourceKey]), 0);
    });
    Object.entries(draftPreviewPlan.tableMetricKeyByColumn || {}).forEach(([target, sourceKey]) => {
      row[target] = row[sourceKey];
    });
    Object.values(draftPreviewPlan.tableMetricKeyByColumn || {}).forEach((sourceKey) => {
      delete row[sourceKey];
    });
    (draftPreviewPlan.tableHiddenMetricKeys || []).forEach((hiddenKey) => {
      delete row[hiddenKey];
    });
    return row;
  });
};

const buildDraftPreviewSpec = ({
  widget,
  datasetId,
  nativeFilters,
}: {
  widget: DashboardWidget;
  datasetId: number;
  nativeFilters: Array<{ column: string; op: string; value?: unknown; visible?: boolean }>;
}): DraftPreviewPlan | null => {
  const widgetType = widget.config.widget_type;
  const isKpi = widgetType === "kpi";
  const isLine = widgetType === "line";
  const isDonut = widgetType === "donut";
  const isBarLike = widgetType === "bar" || widgetType === "column";
  const isCategorical = isBarLike || isDonut;
  const isTable = widgetType === "table";
  const isDre = widgetType === "dre";
  if (!isKpi && !isCategorical && !isLine && !isTable && !isDre) return null;
  if (isKpi && widget.config.kpi_type === "derived") return null;

  let metrics = (widget.config.metrics || [])
    .filter((metric) => !!metric.op)
    .map((metric) => ({
      field: metric.column || "*",
      agg: metric.op,
    }));
  if (isKpi && widget.config.composite_metric) {
    const cfg = widget.config.composite_metric;
    if (!cfg.time_column) return null;
    metrics = [{
      field: cfg.value_column || "*",
      agg: cfg.inner_agg || "count",
    }];
  }
  if (isKpi && metrics.length !== 1) return null;
  if (isDonut && metrics.length !== 1) return null;
  if (widgetType === "bar" && metrics.length !== 1) return null;
  if (widgetType === "column" && metrics.length < 1) return null;
  if (isLine && (metrics.length < 1 || metrics.length > 2)) return null;
  const dreRowMetricKeys: Record<string, string[]> = {};
  const tableMetricKeyByColumn: Record<string, string> = {};
  const tableHiddenMetricKeys: string[] = [];
  if (isDre) {
    const dreRows = widget.config.dre_rows || [];
    if (dreRows.length === 0) return null;
    metrics = [];
    const dreMetricRefs: Array<{ targetKey: string; metric: { field: string; agg: MetricOp } }> = [];
    for (let rowIndex = 0; rowIndex < dreRows.length; rowIndex += 1) {
      const row = dreRows[rowIndex];
      const rowMetrics = (row.metrics || [])
        .filter((metric) => !!metric.op && (metric.op === "count" || !!metric.column))
        .map((metric) => ({
          field: metric.column || "*",
          agg: metric.op as MetricOp,
        }));
      if (rowMetrics.length === 0) return null;
      const targetKey = `m${rowIndex}`;
      rowMetrics.forEach((metric) => {
        dreMetricRefs.push({ targetKey, metric });
      });
    }
    const metricCanonicalKey = (metric: { field: string; agg: MetricOp }) =>
      JSON.stringify({ agg: metric.agg, field: metric.field });
    const uniqueByKey = new Map<string, { field: string; agg: MetricOp }>();
    dreMetricRefs.forEach(({ metric }) => {
      const key = metricCanonicalKey(metric);
      if (!uniqueByKey.has(key)) uniqueByKey.set(key, metric);
    });
    const orderedEntries = Array.from(uniqueByKey.entries()).sort(([left], [right]) => left.localeCompare(right));
    metrics = orderedEntries.map(([, metric]) => metric);
    const sourceIndexByKey = new Map<string, number>(orderedEntries.map(([key], index) => [key, index]));
    dreMetricRefs.forEach(({ targetKey, metric }) => {
      const sourceIndex = sourceIndexByKey.get(metricCanonicalKey(metric));
      if (sourceIndex === undefined) return;
      if (!dreRowMetricKeys[targetKey]) dreRowMetricKeys[targetKey] = [];
      dreRowMetricKeys[targetKey].push(`m${sourceIndex}`);
    });
  }

  const dimensionAliasMap: Record<string, string> = {};
  let dimensions: string[] = [];
  let lineTimeColumn: string | undefined;
  if (isKpi && widget.config.composite_metric) {
    const cfg = widget.config.composite_metric;
    const lineGranularity = cfg.granularity || "day";
    const timeDimension = lineGranularity === "timestamp"
      ? cfg.time_column
      : buildTemporalDimensionToken(
          cfg.time_column,
          lineGranularity === "week" || lineGranularity === "month" || lineGranularity === "hour" ? lineGranularity : "day",
        );
    dimensions = [timeDimension];
    lineTimeColumn = timeDimension;
  } else if (isCategorical) {
    const rawDimension = (widget.config.dimensions || [])[0];
    if (!rawDimension) return null;
    const parsedTemporalDimension = parseTemporalDimensionToken(rawDimension);
    if (parsedTemporalDimension) {
      const normalizedColumn = parsedTemporalDimension.column.trim();
      if (!normalizedColumn) return null;
      // Keep temporal token in preview spec so backend applies derived granularity (month/week/etc),
      // matching persisted widget execution behavior.
      dimensions = [rawDimension];
      // Fallback alias in case backend returns base column instead of temporal token.
      dimensionAliasMap[rawDimension] = normalizedColumn;
    } else {
      dimensions = [rawDimension];
    }
  } else if (isLine) {
    lineTimeColumn = widget.config.time?.column;
    if (!lineTimeColumn) return null;
    const lineGranularity = widget.config.time?.granularity || "day";
    const lineTimeDimension = lineGranularity === "timestamp"
      ? lineTimeColumn
      : buildTemporalDimensionToken(lineTimeColumn, lineGranularity);
    const legendDimension = (widget.config.dimensions || []).slice(0, 1);
    dimensions = [lineTimeDimension, ...legendDimension];
    lineTimeColumn = lineTimeDimension;
  } else if (isTable) {
    const configuredColumns = (widget.config.columns || [])
      .map((column) => column.trim())
      .filter((column) => !!column);
    const fallbackColumnsFromInstances = (widget.config.table_column_instances || [])
      .map((item) => String(item.source || "").trim())
      .filter((column) => !!column);
    const tableColumns = configuredColumns.length > 0
      ? configuredColumns
      : Array.from(new Set(fallbackColumnsFromInstances));
    if (tableColumns.length === 0) return null;
    metrics = [];
    dimensions = [];
    tableColumns.forEach((columnName) => {
      const aggregation = getTableColumnAggregation(widget, columnName);
      if (aggregation === "none") {
        dimensions.push(columnName);
        return;
      }
      tableMetricKeyByColumn[columnName] = `m${metrics.length}`;
      metrics.push({
        field: columnName,
        agg: aggregation,
      });
    });
    // For table widgets with only dimensions, force grouped execution (distinct-like rows)
    // to avoid duplicated lines and edge-case failures on joined datasets.
    if (dimensions.length > 0 && metrics.length === 0) {
      tableHiddenMetricKeys.push(`m${metrics.length}`);
      metrics.push({
        field: "*",
        agg: "count",
      });
    }
    if (dimensions.length === 0 && metrics.length === 0) return null;
  }

  const mergedFilters = [
    ...(nativeFilters || []),
    ...(widget.config.filters || []),
  ];
  const filters: ApiQuerySpec["filters"] = [];
  for (const filter of mergedFilters) {
    if (!filter.column) continue;
    const normalizedValue = normalizePreviewFilterValue(filter.op, filter.value);
    if (normalizedValue === null) return null;
    filters.push({
      field: filter.column,
      op: filter.op,
      value: normalizedValue,
    });
  }

  let sort: ApiQuerySpec["sort"] = [];
  const firstOrder = widget.config.order_by?.[0];
  if (isLine && lineTimeColumn) {
    sort = [{ field: lineTimeColumn, dir: "asc" }];
  } else {
    const sortField = isTable ? firstOrder?.column : firstOrder?.metric_ref || firstOrder?.column;
    sort = sortField
      ? [{ field: sortField, dir: firstOrder?.direction === "asc" ? "asc" : "desc" }]
      : [];
  }

  const rawLimit = isLine
    ? (widget.config.limit || 500)
    : isKpi
    ? (widget.config.composite_metric ? (widget.config.limit || 500) : 1)
    : isDre
    ? 5000
    : isTable
    ? (widget.config.limit || widget.config.table_page_size || 25)
    : isDonut && widget.config.donut_group_others_enabled
    ? (widget.config.limit || 5000)
    : (widget.config.top_n || widget.config.limit || 200);
  const limit = Math.max(1, Math.min(5000, Number(rawLimit) || 200));
  const offset = Math.max(0, Number(widget.config.offset) || 0);

  return {
    spec: {
      datasetId,
      metrics,
      dimensions,
      filters,
      sort,
      limit,
      offset,
    },
    lineTimeColumn,
    dimensionAliasMap: Object.keys(dimensionAliasMap).length > 0 ? dimensionAliasMap : undefined,
    dreRowMetricKeys: Object.keys(dreRowMetricKeys).length > 0 ? dreRowMetricKeys : undefined,
    tableMetricKeyByColumn: Object.keys(tableMetricKeyByColumn).length > 0 ? tableMetricKeyByColumn : undefined,
    tableHiddenMetricKeys: tableHiddenMetricKeys.length > 0 ? tableHiddenMetricKeys : undefined,
  };
};

const WidgetLoadingSkeleton = ({ type, chartHeight }: { type: DashboardWidget["config"]["widget_type"]; chartHeight: number }) => {
  if (type === "kpi") {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-3 py-4">
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-10 w-32" />
      </div>
    );
  }

  if (type === "table" || type === "dre") {
    return (
      <div className="flex h-full w-full flex-col gap-2">
        <Skeleton className="h-7 w-full rounded-md" />
        <Skeleton className="h-7 w-full rounded-md" />
        <Skeleton className="h-7 w-full rounded-md" />
        <Skeleton className="h-7 w-[92%] rounded-md" />
      </div>
    );
  }

  if (type === "text") {
    return (
      <div className="flex h-full w-full flex-col items-start justify-center gap-2">
        <Skeleton className="h-4 w-[85%]" />
        <Skeleton className="h-4 w-[72%]" />
        <Skeleton className="h-4 w-[60%]" />
      </div>
    );
  }

  if (type === "bar") {
    return (
      <div className="flex h-full w-full flex-col justify-center gap-2">
        <Skeleton className="h-5 w-[88%] rounded-md" />
        <Skeleton className="h-5 w-[76%] rounded-md" />
        <Skeleton className="h-5 w-[92%] rounded-md" />
        <Skeleton className="h-5 w-[64%] rounded-md" />
      </div>
    );
  }

  if (type === "donut") {
    return (
      <div className="flex h-full w-full items-center justify-center">
        <div className="relative">
          <Skeleton className="h-28 w-28 rounded-full" />
          <div className="absolute inset-[26%] rounded-full bg-background" />
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full w-full flex-col gap-2">
      <Skeleton className="h-5 w-1/3" />
      <Skeleton className="h-4 w-1/2" />
      <Skeleton className="w-full rounded-lg" style={{ height: `${chartHeight}px` }} />
    </div>
  );
};

const parseDateLike = (value: unknown): Date | null => {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value !== "string") return null;
  const isDateString = /^\d{4}-\d{2}-\d{2}/.test(value) || /^\d{4}\/\d{2}\/\d{2}/.test(value);
  if (!isDateString) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

const formatDateBR = (date: Date, includeTime = false, includeSeconds = false): string => {
  if (!includeTime) {
    return new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" }).format(date);
  }
  return new Intl.DateTimeFormat("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: includeSeconds ? "2-digit" : undefined,
  }).format(date);
};

const isoWeekNumber = (date: Date): number => {
  const utc = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = utc.getUTCDay() || 7;
  utc.setUTCDate(utc.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(utc.getUTCFullYear(), 0, 1));
  return Math.ceil((((utc.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
};

const formatTemporalBucket = (
  value: unknown,
  granularity: "day" | "month" | "week" | "weekday" | "hour",
): string => {
  const parsed = parseDateLike(value);
  if (granularity === "week") {
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (/^S\d+$/i.test(trimmed)) return trimmed.toUpperCase();
    }
    if (parsed) return `S${isoWeekNumber(parsed)}`;
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return `S${Math.max(1, Math.trunc(numeric))}`;
    return `S${String(value ?? "").trim()}`;
  }
  if (granularity === "weekday") {
    if (parsed) return new Intl.DateTimeFormat("pt-BR", { weekday: "short" }).format(parsed).replace(".", "");
    const weekdays = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sab"];
    const numeric = Number(value);
    if (Number.isFinite(numeric)) {
      const normalized = Math.trunc(numeric);
      const idx = normalized >= 1 && normalized <= 7 ? normalized % 7 : Math.max(0, Math.min(6, normalized));
      return weekdays[idx];
    }
    return String(value ?? "");
  }
  if (granularity === "hour") {
    if (parsed) return new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit" }).format(parsed);
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return `${String(Math.max(0, Math.min(23, Math.trunc(numeric)))).padStart(2, "0")}:00`;
    return String(value ?? "");
  }
  if (granularity === "month") {
    if (parsed) return new Intl.DateTimeFormat("pt-BR", { month: "short", year: "2-digit" }).format(parsed);
    return String(value ?? "");
  }
  if (parsed) return formatDateBR(parsed, false);
  return String(value ?? "");
};

const niceNumber = (value: number): number => {
  if (!Number.isFinite(value) || value <= 0) return 1;
  const exponent = Math.floor(Math.log10(value));
  const fraction = value / (10 ** exponent);
  let niceFraction = 10;
  if (fraction <= 1) niceFraction = 1;
  else if (fraction <= 2) niceFraction = 2;
  else if (fraction <= 2.5) niceFraction = 2.5;
  else if (fraction <= 5) niceFraction = 5;
  return niceFraction * (10 ** exponent);
};

const computeNiceAxisMax = (maxValue: number, tickCount = 4): number => {
  if (!Number.isFinite(maxValue) || maxValue <= 0) return 1;
  const safeTickCount = Math.max(2, tickCount);
  const roughStep = maxValue / (safeTickCount - 1);
  const niceStep = niceNumber(roughStep);
  return niceStep * (safeTickCount - 1);
};

const formatByTableConfig = (value: unknown, format: string): string => {
  if (value === null || value === undefined) return "";
  const asNumber = typeof value === "number" ? value : Number(value);
  const asDate = parseDateLike(value);

  if (format === "text") return String(value);
  if (format === "currency_brl" && Number.isFinite(asNumber)) {
    return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(asNumber);
  }
  if (format === "number_2" && Number.isFinite(asNumber)) {
    return new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(asNumber);
  }
  if (format === "integer" && Number.isFinite(asNumber)) {
    return Math.trunc(asNumber).toLocaleString("pt-BR");
  }
  if (asDate) {
    if (format === "datetime") return formatDateBR(asDate, true);
    if (format === "time") return new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit" }).format(asDate);
    if (format === "year") return String(asDate.getFullYear());
    if (format === "month") return String(asDate.getMonth() + 1).padStart(2, "0");
    if (format === "day") return String(asDate.getDate()).padStart(2, "0");
    return formatDateBR(asDate, false);
  }
  if (Number.isFinite(asNumber) && typeof value === "number") {
    return asNumber.toLocaleString("pt-BR");
  }
  return String(value);
};

const MiniTable = ({
  rows,
  widget,
  hideExport = false,
}: {
  rows: Record<string, unknown>[];
  widget: DashboardWidget;
  hideExport?: boolean;
}) => {
  const [sortBy, setSortBy] = useState<{ column_id: string; source: string; direction: "asc" | "desc" } | null>(null);
  const [page, setPage] = useState(1);
  const configured = widget.config.columns || [];
  const rowKeys = Object.keys(rows[0] || {});
  const pageSize = Math.max(1, widget.config.table_page_size || 25);
  const tableColumnDefs = (Array.isArray(widget.config.table_column_instances) && widget.config.table_column_instances.length > 0
    ? widget.config.table_column_instances
      .filter((item) => !!item.source)
      .map((item, index) => ({
        id: item.id || `${item.source}__${index}`,
        source: item.source,
        label: (item.label && item.label.trim()) || item.source,
        format: item.format || widget.config.table_column_formats?.[item.source] || "native",
        aggregation: item.aggregation || getTableColumnAggregation(widget, item.source),
        prefix: item.prefix ?? getTableColumnPrefix(widget, item.source),
        suffix: item.suffix ?? getTableColumnSuffix(widget, item.source),
      }))
    : (() => {
      const tableColumns = configured.length > 0
        ? configured.filter((column) => rowKeys.includes(column))
        : rowKeys;
      return tableColumns.map((key, index) => ({
        id: `${key}__${index}`,
        source: key,
        label: getTableColumnLabel(widget, key),
        format: widget.config.table_column_formats?.[key] || "native",
        aggregation: getTableColumnAggregation(widget, key),
        prefix: getTableColumnPrefix(widget, key),
        suffix: getTableColumnSuffix(widget, key),
      }));
    })());
  const visibleRows = useMemo(() => {
    if (rows.length <= 1 || tableColumnDefs.length === 0) return rows;
    const seen = new Set<string>();
    const uniqueRows: Record<string, unknown>[] = [];
    for (const row of rows) {
      const signature = JSON.stringify(tableColumnDefs.map((column) => row[column.source] ?? null));
      if (seen.has(signature)) continue;
      seen.add(signature);
      uniqueRows.push(row);
    }
    return uniqueRows;
  }, [rows, tableColumnDefs]);
  const tableDensity = widget.config.table_density || "normal";
  const densityClassByMode = {
    compact: {
      head: "py-1.5",
      cell: "py-1 text-[11px]",
    },
    normal: {
      head: "py-2",
      cell: "py-1.5 text-xs",
    },
    comfortable: {
      head: "py-2.5",
      cell: "py-2 text-sm",
    },
  } as const;
  const densityClass = densityClassByMode[tableDensity];
  const stickyHeaderClass = widget.config.table_sticky_header !== false ? "sticky top-0 z-10 bg-muted/40 backdrop-blur-sm" : "bg-muted/30";
  const tableFrameClass = widget.config.table_borders !== false ? "rounded-lg border border-border" : "";
  const rowBorderClass = widget.config.table_borders !== false ? "border-b border-border/60 last:border-b-0" : "";
  const textAlignClass = {
    left: "text-left",
    center: "text-center",
    right: "text-right",
  } as const;

  const sortedRows = useMemo(() => {
    if (!sortBy) return visibleRows;
    const copy = [...visibleRows];
    copy.sort((a, b) => {
      const av = a[sortBy.source];
      const bv = b[sortBy.source];
      if (av === bv) return 0;
      if (av === null || av === undefined) return 1;
      if (bv === null || bv === undefined) return -1;
      const aDate = parseDateLike(av);
      const bDate = parseDateLike(bv);
      if (aDate && bDate) {
        return sortBy.direction === "asc" ? aDate.getTime() - bDate.getTime() : bDate.getTime() - aDate.getTime();
      }
      if (typeof av === "number" && typeof bv === "number") {
        return sortBy.direction === "asc" ? av - bv : bv - av;
      }
      return sortBy.direction === "asc"
        ? String(av).localeCompare(String(bv), "pt-BR")
        : String(bv).localeCompare(String(av), "pt-BR");
    });
    return copy;
  }, [visibleRows, sortBy]);

  const totalPages = Math.max(1, Math.ceil(sortedRows.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const pageRows = sortedRows.slice((safePage - 1) * pageSize, safePage * pageSize);

  if (visibleRows.length === 0) return <EmptyWidgetState text="Nenhum dado retornado" />;

  const exportCsv = () => {
    const escapeCsv = (value: string) => {
      if (value.includes("\"") || value.includes(",") || value.includes("\n")) {
        return `"${value.replace(/"/g, "\"\"")}"`;
      }
      return value;
    };
    const header = tableColumnDefs.map((column) => escapeCsv(column.label)).join(",");
    const body = sortedRows.map((row) =>
      tableColumnDefs
        .map((column) => escapeCsv(`${column.prefix}${formatByTableConfig(row[column.source], column.format)}${column.suffix}`))
        .join(","))
      .join("\n");
    const csv = `${header}\n${body}`;
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.setAttribute("download", `${(widget.title || "tabela").replace(/\s+/g, "_").toLowerCase()}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  return (
    <div className="flex h-full w-full flex-col gap-2 text-sm">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] text-muted-foreground">{sortedRows.length.toLocaleString("pt-BR")} linhas</span>
        {!hideExport && (
          <Button type="button" size="sm" variant="outline" className="h-7 text-xs" onClick={exportCsv}>
            <Download className="h-3.5 w-3.5 mr-1.5" />
            Exportar CSV
          </Button>
        )}
      </div>

      <div className={cn("flex-1 overflow-auto", tableFrameClass)}>
        <div className="min-w-max">
          <Table>
            <TableHeader className={stickyHeaderClass}>
              <TableRow className={cn("hover:bg-muted/30", rowBorderClass)}>
                {tableColumnDefs.map((column) => (
                  <TableHead key={column.id} className={cn("min-w-[120px] whitespace-nowrap text-xs font-semibold", densityClass.head)}>
                    <button
                      className="inline-flex items-center gap-1 hover:text-foreground"
                      onClick={() => {
                        setPage(1);
                        setSortBy((prev) => {
                          if (!prev || prev.column_id !== column.id) return { column_id: column.id, source: column.source, direction: "asc" };
                          if (prev.direction === "asc") return { column_id: column.id, source: column.source, direction: "desc" };
                          return null;
                        });
                      }}
                    >
                      {column.label}
                      {column.aggregation !== "none" && <span className="text-[10px] text-muted-foreground">{column.aggregation.toUpperCase()}</span>}
                      <ArrowUpDown className="h-3 w-3" />
                    </button>
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {pageRows.map((row, idx) => (
                <TableRow
                  key={`${safePage}-${idx}`}
                  className={cn(
                    rowBorderClass,
                    widget.config.table_zebra_rows !== false && "even:bg-muted/20",
                  )}
                >
                  {tableColumnDefs.map((column) => {
                    const value = row[column.source];
                    const isNumericValue = typeof value === "number" || column.aggregation !== "none";
                    const alignClass = isNumericValue
                      ? textAlignClass[widget.config.table_default_number_align || "right"]
                      : textAlignClass[widget.config.table_default_text_align || "left"];
                    return (
                      <TableCell
                        key={column.id}
                        className={cn(
                          "whitespace-nowrap",
                          densityClass.cell,
                          alignClass,
                          isNumericValue && "font-mono tabular-nums",
                        )}
                      >
                        {column.prefix}{formatByTableConfig(value, column.format)}{column.suffix}
                      </TableCell>
                    );
                  })}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </div>

      <div className="flex items-center justify-between text-[11px] text-muted-foreground">
        <span>Pagina {safePage} de {totalPages}</span>
        <div className="inline-flex items-center gap-1">
          <Button
            type="button"
            size="icon"
            variant="outline"
            className="h-7 w-7"
            disabled={safePage <= 1}
            onClick={() => setPage((prev) => Math.max(1, prev - 1))}
          >
            <ChevronLeft className="h-3.5 w-3.5" />
          </Button>
          <Button
            type="button"
            size="icon"
            variant="outline"
            className="h-7 w-7"
            disabled={safePage >= totalPages}
            onClick={() => setPage((prev) => Math.min(totalPages, prev + 1))}
          >
            <ChevronRight className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
    </div>
  );
};

export const WidgetRenderer = ({
  widget,
  dashboardId,
  datasetId,
  nativeFilters = [],
  disableFetch = false,
  builderMode = false,
  heightMultiplier = 1,
  layoutRows,
  preloadedData,
  kpiComparison,
  preloadedLoading = false,
  preloadedError = null,
  hideTableExport = false,
  forcedLoading = false,
}: RendererProps) => {
  const isTextWidget = widget.config.widget_type === "text";
  const kpiValueContainerRef = useRef<HTMLDivElement | null>(null);
  const kpiMeasureRef = useRef<HTMLSpanElement | null>(null);
  const [kpiValueContainerWidth, setKpiValueContainerWidth] = useState(0);
  const [kpiMeasureTextWidth, setKpiMeasureTextWidth] = useState(0);
  const numericDashboardId = Number(dashboardId);
  const numericWidgetId = Number(widget.id);
  const hasPersistedWidgetId = Number.isFinite(numericWidgetId) && numericWidgetId > 0;
  const kpiTrendEnabled = widget.config.widget_type === "kpi" && widget.config.kpi_show_trend === true;
  const persistedGlobalFilters = useMemo(
    () =>
      (nativeFilters || [])
        .filter((filter) => !!filter.column && !!filter.op)
        .map((filter) => ({ column: filter.column, op: filter.op, value: filter.value })),
    [nativeFilters],
  );
  // In builder mode, try draft preview first; fall back to persisted fetch if spec can't be built
  const draftPreviewPlan = useMemo(
    () => {
      if (disableFetch || (!builderMode && hasPersistedWidgetId) || !datasetId || isTextWidget) return null;
      return buildDraftPreviewSpec({ widget, datasetId, nativeFilters });
    },
    [builderMode, datasetId, disableFetch, hasPersistedWidgetId, isTextWidget, nativeFilters, widget],
  );
  const shouldFetchDraftPreview = !disableFetch && (builderMode || !hasPersistedWidgetId) && !!draftPreviewPlan?.spec;
  // Use persisted fetch when: not in builder mode (normal), OR in builder mode as fallback when draft spec can't be built
  const shouldFetchPersisted = !disableFetch
    && !isTextWidget
    && hasPersistedWidgetId
    && Number.isFinite(numericDashboardId)
    && numericDashboardId > 0
    && (!builderMode || !draftPreviewPlan?.spec);
  const shouldTryLocalComparison = kpiTrendEnabled && !disableFetch && !kpiComparison;
  const persistedPreviousPeriod = useMemo(
    () => (
      shouldTryLocalComparison
        ? buildPreviousPeriodFilters(
            persistedGlobalFilters,
            (filter) => filter.column,
            (filter, value) => ({ ...filter, value }),
          )
        : null
    ),
    [persistedGlobalFilters, shouldTryLocalComparison],
  );
  const draftPreviousPeriodSpec = useMemo(() => {
    if (!shouldTryLocalComparison || !draftPreviewPlan?.spec) return null;
    const previous = buildPreviousPeriodFilters(
      draftPreviewPlan.spec.filters || [],
      (filter) => filter.field,
      (filter, value) => ({ ...filter, value }),
    );
    if (!previous) return null;
    return {
      ...draftPreviewPlan.spec,
      filters: previous.filters,
    } as ApiQuerySpec;
  }, [draftPreviewPlan?.spec, shouldTryLocalComparison]);

  const widgetQuery = useQuery({
    queryKey: ["widget-data", dashboardId, widget.id, JSON.stringify(persistedGlobalFilters)],
    queryFn: async () => {
      if (persistedGlobalFilters.length === 0) {
        return api.getDashboardWidgetData(numericDashboardId, numericWidgetId);
      }
      const response = await api.getDashboardWidgetsData(
        numericDashboardId,
        [numericWidgetId],
        persistedGlobalFilters,
      );
      const item = response.results.find((result) => result.widget_id === numericWidgetId);
      if (!item) throw new Error("Widget data not found");
      return item;
    },
    enabled: shouldFetchPersisted,
  });
  const previousWidgetQuery = useQuery({
    queryKey: [
      "widget-data-previous-period",
      dashboardId,
      widget.id,
      JSON.stringify(persistedPreviousPeriod?.filters || []),
      persistedPreviousPeriod?.window.currentStart || "",
      persistedPreviousPeriod?.window.currentEnd || "",
    ],
    queryFn: async () => {
      const response = await api.getDashboardWidgetsData(
        numericDashboardId,
        [numericWidgetId],
        persistedPreviousPeriod?.filters || [],
      );
      const item = response.results.find((result) => result.widget_id === numericWidgetId);
      if (!item) throw new Error("Widget previous period data not found");
      return item;
    },
    enabled: shouldFetchPersisted && !!persistedPreviousPeriod,
  });
  const draftWidgetQuery = useQuery({
    queryKey: ["widget-draft-data", datasetId, widget.id, JSON.stringify(draftPreviewPlan?.spec || {})],
    queryFn: () => api.previewQuery(draftPreviewPlan?.spec as ApiQuerySpec),
    enabled: shouldFetchDraftPreview,
  });
  const previousDraftWidgetQuery = useQuery({
    queryKey: ["widget-draft-data-previous-period", datasetId, widget.id, JSON.stringify(draftPreviousPeriodSpec || {})],
    queryFn: () => api.previewQuery(draftPreviousPeriodSpec as ApiQuerySpec),
    enabled: shouldFetchDraftPreview && !!draftPreviousPeriodSpec,
  });
  const normalizedDraftRows = useMemo(() => {
    const baseRows = draftWidgetQuery.data?.rows || [];
    return normalizeDraftRowsForWidget(baseRows, draftPreviewPlan);
  }, [draftPreviewPlan, draftWidgetQuery.data]);
  const normalizedPreviousDraftRows = useMemo(() => {
    const baseRows = previousDraftWidgetQuery.data?.rows || [];
    return normalizeDraftRowsForWidget(baseRows, draftPreviewPlan);
  }, [draftPreviewPlan, previousDraftWidgetQuery.data]);
  const localKpiComparison = useMemo<KpiComparisonData | undefined>(() => {
    if (!shouldTryLocalComparison) return undefined;
    if (shouldFetchPersisted) {
      if (!persistedPreviousPeriod || previousWidgetQuery.isLoading || previousWidgetQuery.isError) return undefined;
      return {
        previousData: previousWidgetQuery.data
          ? {
              columns: previousWidgetQuery.data.columns,
              rows: previousWidgetQuery.data.rows,
              row_count: previousWidgetQuery.data.row_count,
            }
          : { columns: [], rows: [], row_count: 0 },
        label: "vs periodo anterior",
      };
    }
    if (shouldFetchDraftPreview) {
      if (!draftPreviousPeriodSpec || previousDraftWidgetQuery.isLoading || previousDraftWidgetQuery.isError) return undefined;
      return {
        previousData: {
          columns: previousDraftWidgetQuery.data?.columns || [],
          rows: normalizedPreviousDraftRows,
          row_count: previousDraftWidgetQuery.data?.row_count || normalizedPreviousDraftRows.length,
        },
        label: "vs periodo anterior",
      };
    }
    return undefined;
  }, [
    draftPreviousPeriodSpec,
    normalizedPreviousDraftRows,
    persistedPreviousPeriod,
    previousDraftWidgetQuery.data,
    previousDraftWidgetQuery.isError,
    previousDraftWidgetQuery.isLoading,
    previousWidgetQuery.data,
    previousWidgetQuery.isError,
    previousWidgetQuery.isLoading,
    shouldFetchDraftPreview,
    shouldFetchPersisted,
    shouldTryLocalComparison,
  ]);
  const effectiveKpiComparison = kpiComparison ?? localKpiComparison;

  const rows = useMemo(() => {
    const baseRows = preloadedData?.rows || widgetQuery.data?.rows || normalizedDraftRows || [];
    return normalizeDraftRowsForWidget(baseRows, draftPreviewPlan);
  }, [draftPreviewPlan, normalizedDraftRows, preloadedData, widgetQuery.data]);
  useEffect(() => {
    if (widget.config.widget_type !== "kpi") return;
    const containerEl = kpiValueContainerRef.current;
    const measureEl = kpiMeasureRef.current;
    if (!containerEl || !measureEl) return;
    const recalculate = () => {
      // Measure against real available line width, not content width.
      setKpiValueContainerWidth(Math.max(0, containerEl.clientWidth - 4));
      setKpiMeasureTextWidth(measureEl.scrollWidth);
    };
    recalculate();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => recalculate());
    observer.observe(containerEl);
    observer.observe(measureEl);
    return () => observer.disconnect();
  }, [widget.config, widget.id, rows]);
  const metricLabel = useMemo(() => getMetricLabel(widget), [widget]);
  const fallbackChartHeight = heightMultiplier === 0.5 ? 110 : heightMultiplier === 2 ? 320 : 190;
  const gridItemPixelHeight = typeof layoutRows === "number"
    ? ((layoutRows * 36) + (Math.max(1, layoutRows) - 1) * 16)
    : null;
  const estimatedHeaderHeight = widget.config.show_title === false ? 0 : 52;
  const verticalPaddingByDensity: Record<NonNullable<DashboardWidget["config"]["visual_padding"]>, number> = {
    compact: 16,
    normal: 24,
    comfortable: 32,
  };
  const estimatedInnerHeightFromRows = gridItemPixelHeight === null
    ? null
    : Math.max(
      84,
      Math.floor(
        gridItemPixelHeight
        - estimatedHeaderHeight
        - (verticalPaddingByDensity[widget.config.visual_padding || "normal"] ?? 24)
        - 10,
      ),
    );
  const minReadableHeightByType: Record<DashboardWidget["config"]["widget_type"], number> = {
    kpi: 96,
    line: 170,
    bar: 190,
    column: 170,
    donut: 170,
    table: 180,
    text: 110,
    dre: 240,
  };
  const chartHeight = estimatedInnerHeightFromRows ?? Math.max(
    minReadableHeightByType[widget.config.widget_type] || 170,
    fallbackChartHeight,
  );
  const lineTargetTicks = Math.max(4, Math.round(chartHeight / 34));
  const chartPalette = paletteByName[widget.config.visual_palette || "default"] || paletteByName.default;
  const lineMetricKeys = widget.config.widget_type === "line"
    ? widget.config.metrics.map((_, index) => `m${index}`)
    : [];
  const lineMetricBaseLabelByKey = widget.config.widget_type === "line"
    ? Object.fromEntries(
      widget.config.metrics.map((metric, index) => {
        if (metric.alias && metric.alias.trim()) {
          return [`m${index}`, metric.alias.trim()];
        }
        if (metric.op === "count") {
          return [`m${index}`, metric.column ? `CONTAGEM(${metric.column})` : "CONTAGEM(*)"];
        }
        if (metric.op === "distinct_count") {
          return [`m${index}`, `CONTAGEM ÚNICA(${metric.column || "*"})`];
        }
        return [`m${index}`, `${aggLabelMap[metric.op]}(${metric.column || "*"})`];
      }),
    )
    : {};
  const lineMetricAxisByKey = widget.config.widget_type === "line"
    ? Object.fromEntries(
      widget.config.metrics.map((item, index) => [`m${index}`, item.line_y_axis === "right" ? "right" : index === 0 ? "left" : "right"]),
    )
    : {};
  const lineMetricStyleByKey = widget.config.widget_type === "line"
    ? Object.fromEntries(
      widget.config.metrics.map((item, index) => [`m${index}`, item.line_style || "solid"]),
    )
    : {};
  const lineMetricPrefixByKey = widget.config.widget_type === "line"
    ? Object.fromEntries(
      widget.config.metrics.map((item, index) => [`m${index}`, item.prefix || ""]),
    )
    : {};
  const lineMetricSuffixByKey = widget.config.widget_type === "line"
    ? Object.fromEntries(
      widget.config.metrics.map((item, index) => [`m${index}`, item.suffix || ""]),
    )
    : {};
  const lineLegendDimension = widget.config.widget_type === "line" ? widget.config.dimensions[0] : undefined;
  const { lineRows, lineSeriesDefs } = useMemo(() => {
    if (widget.config.widget_type !== "line") {
      return {
        lineRows: [] as Record<string, unknown>[],
        lineSeriesDefs: [] as Array<{ key: string; label: string; axis: "left" | "right" }>,
      };
    }

    const sortByTimeBucket = (left: Record<string, unknown>, right: Record<string, unknown>) => {
      const leftDate = parseDateLike(left.time_bucket);
      const rightDate = parseDateLike(right.time_bucket);
      if (leftDate && rightDate) return leftDate.getTime() - rightDate.getTime();
      return String(left.time_bucket).localeCompare(String(right.time_bucket), "pt-BR");
    };

    const normalized = rows.map((row) => {
      const next = { ...row };
      lineMetricKeys.forEach((metricKey) => {
        next[metricKey] = toFiniteNumber(next[metricKey]);
      });
      return next;
    });

    if (!lineLegendDimension) {
      const seriesDefs = lineMetricKeys.map((metricKey) => ({
        key: metricKey,
        label: lineMetricBaseLabelByKey[metricKey] || metricKey,
        axis: (lineMetricAxisByKey[metricKey] || "left") as "left" | "right",
      }));
      return {
        lineRows: normalized.sort(sortByTimeBucket),
        lineSeriesDefs: seriesDefs,
      };
    }

    const seriesDefs: Array<{ key: string; label: string; axis: "left" | "right" }> = [];
    const seriesSet = new Set<string>();
    const pivotByBucket = new Map<string, Record<string, unknown>>();

    normalized.forEach((row) => {
      const timeBucket = row.time_bucket;
      const parsedDate = parseDateLike(timeBucket);
      const bucketKey = parsedDate ? `ts:${parsedDate.getTime()}` : `raw:${String(timeBucket)}`;
      const legendRaw = row[lineLegendDimension];
      const legendLabel = legendRaw === null || legendRaw === undefined || String(legendRaw).trim() === ""
        ? "(vazio)"
        : String(legendRaw);
      const pivot = pivotByBucket.get(bucketKey) || { time_bucket: timeBucket };
      lineMetricKeys.forEach((metricKey) => {
        const seriesKey = `${metricKey}__${legendLabel}`;
        pivot[seriesKey] = toFiniteNumber(row[metricKey]);
        if (!seriesSet.has(seriesKey)) {
          seriesSet.add(seriesKey);
          const metricLabel = lineMetricBaseLabelByKey[metricKey] || metricKey;
          const hasMultipleMetrics = lineMetricKeys.length > 1;
          seriesDefs.push({
            key: seriesKey,
            label: hasMultipleMetrics ? `${legendLabel} - ${metricLabel}` : legendLabel,
            axis: (lineMetricAxisByKey[metricKey] || "left") as "left" | "right",
          });
        }
      });
      pivotByBucket.set(bucketKey, pivot);
    });

    return {
      lineRows: Array.from(pivotByBucket.values()).sort(sortByTimeBucket),
      lineSeriesDefs: seriesDefs,
    };
  }, [lineLegendDimension, lineMetricAxisByKey, lineMetricBaseLabelByKey, lineMetricKeys, rows, widget.config.widget_type]);
  const lineSeriesLabelByKey = useMemo(
    () => Object.fromEntries(lineSeriesDefs.map((series) => [series.key, series.label])),
    [lineSeriesDefs],
  );
  const lineSeriesAxisByKey = useMemo(
    () => Object.fromEntries(lineSeriesDefs.map((series) => [series.key, series.axis])),
    [lineSeriesDefs],
  );
  const usesRightAxis = lineSeriesDefs.some((series) => series.axis === "right");
  const usesLeftAxis = lineSeriesDefs.some((series) => series.axis === "left");
  const lineSeriesValuesByKey = useMemo(() => {
    const values: Record<string, number[]> = {};
    lineSeriesDefs.forEach(({ key: seriesKey }) => {
      values[seriesKey] = lineRows.map((row) => toFiniteNumber(row[seriesKey]));
    });
    return values;
  }, [lineRows, lineSeriesDefs]);
  const lineLabelEventsBySeries = useMemo(() => {
    const map: Record<string, Set<number>> = {};
    if (widget.config.widget_type !== "line") return map;
    const sensitivity = widget.config.line_data_labels_percent || 60;
    const windowSize = widget.config.line_label_window || 3;
    const minGap = widget.config.line_label_min_gap || 2;
    const mode = widget.config.line_label_mode || "both";
    lineSeriesDefs.forEach(({ key: seriesKey }) => {
      map[seriesKey] = computePeakValleyEvents({
        series: lineSeriesValuesByKey[seriesKey] || [],
        sensitivityPercent: sensitivity,
        windowSize,
        minGap,
        mode,
      });
    });
    return map;
  }, [lineSeriesDefs, lineSeriesValuesByKey, widget.config]);
  const lineTickInterval = lineRows.length > lineTargetTicks ? Math.ceil(lineRows.length / lineTargetTicks) - 1 : 0;
  const lineGranularity = widget.config.time?.granularity || "day";
  const lineParsedBuckets = useMemo(
    () => lineRows.map((row) => parseDateLike(row.time_bucket)).filter((item): item is Date => item instanceof Date),
    [lineRows],
  );
  const lineXAxisTimeMode = useMemo<"default" | "hour" | "minute">(() => {
    if (lineParsedBuckets.length === 0) return "default";
    const [first] = lineParsedBuckets;
    const sameDate = lineParsedBuckets.every((item) =>
      item.getFullYear() === first.getFullYear()
      && item.getMonth() === first.getMonth()
      && item.getDate() === first.getDate(),
    );
    if (!sameDate) return "default";
    const sameHour = lineParsedBuckets.every((item) =>
      item.getHours() === first.getHours(),
    );
    return sameHour ? "minute" : "hour";
  }, [lineParsedBuckets]);
  const formatLineAxisBucketLabel = (value: unknown): string => {
    const parsed = parseDateLike(value);
    if (!parsed) return String(value);
    if (lineXAxisTimeMode === "minute") {
      return new Intl.DateTimeFormat("pt-BR", { minute: "2-digit" }).format(parsed);
    }
    if (lineXAxisTimeMode === "hour") {
      return new Intl.DateTimeFormat("pt-BR", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      }).format(parsed);
    }
    if (lineGranularity === "timestamp") return formatDateBR(parsed, true, true);
    if (lineGranularity === "hour") return formatDateBR(parsed, true, false);
    return formatDateBR(parsed, false);
  };
  const formatLineTooltipLabel = (value: unknown): string => {
    const parsed = parseDateLike(value);
    if (!parsed) return String(value);
    return formatDateBR(parsed, true, lineGranularity === "timestamp");
  };
  const metricPrefixByKey = Object.fromEntries(
    (widget.config.metrics || []).map((item, index) => [`m${index}`, item.prefix || ""]),
  ) as Record<string, string>;
  const metricSuffixByKey = Object.fromEntries(
    (widget.config.metrics || []).map((item, index) => [`m${index}`, item.suffix || ""]),
  ) as Record<string, string>;
  const resolveBaseMetricKey = (seriesKey: string): string => (seriesKey.includes("__") ? seriesKey.split("__")[0] : seriesKey);
  const chartPrefix = widget.config.widget_type === "line"
    ? (widget.config.metrics[0]?.prefix || widget.config.kpi_prefix || "")
    : (widget.config.metrics[0]?.prefix || widget.config.kpi_prefix || "");
  const chartSuffix = widget.config.widget_type === "line"
    ? (widget.config.metrics[0]?.suffix || widget.config.kpi_suffix || "")
    : (widget.config.metrics[0]?.suffix || widget.config.kpi_suffix || "");
  const showPercentOfTotal = !!widget.config.bar_show_percent_of_total;
  const formatChartValueCompact = (value: unknown): string => `${chartPrefix}${formatCompactNumber(value)}${chartSuffix}`;
  const formatChartValueFull = (value: unknown): string => `${chartPrefix}${formatFullNumber(value)}${chartSuffix}`;
  const formatMetricValueCompact = (seriesKey: string, value: unknown): string => {
    const baseMetricKey = resolveBaseMetricKey(seriesKey);
    const prefix = metricPrefixByKey[baseMetricKey] ?? chartPrefix;
    const suffix = metricSuffixByKey[baseMetricKey] ?? chartSuffix;
    return `${prefix}${formatCompactNumber(value)}${suffix}`;
  };
  const formatMetricValueFull = (seriesKey: string, value: unknown): string => {
    const baseMetricKey = resolveBaseMetricKey(seriesKey);
    const prefix = metricPrefixByKey[baseMetricKey] ?? chartPrefix;
    const suffix = metricSuffixByKey[baseMetricKey] ?? chartSuffix;
    return `${prefix}${formatFullNumber(value)}${suffix}`;
  };
  const formatLineSeriesValueCompact = (seriesKey: string, value: unknown): string => {
    const baseMetricKey = resolveBaseMetricKey(seriesKey);
    const prefix = lineMetricPrefixByKey[baseMetricKey] || "";
    const suffix = lineMetricSuffixByKey[baseMetricKey] || "";
    return `${prefix}${formatCompactNumber(value)}${suffix}`;
  };
  const formatLineSeriesValueFull = (seriesKey: string, value: unknown): string => {
    const baseMetricKey = resolveBaseMetricKey(seriesKey);
    const prefix = lineMetricPrefixByKey[baseMetricKey] || "";
    const suffix = lineMetricSuffixByKey[baseMetricKey] || "";
    return `${prefix}${formatFullNumber(value)}${suffix}`;
  };

  if (forcedLoading) {
    return <WidgetLoadingSkeleton type={widget.config.widget_type} chartHeight={chartHeight} />;
  }

  if (isTextWidget) {
    const textStyle = widget.config.text_style || { content: "", font_size: 18, align: "left" as const };
    const alignClass = {
      left: "text-left",
      center: "text-center",
      right: "text-right",
    }[textStyle.align];
    return (
      <div className={`flex h-full w-full items-center ${alignClass}`}>
        <p className="w-full break-words leading-snug text-foreground" style={{ fontSize: `${textStyle.font_size}px` }}>
          {textStyle.content || "Texto"}
        </p>
      </div>
    );
  }

  if (disableFetch && preloadedLoading) {
    return <EmptyWidgetState text="Carregando dados..." />;
  }
  if (disableFetch && preloadedError) {
    return <EmptyWidgetState text={preloadedError} />;
  }
  // Draft preview path (builder mode for all widgets, or non-persisted widgets in any mode)
  // "Configure" message only for new (non-persisted) widgets with incomplete config
  if (!disableFetch && !hasPersistedWidgetId && !shouldFetchDraftPreview) {
    if (widget.config.widget_type === "kpi" && widget.config.kpi_type === "derived") {
      return <EmptyWidgetState text="Preview da KPI por formula aparece apos salvar o dashboard." />;
    }
    return <EmptyWidgetState text="Configure o widget para visualizar o preview." />;
  }
  if (shouldFetchDraftPreview && draftWidgetQuery.isLoading) {
    return <EmptyWidgetState text="Carregando dados..." />;
  }
  if (shouldFetchDraftPreview && draftWidgetQuery.isError) {
    return <EmptyWidgetState text={(draftWidgetQuery.error as Error).message || "Falha ao carregar dados"} />;
  }
  if (shouldFetchPersisted && widgetQuery.isLoading) {
    return <EmptyWidgetState text="Carregando dados..." />;
  }
  if (shouldFetchPersisted && widgetQuery.isError) {
    return <EmptyWidgetState text={(widgetQuery.error as Error).message || "Falha ao carregar dados"} />;
  }
  if (rows.length === 0) {
    return <EmptyWidgetState text="Nenhum dado retornado" />;
  }

  const type = widget.config.widget_type;

  if (type === "table") {
    return <MiniTable rows={rows} widget={widget} hideExport={hideTableExport} />;
  }

  if (type === "dre") {
    const dreRowsCfg = widget.config.dre_rows || [];
    const firstRow = rows[0] || {};
    const renderedRows = dreRowsCfg.map((item, index) => {
      const raw = toFiniteNumber(firstRow[`m${index}`]);
      let impact: "add" | "subtract" = "add";
      if (item.row_type === "deduction") {
        impact = item.impact || "subtract";
      } else if (item.row_type === "detail") {
        for (let previous = index - 1; previous >= 0; previous -= 1) {
          if (dreRowsCfg[previous]?.row_type === "deduction") {
            impact = dreRowsCfg[previous]?.impact || "subtract";
            break;
          }
        }
      }
      const effective = impact === "subtract" ? -raw : raw;
      return {
        ...item,
        impact,
        raw,
        effective,
      };
    });
    const configuredBaseIndex = widget.config.dre_percent_base_row_index;
    const configuredBaseRow = typeof configuredBaseIndex === "number"
      ? renderedRows[configuredBaseIndex]
      : undefined;
    const baseRow = configuredBaseRow?.row_type === "result"
      ? configuredBaseRow
      : renderedRows.find((row) => row.row_type === "result");
    const fallbackTotal = renderedRows
      .filter((row) => row.row_type === "result")
      .reduce((sum, row) => sum + Math.abs(row.effective), 0);
    const totalBase = Math.abs(baseRow?.effective || 0) || fallbackTotal || 1;
    const percentColumnLabel = `% do ${(baseRow?.title || "total").replace(/"/g, "'")}`;

    return (
      <div className="h-full w-full overflow-auto rounded-lg border border-border">
        <table className="w-full text-xs">
          <thead className="sticky top-0 z-10 bg-muted/50 backdrop-blur-sm">
            <tr className="border-b border-border">
              <th className="px-3 py-2 text-left font-semibold text-muted-foreground">Conta</th>
              <th className="px-3 py-2 text-right font-semibold text-muted-foreground">Valor (R$)</th>
              <th className="px-3 py-2 text-right font-semibold text-muted-foreground">{percentColumnLabel}</th>
            </tr>
          </thead>
          <tbody>
            {renderedRows.map((row, index) => {
              const isResult = row.row_type === "result";
              const isSubtract = row.impact === "subtract";
              const isDetail = row.row_type === "detail";
              const rowTextColorClass = isDetail ? "text-muted-foreground" : "text-foreground";
              const rowWeightClass = isResult ? "font-semibold" : "";
              const normalizedTitle = row.title.replace(/^\((?:-|\+)\)\s*/i, "");
              const accountLabel = row.row_type === "deduction"
                ? (isSubtract ? `(-) ${normalizedTitle}` : `(+) ${normalizedTitle}`)
                : row.title;
              const valueText = isDetail
                ? formatCurrencyBRL(Math.abs(row.effective))
                : isSubtract
                ? `(${formatCurrencyBRL(Math.abs(row.effective))})`
                : formatCurrencyBRL(row.effective);
              const detailPercentText = formatPercentOfTotal(Math.abs(row.effective), totalBase);
              const percentText = isDetail
                ? detailPercentText
                : formatPercentOfTotal(row.effective, totalBase);
              const valueColorClass = isDetail ? rowTextColorClass : (isSubtract ? "text-rose-500" : rowTextColorClass);
              const percentColorClass = isDetail ? rowTextColorClass : (isSubtract ? "text-rose-500" : rowTextColorClass);
              return (
                <tr key={`dre-${index}`} className="border-b border-border/60 last:border-b-0 transition-colors hover:bg-muted/30">
                  <td
                    className={`px-3 py-2 text-left ${rowWeightClass} ${isDetail ? "pl-7" : ""} ${rowTextColorClass}`}
                  >
                    {accountLabel}
                  </td>
                  <td className={`px-3 py-2 text-right tabular-nums ${rowWeightClass} ${valueColorClass}`}>
                    {valueText}
                  </td>
                  <td className={`px-3 py-2 text-right tabular-nums ${rowWeightClass} ${percentColorClass}`}>
                    {percentText}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    );
  }

  if (type === "kpi") {
    const metricKey = resolvePrimaryMetricKey(widget, rows);
    const value = (() => {
      if (widget.config.composite_metric && shouldFetchDraftPreview) {
        const outerAgg = widget.config.composite_metric.outer_agg || "avg";
        const values = rows.map((row) => toFiniteNumber(row[metricKey]));
        if (values.length === 0) return 0;
        if (outerAgg === "sum") return values.reduce((acc, item) => acc + item, 0);
        if (outerAgg === "max") return Math.max(...values);
        if (outerAgg === "min") return Math.min(...values);
        if (outerAgg === "count") return values.length;
        if (outerAgg === "distinct_count") return new Set(values.map((item) => String(item))).size;
        return values.reduce((acc, item) => acc + item, 0) / Math.max(1, values.length);
      }
      return toFiniteNumber(rows[0]?.[metricKey]);
    })();
    const hasComparison = !!effectiveKpiComparison;
    const previousRows = effectiveKpiComparison?.previousData?.rows || [];
    const previousMetricKey = previousRows.length > 0 ? resolvePrimaryMetricKey(widget, previousRows) : metricKey;
    const previousValue = hasComparison ? toFiniteNumber(previousRows[0]?.[previousMetricKey]) : null;
    const deltaAbsolute = hasComparison && previousValue !== null ? value - previousValue : null;
    const deltaPercent = previousValue !== null && previousValue !== 0 && deltaAbsolute !== null
      ? deltaAbsolute / previousValue
      : null;
    const deltaPercentText = deltaPercent === null
      ? null
      : `${deltaPercent > 0 ? "+" : ""}${new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(deltaPercent * 100)}%`;
    const trendLabel = effectiveKpiComparison?.label || "vs periodo anterior";
    const trendColorClass = deltaPercent === null
      ? "text-muted-foreground"
      : deltaPercent > 0
        ? "text-emerald-500"
        : deltaPercent < 0
          ? "text-rose-500"
          : "text-muted-foreground";
    const showAs = widget.config.kpi_show_as || "number_2";
    const abbreviationMode = widget.config.kpi_abbreviation_mode || "always";
    const decimals = widget.config.kpi_decimals ?? 2;
    const prefix = widget.config.kpi_prefix;
    const suffix = widget.config.kpi_suffix;
    const width = widget.config.size?.width || 1;
    const height = typeof layoutRows === "number"
      ? (layoutRows <= 2 ? 0.5 : layoutRows >= 8 ? 2 : 1)
      : (widget.config.size?.height || 1);
    const kpiSizeClass = width >= 3 || height >= 2
      ? "text-4xl"
      : width >= 2
        ? "text-3xl"
        : height <= 0.5
          ? "text-xl"
          : "text-2xl";
    const fullKpiValue = formatKpiValueFull(value, showAs, decimals, prefix, suffix);
    const compactKpiValue = formatKpiValueCompact(value, showAs, decimals, prefix, suffix);
    const shouldUseCompactInAuto = kpiValueContainerWidth <= 0 || kpiMeasureTextWidth <= 0
      ? true
      : kpiMeasureTextWidth > kpiValueContainerWidth;
    const shouldUseCompactValue = abbreviationMode === "always"
      || (abbreviationMode === "auto" && shouldUseCompactInAuto);
    return (
      <div className="flex h-full w-full items-center justify-center">
        <div className="flex h-full w-full max-w-full flex-col items-center justify-center gap-2 text-center">
          <span className="max-w-full truncate text-[11px] font-medium uppercase tracking-wider text-muted-foreground" title={widget.title || "KPI"}>
            {widget.title || "KPI"}
          </span>
          <div ref={kpiValueContainerRef} className="relative w-full max-w-full text-center">
            <span className={`${kpiSizeClass} min-h-[1.25rem] whitespace-nowrap font-extrabold leading-tight tracking-tight text-foreground`} title={fullKpiValue}>
              {shouldUseCompactValue ? compactKpiValue : fullKpiValue}
            </span>
            <span ref={kpiMeasureRef} className={`${kpiSizeClass} pointer-events-none invisible absolute left-0 top-0 whitespace-nowrap font-extrabold leading-tight tracking-tight`}>
              {fullKpiValue}
            </span>
          </div>
          {hasComparison && (
            <div className={`flex items-center justify-center gap-1 text-[12px] font-semibold ${trendColorClass}`}>
              {deltaPercent === null ? (
                <span className="font-medium text-muted-foreground">Sem base de comparacao</span>
              ) : (
                <>
                  {deltaPercent > 0 && <TrendingUp className="h-3.5 w-3.5 shrink-0" />}
                  {deltaPercent < 0 && <TrendingDown className="h-3.5 w-3.5 shrink-0" />}
                  <span className="tabular-nums">{deltaPercentText}</span>
                  <span className="font-medium text-muted-foreground">{trendLabel}</span>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    );
  }

  if (type === "line") {
    const showLineLabels = !!widget.config.line_data_labels_enabled;
    const showLineGrid = !!widget.config.line_show_grid;
    const lineSeriesKeys = lineSeriesDefs.length > 0 ? lineSeriesDefs.map((series) => series.key) : ["m0"];
    return (
      <div className="relative h-full w-full">
        <ResponsiveContainer width="100%" height={chartHeight}>
          <ReLineChart data={lineRows} margin={{ top: 8, right: 8, bottom: 8, left: 8 }}>
            {showLineGrid && <CartesianGrid strokeDasharray="3 3" stroke="hsl(214, 20%, 88%)" vertical={false} />}
            <XAxis
              dataKey="time_bucket"
              tick={{ fontSize: 10 }}
              axisLine={false}
              tickLine={false}
              interval={lineTickInterval}
              minTickGap={20}
              tickFormatter={(value) => {
                return formatLineAxisBucketLabel(value);
              }}
            />
            <YAxis
              yAxisId="left"
              tick={{ fontSize: 10 }}
              axisLine={false}
              tickLine={false}
              width={50}
              hide={!usesLeftAxis}
              tickFormatter={(value) => formatChartValueCompact(value)}
            />
            <YAxis
              yAxisId="right"
              orientation="right"
              tick={{ fontSize: 10 }}
              axisLine={false}
              tickLine={false}
              width={50}
              hide={!usesRightAxis}
              tickFormatter={(value) => formatChartValueCompact(value)}
            />
            <Tooltip
              content={(props) => {
                const payload = (props.payload || []) as Array<{ value?: unknown; name?: unknown; color?: string; dataKey?: unknown }>;
                const points = payload.filter((item) => item && item.value !== undefined && item.value !== null);
                if (!props.active || points.length === 0) return null;
                return (
                  <div
                    className="min-w-[160px] rounded-xl border border-border/60 bg-[hsl(var(--card)/0.72)] px-3 py-2 shadow-xl backdrop-blur-md"
                    style={{ boxShadow: "0 14px 30px -16px rgba(2,6,23,0.65)" }}
                  >
                    <p className="text-[11px] font-semibold text-foreground/95">{formatLineTooltipLabel(props.label)}</p>
                    <div className="mt-1 space-y-1">
                      {points.map((item, index) => {
                        const seriesKey = String(item.dataKey || item.name || "");
                        const seriesLabel = lineSeriesLabelByKey[seriesKey] || String(item.name || seriesKey);
                        return (
                          <div key={`${seriesKey}-${index}`} className="flex items-center justify-between gap-3 text-[11px]">
                            <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                              <span className="h-2 w-2 rounded-full" style={{ backgroundColor: item.color || chartPalette[index % chartPalette.length] }} />
                              {seriesLabel}
                            </span>
                            <span className="font-semibold tabular-nums text-foreground">{formatLineSeriesValueFull(seriesKey, item.value)}</span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              }}
            />
            {lineSeriesKeys.length > 1 && <Legend wrapperStyle={{ fontSize: 10 }} />}
            {lineSeriesKeys.map((seriesKey, index) => (
              (() => {
                const baseMetricKey = seriesKey.includes("__") ? seriesKey.split("__")[0] : seriesKey;
                const lineStyle = (lineMetricStyleByKey[baseMetricKey] || "solid") as "solid" | "dashed" | "dotted";
                const strokeDasharray = lineStyle === "dashed" ? "8 5" : (lineStyle === "dotted" ? "2 6" : undefined);
                return (
                  <Line
                    key={seriesKey}
                    type="monotone"
                    dataKey={seriesKey}
                    name={lineSeriesLabelByKey[seriesKey] || seriesKey}
                    yAxisId={lineSeriesAxisByKey[seriesKey] || "left"}
                    stroke={chartPalette[index % chartPalette.length]}
                    strokeWidth={2}
                    strokeDasharray={strokeDasharray}
                    dot={false}
                  >
                    {showLineLabels && (
                      <LabelList
                        dataKey={seriesKey}
                        content={(props: Record<string, unknown>) => {
                          const value = props.value;
                          const x = Number(props.x || 0);
                          const y = Number(props.y || 0);
                          const indexValue = Number(props.index || 0);
                          const viewBox = props.viewBox as { y?: number; height?: number } | undefined;
                          if (value === undefined || value === null) return null;
                          if (!(lineLabelEventsBySeries[seriesKey]?.has(indexValue))) return null;
                          const axis = lineSeriesAxisByKey[seriesKey] || "left";
                          const yOffset = axis === "left" ? -12 : 12;
                          const baseY = y + yOffset;
                          const plotTop = Number(viewBox?.y ?? 0);
                          const plotBottom = plotTop + Number(viewBox?.height ?? chartHeight);
                          const safeY = clamp(baseY, plotTop + 10, plotBottom - 10);
                          return renderGlassLabel({ x, y: safeY, text: formatLineSeriesValueCompact(seriesKey, value), fontSize: 10 });
                        }}
                      />
                    )}
                  </Line>
                );
              })()
            ))}
          </ReLineChart>
        </ResponsiveContainer>
      </div>
    );
  }

  const dim = widget.config.dimensions[0];
  const dimKey = dim || "__dim";
  const parsedTemporalCategoryDimension = dim ? parseTemporalDimensionToken(dim) : null;
  const categoryTemporalGranularity = parsedTemporalCategoryDimension?.granularity;
  const metricKey = resolvePrimaryMetricKey(widget, rows);
  const configuredMetricKeys = (widget.config.metrics || []).map((_, index) => `m${index}`);
  const chartMetricKeys = (configuredMetricKeys.length > 0 ? configuredMetricKeys : [metricKey]).filter((key, index, arr) => arr.indexOf(key) === index);
  const chartMetricLabelByKey = Object.fromEntries(
    chartMetricKeys.map((key, index) => {
      const metricConfig = widget.config.metrics[index];
      if (!metricConfig) return [key, key];
      if (metricConfig.alias && metricConfig.alias.trim()) return [key, metricConfig.alias.trim()];
      if (metricConfig.op === "count") return [key, metricConfig.column ? `CONTAGEM(${metricConfig.column})` : "CONTAGEM(*)"];
      if (metricConfig.op === "distinct_count") return [key, `CONTAGEM ÚNICA(${metricConfig.column || "*"})`];
      return [key, `${aggLabelMap[metricConfig.op]}(${metricConfig.column || "*"})`];
    }),
  );
  const chartRows = rows.map((row) => {
    const next = { ...row };
    chartMetricKeys.forEach((key) => {
      next[key] = toFiniteNumber(next[key]);
    });
    return next;
  });
  const formatCategoricalBucketLabel = (value: unknown): string => {
    if (categoryTemporalGranularity) {
      return formatTemporalBucket(value, categoryTemporalGranularity);
    }
    const parsed = parseDateLike(value);
    return parsed ? formatDateBR(parsed) : String(value ?? "");
  };

  if (type === "bar") {
    const showBarLabels = widget.config.bar_data_labels_enabled !== false;
    const showBarGrid = !!widget.config.bar_show_grid;
    const barGap = 8;
    const primaryMetricKey = chartMetricKeys[0] || metricKey;
    const overlayMetricKeys: string[] = [];
    const hasOverlayMetrics = false;
    const barRows = [...chartRows].sort((left, right) => {
      const metricDiff = toFiniteNumber(right[primaryMetricKey]) - toFiniteNumber(left[primaryMetricKey]);
      if (metricDiff !== 0) return metricDiff;
      return String(left[dimKey] ?? "").localeCompare(String(right[dimKey] ?? ""), "pt-BR");
    });
    const barTotal = barRows.reduce((sum, row) => sum + toFiniteNumber(row[primaryMetricKey]), 0);
    const formatBarMetricLabel = (value: unknown, compact = true): string => {
      const numericValue = toFiniteNumber(value);
      const absolute = compact ? formatChartValueCompact(numericValue) : formatChartValueFull(numericValue);
      if (!showPercentOfTotal) return absolute;
      return `${absolute} (${formatPercentOfTotal(numericValue, barTotal)})`;
    };
    const barDataMax = barRows.reduce((maxValue, row) => Math.max(maxValue, toFiniteNumber(row[primaryMetricKey])), 0);
    const barAxisMax = computeNiceAxisMax(barDataMax, 4);
    const overlayDataMax = overlayMetricKeys.reduce((maxValue, key) => (
      Math.max(maxValue, barRows.reduce((innerMax, row) => Math.max(innerMax, toFiniteNumber(row[key])), 0))
    ), 0);
    const overlayAxisMax = computeNiceAxisMax(overlayDataMax, 4);
    const barRightMargin = showBarLabels
      ? (showPercentOfTotal ? 76 : 56)
      : 28;
    const axisFooterHeight = 26;
    const plotViewportHeight = Math.max(96, chartHeight - axisFooterHeight);
    const barsCount = Math.max(1, barRows.length);
    const adaptiveBarHeight = clamp(
      Math.floor((plotViewportHeight - 20 - ((barsCount - 1) * barGap)) / barsCount),
      16,
      42,
    );
    const barChartHeight = Math.max(plotViewportHeight, barsCount * (adaptiveBarHeight + barGap) + 16);
    return (
      <div className="relative flex h-full w-full flex-col">
        <div
          className="w-full overflow-y-auto pr-1"
          style={{
            height: hasOverlayMetrics ? "100%" : `calc(100% - ${axisFooterHeight}px)`,
          }}
        >
          <div style={{ minHeight: "100%", height: `${barChartHeight}px` }}>
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={barRows} margin={{ top: 8, right: barRightMargin, bottom: 6, left: 4 }} layout="vertical" barCategoryGap={barGap}>
                {showBarGrid && <CartesianGrid strokeDasharray="3 3" stroke="hsl(214, 20%, 88%)" horizontal={false} />}
                <XAxis
                  xAxisId="left"
                  type="number"
                  hide
                  domain={[0, barAxisMax]}
                  allowDataOverflow={false}
                  tickFormatter={(value) => formatChartValueCompact(value)}
                />
                {hasOverlayMetrics && (
                  <XAxis
                    xAxisId="right"
                    type="number"
                    hide
                    orientation="top"
                    domain={[0, overlayAxisMax]}
                    allowDataOverflow={false}
                    tickFormatter={(value) => formatChartValueCompact(value)}
                  />
                )}
                <YAxis
                  type="category"
                  dataKey={dimKey}
                  interval={0}
                  tick={(props: { x?: number; y?: number; payload?: { value?: unknown } }) => {
                    const x = Number(props.x || 0);
                    const y = Number(props.y || 0);
                    const { lines, full } = splitLabelIntoTwoLines(formatCategoricalBucketLabel(props.payload?.value), 18);
                    const startY = lines.length > 1 ? -5 : 4;
                    return (
                      <g transform={`translate(${x},${y})`}>
                        <title>{full}</title>
                        <text
                          x={0}
                          y={0}
                          dy={startY}
                          textAnchor="end"
                          fill="hsl(var(--muted-foreground))"
                          fontSize={11}
                        >
                          {lines.map((line, index) => (
                            <tspan key={`${line}-${index}`} x={0} dy={index === 0 ? 0 : 12}>{line}</tspan>
                          ))}
                        </text>
                      </g>
                    );
                  }}
                  axisLine={false}
                  tickLine={false}
                  width={118}
                />
                <Tooltip
                  cursor={{ fill: "hsl(var(--muted)/0.28)" }}
                  content={(props) => {
                    const payload = (props.payload || []) as Array<{ value?: unknown; name?: string; color?: string; dataKey?: string }>;
                    if (!props.active || payload.length === 0) return null;
                    if (!hasOverlayMetrics) {
                      return (
                        <GlassTooltip
                          active={props.active}
                          payload={props.payload as Array<{ value?: unknown }> | undefined}
                          label={props.label}
                          categoryLabel={formatCategoricalBucketLabel}
                          metricLabel={metricLabel}
                          valueLabel={(value) => formatBarMetricLabel(value, false)}
                        />
                      );
                    }
                    return (
                      <div
                        className="min-w-[170px] rounded-xl border border-border/60 bg-[hsl(var(--card)/0.72)] px-3 py-2 shadow-xl backdrop-blur-md"
                        style={{ boxShadow: "0 14px 30px -16px rgba(2,6,23,0.65)" }}
                      >
                        <p className="text-[11px] font-semibold text-foreground/95">{formatCategoricalBucketLabel(props.label)}</p>
                        <div className="mt-1 space-y-1 text-[11px]">
                          {payload.map((entry) => {
                            const key = String(entry.dataKey || "");
                            const isPrimary = key === primaryMetricKey;
                            const formatted = isPrimary
                              ? formatBarMetricLabel(entry.value, false)
                              : formatChartValueFull(entry.value);
                            return (
                              <div key={`${key}-${entry.name}`} className="flex items-center justify-between gap-3">
                                <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                                  <span className="h-2 w-2 rounded-full" style={{ backgroundColor: entry.color || "hsl(var(--chart-1))" }} />
                                  {entry.name || chartMetricLabelByKey[key] || key}
                                </span>
                                <span className="font-semibold tabular-nums text-foreground">{formatted}</span>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    );
                  }}
                />
                <Bar
                  dataKey={primaryMetricKey}
                  name={chartMetricLabelByKey[primaryMetricKey] || metricLabel}
                  xAxisId="left"
                  fill={chartPalette[0]}
                  radius={[4, 4, 0, 0]}
                  barSize={adaptiveBarHeight}
                >
                  {showBarLabels && (
                    <LabelList
                      dataKey={primaryMetricKey}
                      content={(props: Record<string, unknown>) => {
                        const value = props.value;
                        const x = Number(props.x || 0);
                        const y = Number(props.y || 0);
                        const width = Number(props.width || 0);
                        const height = Number(props.height || 0);
                        if (value === undefined || value === null) return null;
                        const labelX = x + width + 12;
                        const labelY = y + (height / 2);
                        return renderGlassLabel({ x: labelX, y: labelY, text: formatBarMetricLabel(value, true), fontSize: 9 });
                      }}
                    />
                  )}
                </Bar>
                {overlayMetricKeys.map((lineKey, index) => (
                  <Line
                    key={`bar-overlay-${lineKey}`}
                    type="monotone"
                    dataKey={lineKey}
                    name={chartMetricLabelByKey[lineKey] || lineKey}
                    xAxisId={hasOverlayMetrics ? "right" : "left"}
                    stroke={chartPalette[(index + 1) % chartPalette.length]}
                    strokeWidth={2}
                    dot={{ r: 2 }}
                    activeDot={{ r: 3 }}
                  />
                ))}
                {hasOverlayMetrics && <Legend wrapperStyle={{ fontSize: 10 }} />}
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        </div>
        {!hasOverlayMetrics && (
          <div className="shrink-0" style={{ height: `${axisFooterHeight}px` }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={barRows.length > 0 ? [barRows[0]] : [{ [primaryMetricKey]: 0 }]} margin={{ top: 0, right: barRightMargin, bottom: 0, left: 4 }}>
                <XAxis
                  type="number"
                  dataKey={primaryMetricKey}
                  tick={{ fontSize: 10 }}
                  height={20}
                  axisLine={false}
                  tickLine={false}
                  domain={[0, barAxisMax]}
                  tickCount={4}
                  allowDataOverflow={false}
                  tickFormatter={(value) => formatChartValueCompact(value)}
                />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>
    );
  }

  if (type === "column") {
    const showColumnLabels = widget.config.bar_data_labels_enabled !== false;
    const showColumnGrid = !!widget.config.bar_show_grid;
    const primaryMetricKey = chartMetricKeys[0] || metricKey;
    const overlayMetricKeys = chartMetricKeys.slice(1);
    const hasOverlayMetrics = overlayMetricKeys.length > 0;
    const columnRows = [...chartRows].sort((left, right) => {
      const leftDim = left[dimKey];
      const rightDim = right[dimKey];
      const leftDate = parseDateLike(leftDim);
      const rightDate = parseDateLike(rightDim);
      if (leftDate && rightDate) return leftDate.getTime() - rightDate.getTime();
      const leftNumeric = Number(leftDim);
      const rightNumeric = Number(rightDim);
      if (Number.isFinite(leftNumeric) && Number.isFinite(rightNumeric)) {
        return leftNumeric - rightNumeric;
      }
      return String(leftDim ?? "").localeCompare(String(rightDim ?? ""), "pt-BR");
    });
    const columnTotal = columnRows.reduce((sum, row) => sum + toFiniteNumber(row[primaryMetricKey]), 0);
    const columnDataMax = columnRows.reduce((maxValue, row) => Math.max(maxValue, toFiniteNumber(row[primaryMetricKey])), 0);
    const columnAxisMax = computeNiceAxisMax(columnDataMax, 5);
    const overlayDataMax = overlayMetricKeys.reduce((maxValue, key) => (
      Math.max(maxValue, columnRows.reduce((innerMax, row) => Math.max(innerMax, toFiniteNumber(row[key])), 0))
    ), 0);
    const overlayAxisMax = computeNiceAxisMax(overlayDataMax, 5);
    const rightAxisMetricKey = overlayMetricKeys[0] || primaryMetricKey;
    const hasMultilineColumnTicks = columnRows.some((row) => splitLabelIntoTwoLines(formatCategoricalBucketLabel(row[dimKey]), 12).lines.length > 1);
    const denseColumnTicks = columnRows.length > 14;
    const columnTickInterval = denseColumnTicks ? Math.max(1, Math.ceil(columnRows.length / 10)) - 1 : 0;
    const columnXAxisHeight = denseColumnTicks ? 56 : (hasMultilineColumnTicks ? 40 : 26);
    const formatColumnMetricLabel = (value: unknown, compact = true): string => {
      const numericValue = toFiniteNumber(value);
      const absolute = compact
        ? formatMetricValueCompact(primaryMetricKey, numericValue)
        : formatMetricValueFull(primaryMetricKey, numericValue);
      if (!showPercentOfTotal) return absolute;
      return `${absolute} (${formatPercentOfTotal(numericValue, columnTotal)})`;
    };
    return (
      <ResponsiveContainer width="100%" height={chartHeight}>
        <ComposedChart data={columnRows} margin={{ top: 8, right: hasOverlayMetrics ? 22 : 8, bottom: 0, left: 2 }}>
          {showColumnGrid && <CartesianGrid strokeDasharray="3 3" stroke="hsl(214, 20%, 88%)" vertical={false} />}
          <XAxis
            dataKey={dimKey}
            interval={columnTickInterval}
            minTickGap={12}
            allowDuplicatedCategory={false}
            height={columnXAxisHeight}
            tickMargin={6}
            tick={(props: { x?: number; y?: number; payload?: { value?: unknown } }) => {
              const x = Number(props.x || 0);
              const y = Number(props.y || 0);
              const formatted = formatCategoricalBucketLabel(props.payload?.value);
              const { lines, full } = splitLabelIntoTwoLines(formatted, denseColumnTicks ? 10 : 12);
              if (denseColumnTicks) {
                return (
                  <g transform={`translate(${x},${y})`}>
                    <title>{full}</title>
                    <text
                      x={0}
                      y={0}
                      dy={10}
                      textAnchor="end"
                      fill="hsl(var(--muted-foreground))"
                      fontSize={10}
                      transform="rotate(-32)"
                    >
                      {lines[0] || formatted}
                    </text>
                  </g>
                );
              }
              return (
                <g transform={`translate(${x},${y})`}>
                  <title>{full}</title>
                  <text
                    x={0}
                    y={0}
                    dy={hasMultilineColumnTicks ? 13 : 10}
                    textAnchor="middle"
                    fill="hsl(var(--muted-foreground))"
                    fontSize={10}
                  >
                    {lines.map((line, index) => (
                      <tspan key={`${line}-${index}`} x={0} dy={index === 0 ? 0 : 11}>{line}</tspan>
                    ))}
                  </text>
                </g>
              );
            }}
            axisLine={false}
            tickLine={false}
          />
          <YAxis
            yAxisId="left"
            tick={{ fontSize: 10 }}
            axisLine={false}
            tickLine={false}
            width={50}
            domain={[0, columnAxisMax]}
            tickCount={5}
            tickFormatter={(value) => formatMetricValueCompact(primaryMetricKey, value)}
          />
          {hasOverlayMetrics && (
            <YAxis
              yAxisId="right"
              orientation="right"
              tick={{ fontSize: 10 }}
              axisLine={false}
              tickLine={false}
              width={50}
              domain={[0, overlayAxisMax]}
              tickCount={5}
              tickFormatter={(value) => formatMetricValueCompact(rightAxisMetricKey, value)}
            />
          )}
          <Tooltip
            cursor={{ fill: "hsl(var(--muted)/0.28)" }}
            content={(props) => {
              const payload = (props.payload || []) as Array<{ value?: unknown; name?: string; color?: string; dataKey?: string }>;
              if (!props.active || payload.length === 0) return null;
              if (!hasOverlayMetrics) {
                return (
                  <GlassTooltip
                    active={props.active}
                    payload={props.payload as Array<{ value?: unknown }> | undefined}
                    label={props.label}
                    categoryLabel={formatCategoricalBucketLabel}
                    metricLabel={metricLabel}
                    valueLabel={(value) => formatColumnMetricLabel(value, false)}
                  />
                );
              }
              return (
                <div
                  className="min-w-[170px] rounded-xl border border-border/60 bg-[hsl(var(--card)/0.72)] px-3 py-2 shadow-xl backdrop-blur-md"
                  style={{ boxShadow: "0 14px 30px -16px rgba(2,6,23,0.65)" }}
                >
                  <p className="text-[11px] font-semibold text-foreground/95">{formatCategoricalBucketLabel(props.label)}</p>
                  <div className="mt-1 space-y-1 text-[11px]">
                    {payload.map((entry) => {
                      const key = String(entry.dataKey || "");
                      const isPrimary = key === primaryMetricKey;
                      const formatted = isPrimary
                        ? formatColumnMetricLabel(entry.value, false)
                        : formatMetricValueFull(key, entry.value);
                      return (
                        <div key={`${key}-${entry.name}`} className="flex items-center justify-between gap-3">
                          <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                            <span className="h-2 w-2 rounded-full" style={{ backgroundColor: entry.color || "hsl(var(--chart-1))" }} />
                            {entry.name || chartMetricLabelByKey[key] || key}
                          </span>
                          <span className="font-semibold tabular-nums text-foreground">{formatted}</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            }}
          />
          <Bar
            dataKey={primaryMetricKey}
            name={chartMetricLabelByKey[primaryMetricKey] || metricLabel}
            yAxisId="left"
            fill={chartPalette[0]}
            radius={[6, 6, 0, 0]}
          >
            {showColumnLabels && (
              <LabelList
                dataKey={primaryMetricKey}
                content={(props: Record<string, unknown>) => {
                  const value = props.value;
                  const x = Number(props.x || 0);
                  const y = Number(props.y || 0);
                  const width = Number(props.width || 0);
                  const viewBox = props.viewBox as { y?: number; height?: number } | undefined;
                  if (value === undefined || value === null) return null;
                  const plotTop = Number(viewBox?.y ?? 0);
                  const safeY = Math.max(plotTop + 10, y - 12);
                  return renderGlassLabel({ x: x + (width / 2), y: safeY, text: formatColumnMetricLabel(value, true), fontSize: 9 });
                }}
              />
            )}
          </Bar>
          {overlayMetricKeys.map((lineKey, index) => (
            <Line
              key={`column-overlay-${lineKey}`}
              type="monotone"
              dataKey={lineKey}
              name={chartMetricLabelByKey[lineKey] || lineKey}
              yAxisId="right"
              stroke={chartPalette[(index + 1) % chartPalette.length]}
              strokeWidth={2}
              dot={{ r: 2 }}
              activeDot={{ r: 3 }}
            />
          ))}
          {hasOverlayMetrics && <Legend wrapperStyle={{ fontSize: 10 }} />}
        </ComposedChart>
      </ResponsiveContainer>
    );
  }

  const donutShowLegend = widget.config.donut_show_legend !== false;
  const donutDataLabelsEnabled = !!widget.config.donut_data_labels_enabled;
  const donutGroupOthersEnabled = !!widget.config.donut_group_others_enabled;
  const donutGroupOthersTopN = Math.max(2, Math.min(200, Math.trunc(widget.config.donut_group_others_top_n || widget.config.top_n || 3)));
  const donutCanvasHeight = Math.max(160, chartHeight);
  const donutLegendReservedHeight = donutShowLegend ? 34 : 0;
  const donutLabelTopPadding = 12;
  const donutLabelBottomPadding = 10 + donutLegendReservedHeight;
  const donutRows = donutGroupOthersEnabled && chartRows.length > donutGroupOthersTopN
    ? (() => {
        const sorted = [...chartRows].sort((a, b) => toFiniteNumber(b[metricKey]) - toFiniteNumber(a[metricKey]));
        const topRows = sorted.slice(0, donutGroupOthersTopN);
        const remaining = sorted.slice(donutGroupOthersTopN);
        const othersValue = remaining.reduce((sum, row) => sum + toFiniteNumber(row[metricKey]), 0);
        return othersValue > 0 ? [...topRows, { [dimKey]: "Outros", [metricKey]: othersValue }] : topRows;
      })()
    : chartRows;
  const donutTotal = donutRows.reduce((sum, row) => sum + toFiniteNumber(row[metricKey]), 0);
  const shouldShowDonutLabel = (_entry: { percent?: number }) => true;

  return (
    <ResponsiveContainer width="100%" height={donutCanvasHeight}>
      <RePieChart>
        <Tooltip
          content={(props) => {
            const payload = (props.payload || []) as Array<{ value?: unknown; payload?: Record<string, unknown>; color?: string }>;
            const point = payload[0];
            if (!props.active || !point) return null;
            const category = String(point.payload?.[dimKey] ?? "");
            const numericValue = toFiniteNumber(point.value);
            const percent = donutTotal > 0 ? (numericValue / donutTotal) * 100 : 0;
            const valueText = formatChartValueFull(numericValue);
            return (
              <div
                className="min-w-[170px] rounded-xl border border-border/60 bg-[hsl(var(--card)/0.72)] px-3 py-2 shadow-xl backdrop-blur-md"
                style={{ boxShadow: "0 14px 30px -16px rgba(2,6,23,0.65)" }}
              >
                <p className="text-[11px] font-semibold text-foreground/95">{category}</p>
                <div className="mt-1 flex items-center justify-between gap-3 text-[11px]">
                  <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                    <span className="h-2 w-2 rounded-full" style={{ backgroundColor: point.color || "hsl(var(--chart-1))" }} />
                    {metricLabel}
                  </span>
                  <span className="font-semibold tabular-nums text-foreground">{valueText}</span>
                </div>
                <p className="mt-0.5 text-right text-[10px] text-muted-foreground">{formatPercent(percent)}</p>
              </div>
            );
          }}
        />
        {donutShowLegend && (
          <Legend
            verticalAlign="bottom"
            align="center"
            wrapperStyle={{ fontSize: 10, color: "hsl(var(--muted-foreground))" }}
          />
        )}
        <Pie
          data={donutRows}
          dataKey={metricKey}
          nameKey={dimKey}
          cy={donutShowLegend ? "44%" : "50%"}
          innerRadius="56%"
          outerRadius={donutShowLegend ? "76%" : "82%"}
          paddingAngle={2}
          strokeWidth={1}
          stroke="hsl(var(--background))"
          label={donutDataLabelsEnabled
            ? (entry: {
                percent?: number;
                value?: unknown;
                x?: number;
                y?: number;
                cx?: number;
                cy?: number;
                midAngle?: number;
                outerRadius?: number;
              }) => {
                if (!shouldShowDonutLabel(entry)) return null;
                const x = Number(entry.x || 0);
                const y = Number(entry.y || 0);
                const cx = Number(entry.cx || 0);
                const cy = Number(entry.cy || 0);
                const midAngle = Number(entry.midAngle || 0);
                const outerRadius = Number(entry.outerRadius || 0);
                const rad = -midAngle * (Math.PI / 180);
                const lineStartX = cx + (outerRadius + 2) * Math.cos(rad);
                const lineStartY = cy + (outerRadius + 2) * Math.sin(rad);
                const safeY = clamp(y, donutLabelTopPadding, donutCanvasHeight - donutLabelBottomPadding);
                const numericValue = toFiniteNumber(entry.value);
                const percent = donutTotal > 0 ? (numericValue / donutTotal) * 100 : 0;
                const text = `${formatCompactNumber(numericValue)} (${formatPercent(percent)})`;
                return (
                  <g>
                    <line
                      x1={lineStartX}
                      y1={lineStartY}
                      x2={x}
                      y2={safeY}
                      stroke="hsl(var(--border-default) / 0.8)"
                      strokeWidth={1}
                    />
                    {renderGlassLabel({ x, y: safeY, text, fontSize: 9 })}
                  </g>
                );
              }
            : false}
          labelLine={false}
        >
          {donutRows.map((entry, index) => (
            <Cell
              key={`${String(entry[dimKey] ?? index)}`}
              fill={String(entry[dimKey]) === "Outros" ? "hsl(0, 0%, 62%)" : chartPalette[index % chartPalette.length]}
            />
          ))}
        </Pie>
      </RePieChart>
    </ResponsiveContainer>
  );
};
