import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  LineChart as ReLineChart, Line, LabelList, Legend, PieChart as RePieChart, Pie, Cell,
} from "recharts";
import { ArrowUpDown, Download, ChevronLeft, ChevronRight } from "lucide-react";
import type { DashboardWidget } from "@/types/dashboard";
import { api, type ApiDashboardWidgetDataResponse } from "@/lib/api";

const tooltipStyle = {
  borderRadius: 8,
  border: "1px solid hsl(214, 20%, 88%)",
  fontSize: 12,
  boxShadow: "0 4px 12px -2px rgba(0,0,0,0.08)",
};

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
  if (metric.op === "count") {
    return metric.column ? `CONTAGEM(${metric.column})` : "CONTAGEM(*)";
  }
  if (metric.op === "distinct_count") {
    return `CONTAGEM ÚNICA(${metric.column || "*"})`;
  }
  return `${aggLabelMap[metric.op]}(${metric.column || "*"})`;
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
  const labelWidth = Math.max(28, text.length * 6 + 10);
  const labelHeight = 16;
  return (
    <g>
      <rect
        x={x - (labelWidth / 2)}
        y={y - (labelHeight / 2)}
        width={labelWidth}
        height={labelHeight}
        rx={6}
        ry={6}
        fill="rgba(200,200,200,0.75)"
        stroke="rgba(255,255,255,0.18)"
      />
      <text x={x} y={y + 3} fill="hsl(0, 0%, 30%)" fontSize={fontSize} textAnchor="middle">
        {text}
      </text>
    </g>
  );
};

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));

type RendererProps = {
  widget: DashboardWidget;
  dashboardId?: string;
  disableFetch?: boolean;
  heightMultiplier?: 0.5 | 1 | 2;
  preloadedData?: ApiDashboardWidgetDataResponse;
  preloadedLoading?: boolean;
  preloadedError?: string | null;
  hideTableExport?: boolean;
  forcedLoading?: boolean;
};

