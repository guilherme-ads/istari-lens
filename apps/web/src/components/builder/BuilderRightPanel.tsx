import { useEffect, useMemo, useState, type ElementType, type ReactNode } from "react";
import { ArrowUpDown, BarChart3, Calendar, ChevronDown, Columns3, Filter, Hash, LineChart, MousePointer, Palette, PieChart, Sparkles, Table2, Type, Wand2, X, Trash2, Plus } from "lucide-react";

import type { DashboardWidget, MetricOp, WidgetFilter } from "@/types/dashboard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
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
const filterOps: Array<{ value: WidgetFilter["op"]; label: string }> = [
  { value: "eq", label: "=" },
  { value: "neq", label: "!=" },
  { value: "gt", label: ">" },
  { value: "lt", label: "<" },
  { value: "gte", label: ">=" },
  { value: "lte", label: "<=" },
  { value: "contains", label: "contem" },
  { value: "between", label: "entre" },
  { value: "in", label: "in" },
  { value: "not_in", label: "not in" },
  { value: "is_null", label: "nulo" },
  { value: "not_null", label: "nao nulo" },
];

const paletteByName: Record<"default" | "warm" | "cool" | "mono" | "vivid", string[]> = {
  default: ["bg-chart-1", "bg-chart-2", "bg-chart-3", "bg-chart-4", "bg-chart-5"],
  warm: ["bg-warning", "bg-highlight", "bg-destructive", "bg-chart-3", "bg-chart-5"],
  cool: ["bg-chart-4", "bg-chart-6", "bg-chart-7", "bg-chart-1", "bg-chart-2"],
  mono: ["bg-foreground", "bg-foreground/80", "bg-foreground/60", "bg-foreground/40", "bg-foreground/20"],
  vivid: ["bg-accent", "bg-chart-7", "bg-chart-8", "bg-success", "bg-chart-5"],
};

