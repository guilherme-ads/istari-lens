import { useEffect, useMemo, useState, type ElementType, type ReactNode } from "react";
import { ArrowUpDown, BarChart3, Calendar, ChevronDown, Columns3, Filter, Hash, LineChart, MousePointer, Palette, PieChart, Sparkles, Table2, Type, Wand2, X, Trash2, Plus } from "lucide-react";
import type { DateRange } from "react-day-picker";

import type { DashboardWidget, MetricOp, WidgetFilter } from "@/types/dashboard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Calendar as DatePicker } from "@/components/ui/calendar";
import { cn } from "@/lib/utils";

export interface BuilderRightPanelProps {
  widget: DashboardWidget | null;
  onUpdate: (widget: DashboardWidget) => void;
  onDelete: () => void;
  onClose: () => void;
  columns?: Array<{ name: string; type: string }>;
  dashboardWidgets?: DashboardWidget[];
}

type TabKey = "dados" | "visual" | "filtros" | "interacoes";

const widgetTypeIcon = {
  kpi: Hash,
  line: LineChart,
  bar: BarChart3,
  column: BarChart3,
  donut: PieChart,
  table: Table2,
  text: Type,
  dre: Columns3,
} as const;

const metricOps: MetricOp[] = ["count", "distinct_count", "sum", "avg", "min", "max"];
const countLikeOps = new Set<MetricOp>(["count", "distinct_count"]);
const kpiFormulaFunctionNames = new Set(["COUNT", "DISTINCT", "SUM", "AVG", "MAX", "MIN"]);
const metricLabelByOp: Record<MetricOp, string> = {
  count: "CONTAGEM",
  distinct_count: "CONTAGEM ÚNICA",
  sum: "SOMA",
  avg: "MÉDIA",
  min: "MÍNIMO",
  max: "MÁXIMO",
};
const commonFilterOps: Array<{ value: WidgetFilter["op"]; label: string }> = [
  { value: "eq", label: "=" },
  { value: "neq", label: "!=" },
  { value: "gt", label: ">" },
  { value: "lt", label: "<" },
  { value: "gte", label: ">=" },
  { value: "lte", label: "<=" },
  { value: "in", label: "in" },
  { value: "not_in", label: "not in" },
  { value: "contains", label: "contem" },
  { value: "between", label: "entre" },
  { value: "is_null", label: "nulo" },
  { value: "not_null", label: "nao nulo" },
];
type TemporalFilterOpUi = WidgetFilter["op"] | "__relative__";
const temporalFilterOps: Array<{ value: TemporalFilterOpUi; label: string }> = [
  { value: "eq", label: "=" },
  { value: "neq", label: "!=" },
  { value: "gt", label: ">" },
  { value: "lt", label: "<" },
  { value: "gte", label: ">=" },
  { value: "lte", label: "<=" },
  { value: "in", label: "in" },
  { value: "not_in", label: "not in" },
  { value: "between", label: "entre datas" },
  { value: "__relative__", label: "relativa" },
  { value: "is_null", label: "nulo" },
  { value: "not_null", label: "nao nulo" },
];
const nullOps = new Set<WidgetFilter["op"]>(["is_null", "not_null"]);
const listOps = new Set<WidgetFilter["op"]>(["in", "not_in"]);
const relativeDateOptions = [
  { value: "today", label: "Hoje" },
  { value: "yesterday", label: "Ontem" },
  { value: "last_7_days", label: "Ultimos 7 dias" },
  { value: "last_30_days", label: "Ultimos 30 dias" },
  { value: "this_year", label: "Este ano" },
  { value: "this_month", label: "Este mes" },
  { value: "last_month", label: "Mes passado" },
] as const;

const dateToApi = (date: Date) => date.toISOString().slice(0, 10);

const parseDateValue = (value: unknown): Date | undefined => {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const raw = value.trim();
  const date = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? new Date(`${raw}T00:00:00`) : new Date(raw);
  if (Number.isNaN(date.getTime())) return undefined;
  return date;
};

const formatDateLabel = (date: Date) =>
  new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" }).format(date);

const paletteByName: Record<"default" | "warm" | "cool" | "mono" | "vivid", string[]> = {
  default: ["bg-chart-1", "bg-chart-2", "bg-chart-3", "bg-chart-4", "bg-chart-5"],
  warm: ["bg-warning", "bg-highlight", "bg-destructive", "bg-chart-3", "bg-chart-5"],
  cool: ["bg-chart-4", "bg-chart-6", "bg-chart-7", "bg-chart-1", "bg-chart-2"],
  mono: ["bg-foreground", "bg-foreground/80", "bg-foreground/60", "bg-foreground/40", "bg-foreground/20"],
  vivid: ["bg-accent", "bg-chart-7", "bg-chart-8", "bg-success", "bg-chart-5"],
};

const kpiShowAsOptions: Array<{ value: "number_2" | "integer"; label: string }> = [
  { value: "number_2", label: "Decimal" },
  { value: "integer", label: "Inteiro" },
];
const kpiAbbreviationModeOptions: Array<{ value: "auto" | "always"; label: string }> = [
  { value: "auto", label: "Automatico" },
  { value: "always", label: "Sempre abreviar" },
];
const kpiBaseAggOptions: Array<{ value: MetricOp; label: string }> = [
  { value: "sum", label: "SOMA" },
  { value: "count", label: "CONTAGEM" },
  { value: "distinct_count", label: "CONTAGEM UNICA" },
  { value: "avg", label: "MEDIA" },
];
const kpiFinalAggOptions: Array<{ value: MetricOp; label: string }> = [
  { value: "avg", label: "MEDIA" },
  { value: "sum", label: "SOMA" },
  { value: "max", label: "MAXIMO" },
  { value: "min", label: "MINIMO" },
];
const kpiGranularityTokenOptions: Array<{ value: "day" | "month" | "timestamp"; label: string }> = [
  { value: "day", label: "dia" },
  { value: "month", label: "mes" },
  { value: "timestamp", label: "ano" },
];
const kpiGranularityLabelByValue: Record<"day" | "month" | "timestamp", string> = {
  day: "dia",
  month: "mes",
  timestamp: "ano",
};
const kpiModeOptions: Array<{ value: "atomic" | "composite" | "derived"; title: string; description: string }> = [
  { value: "atomic", title: "Valor unico", description: "Mostra um unico total, media ou contagem." },
  { value: "composite", title: "Media por periodo", description: "Calcula por dia/mes/ano e depois resume." },
  { value: "derived", title: "Formula personalizada", description: "Combina bases com uma formula avancada." },
];
const kpiModeLabel: Record<"atomic" | "composite" | "derived", string> = {
  atomic: "VALOR",
  composite: "PERIODO",
  derived: "FORMULA",
};

const normalizeColumnType = (rawType: string): "numeric" | "temporal" | "text" | "boolean" => {
  const value = (rawType || "").toLowerCase();
  if (value === "numeric" || value === "temporal" || value === "text" || value === "boolean") return value;
  if (["int", "numeric", "decimal", "real", "double", "float", "money"].some((token) => value.includes(token))) return "numeric";
  if (["date", "time", "timestamp"].some((token) => value.includes(token))) return "temporal";
  if (value.includes("bool")) return "boolean";
  return "text";
};

const parseTemporalDimensionToken = (value: string): { column: string; granularity: "day" | "month" | "week" | "weekday" | "hour" } | null => {
  if (value.startsWith("__time_day__:")) return { column: value.slice("__time_day__:".length), granularity: "day" };
  if (value.startsWith("__time_month__:")) return { column: value.slice("__time_month__:".length), granularity: "month" };
  if (value.startsWith("__time_week__:")) return { column: value.slice("__time_week__:".length), granularity: "week" };
  if (value.startsWith("__time_weekday__:")) return { column: value.slice("__time_weekday__:".length), granularity: "weekday" };
  if (value.startsWith("__time_hour__:")) return { column: value.slice("__time_hour__:".length), granularity: "hour" };
  return null;
};

const buildTemporalDimensionToken = (column: string, granularity: "day" | "month" | "week" | "weekday" | "hour"): string =>
  `__time_${granularity}__:${column}`;

const temporalDimensionGranularityOptions: Array<{ value: "day" | "month" | "week" | "weekday" | "hour"; label: string }> = [
  { value: "day", label: "Dia" },
  { value: "month", label: "Mês" },
  { value: "week", label: "Semana" },
  { value: "weekday", label: "Dia da semana" },
  { value: "hour", label: "Hora" },
];

const inferColumns = (widget: DashboardWidget): Array<{ name: string; type: string }> => {
  const names = new Set<string>();
  widget.config.metrics.forEach((metric) => metric.column && names.add(metric.column));
  widget.config.dimensions.forEach((dimension) => !dimension.startsWith("__time_") && names.add(dimension));
  widget.config.filters.forEach((filter) => filter.column && names.add(filter.column));
  widget.config.columns?.forEach((column) => names.add(column));
  if (widget.config.time?.column) names.add(widget.config.time.column);
  return Array.from(names).map((name) => ({ name, type: "text" }));
};

const extractKpiFormulaRefs = (formula: string): string[] => {
  const matches = formula.match(/\b[A-Za-z_][A-Za-z0-9_]*\b/g) || [];
  const refs: string[] = [];
  for (const token of matches) {
    if (!kpiFormulaFunctionNames.has(token.toUpperCase())) refs.push(token);
  }
  return [...new Set(refs)];
};

const normalizeKpiDependencyWidgetId = (value: unknown): number | string | undefined => {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value;
  }
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (/^\d+$/.test(trimmed)) {
    const numeric = Number(trimmed);
    if (Number.isFinite(numeric) && numeric > 0) return numeric;
  }
  return trimmed;
};