const EmptyWidgetState = ({ text }: { text: string }) => (
  <div className="text-xs text-muted-foreground text-center">{text}</div>
);

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
  const [sortBy, setSortBy] = useState<{ column: string; direction: "asc" | "desc" } | null>(null);
  const [page, setPage] = useState(1);
  const configured = widget.config.columns || [];
  const rowKeys = Object.keys(rows[0] || {});
  const pageSize = Math.max(1, widget.config.table_page_size || 25);
  const tableColumns = configured.length > 0
    ? [...configured.filter((column) => rowKeys.includes(column)), ...rowKeys.filter((column) => !configured.includes(column))]
    : rowKeys;

  const sortedRows = useMemo(() => {
    if (!sortBy) return rows;
    const copy = [...rows];
    copy.sort((a, b) => {
      const av = a[sortBy.column];
      const bv = b[sortBy.column];
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
  }, [rows, sortBy]);

  const totalPages = Math.max(1, Math.ceil(sortedRows.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const pageRows = sortedRows.slice((safePage - 1) * pageSize, safePage * pageSize);

  if (rows.length === 0) return <EmptyWidgetState text="Nenhum dado retornado" />;

  const exportCsv = () => {
    const escapeCsv = (value: string) => {
      if (value.includes("\"") || value.includes(",") || value.includes("\n")) {
        return `"${value.replace(/"/g, "\"\"")}"`;
      }
      return value;
    };
    const header = tableColumns.map(escapeCsv).join(",");
    const body = sortedRows.map((row) =>
      tableColumns
        .map((key) => escapeCsv(formatByTableConfig(row[key], widget.config.table_column_formats?.[key] || "native")))
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

      <div className="flex-1 overflow-auto rounded-lg border border-border">
        <div className="min-w-max">
          <Table>
            <TableHeader className="sticky top-0 z-10 bg-muted/40 backdrop-blur-sm">
              <TableRow className="hover:bg-muted/30">
                {tableColumns.map((key) => (
                  <TableHead key={key} className="text-xs font-semibold whitespace-nowrap py-2 min-w-[120px]">
                    <button
                      className="inline-flex items-center gap-1 hover:text-foreground"
                      onClick={() => {
                        setPage(1);
                        setSortBy((prev) => {
                          if (!prev || prev.column !== key) return { column: key, direction: "asc" };
                          if (prev.direction === "asc") return { column: key, direction: "desc" };
                          return null;
                        });
                      }}
                    >
                      {key}
                      <ArrowUpDown className="h-3 w-3" />
                    </button>
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {pageRows.map((row, idx) => (
                <TableRow key={`${safePage}-${idx}`} className="even:bg-muted/20">
                  {tableColumns.map((key) => (
                    <TableCell key={key} className={`py-1.5 text-xs whitespace-nowrap ${typeof row[key] === "number" ? "font-mono text-right tabular-nums" : ""}`}>
                      {formatByTableConfig(row[key], widget.config.table_column_formats?.[key] || "native")}
                    </TableCell>
                  ))}
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
  disableFetch = false,
  heightMultiplier = 1,
  preloadedData,
  preloadedLoading = false,
  preloadedError = null,
  hideTableExport = false,
  forcedLoading = false,
}: RendererProps) => {
  const isTextWidget = widget.config.widget_type === "text";
  const shouldFetch = !disableFetch && !!dashboardId && !isTextWidget;

  const widgetQuery = useQuery({
    queryKey: ["widget-data", dashboardId, widget.id],
    queryFn: () => api.getDashboardWidgetData(Number(dashboardId), Number(widget.id)),
    enabled: shouldFetch,
  });

  const rows = useMemo(
    () => preloadedData?.rows || widgetQuery.data?.rows || [],
    [preloadedData, widgetQuery.data],
  );
  const metricLabel = useMemo(() => getMetricLabel(widget), [widget]);
  const chartHeight = heightMultiplier === 0.5 ? 110 : heightMultiplier === 2 ? 380 : 220;
  const lineTargetTicks = heightMultiplier === 0.5 ? 4 : heightMultiplier === 2 ? 12 : 8;
  const chartPalette = paletteByName[widget.config.visual_palette || "default"] || paletteByName.default;
  const lineMetricKeys = widget.config.widget_type === "line"
    ? widget.config.metrics.map((_, index) => `m${index}`)
    : [];
  const lineMetricBaseLabelByKey = widget.config.widget_type === "line"
    ? Object.fromEntries(
      widget.config.metrics.map((metric, index) => {
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
  const chartPrefix = widget.config.kpi_prefix || "";
  const chartSuffix = widget.config.kpi_suffix || "";
  const formatChartValueCompact = (value: unknown): string => `${chartPrefix}${formatCompactNumber(value)}${chartSuffix}`;

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
  if (!disableFetch && widgetQuery.isLoading) {
    return <EmptyWidgetState text="Carregando dados..." />;
  }
  if (!disableFetch && widgetQuery.isError) {
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
              const normalizedTitle = row.title.replace(/^\((?:-|\+)\)\s*/i, "");
              const accountLabel = row.row_type === "deduction"
                ? (isSubtract ? `(-) ${normalizedTitle}` : `(+) ${normalizedTitle}`)
                : row.title;
              const valueText = isSubtract
                ? `(${formatCurrencyBRL(Math.abs(row.effective))})`
                : formatCurrencyBRL(row.effective);
              return (
                <tr key={`dre-${index}`} className="border-b border-border/60 last:border-b-0 transition-colors hover:bg-muted/30">
                  <td
                    className={`px-3 py-2 text-left ${isResult ? "font-semibold" : ""} ${isDetail ? "pl-7" : ""} ${rowTextColorClass}`}
                  >
                    {accountLabel}
                  </td>
                  <td className={`px-3 py-2 text-right tabular-nums ${isResult ? "font-semibold" : ""} ${isSubtract ? "text-rose-500" : rowTextColorClass}`}>
                    {valueText}
                  </td>
                  <td className={`px-3 py-2 text-right tabular-nums ${isResult ? "font-semibold" : ""} ${isSubtract ? "text-rose-500" : rowTextColorClass}`}>
                    {formatPercentOfTotal(row.effective, totalBase)}
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
    const value = Number(rows[0]?.m0 || 0);
    const showAs = widget.config.kpi_show_as || "number_2";
    const decimals = widget.config.kpi_decimals ?? 2;
    const prefix = widget.config.kpi_prefix;
    const suffix = widget.config.kpi_suffix;
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 py-4">
        <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
          {widget.title || "KPI"}
        </span>
        <span className="text-3xl font-extrabold tracking-tight text-foreground" title={formatKpiValueFull(value, showAs, decimals, prefix, suffix)}>
          {formatKpiValueCompact(value, showAs, decimals, prefix, suffix)}
        </span>
      </div>
    );
  }

  if (type === "line") {
    const showLineLabels = !!widget.config.line_data_labels_enabled;
    const showLineGrid = widget.config.line_show_grid !== false;
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
              contentStyle={tooltipStyle}
              labelFormatter={(label) => {
                return formatLineTooltipLabel(label);
              }}
              formatter={(value, name) => [formatChartValueCompact(value), lineSeriesLabelByKey[String(name)] || String(name)]}
            />
            {lineSeriesKeys.length > 1 && <Legend wrapperStyle={{ fontSize: 10 }} />}
            {lineSeriesKeys.map((seriesKey, index) => (
              <Line
                key={seriesKey}
                type="monotone"
                dataKey={seriesKey}
                name={lineSeriesLabelByKey[seriesKey] || seriesKey}
                yAxisId={lineSeriesAxisByKey[seriesKey] || "left"}
                stroke={chartPalette[index % chartPalette.length]}
                strokeWidth={2}
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
                      return renderGlassLabel({ x, y: safeY, text: formatChartValueCompact(value), fontSize: 10 });
                    }}
                  />
                )}
              </Line>
            ))}
          </ReLineChart>
        </ResponsiveContainer>
      </div>
    );
  }

  const dim = widget.config.dimensions[0];
  const dimKey = dim || "__dim";
  const chartRows = rows.map((row) => ({ ...row, m0: toFiniteNumber(row.m0) }));

  if (type === "bar") {
    const showBarLabels = widget.config.bar_data_labels_enabled !== false;
    const fixedBarHeight = 22;
    const barGap = 8;
    const barDataMax = chartRows.reduce((maxValue, row) => Math.max(maxValue, toFiniteNumber(row.m0)), 0);
    const barAxisMax = barDataMax > 0 ? barDataMax * 1.18 : 1;
    const barChartHeight = Math.max(chartHeight, rows.length * (fixedBarHeight + barGap) + 24);
    return (
      <div className="w-full overflow-y-auto" style={{ maxHeight: `${chartHeight}px` }}>
        <div style={{ height: `${barChartHeight}px` }}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={chartRows} margin={{ top: 8, right: 64, bottom: 8, left: 8 }} layout="vertical" barCategoryGap={barGap}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(214, 20%, 88%)" horizontal={false} />
              <XAxis
                type="number"
                tick={{ fontSize: 10 }}
                axisLine={false}
                tickLine={false}
                domain={[0, barAxisMax]}
                allowDataOverflow={false}
                tickFormatter={(value) => formatChartValueCompact(value)}
              />
              <YAxis
                type="category"
                dataKey={dimKey}
                tick={{ fontSize: 10 }}
                axisLine={false}
                tickLine={false}
                width={90}
                tickFormatter={(value) => {
                  const parsed = parseDateLike(value);
                  return parsed ? formatDateBR(parsed) : String(value);
                }}
              />
              <Tooltip contentStyle={tooltipStyle} formatter={(value) => [formatChartValueCompact(value), metricLabel]} />
              <Bar dataKey="m0" fill={chartPalette[0]} radius={[4, 4, 0, 0]} barSize={fixedBarHeight}>
                {showBarLabels && (
                  <LabelList
                    dataKey="m0"
                    content={(props: Record<string, unknown>) => {
                      const value = props.value;
                      const x = Number(props.x || 0);
                      const y = Number(props.y || 0);
                      const width = Number(props.width || 0);
                      const height = Number(props.height || 0);
                      if (value === undefined || value === null) return null;
                      const labelX = x + width + 18;
                      const labelY = y + (height / 2);
                      return renderGlassLabel({ x: labelX, y: labelY, text: formatChartValueCompact(value), fontSize: 10 });
                    }}
                  />
                )}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>
    );
  }

  if (type === "column") {
    const showColumnLabels = widget.config.bar_data_labels_enabled !== false;
    return (
      <ResponsiveContainer width="100%" height={chartHeight}>
        <BarChart data={chartRows} margin={{ top: 16, right: 8, bottom: 8, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="hsl(214, 20%, 88%)" vertical={false} />
          <XAxis
            dataKey={dimKey}
            tick={{ fontSize: 10 }}
            axisLine={false}
            tickLine={false}
            tickFormatter={(value) => {
              const parsed = parseDateLike(value);
              return parsed ? formatDateBR(parsed) : String(value);
            }}
          />
          <YAxis
            tick={{ fontSize: 10 }}
            axisLine={false}
            tickLine={false}
            width={34}
            tickFormatter={(value) => formatChartValueCompact(value)}
          />
          <Tooltip contentStyle={tooltipStyle} formatter={(value) => [formatChartValueCompact(value), metricLabel]} />
          <Bar dataKey="m0" fill={chartPalette[0]} radius={[6, 6, 0, 0]}>
            {showColumnLabels && (
              <LabelList
                dataKey="m0"
                content={(props: Record<string, unknown>) => {
                  const value = props.value;
                  const x = Number(props.x || 0);
                  const y = Number(props.y || 0);
                  const width = Number(props.width || 0);
                  const viewBox = props.viewBox as { y?: number; height?: number } | undefined;
                  if (value === undefined || value === null) return null;
                  const plotTop = Number(viewBox?.y ?? 0);
                  const safeY = Math.max(plotTop + 10, y - 8);
                  return renderGlassLabel({ x: x + (width / 2), y: safeY, text: formatChartValueCompact(value), fontSize: 10 });
                }}
              />
            )}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    );
  }

  const donutShowLegend = widget.config.donut_show_legend !== false;
  const donutDataLabelsEnabled = !!widget.config.donut_data_labels_enabled;
  const donutLabelMinPercent = Math.max(1, Math.min(100, widget.config.donut_data_labels_min_percent || 6));
  const donutMetricDisplay = widget.config.donut_metric_display === "percent" ? "percent" : "value";
  const donutCanvasHeight = Math.max(160, chartHeight);
  const donutLegendReservedHeight = donutShowLegend ? 34 : 0;
  const donutLabelTopPadding = 12;
  const donutLabelBottomPadding = 10 + donutLegendReservedHeight;
  const donutRows = chartRows.length > 5
    ? (() => {
        const sorted = [...chartRows].sort((a, b) => toFiniteNumber(b.m0) - toFiniteNumber(a.m0));
        const top3 = sorted.slice(0, 3);
        const remaining = sorted.slice(3);
        const othersValue = remaining.reduce((sum, row) => sum + toFiniteNumber(row.m0), 0);
        return othersValue > 0 ? [...top3, { [dimKey]: "Outros", m0: othersValue }] : top3;
      })()
    : chartRows;
  const donutTotal = donutRows.reduce((sum, row) => sum + toFiniteNumber(row.m0), 0);
  const shouldShowDonutLabel = (entry: { percent?: number }) =>
    Number(entry?.percent || 0) * 100 >= donutLabelMinPercent;

  return (
    <ResponsiveContainer width="100%" height={donutCanvasHeight}>
      <RePieChart>
        <Tooltip
          contentStyle={tooltipStyle}
          formatter={(value, _name, item) => {
            const numericValue = toFiniteNumber(value);
            const percent = donutTotal > 0 ? (numericValue / donutTotal) * 100 : 0;
            const formatted = donutMetricDisplay === "percent" ? formatPercent(percent) : formatCompactNumber(numericValue);
            return [formatted, String(item?.payload?.[dimKey] ?? "")];
          }}
        />
        {donutShowLegend && <Legend verticalAlign="bottom" align="center" wrapperStyle={{ fontSize: 10 }} />}
        <Pie
          data={donutRows}
          dataKey="m0"
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
                const text = donutMetricDisplay === "percent" ? formatPercent(percent) : formatCompactNumber(numericValue);
                return (
                  <g>
                    <line
                      x1={lineStartX}
                      y1={lineStartY}
                      x2={x}
                      y2={safeY}
                      stroke="rgba(148,163,184,0.75)"
                      strokeWidth={1}
                    />
                    {renderGlassLabel({ x, y: safeY, text, fontSize: 10 })}
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