const kpiShowAsOptions: Array<{ value: "number_2" | "integer" | "currency_brl" | "percent"; label: string }> = [
  { value: "number_2", label: "Decimal (2 casas)" },
  { value: "integer", label: "Inteiro" },
  { value: "currency_brl", label: "Moeda (BRL)" },
  { value: "percent", label: "Percentual" },
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
  tone: "agg" | "column" | "time";
  placeholder?: string;
  showCalendarIcon?: boolean;
}) => {
  const toneClass = tone === "agg"
    ? "border-violet-500/40 bg-violet-500/10 text-violet-300"
    : tone === "column"
      ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
      : "border-sky-500/40 bg-sky-500/10 text-sky-300";
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
    setDraft(widget);
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
  const currentOrder = draft.config.order_by[0];
  const orderTargetValue = currentOrder?.metric_ref ? "__metric__" : currentOrder?.column || "__none__";

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
    }
    onUpdate(normalizedDraft);
    onClose();
  };

  return (
    <aside className="h-full border-l border-border/60 bg-[hsl(var(--card)/0.28)] flex flex-col">
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
                                { value: "__none__", label: "sem coluna", disabled: !countLikeOps.has(kpiSentenceBaseAgg) },
                                ...resolvedColumns.map((column) => ({
                                  value: column.name,
                                  label: column.name,
                                  disabled: !countLikeOps.has(kpiSentenceBaseAgg) && !numericColumns.some((numCol) => numCol.name === column.name),
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
                )}
              </ConfigSection>

              {(isCategoricalChart || isLineWidget) && (
                <ConfigSection title="Dimensao" icon={Hash} badge={draft.config.dimensions.length || undefined}>
                  {isLineWidget ? (
                    <>
                      <div className="grid grid-cols-2 gap-2">
                        <Select value={draft.config.time?.column || "__none__"} onValueChange={(value) => setConfig({ time: { column: value === "__none__" ? "" : value, granularity: draft.config.time?.granularity || "day" } })}>
                          <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="Tempo" /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="__none__">Sem tempo</SelectItem>
                            {temporalColumns.map((column) => <SelectItem key={column.name} value={column.name}>{column.name}</SelectItem>)}
                          </SelectContent>
                        </Select>
                        <Select value={draft.config.time?.granularity || "day"} onValueChange={(value) => setConfig({ time: { column: draft.config.time?.column || "", granularity: value as "day" | "week" | "month" | "hour" | "timestamp" } })}>
                          <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="day">Dia</SelectItem>
                            <SelectItem value="week">Semana</SelectItem>
                            <SelectItem value="month">Mês</SelectItem>
                            <SelectItem value="hour">Hora</SelectItem>
                            <SelectItem value="timestamp">Timestamp</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      <Select value={draft.config.dimensions[0] || "__none__"} onValueChange={(value) => setConfig({ dimensions: value === "__none__" ? [] : [value] })}>
                        <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="Legenda (series)" /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="__none__">Sem legenda</SelectItem>
                          {categoricalColumns.map((column) => <SelectItem key={column.name} value={column.name}>{column.name}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    </>
                  ) : (
                    <Select value={draft.config.dimensions[0] || "__none__"} onValueChange={(value) => setConfig({ dimensions: value === "__none__" ? [] : [value] })}>
                      <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="Dimensão" /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__none__">Sem dimensão</SelectItem>
                        {categoricalColumns.map((column) => <SelectItem key={column.name} value={column.name}>{column.name}</SelectItem>)}
                        {temporalColumns.map((column) => <SelectItem key={`temporal-${column.name}`} value={column.name}>{column.name}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  )}
                </ConfigSection>
              )}

              {(isCategoricalChart || isLineWidget || draft.config.widget_type === "table") && (
                <ConfigSection title="Ordenação" icon={ArrowUpDown} badge={currentOrder ? 1 : undefined}>
                  {isCategoricalChart ? (
                    <div className="space-y-2">
                      <div className="grid grid-cols-[minmax(0,1fr)_88px] gap-2">
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
                    <div className="grid grid-cols-[minmax(0,1fr)_88px] gap-2">
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
                    value={draft.config.kpi_show_as || "number_2"}
                    onValueChange={(value) => setConfig({ kpi_show_as: value as "number_2" | "integer" | "currency_brl" | "percent" })}
                  >
                    <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {kpiShowAsOptions.map((option) => (
                        <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
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
                        <Switch checked={!!draft.config.line_data_labels_enabled} onCheckedChange={(checked) => setConfig({ line_data_labels_enabled: checked })} />
                      </div>
                      <div className="grid grid-cols-[140px_minmax(0,1fr)] items-center gap-2">
                        <Label className="text-caption text-muted-foreground">Sensibilidade (%)</Label>
                        <Input
                          type="number"
                          min={25}
                          max={100}
                          className="h-8 text-xs"
                          value={draft.config.line_data_labels_percent ?? 60}
                          onChange={(event) => {
                            const nextValue = Math.max(25, Math.min(100, Number(event.target.value) || 60));
                            setConfig({ line_data_labels_percent: nextValue });
                          }}
                          disabled={!draft.config.line_data_labels_enabled}
                        />
                      </div>
                      <div className="grid grid-cols-[140px_minmax(0,1fr)] items-center gap-2">
                        <Label className="text-caption text-muted-foreground">Janela (pontos)</Label>
                        <Input
                          type="number"
                          min={1}
                          max={12}
                          className="h-8 text-xs"
                          value={draft.config.line_label_window ?? 3}
                          onChange={(event) => setConfig({ line_label_window: Math.max(1, Math.min(12, Math.trunc(Number(event.target.value) || 1))) })}
                          disabled={!draft.config.line_data_labels_enabled}
                        />
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
                    <div className="grid grid-cols-[minmax(0,1fr)_120px_30px] gap-1.5">
                      <Select value={filter.column || "__none__"} onValueChange={(value) => updateFilter(index, { column: value === "__none__" ? "" : value })}>
                        <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="Coluna" /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="__none__">Sem coluna</SelectItem>
                          {resolvedColumns.map((column) => <SelectItem key={column.name} value={column.name}>{column.name}</SelectItem>)}
                        </SelectContent>
                      </Select>
                      <Select value={filter.op} onValueChange={(value) => updateFilter(index, { op: value as WidgetFilter["op"] })}>
                        <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                        <SelectContent>{filterOps.map((op) => <SelectItem key={op.value} value={op.value}>{op.label}</SelectItem>)}</SelectContent>
                      </Select>
                      <Button type="button" size="icon" variant="ghost" className="h-8 w-8 text-muted-foreground hover:text-destructive hover:bg-destructive/10" onClick={() => removeFilter(index)}><Trash2 className="h-3.5 w-3.5" /></Button>
                    </div>
                    {filter.op !== "is_null" && filter.op !== "not_null" && (
                      <Input className="h-8 text-xs" value={String(filter.value ?? "")} onChange={(event) => updateFilter(index, { value: event.target.value })} placeholder="Valor" />
                    )}
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