const normalizeKpiDependencies = (
  deps: Array<{ source_type?: "widget" | "column"; widget_id?: number | string; column?: string; alias?: string }> = [],
): Array<{ source_type: "widget" | "column"; widget_id?: number | string; column?: string; alias: string }> =>
  deps
    .map((item, index) => {
      const alias = (item.alias || "").trim() || `kpi_${index}`;
      const column = (item.column || "").trim();
      const widgetId = normalizeKpiDependencyWidgetId(item.widget_id);
      const hasValidWidgetId = widgetId !== undefined;
      const inferredSource: "widget" | "column" = item.source_type === "column"
        ? "column"
        : item.source_type === "widget"
          ? "widget"
          : (column ? "column" : "widget");
      const sourceType: "widget" | "column" = inferredSource === "widget" && !hasValidWidgetId && column
        ? "column"
        : inferredSource;
      return sourceType === "column"
        ? {
            source_type: "column" as const,
            column: column || undefined,
            alias,
          }
        : {
            source_type: "widget" as const,
            widget_id: widgetId,
            alias,
          };
    })
    .filter((item) => (item.source_type === "column" ? !!item.column : normalizeKpiDependencyWidgetId(item.widget_id) !== undefined));

const clampKpiDecimals = (value: unknown): number => Math.max(0, Math.min(8, Math.trunc(Number(value) || 0)));

const ConfigSection = ({
  title,
  icon: Icon,
  children,
  defaultOpen = true,
  badge,
}: {
  title: string;
  icon: ElementType;
  children: ReactNode;
  defaultOpen?: boolean;
  badge?: string | number;
}) => {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="rounded-xl border border-border/60 bg-background/45 p-3">
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        className="flex w-full items-center justify-between gap-2 text-left text-label font-semibold text-foreground"
        aria-expanded={open}
      >
      <span className="inline-flex items-center gap-1.5">
        <Icon className="h-3.5 w-3.5 text-muted-foreground" />
        {title}
        {badge !== undefined && (
          <span className="inline-flex h-4 min-w-[16px] items-center justify-center rounded-full bg-accent/15 px-1 text-[10px] font-bold text-accent">
            {badge}
          </span>
        )}
      </span>
        <ChevronDown className={cn("h-3.5 w-3.5 text-muted-foreground transition-transform", open ? "rotate-180" : "")} />
      </button>
      {open && <div className="mt-2.5 space-y-2.5">{children}</div>}
    </div>
  );
};

const SentenceTokenSelect = ({
  value,
  onChange,
  options,
  tone,
  placeholder,
  showCalendarIcon = false,
}: {
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string; disabled?: boolean }>;
  tone: "agg" | "column" | "time" | "segment";
  placeholder?: string;
  showCalendarIcon?: boolean;
}) => {
  const toneClass = tone === "agg"
    ? "border-violet-500/40 bg-violet-500/10 text-violet-300"
    : tone === "column"
      ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
      : tone === "time"
        ? "border-sky-500/40 bg-sky-500/10 text-sky-300"
        : "border-orange-500/40 bg-orange-500/10 text-orange-300";
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className={cn("h-7 w-auto min-w-[92px] rounded-md px-1.5 text-[11px] font-semibold", toneClass)}>
        {showCalendarIcon && <Calendar className="mr-1 h-3 w-3 shrink-0" />}
        <SelectValue placeholder={placeholder || "Selecionar"} />
      </SelectTrigger>
      <SelectContent position="item-aligned" className="max-h-44 rounded-md p-1">
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value} disabled={option.disabled} className="h-7 rounded-sm pl-7 pr-2 text-[11px]">
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
};

export const BuilderRightPanel = ({ widget, onUpdate, onDelete, onClose, columns, dashboardWidgets = [] }: BuilderRightPanelProps) => {
  const [draft, setDraft] = useState<DashboardWidget | null>(widget);
  const [activeTab, setActiveTab] = useState<TabKey>("dados");
  const [filterJoin, setFilterJoin] = useState<"AND" | "OR">("AND");

  useEffect(() => {
    if (!widget) {
      setDraft(null);
      setActiveTab("dados");
      return;
    }
    if (widget.config.widget_type !== "kpi") {
      setDraft(widget);
      setActiveTab("dados");
      return;
    }
    const legacyShowAs = widget.config.kpi_show_as;
    const normalizedShowAs = legacyShowAs === "integer" ? "integer" : "number_2";
    const normalizedPrefix = legacyShowAs === "currency_brl" && !widget.config.kpi_prefix
      ? "R$ "
      : widget.config.kpi_prefix;
    const normalizedSuffix = legacyShowAs === "percent" && !widget.config.kpi_suffix
      ? "%"
      : widget.config.kpi_suffix;
    const normalizedShowTrend = widget.config.kpi_show_trend === true;
    setDraft({
      ...widget,
      config: {
        ...widget.config,
        kpi_show_as: normalizedShowAs,
        kpi_prefix: normalizedPrefix,
        kpi_suffix: normalizedSuffix,
        kpi_show_trend: normalizedShowTrend,
      },
      props: {
        ...widget.props,
        kpi_show_as: normalizedShowAs,
        kpi_prefix: normalizedPrefix,
        kpi_suffix: normalizedSuffix,
        kpi_show_trend: normalizedShowTrend,
      },
    });
    setActiveTab("dados");
  }, [widget]);

  const resolvedColumns = useMemo(() => {
    if (columns && columns.length > 0) return columns;
    if (!draft) return [];
    return inferColumns(draft);
  }, [columns, draft]);

  const numericColumns = useMemo(() => resolvedColumns.filter((column) => normalizeColumnType(column.type) === "numeric"), [resolvedColumns]);
  const temporalColumns = useMemo(() => resolvedColumns.filter((column) => normalizeColumnType(column.type) === "temporal"), [resolvedColumns]);
  const categoricalColumns = useMemo(() => resolvedColumns.filter((column) => {
    const type = normalizeColumnType(column.type);
    return type === "text" || type === "boolean";
  }), [resolvedColumns]);
  const availableDashboardKpiWidgets = useMemo(
    () => dashboardWidgets.filter((item) => item.id !== draft?.id && item.config.widget_type === "kpi"),
    [dashboardWidgets, draft?.id],
  );

  if (!draft) {
    return (
      <aside className="h-full border-l border-border/60 bg-[hsl(var(--card)/0.28)]">
        <div className="h-full flex items-center justify-center p-6">
          <div className="text-center space-y-2 max-w-[240px]">
            <div className="mx-auto h-10 w-10 rounded-xl border border-accent/25 bg-accent/10 text-accent flex items-center justify-center">
              <MousePointer className="h-5 w-5" />
            </div>
            <p className="text-body font-semibold text-foreground">Nenhum widget selecionado</p>
            <p className="text-caption text-muted-foreground">Clique em um widget no canvas para configura-lo aqui.</p>
          </div>
        </div>
      </aside>
    );
  }

  const Icon = widgetTypeIcon[draft.config.widget_type];
  const metric = draft.config.metrics[0] || { op: "count" as const, column: resolvedColumns[0]?.name };
  const isKpiWidget = draft.config.widget_type === "kpi";
  const isLineWidget = draft.config.widget_type === "line";
  const isBarLikeWidget = draft.config.widget_type === "bar" || draft.config.widget_type === "column";
  const isDonutWidget = draft.config.widget_type === "donut";
  const isCategoricalChart = isBarLikeWidget || isDonutWidget;
  const hasChartOptions = isLineWidget || isBarLikeWidget || isDonutWidget;
  const kpiMode = isKpiWidget
    ? draft.config.kpi_type === "derived"
      ? "derived"
      : draft.config.composite_metric
        ? "composite"
        : "atomic"
    : "atomic";
  const normalizedDerivedDeps = kpiMode === "derived" ? normalizeKpiDependencies(draft.config.kpi_dependencies || []) : [];
  const derivedMetricAliases = normalizedDerivedDeps.map((item) => item.alias);
  const compositeMetric = isKpiWidget ? draft.config.composite_metric : undefined;
  const isCompositeSentence = kpiMode === "composite" && !!compositeMetric;
  const kpiFormattingMode = draft.config.kpi_show_as === "integer" ? "integer" : "number_2";
  const kpiSentenceBaseAgg = (isCompositeSentence ? compositeMetric.inner_agg : metric.op) as MetricOp;
  const kpiSentenceFinalAgg = (isCompositeSentence ? compositeMetric.outer_agg : metric.op) as MetricOp;
  const kpiSentenceColumn = isCompositeSentence ? (compositeMetric.value_column || "__none__") : (metric.column || "__none__");
  const kpiAllowedColumns = countLikeOps.has(kpiSentenceBaseAgg) ? resolvedColumns : numericColumns;
  const selectedGranularity = isCompositeSentence
    ? (kpiGranularityTokenOptions.some((item) => item.value === compositeMetric.granularity)
      ? compositeMetric.granularity
      : "day")
    : "day";
  const kpiTimeTokenValue = isCompositeSentence
    ? `${compositeMetric.time_column || "__none__"}::${selectedGranularity}`
    : "__none__::day";
  const [kpiPreviewTimeColumn, kpiPreviewTimeGranularityRaw] = kpiTimeTokenValue.split("::");
  const kpiPreviewTimeGranularity = (kpiGranularityTokenOptions.some((item) => item.value === kpiPreviewTimeGranularityRaw)
    ? kpiPreviewTimeGranularityRaw
    : "day") as "day" | "month" | "timestamp";
  const kpiTimeTokenOptions = temporalColumns.flatMap((column) =>
    kpiGranularityTokenOptions.map((granularity) => ({
      value: `${column.name}::${granularity.value}`,
      label: `${column.name}[${granularity.label}]`,
    })));
  const kpiSentencePreview = isCompositeSentence
    ? `${metricLabelByOp[kpiSentenceFinalAgg]} de (${metricLabelByOp[kpiSentenceBaseAgg]} de ${kpiSentenceColumn === "__none__" ? "*" : kpiSentenceColumn} por ${kpiPreviewTimeColumn}[${kpiGranularityLabelByValue[kpiPreviewTimeGranularity]}])`
    : `${metricLabelByOp[kpiSentenceBaseAgg]} de ${kpiSentenceColumn === "__none__" ? "*" : kpiSentenceColumn}`;
  const barSentenceAgg = metric.op as MetricOp;
  const barSentenceColumn = metric.column || "__none__";
  const barAllowedColumns = countLikeOps.has(barSentenceAgg) ? resolvedColumns : numericColumns;
  const barSentenceColumnOptions = [
    ...(countLikeOps.has(barSentenceAgg) ? [{ value: "__none__", label: "sem coluna" }] : []),
    ...barAllowedColumns.map((column) => ({
      value: column.name,
      label: column.name,
    })),
  ];
  const barSentencePreview = `${metricLabelByOp[barSentenceAgg]} de ${barSentenceColumn === "__none__" ? "*" : barSentenceColumn}`;
  const lineMetrics = (draft.config.metrics.length > 0
    ? draft.config.metrics
    : [{ op: "count" as const, column: undefined, line_y_axis: "left" as const }]).slice(0, 2);
  const primaryLineMetric = lineMetrics[0] || { op: "count" as const, column: undefined, line_y_axis: "left" as const };
  const primaryLineMetricColumn = primaryLineMetric.column || "__none__";
  const primaryLineAllowedColumns = countLikeOps.has(primaryLineMetric.op) ? resolvedColumns : numericColumns;
  const currentOrder = draft.config.order_by[0];
  const orderTargetValue = currentOrder?.metric_ref ? "__metric__" : currentOrder?.column || "__none__";
  const currentDimensionRaw = draft.config.dimensions[0] || "";
  const parsedTemporalDimension = parseTemporalDimensionToken(currentDimensionRaw);
  const barLikeDimensionColumn = parsedTemporalDimension?.column || currentDimensionRaw;
  const barLikeDimensionGranularity = parsedTemporalDimension?.granularity || "day";
  const barLikeDimensionIsTemporal = !!barLikeDimensionColumn && temporalColumns.some((column) => column.name === barLikeDimensionColumn);
  const barLikeDimensionPreview = barLikeDimensionColumn
    ? `${barLikeDimensionColumn}${barLikeDimensionIsTemporal ? `[${barLikeDimensionGranularity}]` : ""}`
    : "Sem dimensao";
  const lineTimeColumnValue = draft.config.time?.column || "__none__";
  const lineTimeGranularityValue = draft.config.time?.granularity || "day";
  const lineSeriesDimensionValue = draft.config.dimensions[0] || "__none__";
  const lineDimensionPreview = lineTimeColumnValue === "__none__"
    ? "Sem tempo"
    : `${lineTimeColumnValue}[${lineTimeGranularityValue}]${lineSeriesDimensionValue !== "__none__" ? ` segmentado por ${lineSeriesDimensionValue}` : ""}`;
  const lineSentencePreview = `${metricLabelByOp[primaryLineMetric.op]} de ${primaryLineMetricColumn === "__none__" ? "*" : primaryLineMetricColumn} por ${lineDimensionPreview}`;

  const setConfig = (patch: Partial<DashboardWidget["config"]>) => {
    setDraft((current) => {
      if (!current) return current;
      const nextConfig = { ...current.config, ...patch };
      return {
        ...current,
        type: nextConfig.widget_type,
        props: nextConfig,
        config: nextConfig,
      };
    });
  };

  const setMetric = (patch: Partial<(typeof metric)>) => {
    const nextMetrics = [...(draft.config.metrics || [{ op: "count", column: resolvedColumns[0]?.name }])];
    nextMetrics[0] = { ...nextMetrics[0], ...patch };
    setConfig({ metrics: nextMetrics });
  };
  const setLineMetrics = (nextMetrics: Array<{ op: MetricOp; column?: string; alias?: string; line_y_axis?: "left" | "right" }>) => {
    setConfig({
      metrics: nextMetrics.map((item, index) => ({
        ...item,
        line_y_axis: item.line_y_axis === "right" ? "right" : index === 0 ? "left" : "right",
      })),
    });
  };
  const setKpiSentenceBaseAgg = (value: string) => {
    const nextAgg = value as MetricOp;
    if (isCompositeSentence && compositeMetric) {
      const nextColumn = countLikeOps.has(nextAgg)
        ? compositeMetric.value_column
        : (compositeMetric.value_column && numericColumns.some((column) => column.name === compositeMetric.value_column)
          ? compositeMetric.value_column
          : numericColumns[0]?.name);
      setConfig({
        composite_metric: {
          ...compositeMetric,
          inner_agg: nextAgg,
          value_column: nextColumn,
        },
      });
      return;
    }
    const nextColumn = countLikeOps.has(nextAgg)
      ? metric.column
      : (metric.column && numericColumns.some((column) => column.name === metric.column)
        ? metric.column
        : numericColumns[0]?.name);
    setMetric({ op: nextAgg, column: nextColumn });
  };
  const setKpiSentenceFinalAgg = (value: string) => {
    if (!isCompositeSentence || !compositeMetric) return;
    setConfig({
      composite_metric: {
        ...compositeMetric,
        outer_agg: value as MetricOp,
      },
    });
  };
  const setKpiSentenceColumn = (value: string) => {
    const nextColumn = value === "__none__" ? undefined : value;
    if (isCompositeSentence && compositeMetric) {
      setConfig({
        composite_metric: {
          ...compositeMetric,
          value_column: nextColumn,
        },
      });
      return;
    }
    setMetric({ column: nextColumn });
  };
  const setBarSentenceAgg = (value: string) => {
    const nextAgg = value as MetricOp;
    const nextColumn = countLikeOps.has(nextAgg)
      ? metric.column
      : (metric.column && numericColumns.some((column) => column.name === metric.column)
        ? metric.column
        : numericColumns[0]?.name);
    setMetric({ op: nextAgg, column: nextColumn });
  };
  const setBarSentenceColumn = (value: string) => {
    setMetric({ column: value === "__none__" ? undefined : value });
  };
  const setKpiSentenceTimeToken = (value: string) => {
    if (!isCompositeSentence || !compositeMetric) return;
    const [column, granularityRaw] = value.split("::");
    const granularity = (kpiGranularityTokenOptions.some((item) => item.value === granularityRaw)
      ? granularityRaw
      : "day") as "day" | "month" | "timestamp";
    setConfig({
      composite_metric: {
        ...compositeMetric,
        time_column: column === "__none__" ? "" : column,
        granularity,
      },
    });
  };

  const createDefaultKpiDependency = (index: number) =>
    normalizeKpiDependencyWidgetId(availableDashboardKpiWidgets[0]?.id) !== undefined
      ? {
          source_type: "widget" as const,
          widget_id: normalizeKpiDependencyWidgetId(availableDashboardKpiWidgets[0]?.id),
          alias: `kpi_${index}`,
        }
      : {
          source_type: "column" as const,
          column: resolvedColumns[0]?.name || "",
          alias: `col_${index}`,
        };

  const handleKpiModeChange = (value: string) => {
    if (!isKpiWidget) return;
    const nextMode = value === "derived" || value === "composite" ? value : "atomic";
    const existingMetrics = (draft.config.metrics || []).length > 0
      ? draft.config.metrics
      : [{ op: "count" as const, column: undefined }];
    const existingKpiDeps = (draft.config.kpi_dependencies || []).length > 0
      ? draft.config.kpi_dependencies
      : [createDefaultKpiDependency(0)];
    setConfig({
      kpi_type: nextMode === "derived" ? "derived" : "atomic",
      composite_metric: nextMode === "composite"
        ? (draft.config.composite_metric || {
            type: "agg_over_time_bucket",
            inner_agg: existingMetrics[0]?.op || "count",
            outer_agg: "avg",
            value_column: existingMetrics[0]?.column,
            time_column: temporalColumns[0]?.name || "",
            granularity: "day",
          })
        : undefined,
      formula: nextMode === "derived" ? (draft.config.formula || "") : undefined,
      dependencies: nextMode === "derived"
        ? extractKpiFormulaRefs(draft.config.formula || "")
        : [],
      kpi_dependencies: nextMode === "derived" ? existingKpiDeps : [],
      metrics: nextMode === "derived" ? [] : [existingMetrics[0]],
    });
  };

  const updateFilter = (index: number, patch: Partial<WidgetFilter>) => {
    const next = [...(draft.config.filters || [])];
    next[index] = { ...next[index], ...patch };
    setConfig({ filters: next });
  };

  const addFilter = () => setConfig({ filters: [...(draft.config.filters || []), { column: "", op: "eq", value: "" }] });
  const removeFilter = (index: number) => setConfig({ filters: (draft.config.filters || []).filter((_, idx) => idx !== index) });

  const save = () => {
    let normalizedDraft = draft;
    if (normalizedDraft.config.widget_type === "kpi") {
      const kpiType = normalizedDraft.config.kpi_type === "derived" ? "derived" : "atomic";
      const draftMetric = normalizedDraft.config.metrics[0]
        || (normalizedDraft.config.composite_metric
          ? {
              op: normalizedDraft.config.composite_metric.inner_agg,
              column: normalizedDraft.config.composite_metric.value_column,
            }
          : { op: "count" as const, column: undefined });
      if (normalizedDraft.config.composite_metric) {
        normalizedDraft = {
          ...normalizedDraft,
          config: {
            ...normalizedDraft.config,
            kpi_type: "atomic",
            formula: undefined,
            dependencies: [],
            kpi_dependencies: [],
            metrics: [],
            kpi_show_trend: !!normalizedDraft.config.kpi_show_trend,
            kpi_decimals: clampKpiDecimals(normalizedDraft.config.kpi_decimals ?? 2),
            composite_metric: {
              ...normalizedDraft.config.composite_metric,
              inner_agg: draftMetric.op,
              value_column: draftMetric.column,
            },
          },
        };
      } else {
        const normalizedFormula = normalizedDraft.config.formula?.trim();
        const dependencies = kpiType === "derived" && normalizedFormula ? extractKpiFormulaRefs(normalizedFormula) : [];
        normalizedDraft = {
          ...normalizedDraft,
          config: {
            ...normalizedDraft.config,
            kpi_type: kpiType,
            formula: kpiType === "derived" ? normalizedFormula : undefined,
            dependencies,
            kpi_dependencies: kpiType === "derived"
              ? normalizeKpiDependencies(normalizedDraft.config.kpi_dependencies || [])
              : [],
            kpi_show_trend: !!normalizedDraft.config.kpi_show_trend,
            kpi_decimals: clampKpiDecimals(normalizedDraft.config.kpi_decimals ?? 2),
            composite_metric: undefined,
            metrics: kpiType === "derived"
              ? []
              : [{ op: draftMetric.op, column: draftMetric.column }],
          },
        };
      }
      normalizedDraft = {
        ...normalizedDraft,
        type: normalizedDraft.config.widget_type,
        props: normalizedDraft.config,
      };
    } else if (normalizedDraft.config.widget_type === "line") {
      const draftLineMetrics = (normalizedDraft.config.metrics.length > 0
        ? normalizedDraft.config.metrics
        : [{ op: "count" as const, column: undefined, line_y_axis: "left" as const }]).slice(0, 2);
      const lineLabelWindow = [3, 5, 7].includes(Number(normalizedDraft.config.line_label_window))
        ? Number(normalizedDraft.config.line_label_window)
        : 3;
      normalizedDraft = {
        ...normalizedDraft,
        config: {
          ...normalizedDraft.config,
          metrics: draftLineMetrics.map((item, index) => ({
            op: item.op,
            column: item.column,
            alias: item.alias,
            line_y_axis: item.line_y_axis === "right" ? "right" : index === 0 ? "left" : "right",
          })),
          line_show_grid: !!normalizedDraft.config.line_show_grid,
          line_data_labels_percent: Math.max(25, Math.min(100, Number(normalizedDraft.config.line_data_labels_percent) || 60)),
          line_label_window: lineLabelWindow,
          line_label_min_gap: Math.max(1, Math.trunc(Number(normalizedDraft.config.line_label_min_gap) || 2)),
          line_label_mode: normalizedDraft.config.line_label_mode === "peak" || normalizedDraft.config.line_label_mode === "valley"
            ? normalizedDraft.config.line_label_mode
            : "both",
        },
      };
      normalizedDraft = {
        ...normalizedDraft,
        type: normalizedDraft.config.widget_type,
        props: normalizedDraft.config,
      };
    }
    onUpdate(normalizedDraft);
    onClose();
  };

  const handlePanelKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Enter" || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.isComposing) return;
    const target = event.target as HTMLElement | null;
    if (!target) return;
    const tagName = target.tagName.toLowerCase();
    if (tagName === "textarea") return;
    if (target.isContentEditable) return;
    if (target.closest("button,[role='button'],[role='combobox'],[data-radix-select-trigger]")) return;
    event.preventDefault();
    save();
  };

  return (
    <aside className="h-full border-l border-border/60 bg-[hsl(var(--card)/0.28)] flex flex-col" onKeyDownCapture={handlePanelKeyDown}>
      <div className="h-14 border-b border-border/60 px-3 flex items-center justify-between gap-2 shrink-0 bg-gradient-to-b from-[hsl(var(--card)/0.65)] to-[hsl(var(--card)/0.4)]">
        <div className="min-w-0 flex items-center gap-2">
          <span className="inline-flex h-7 w-7 items-center justify-center rounded-lg border border-accent/20 bg-accent/10 text-accent">
            <Icon className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <p className="text-label font-semibold text-foreground truncate">{draft.title || "Sem titulo"}</p>
            <p className="text-caption text-muted-foreground truncate">{draft.config.view_name}</p>
          </div>
        </div>
        <Button type="button" variant="ghost" size="icon" className="h-7 w-7" onClick={onClose}>
          <X className="h-4 w-4" />
        </Button>
      </div>

      <div className="px-3 pt-2.5 shrink-0">
        <Input className="h-9 text-caption rounded-xl border-border/70 bg-background/45" value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} placeholder="Renomear widget" />
        <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as TabKey)} className="mt-2">
          <TabsList className="w-full h-9 grid grid-cols-4 rounded-xl bg-background/40 p-1">
            <TabsTrigger value="dados" className="text-caption rounded-lg"><Hash className="h-3.5 w-3.5 mr-1" />Dados</TabsTrigger>
            <TabsTrigger value="visual" className="text-caption rounded-lg"><Palette className="h-3.5 w-3.5 mr-1" />Visual</TabsTrigger>
            <TabsTrigger value="filtros" className="text-caption rounded-lg"><Filter className="h-3.5 w-3.5 mr-1" />Filtros</TabsTrigger>
            <TabsTrigger value="interacoes" className="text-caption rounded-lg"><Wand2 className="h-3.5 w-3.5 mr-1" />Inter.</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      <Separator className="my-2 bg-border/60" />

      <ScrollArea className="flex-1 px-3 pb-3">
        <div className="space-y-3">
          {activeTab === "dados" && (
            <div className="space-y-3">
              <ConfigSection
                title="Metricas"
                icon={Hash}
                badge={isKpiWidget ? kpiModeLabel[kpiMode] : (draft.config.metrics.length || undefined)}
              >
                {isKpiWidget ? (
                  <div className="space-y-2">
                    <div className="space-y-1">
                      <Label className="text-caption text-muted-foreground">Tipo de Métrica</Label>
                      <div className="space-y-2">
                        <Select value={kpiMode} onValueChange={handleKpiModeChange}>
                          <SelectTrigger className="h-auto min-h-[64px] cursor-pointer rounded-lg border-accent/50 bg-accent/10 px-3 py-2 text-left hover:border-accent/70 hover:bg-accent/15">
                            {(() => {
                              const current = kpiModeOptions.find((option) => option.value === kpiMode) || kpiModeOptions[0];
                              return (
                                <div className="min-w-0">
                                  <p className="text-xs font-semibold text-violet-100">{current.title}</p>
                                  <p className="mt-0.5 whitespace-normal text-[11px] leading-4 text-slate-200">{current.description}</p>
                                </div>
                              );
                            })()}
                          </SelectTrigger>
                          <SelectContent>
                            {kpiModeOptions.map((option) => (
                              <SelectItem
                                key={option.value}
                                value={option.value}
                                className="group h-auto cursor-pointer rounded-md py-2 data-[state=checked]:bg-accent data-[state=checked]:text-white"
                              >
                                <div className="min-w-0">
                                  <p className="text-xs font-semibold text-foreground group-data-[state=checked]:text-white">{option.title}</p>
                                  <p className="mt-0.5 whitespace-normal text-[11px] leading-4 text-muted-foreground group-data-[state=checked]:text-slate-100">{option.description}</p>
                                </div>
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    </div>

                    {(kpiMode === "atomic" || kpiMode === "composite") && (
                      <div className="space-y-2">
                        <Label className="text-caption text-muted-foreground">Cálculo</Label>
                        <div className="rounded-lg border border-border/60 bg-background/70 p-2.5">
                          <div className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
                            {isCompositeSentence && (
                              <>
                                <SentenceTokenSelect
                                  tone="agg"
                                  value={kpiSentenceFinalAgg}
                                  onChange={setKpiSentenceFinalAgg}
                                  options={kpiFinalAggOptions.map((item) => ({ value: item.value, label: item.label }))}
                                />
                                <span>de</span>
                                <span>(</span>
                              </>
                            )}
                            <SentenceTokenSelect
                              tone="agg"
                              value={kpiSentenceBaseAgg}
                              onChange={setKpiSentenceBaseAgg}
                              options={kpiBaseAggOptions.map((item) => ({
                                value: item.value,
                                label: item.label,
                                disabled: (item.value === "sum" || item.value === "avg") && numericColumns.length === 0,
                              }))}
                            />
                            <span>de</span>
                            <SentenceTokenSelect
                              tone="column"
                              value={kpiSentenceColumn}
                              onChange={setKpiSentenceColumn}
                              options={[
                                ...(countLikeOps.has(kpiSentenceBaseAgg) ? [{ value: "__none__", label: "sem coluna" }] : []),
                                ...kpiAllowedColumns.map((column) => ({
                                  value: column.name,
                                  label: column.name,
                                })),
                              ]}
                            />
                            {isCompositeSentence && (
                              <>
                                <span>por</span>
                                <SentenceTokenSelect
                                  tone="time"
                                  value={kpiTimeTokenValue}
                                  onChange={setKpiSentenceTimeToken}
                                  options={kpiTimeTokenOptions.length > 0
                                    ? kpiTimeTokenOptions
                                    : [{ value: "__none__::day", label: "sem coluna temporal", disabled: true }]}
                                  placeholder="tempo[gran]"
                                  showCalendarIcon
                                />
                                <span>)</span>
                              </>
                            )}
                          </div>
                        </div>
                        <p className="text-caption text-muted-foreground">Preview: {kpiSentencePreview}</p>
                      </div>
                    )}

                    {kpiMode === "derived" && (
                      <div className="space-y-2">
                        {normalizedDerivedDeps.map((item, index) => (
                          <div key={`kpi-derived-base-${index}`} className="grid grid-cols-[minmax(0,1fr)_112px_minmax(0,1fr)_30px] gap-1.5 items-center">
                            <Input
                              className="h-8 text-xs font-mono"
                              value={item.alias || ""}
                              placeholder={`kpi_${index}`}
                              onChange={(e) => {
                                const nextDeps = [...(draft.config.kpi_dependencies || normalizedDerivedDeps)];
                                nextDeps[index] = { ...nextDeps[index], alias: e.target.value };
                                setConfig({ kpi_dependencies: nextDeps });
                              }}
                            />
                            <Select
                              value={item.source_type === "column" ? "column" : "widget"}
                              onValueChange={(value) => {
                                const nextDeps = [...(draft.config.kpi_dependencies || normalizedDerivedDeps)];
                                nextDeps[index] = value === "column"
                                  ? {
                                      alias: item.alias,
                                      source_type: "column",
                                      column: item.column || resolvedColumns[0]?.name,
                                    }
                                  : {
                                      alias: item.alias,
                                      source_type: "widget",
                                      widget_id: normalizeKpiDependencyWidgetId(item.widget_id)
                                        ?? normalizeKpiDependencyWidgetId(availableDashboardKpiWidgets[0]?.id),
                                    };
                                setConfig({ kpi_dependencies: nextDeps });
                              }}
                            >
                              <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                              <SelectContent>
                                <SelectItem value="widget">KPI</SelectItem>
                                <SelectItem value="column">Coluna</SelectItem>
                              </SelectContent>
                            </Select>
                            <Select
                              value={item.source_type === "column" ? String(item.column || "__none__") : String(item.widget_id || 0)}
                              onValueChange={(value) => {
                                const nextDeps = [...(draft.config.kpi_dependencies || normalizedDerivedDeps)];
                                if (item.source_type === "column") {
                                  nextDeps[index] = { ...item, source_type: "column", column: value === "__none__" ? "" : value };
                                } else {
                                  nextDeps[index] = {
                                    ...item,
                                    source_type: "widget",
                                    widget_id: value === "0" ? undefined : normalizeKpiDependencyWidgetId(value),
                                  };
                                }
                                setConfig({ kpi_dependencies: nextDeps });
                              }}
                            >
                              <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="Base" /></SelectTrigger>
                              <SelectContent>
                                {item.source_type === "column"
                                  ? (
                                    <>
                                      <SelectItem value="__none__">Sem coluna</SelectItem>
                                      {resolvedColumns.map((col) => (
                                        <SelectItem key={`${col.name}:${index}`} value={col.name}>{col.name}</SelectItem>
                                      ))}
                                    </>
                                  )
                                  : availableDashboardKpiWidgets.map((depWidget) => (
                                    <SelectItem key={`${depWidget.id}-${index}`} value={String(depWidget.id)}>
                                      #{depWidget.id} · {depWidget.title || "KPI sem titulo"}
                                    </SelectItem>
                                  ))}
                                {item.source_type === "widget" && availableDashboardKpiWidgets.length === 0 && (
                                  <SelectItem value="0" disabled>Nenhum KPI disponível</SelectItem>
                                )}
                              </SelectContent>
                            </Select>
                            <Button
                              type="button"
                              size="icon"
                              variant="ghost"
                              className="h-8 w-8 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                              onClick={() => {
                                const nextDeps = normalizedDerivedDeps.filter((_, depIndex) => depIndex !== index);
                                setConfig({ kpi_dependencies: nextDeps });
                              }}
                              disabled={normalizedDerivedDeps.length <= 1}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        ))}
                        <div className="flex items-center justify-between gap-2">
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="h-8 text-caption"
                            onClick={() => {
                              const nextDeps = [...normalizedDerivedDeps, createDefaultKpiDependency(normalizedDerivedDeps.length)];
                              setConfig({ kpi_dependencies: nextDeps });
                            }}
                            disabled={resolvedColumns.length === 0 && availableDashboardKpiWidgets.length === 0}
                          >
                            <Plus className="h-3.5 w-3.5 mr-1" />Adicionar base
                          </Button>
                          <span className="text-caption text-muted-foreground">Aliases: {derivedMetricAliases.join(", ") || "-"}</span>
                        </div>
                        <div className="space-y-1">
                          <Label className="text-caption text-muted-foreground">Fórmula</Label>
                          <Input
                            className="h-8 text-xs font-mono"
                            value={draft.config.formula || ""}
                            onChange={(event) =>
                              setConfig({
                                formula: event.target.value,
                                dependencies: extractKpiFormulaRefs(event.target.value),
                              })}
                            placeholder="Ex: SUM(receita) / COUNT(clientes)"
                          />
                        </div>
                      </div>
                    )}

                    <div className="grid grid-cols-[160px_minmax(0,1fr)] items-center gap-2">
                      <Label className="text-caption text-muted-foreground">Comparar periodo</Label>
                      <div className="flex items-center justify-end gap-2">
                        <span className="text-[11px] text-muted-foreground">{draft.config.kpi_show_trend ? "Ativa" : "Desativada"}</span>
                        <Switch
                          checked={!!draft.config.kpi_show_trend}
                          onCheckedChange={(checked) => setConfig({ kpi_show_trend: checked })}
                        />
                      </div>
                    </div>
                  </div>
                ) : (
                  isLineWidget ? (
                    <div className="space-y-2">
                      <div className="rounded-lg border border-border/60 bg-background/70 p-2.5">
                        <div className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
                          <SentenceTokenSelect
                            tone="agg"
                            value={primaryLineMetric.op}
                            onChange={(value) => {
                              const nextOp = value as MetricOp;
                              const nextColumn = countLikeOps.has(nextOp)
                                ? primaryLineMetric.column
                                : (primaryLineMetric.column && numericColumns.some((column) => column.name === primaryLineMetric.column)
                                  ? primaryLineMetric.column
                                  : numericColumns[0]?.name);
                              const nextMetrics = [...lineMetrics];
                              nextMetrics[0] = { ...primaryLineMetric, op: nextOp, column: nextColumn };
                              setLineMetrics(nextMetrics);
                            }}
                            options={metricOps.map((op) => ({
                              value: op,
                              label: metricLabelByOp[op],
                              disabled: (op === "sum" || op === "avg" || op === "min" || op === "max") && numericColumns.length === 0,
                            }))}
                          />
                          <span>de</span>
                          <SentenceTokenSelect
                            tone="column"
                            value={primaryLineMetricColumn}
                            onChange={(value) => {
                              const nextMetrics = [...lineMetrics];
                              nextMetrics[0] = { ...primaryLineMetric, column: value === "__none__" ? undefined : value };
                              setLineMetrics(nextMetrics);
                            }}
                            options={[
                              ...(countLikeOps.has(primaryLineMetric.op) ? [{ value: "__none__", label: "sem coluna" }] : []),
                              ...primaryLineAllowedColumns.map((column) => ({ value: column.name, label: column.name })),
                            ]}
                            placeholder="coluna"
                          />
                          <span>por</span>
                          <SentenceTokenSelect
                            tone="time"
                            value={lineTimeColumnValue}
                            onChange={(value) => setConfig({ time: { column: value === "__none__" ? "" : value, granularity: draft.config.time?.granularity || "day" } })}
                            options={[
                              { value: "__none__", label: "sem tempo" },
                              ...temporalColumns.map((column) => ({ value: column.name, label: column.name })),
                            ]}
                            placeholder="tempo"
                            showCalendarIcon
                          />
                          {lineTimeColumnValue !== "__none__" && (
                            <>
                              <span>como</span>
                              <SentenceTokenSelect
                                tone="time"
                                value={lineTimeGranularityValue}
                                onChange={(value) =>
                                  setConfig({
                                    time: {
                                      column: draft.config.time?.column || "",
                                      granularity: value as "day" | "week" | "month" | "hour" | "timestamp",
                                    },
                                  })}
                                options={[
                                  { value: "day", label: "dia" },
                                  { value: "week", label: "semana" },
                                  { value: "month", label: "mês" },
                                  { value: "hour", label: "hora" },
                                  { value: "timestamp", label: "instante" },
                                ]}
                              />
                            </>
                          )}
                          <span>segmentado por</span>
                          <SentenceTokenSelect
                            tone="segment"
                            value={lineSeriesDimensionValue}
                            onChange={(value) => setConfig({ dimensions: value === "__none__" ? [] : [value] })}
                            options={[
                              { value: "__none__", label: "sem legenda" },
                              ...categoricalColumns.map((column) => ({ value: column.name, label: column.name })),
                            ]}
                            placeholder="legenda"
                          />
                        </div>
                      </div>
                      {lineMetrics.length > 1 && (
                        <div className="space-y-1.5">
                          <Label className="text-caption text-muted-foreground">Metricas adicionais</Label>
                          {lineMetrics.slice(1).map((item, offsetIndex) => {
                            const index = offsetIndex + 1;
                            return (
                              <div key={`line-metric-${index}`} className="grid grid-cols-[112px_minmax(0,1fr)_30px] gap-1.5 items-center">
                          <Select
                            value={item.op}
                            onValueChange={(value) => {
                              const nextOp = value as MetricOp;
                              const nextColumn = countLikeOps.has(nextOp)
                                ? item.column
                                : (item.column && numericColumns.some((column) => column.name === item.column)
                                  ? item.column
                                  : numericColumns[0]?.name);
                              const nextMetrics = [...lineMetrics];
                              nextMetrics[index] = { ...item, op: nextOp, column: nextColumn };
                              setLineMetrics(nextMetrics);
                            }}
                          >
                            <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                            <SelectContent>
                              {metricOps.map((op) => <SelectItem key={`line-op-${index}-${op}`} value={op}>{metricLabelByOp[op]}</SelectItem>)}
                            </SelectContent>
                          </Select>
                          <Select
                            value={item.column || "__none__"}
                            onValueChange={(value) => {
                              const nextMetrics = [...lineMetrics];
                              nextMetrics[index] = { ...item, column: value === "__none__" ? undefined : value };
                              setLineMetrics(nextMetrics);
                            }}
                          >
                            <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="Coluna" /></SelectTrigger>
                            <SelectContent>
                              {item.op === "count" && <SelectItem value="__none__">contagem(*)</SelectItem>}
                              {(countLikeOps.has(item.op) ? resolvedColumns : numericColumns).map((column) => (
                                <SelectItem key={`line-col-${index}-${column.name}`} value={column.name}>{column.name}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          <Button
                            type="button"
                            size="icon"
                            variant="ghost"
                            className="h-8 w-8 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                            onClick={() => setLineMetrics(lineMetrics.filter((_, metricIndex) => metricIndex !== index))}
                            disabled={lineMetrics.length <= 1}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                              </div>
                            );
                          })}
                        </div>
                      )}
                      <div className="flex justify-end">
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="h-8 text-caption"
                          onClick={() => setLineMetrics([...lineMetrics, { op: "count", column: undefined, line_y_axis: "right" }])}
                          disabled={lineMetrics.length >= 2}
                        >
                          <Plus className="h-3.5 w-3.5 mr-1" />Adicionar metrica
                        </Button>
                      </div>
                      <p className="text-caption text-muted-foreground">Preview: {lineSentencePreview}</p>
                    </div>
                  ) : isBarLikeWidget ? (
                    <div className="space-y-2">
                      <Label className="text-caption text-muted-foreground">Calculo</Label>
                      <div className="rounded-lg border border-border/60 bg-background/70 p-2.5">
                        <div className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
                          <SentenceTokenSelect
                            tone="agg"
                            value={barSentenceAgg}
                            onChange={setBarSentenceAgg}
                            options={metricOps.map((op) => ({
                              value: op,
                              label: metricLabelByOp[op] || op,
                              disabled: (op === "sum" || op === "avg" || op === "min" || op === "max") && numericColumns.length === 0,
                            }))}
                          />
                          <span>de</span>
                          <SentenceTokenSelect
                            tone="column"
                            value={barSentenceColumn}
                            onChange={setBarSentenceColumn}
                            options={barSentenceColumnOptions.length > 0
                              ? barSentenceColumnOptions
                              : [{ value: "__none__", label: "sem coluna disponivel", disabled: true }]}
                          />
                          <span>por</span>
                          <SentenceTokenSelect
                            tone={barLikeDimensionIsTemporal ? "time" : "column"}
                            value={barLikeDimensionColumn || "__none__"}
                            onChange={(value) => {
                              if (value === "__none__") {
                                setConfig({ dimensions: [] });
                                return;
                              }
                              const isTemporal = temporalColumns.some((column) => column.name === value);
                              const nextDimension = isTemporal ? buildTemporalDimensionToken(value, "day") : value;
                              if (draft.config.widget_type === "column") {
                                setConfig({
                                  dimensions: [nextDimension],
                                  order_by: [{ column: nextDimension, direction: "asc" }],
                                });
                                return;
                              }
                              setConfig({ dimensions: [nextDimension] });
                            }}
                            options={[
                              { value: "__none__", label: "sem dimensao" },
                              ...categoricalColumns.map((column) => ({ value: column.name, label: column.name })),
                              ...temporalColumns.map((column) => ({ value: column.name, label: column.name })),
                            ]}
                            placeholder="dimensao"
                            showCalendarIcon={barLikeDimensionIsTemporal}
                          />
                          {barLikeDimensionIsTemporal && (
                            <>
                              <span>como</span>
                              <SentenceTokenSelect
                                tone="time"
                                value={barLikeDimensionGranularity}
                                onChange={(value) => {
                                  if (!barLikeDimensionColumn) return;
                                  const nextDimension = buildTemporalDimensionToken(
                                    barLikeDimensionColumn,
                                    value as "day" | "month" | "week" | "weekday" | "hour",
                                  );
                                  if (draft.config.widget_type === "column") {
                                    setConfig({
                                      dimensions: [nextDimension],
                                      order_by: [{ column: nextDimension, direction: "asc" }],
                                    });
                                    return;
                                  }
                                  setConfig({ dimensions: [nextDimension] });
                                }}
                                options={temporalDimensionGranularityOptions.map((option) => ({ value: option.value, label: option.label.toLowerCase() }))}
                              />
                            </>
                          )}
                        </div>
                      </div>
                      <p className="text-caption text-muted-foreground">Preview: {barSentencePreview} por {barLikeDimensionPreview}</p>
                    </div>
                  ) : (
                    <div className="grid grid-cols-[120px_minmax(0,1fr)] gap-2">
                      <Select value={metric.op} onValueChange={(value) => setMetric({ op: value as MetricOp })}>
                        <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                        <SelectContent>{metricOps.map((op) => <SelectItem key={op} value={op}>{op}</SelectItem>)}</SelectContent>
                      </Select>
                      <Select value={metric.column || "__none__"} onValueChange={(value) => setMetric({ column: value === "__none__" ? undefined : value })}>
                        <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="Coluna" /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="__none__">Sem coluna</SelectItem>
                          {(countLikeOps.has(metric.op) ? resolvedColumns : numericColumns).map((column) => (
                            <SelectItem key={column.name} value={column.name}>{column.name}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  )
                )}
              </ConfigSection>

              {isDonutWidget && (
                <ConfigSection title="Dimensao" icon={Hash} badge={draft.config.dimensions.length || undefined}>
                  {
                    <Select value={draft.config.dimensions[0] || "__none__"} onValueChange={(value) => setConfig({ dimensions: value === "__none__" ? [] : [value] })}>
                      <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="Dimensao" /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__none__">Sem dimensao</SelectItem>
                        {categoricalColumns.map((column) => <SelectItem key={column.name} value={column.name}>{column.name}</SelectItem>)}
                        {temporalColumns.map((column) => <SelectItem key={`temporal-${column.name}`} value={column.name}>{column.name}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  }
                </ConfigSection>
              )}

              {(isBarLikeWidget || isLineWidget) && (
                <ConfigSection title="Formatação" icon={Type} defaultOpen={false}>
                  {isBarLikeWidget && (
                    <div className="grid grid-cols-[120px_minmax(0,1fr)] items-center gap-2">
                      <Label className="text-caption text-muted-foreground">Alias da métrica</Label>
                      <Input
                        className="h-8 text-xs"
                        value={metric.alias || ""}
                        placeholder="Ex: Recargas"
                        onChange={(event) => {
                          const value = event.target.value;
                          setMetric({ alias: value.trim() ? value : undefined });
                        }}
                      />
                    </div>
                  )}
                  {isLineWidget && (
                    <div className="space-y-2">
                      {lineMetrics.map((item, index) => (
                        <div key={`line-alias-${index}`} className="grid grid-cols-[120px_minmax(0,1fr)] items-center gap-2">
                          <Label className="text-caption text-muted-foreground">Alias m{index + 1}</Label>
                          <Input
                            className="h-8 text-xs"
                            value={item.alias || ""}
                            placeholder={`Ex: Serie ${index + 1}`}
                            onChange={(event) => {
                              const nextMetrics = [...lineMetrics];
                              nextMetrics[index] = { ...item, alias: event.target.value || undefined };
                              setLineMetrics(nextMetrics);
                            }}
                          />
                        </div>
                      ))}
                    </div>
                  )}
                  <div className="grid grid-cols-2 gap-2">
                    <Input
                      className="h-8 text-xs"
                      value={draft.config.kpi_prefix || ""}
                      placeholder="Prefixo (ex: R$)"
                      onChange={(event) => setConfig({ kpi_prefix: event.target.value || undefined })}
                    />
                    <Input
                      className="h-8 text-xs"
                      value={draft.config.kpi_suffix || ""}
                      placeholder="Sufixo (ex: %)"
                      onChange={(event) => setConfig({ kpi_suffix: event.target.value || undefined })}
                    />
                  </div>
                </ConfigSection>
              )}

              {(isCategoricalChart || isLineWidget || draft.config.widget_type === "table") && (
                <ConfigSection title="Ordenação" icon={ArrowUpDown} badge={currentOrder ? 1 : undefined}>
                  {isCategoricalChart ? (
                    <div className="space-y-2">
                      <div className="grid grid-cols-[minmax(0,1fr)_132px] gap-2">
                        <Select
                          value={orderTargetValue}
                          onValueChange={(value) => {
                            if (value === "__none__") {
                              setConfig({ order_by: [] });
                              return;
                            }
                            if (value === "__metric__") {
                              setConfig({ order_by: [{ metric_ref: "m0", direction: currentOrder?.direction || "desc" }] });
                              return;
                            }
                            setConfig({ order_by: [{ column: value, direction: currentOrder?.direction || "desc" }] });
                          }}
                        >
                          <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="Sem ordenação" /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="__none__">Sem ordenação</SelectItem>
                            <SelectItem value="__metric__">Pela métrica</SelectItem>
                            {draft.config.dimensions[0] && <SelectItem value={draft.config.dimensions[0]}>Pela dimensão</SelectItem>}
                          </SelectContent>
                        </Select>
                        <Select
                          value={currentOrder?.direction || "desc"}
                          onValueChange={(value) => {
                            if (!currentOrder) return;
                            setConfig({
                              order_by: [{ ...currentOrder, direction: value as "asc" | "desc" }],
                            });
                          }}
                          disabled={!currentOrder}
                        >
                          <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="asc">CRESCENTE</SelectItem>
                            <SelectItem value="desc">DECRESCENTE</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      {(isBarLikeWidget || isDonutWidget) && (
                        <div className="grid grid-cols-[96px_minmax(0,1fr)] items-center gap-2">
                          <Label className="text-caption text-muted-foreground">Top N</Label>
                          <Input
                            type="number"
                            min={1}
                            className="h-8 text-xs"
                            value={draft.config.top_n ?? ""}
                            placeholder="Vazio = sem limite"
                            onChange={(event) => {
                              const raw = event.target.value.trim();
                              if (!raw) {
                                setConfig({ top_n: undefined });
                                return;
                              }
                              setConfig({ top_n: Math.max(1, Math.trunc(Number(raw) || 1)) });
                            }}
                          />
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="grid grid-cols-[minmax(0,1fr)_132px] gap-2">
                      <Select
                        value={currentOrder?.column || "__none__"}
                        onValueChange={(value) => {
                          if (value === "__none__") {
                            setConfig({ order_by: [] });
                            return;
                          }
                          setConfig({ order_by: [{ column: value, direction: currentOrder?.direction || "desc" }] });
                        }}
                      >
                        <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="Sem ordenação" /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="__none__">Sem ordenação</SelectItem>
                          {resolvedColumns.map((column) => <SelectItem key={`order-${column.name}`} value={column.name}>{column.name}</SelectItem>)}
                        </SelectContent>
                      </Select>
                      <Select
                        value={currentOrder?.direction || "desc"}
                        onValueChange={(value) => {
                          if (!currentOrder) return;
                          setConfig({ order_by: [{ ...currentOrder, direction: value as "asc" | "desc" }] });
                        }}
                        disabled={!currentOrder}
                      >
                        <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="asc">CRESCENTE</SelectItem>
                          <SelectItem value="desc">DECRESCENTE</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  )}
                </ConfigSection>
              )}

              {draft.config.widget_type === "kpi" && (
                <ConfigSection title="Formatação" icon={Type} defaultOpen={false}>
                  <Select
                    value={kpiFormattingMode}
                    onValueChange={(value) => setConfig({ kpi_show_as: value as "number_2" | "integer" })}
                  >
                    <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {kpiShowAsOptions.map((option) => (
                        <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <div className="grid grid-cols-[120px_minmax(0,1fr)] items-center gap-2">
                    <Label className="text-caption text-muted-foreground">Abreviacao</Label>
                    <Select
                      value={draft.config.kpi_abbreviation_mode || "always"}
                      onValueChange={(value) => setConfig({ kpi_abbreviation_mode: value as "auto" | "always" })}
                    >
                      <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {kpiAbbreviationModeOptions.map((option) => (
                          <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  {kpiFormattingMode !== "integer" && (
                    <div className="grid grid-cols-[120px_minmax(0,1fr)] items-center gap-2">
                      <Label className="text-caption text-muted-foreground">Casas decimais</Label>
                      <Input
                        type="number"
                        min={0}
                        max={8}
                        className="h-8 text-xs"
                        value={draft.config.kpi_decimals ?? 2}
                        onChange={(event) => setConfig({ kpi_decimals: clampKpiDecimals(event.target.value) })}
                      />
                    </div>
                  )}
                  <div className="grid grid-cols-2 gap-2">
                    <Input className="h-8 text-xs" value={draft.config.kpi_prefix || ""} placeholder="Prefixo (ex: R$)" onChange={(event) => setConfig({ kpi_prefix: event.target.value || undefined })} />
                    <Input className="h-8 text-xs" value={draft.config.kpi_suffix || ""} placeholder="Sufixo (ex: %)" onChange={(event) => setConfig({ kpi_suffix: event.target.value || undefined })} />
                  </div>
                </ConfigSection>
              )}

              {draft.config.widget_type === "table" && (
                <ConfigSection title="Tabela" icon={Table2} defaultOpen={false}>
                  <div className="grid grid-cols-[120px_minmax(0,1fr)] items-center gap-2">
                    <Label className="text-caption text-muted-foreground">Itens por pagina</Label>
                    <Select
                      value={String(draft.config.table_page_size || 25)}
                      onValueChange={(value) => setConfig({ table_page_size: Math.max(1, Number(value) || 25) })}
                    >
                      <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="10">10</SelectItem>
                        <SelectItem value="25">25</SelectItem>
                        <SelectItem value="50">50</SelectItem>
                        <SelectItem value="100">100</SelectItem>
                        <SelectItem value="200">200</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </ConfigSection>
              )}
            </div>
          )}

          {activeTab === "visual" && (
            <div className="space-y-3">
              <ConfigSection title="Layout" icon={Palette}>
                <div className="flex items-center justify-between"><Label className="text-caption text-muted-foreground">Mostrar título</Label><Switch checked={draft.config.show_title !== false} onCheckedChange={(checked) => setConfig({ show_title: checked })} /></div>
              </ConfigSection>

              {hasChartOptions && (
                <ConfigSection title="Opcoes do grafico" icon={BarChart3} defaultOpen={false}>

                  {isLineWidget && (
                    <>
                      <div className="flex items-center justify-between">
                        <Label className="text-caption text-muted-foreground">Mostrar linhas de grade</Label>
                        <Switch checked={draft.config.line_show_grid !== false} onCheckedChange={(checked) => setConfig({ line_show_grid: checked })} />
                      </div>
                      <div className="flex items-center justify-between">
                        <Label className="text-caption text-muted-foreground">Mostrar rotulos de dados</Label>
                        <Switch
                          checked={!!draft.config.line_data_labels_enabled}
                          onCheckedChange={(checked) =>
                            setConfig({
                              line_data_labels_enabled: checked,
                              line_data_labels_percent: Math.max(25, Math.min(100, draft.config.line_data_labels_percent || 60)),
                              line_label_window: [3, 5, 7].includes(Number(draft.config.line_label_window)) ? draft.config.line_label_window : 3,
                              line_label_min_gap: Math.max(1, Number(draft.config.line_label_min_gap) || 2),
                              line_label_mode: draft.config.line_label_mode || "both",
                            })}
                        />
                      </div>
                      <div className="grid grid-cols-[140px_minmax(0,1fr)] items-center gap-2">
                        <Label className="text-caption text-muted-foreground">Sensibilidade (%)</Label>
                        <Select
                          value={String(draft.config.line_data_labels_percent ?? 60)}
                          onValueChange={(value) => setConfig({ line_data_labels_percent: Math.max(25, Math.min(100, Number(value) || 60)) })}
                          disabled={!draft.config.line_data_labels_enabled}
                        >
                          <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="25">25%</SelectItem>
                            <SelectItem value="50">50%</SelectItem>
                            <SelectItem value="75">75%</SelectItem>
                            <SelectItem value="100">100%</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="grid grid-cols-[140px_minmax(0,1fr)] items-center gap-2">
                        <Label className="text-caption text-muted-foreground">Janela (pontos)</Label>
                        <Select
                          value={String(([3, 5, 7].includes(Number(draft.config.line_label_window)) ? draft.config.line_label_window : 3))}
                          onValueChange={(value) => setConfig({ line_label_window: Number(value) as 3 | 5 | 7 })}
                          disabled={!draft.config.line_data_labels_enabled}
                        >
                          <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="3">3</SelectItem>
                            <SelectItem value="5">5</SelectItem>
                            <SelectItem value="7">7</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="grid grid-cols-[140px_minmax(0,1fr)] items-center gap-2">
                        <Label className="text-caption text-muted-foreground">Gap minimo</Label>
                        <Input
                          type="number"
                          min={1}
                          max={12}
                          className="h-8 text-xs"
                          value={draft.config.line_label_min_gap ?? 2}
                          onChange={(event) => setConfig({ line_label_min_gap: Math.max(1, Math.min(12, Math.trunc(Number(event.target.value) || 1))) })}
                          disabled={!draft.config.line_data_labels_enabled}
                        />
                      </div>
                      <div className="grid grid-cols-[140px_minmax(0,1fr)] items-center gap-2">
                        <Label className="text-caption text-muted-foreground">Modo de evento</Label>
                        <Select
                          value={draft.config.line_label_mode || "both"}
                          onValueChange={(value) => setConfig({ line_label_mode: value as "peak" | "valley" | "both" })}
                          disabled={!draft.config.line_data_labels_enabled}
                        >
                          <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="both">Picos e vales</SelectItem>
                            <SelectItem value="peak">Somente picos</SelectItem>
                            <SelectItem value="valley">Somente vales</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                    </>
                  )}

                  {isBarLikeWidget && (
                    <>
                      <div className="flex items-center justify-between">
                        <Label className="text-caption text-muted-foreground">Mostrar linhas de grade</Label>
                        <Switch checked={!!draft.config.bar_show_grid} onCheckedChange={(checked) => setConfig({ bar_show_grid: checked })} />
                      </div>
                      <div className="flex items-center justify-between">
                        <Label className="text-caption text-muted-foreground">Mostrar rótulos de dados</Label>
                        <Switch checked={draft.config.bar_data_labels_enabled !== false} onCheckedChange={(checked) => setConfig({ bar_data_labels_enabled: checked })} />
                      </div>
                      <div className="flex items-center justify-between">
                        <Label className="text-caption text-muted-foreground">Mostrar % junto ao valor</Label>
                        <Switch checked={!!draft.config.bar_show_percent_of_total} onCheckedChange={(checked) => setConfig({ bar_show_percent_of_total: checked })} />
                      </div>
                    </>
                  )}

                  {isDonutWidget && (
                    <>
                      <div className="flex items-center justify-between">
                        <Label className="text-caption text-muted-foreground">Mostrar legenda</Label>
                        <Switch checked={draft.config.donut_show_legend !== false} onCheckedChange={(checked) => setConfig({ donut_show_legend: checked })} />
                      </div>
                      <div className="flex items-center justify-between">
                        <Label className="text-caption text-muted-foreground">Mostrar rótulos de dados</Label>
                        <Switch checked={!!draft.config.donut_data_labels_enabled} onCheckedChange={(checked) => setConfig({ donut_data_labels_enabled: checked })} />
                      </div>
                      <div className="flex items-center justify-between">
                        <Label className="text-caption text-muted-foreground">Agrupar em Outros</Label>
                        <Switch checked={draft.config.donut_group_others_enabled !== false} onCheckedChange={(checked) => setConfig({ donut_group_others_enabled: checked })} />
                      </div>
                      <div className="grid grid-cols-[140px_minmax(0,1fr)] items-center gap-2">
                        <Label className="text-caption text-muted-foreground">Top N categorias</Label>
                        <Input
                          type="number"
                          min={2}
                          max={12}
                          className="h-8 text-xs"
                          value={draft.config.donut_group_others_top_n ?? 3}
                          onChange={(event) => setConfig({ donut_group_others_top_n: Math.max(2, Math.min(12, Math.trunc(Number(event.target.value) || 3))) })}
                          disabled={draft.config.donut_group_others_enabled === false}
                        />
                      </div>
                      <div className="grid grid-cols-[140px_minmax(0,1fr)] items-center gap-2">
                        <Label className="text-caption text-muted-foreground">Exibir valores</Label>
                        <Select
                          value={draft.config.donut_metric_display || "value"}
                          onValueChange={(value) => setConfig({ donut_metric_display: value === "percent" ? "percent" : "value" })}
                        >
                          <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="value">Valor</SelectItem>
                            <SelectItem value="percent">Percentual</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="grid grid-cols-[140px_minmax(0,1fr)] items-center gap-2">
                        <Label className="text-caption text-muted-foreground">Percentual mínimo</Label>
                        <Input
                          type="number"
                          min={1}
                          max={100}
                          className="h-8 text-xs"
                          value={draft.config.donut_data_labels_min_percent ?? 6}
                          onChange={(event) => setConfig({ donut_data_labels_min_percent: Math.max(1, Math.min(100, Number(event.target.value) || 6)) })}
                          disabled={!draft.config.donut_data_labels_enabled}
                        />
                      </div>
                    </>
                  )}
                </ConfigSection>
              )}

              {draft.config.widget_type !== "table" && draft.config.widget_type !== "dre" && (
                <ConfigSection title="Paleta de cores" icon={Palette} defaultOpen={false}>
                  {(Object.keys(paletteByName) as Array<keyof typeof paletteByName>).map((paletteName) => {
                    const selected = (draft.config.visual_palette || "default") === paletteName;
                    return (
                      <button key={paletteName} type="button" className={cn("w-full rounded-md border px-2.5 py-1.5", selected ? "border-accent/40 bg-accent/10" : "border-border/70 bg-background hover:bg-muted/50")} onClick={() => setConfig({ visual_palette: paletteName })}>
                        <div className="flex items-center justify-between"><div className="flex gap-1">{paletteByName[paletteName].map((colorClass) => <span key={`${paletteName}-${colorClass}`} className={cn("h-3 w-3 rounded-full border border-background/40", colorClass)} />)}</div><span className="text-caption text-muted-foreground">{paletteName}</span></div>
                      </button>
                    );
                  })}
                </ConfigSection>
              )}
            </div>
          )}

          {activeTab === "filtros" && (
            <div className="space-y-3">
              <ConfigSection title="Regras de filtro" icon={Filter} badge={(draft.config.filters || []).length || undefined}>
                <div className="flex items-center justify-between">
                  <Button type="button" variant="outline" size="sm" className="h-8 text-caption" onClick={addFilter}><Plus className="h-3.5 w-3.5 mr-1" />Adicionar filtro</Button>
                  {(draft.config.filters || []).length > 1 && <Button type="button" variant="outline" size="sm" className="h-8 text-caption" onClick={() => setFilterJoin((current) => current === "AND" ? "OR" : "AND")}>{filterJoin}</Button>}
                </div>
                {(draft.config.filters || []).map((filter, index) => (
                  <div key={`filter-${index}`} className="rounded-xl border border-border/60 bg-background/45 p-2 space-y-2">
                    {(() => {
                      const selectedColumn = resolvedColumns.find((column) => column.name === filter.column);
                      const isTemporal = normalizeColumnType(selectedColumn?.type || "") === "temporal";
                      const operatorOptions = isTemporal ? temporalFilterOps : commonFilterOps;
                      const isRelativeTemporalFilter = isTemporal
                        && filter.op === "between"
                        && typeof filter.value === "object"
                        && !!filter.value
                        && !Array.isArray(filter.value)
                        && "relative" in (filter.value as Record<string, unknown>);
                      const temporalOpUiValue = isRelativeTemporalFilter ? "__relative__" : filter.op;
                      const scalarValue = Array.isArray(filter.value) ? String(filter.value[0] || "") : String(filter.value || "");
                      const listValue = Array.isArray(filter.value)
                        ? filter.value.map((item) => String(item)).join(", ")
                        : String(filter.value || "");
                      const betweenValues = Array.isArray(filter.value)
                        ? [String(filter.value[0] || ""), String(filter.value[1] || "")]
                        : ["", ""];
                      const singleDate = parseDateValue(scalarValue);
                      const rangeValue: DateRange = {
                        from: parseDateValue(betweenValues[0]),
                        to: parseDateValue(betweenValues[1]),
                      };

                      return (
                        <>
                          <div className="grid grid-cols-[minmax(0,1fr)_120px_30px] gap-1.5">
                            <Select
                              value={filter.column || "__none__"}
                              onValueChange={(value) => updateFilter(index, { column: value === "__none__" ? "" : value, op: "eq", value: "" })}
                            >
                              <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="Coluna" /></SelectTrigger>
                              <SelectContent>
                                <SelectItem value="__none__">Sem coluna</SelectItem>
                                {resolvedColumns.map((column) => <SelectItem key={column.name} value={column.name}>{column.name}</SelectItem>)}
                              </SelectContent>
                            </Select>
                            <Select
                              value={isTemporal ? temporalOpUiValue : filter.op}
                              onValueChange={(value) => updateFilter(index, {
                                op: (value === "__relative__" ? "between" : value) as WidgetFilter["op"],
                                value: value === "__relative__"
                                  ? { relative: "last_7_days" }
                                  : value === "between"
                                    ? ["", ""]
                                    : nullOps.has(value as WidgetFilter["op"])
                                      ? undefined
                                      : "",
                              })}
                              disabled={!filter.column}
                            >
                              <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                              <SelectContent>{operatorOptions.map((op) => <SelectItem key={op.value} value={op.value}>{op.label}</SelectItem>)}</SelectContent>
                            </Select>
                            <Button type="button" size="icon" variant="ghost" className="h-8 w-8 text-muted-foreground hover:text-destructive hover:bg-destructive/10" onClick={() => removeFilter(index)}><Trash2 className="h-3.5 w-3.5" /></Button>
                          </div>

                          {!isTemporal && !nullOps.has(filter.op) && !listOps.has(filter.op) && filter.op !== "between" && (
                            <Input
                              className="h-8 text-xs"
                              value={scalarValue}
                              onChange={(event) => updateFilter(index, { value: event.target.value })}
                              placeholder="Valor"
                              disabled={!filter.column}
                            />
                          )}

                          {!isTemporal && listOps.has(filter.op) && (
                            <Input
                              className="h-8 text-xs"
                              value={listValue}
                              onChange={(event) => updateFilter(index, { value: event.target.value.split(",").map((v) => v.trim()).filter(Boolean) })}
                              placeholder="Ex: A, B, C"
                              disabled={!filter.column}
                            />
                          )}

                          {!isTemporal && filter.op === "between" && (
                            <div className="flex items-center gap-1.5">
                              <Input
                                className="h-8 text-xs"
                                value={betweenValues[0]}
                                onChange={(event) => updateFilter(index, { value: [event.target.value, betweenValues[1]] })}
                                placeholder="De"
                                disabled={!filter.column}
                              />
                              <Input
                                className="h-8 text-xs"
                                value={betweenValues[1]}
                                onChange={(event) => updateFilter(index, { value: [betweenValues[0], event.target.value] })}
                                placeholder="Ate"
                                disabled={!filter.column}
                              />
                            </div>
                          )}

                          {isTemporal && listOps.has(filter.op) && (
                            <Input
                              className="h-8 text-xs"
                              value={listValue}
                              onChange={(event) => updateFilter(index, { value: event.target.value.split(",").map((v) => v.trim()).filter(Boolean) })}
                              placeholder="Ex: 2026-01-01, 2026-01-15"
                              disabled={!filter.column}
                            />
                          )}

                          {isTemporal && isRelativeTemporalFilter && (
                            <Select
                              value={String((filter.value as Record<string, unknown>)?.relative || "last_7_days")}
                              onValueChange={(value) => updateFilter(index, { op: "between", value: { relative: value } })}
                              disabled={!filter.column}
                            >
                              <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                              <SelectContent>
                                {relativeDateOptions.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}
                              </SelectContent>
                            </Select>
                          )}

                          {isTemporal && filter.op !== "between" && !nullOps.has(filter.op) && !listOps.has(filter.op) && (
                            <Popover>
                              <PopoverTrigger asChild>
                                <Button
                                  type="button"
                                  variant="outline"
                                  className={cn("h-8 w-full justify-start text-left text-xs font-normal", !singleDate && "text-muted-foreground")}
                                  disabled={!filter.column}
                                >
                                  <Calendar className="mr-2 h-3.5 w-3.5" />
                                  {singleDate ? formatDateLabel(singleDate) : "Selecionar data"}
                                </Button>
                              </PopoverTrigger>
                              <PopoverContent className="w-auto p-0" align="start">
                                <DatePicker
                                  mode="single"
                                  selected={singleDate}
                                  onSelect={(date) => updateFilter(index, { value: date ? dateToApi(date) : "" })}
                                />
                              </PopoverContent>
                            </Popover>
                          )}

                          {isTemporal && filter.op === "between" && !isRelativeTemporalFilter && (
                            <Popover>
                              <PopoverTrigger asChild>
                                <Button
                                  type="button"
                                  variant="outline"
                                  className={cn("h-8 w-full justify-start text-left text-xs font-normal", (!rangeValue.from || !rangeValue.to) && "text-muted-foreground")}
                                  disabled={!filter.column}
                                >
                                  <Calendar className="mr-2 h-3.5 w-3.5" />
                                  {rangeValue.from && rangeValue.to
                                    ? `${formatDateLabel(rangeValue.from)} - ${formatDateLabel(rangeValue.to)}`
                                    : "Selecionar intervalo"}
                                </Button>
                              </PopoverTrigger>
                              <PopoverContent className="w-auto p-0" align="start">
                                <DatePicker
                                  mode="range"
                                  selected={rangeValue}
                                  onSelect={(range) => updateFilter(index, { value: [range?.from ? dateToApi(range.from) : "", range?.to ? dateToApi(range.to) : ""] })}
                                  numberOfMonths={2}
                                />
                              </PopoverContent>
                            </Popover>
                          )}
                        </>
                      );
                    })()}
                  </div>
                ))}
              </ConfigSection>
            </div>
          )}

          {activeTab === "interacoes" && (
            <ConfigSection title="Interações" icon={Wand2} defaultOpen={false}>
              <div className="p-1 text-center">
                <Sparkles className="h-5 w-5 text-accent mx-auto mb-2" />
                <p className="text-label font-semibold text-foreground">Em breve</p>
                <p className="text-caption text-muted-foreground mt-1">Drilldown e navegacao entre widgets.</p>
              </div>
            </ConfigSection>
          )}
        </div>
      </ScrollArea>

      <div className="h-14 border-t border-border/60 bg-[hsl(var(--card)/0.6)] backdrop-blur-sm px-3 flex items-center gap-2 shrink-0">
        <Button className="flex-1 h-9 text-caption rounded-xl bg-accent text-accent-foreground hover:bg-accent/90" onClick={save}>Concluir</Button>
        <Button type="button" variant="ghost" size="icon" className="h-9 w-9 text-muted-foreground hover:text-destructive hover:bg-destructive/10" onClick={onDelete}><Trash2 className="h-4 w-4" /></Button>
      </div>
    </aside>
  );
};

export default BuilderRightPanel;
