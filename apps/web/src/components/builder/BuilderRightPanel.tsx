import { useEffect, useMemo, useState, type DragEvent } from "react";
import { ArrowUpDown, BarChart3, Calendar, Columns3, Filter, GripVertical, Hash, LineChart, MoreHorizontal, MousePointer, Palette, Pencil, PieChart, Sparkles, Table2, Type, Wand2, X, Trash2, Plus } from "lucide-react";
import type { DateRange } from "react-day-picker";

import type { DashboardWidget, MetricOp, TableColumnAggregation, WidgetFilter } from "@/types/dashboard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Calendar as DatePicker } from "@/components/ui/calendar";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { LineWidgetDataConfig, LineWidgetFormattingGroup } from "@/components/builder/right-panel/LineWidgetConfigSections";
import { ConfigSection, SentenceTokenSelect } from "@/components/builder/right-panel/shared";
import { TableWidgetDataSection, DreWidgetDataSection } from "@/components/builder/right-panel/TableAndDreDataSections";
import { KpiWidgetDataSection } from "@/components/builder/right-panel/KpiDataSection";
import { DonutWidgetDataSection } from "@/components/builder/right-panel/DonutDataSection";
import { BarLikeWidgetDataSection, GenericMetricDataSection } from "@/components/builder/right-panel/BarColumnDataSection";
import { TextWidgetDataSection } from "@/components/builder/right-panel/TextDataSection";
import { buildTemporalDimensionToken, columnTypeBadgeMeta, commonFilterOps, countLikeOps, dateToApi, formatDateLabel, kpiAbbreviationModeOptions, kpiBaseAggOptions, kpiFinalAggOptions, kpiFormulaFunctionNames, kpiGranularityLabelByValue, kpiGranularityTokenOptions, kpiModeLabel, kpiModeOptions, kpiShowAsOptions, listOps, metricLabelByOp, metricOps, normalizeColumnType, nullOps, numericOps, paletteByName, parseDateValue, parseTemporalDimensionToken, relativeDateOptions, resolveDrePercentBaseRowIndex, resolveInheritedDreImpact, temporalDimensionGranularityOptions, temporalFilterOps, type TemporalFilterOpUi } from "@/components/builder/right-panel/configShared";

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
  const columnTypeByName = useMemo(
    () => Object.fromEntries(resolvedColumns.map((column) => [column.name, normalizeColumnType(column.type)])),
    [resolvedColumns],
  );
  const availableDashboardKpiWidgets = useMemo(
    () => dashboardWidgets.filter((item) => item.id !== draft?.id && item.config.widget_type === "kpi"),
    [dashboardWidgets, draft?.id],
  );
  const [draggedTableColumn, setDraggedTableColumn] = useState<string | null>(null);
  const [tableDropZone, setTableDropZone] = useState<"selected" | "available" | null>(null);
  const [tableDropColumn, setTableDropColumn] = useState<string | null>(null);
  const [openTableColumnMenu, setOpenTableColumnMenu] = useState<string | null>(null);
  const [draggedDreRowIndex, setDraggedDreRowIndex] = useState<number | null>(null);
  const [dreDropRowIndex, setDreDropRowIndex] = useState<number | null>(null);
  const [openDreRowMenu, setOpenDreRowMenu] = useState<string | null>(null);

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
  const isColumnWidget = draft.config.widget_type === "column";
  const isDonutWidget = draft.config.widget_type === "donut";
  const barLikeMetrics = isBarLikeWidget
    ? ((draft.config.metrics && draft.config.metrics.length > 0)
      ? (isColumnWidget ? draft.config.metrics : [draft.config.metrics[0]])
      : [{ op: "count" as const, column: undefined }])
    : [];
  const isDreWidget = draft.config.widget_type === "dre";
  const isCategoricalChart = isBarLikeWidget || isDonutWidget;
  const hasChartOptions = isLineWidget || isBarLikeWidget || isDonutWidget;
  const dreRows = draft.config.dre_rows || [];
  const dreRowsForUi = dreRows;
  const dreResultRowOptions = dreRowsForUi
    .map((row, index) => ({ row, index }))
    .filter((item) => item.row.row_type === "result");
  const effectiveDrePercentBaseRowIndex = resolveDrePercentBaseRowIndex(dreRowsForUi, draft.config.dre_percent_base_row_index);
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
  const donutSentenceAgg = metric.op as MetricOp;
  const donutSentenceColumn = metric.column || "__none__";
  const donutAllowedColumns = countLikeOps.has(donutSentenceAgg) ? resolvedColumns : numericColumns;
  const donutSentenceColumnOptions = [
    ...(countLikeOps.has(donutSentenceAgg) ? [{ value: "__none__", label: "sem coluna" }] : []),
    ...donutAllowedColumns.map((column) => ({
      value: column.name,
      label: column.name,
    })),
  ];
  const donutDimensionValue = draft.config.dimensions[0] || "__none__";
  const donutDimensionPreview = donutDimensionValue === "__none__" ? "Sem dimensao" : donutDimensionValue;
  const donutSentencePreview = `${metricLabelByOp[donutSentenceAgg]} de ${donutSentenceColumn === "__none__" ? "*" : donutSentenceColumn} por ${donutDimensionPreview}`;
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
  const donutTopNInputValue = draft.config.donut_group_others_enabled
    ? (draft.config.donut_group_others_top_n ?? draft.config.top_n ?? "")
    : (draft.config.top_n ?? draft.config.donut_group_others_top_n ?? "");
  const donutShouldShowGroupOthersToggle = isDonutWidget && !!(draft.config.top_n || draft.config.donut_group_others_top_n);
  const lineTimeColumnValue = draft.config.time?.column || "__none__";
  const lineTimeGranularityValue = draft.config.time?.granularity || "day";
  const lineSeriesDimensionValue = draft.config.dimensions[0] || "__none__";
  const lineDimensionPreview = lineTimeColumnValue === "__none__"
    ? "Sem tempo"
    : `${lineTimeColumnValue}[${lineTimeGranularityValue}]${lineSeriesDimensionValue !== "__none__" ? ` segmentado por ${lineSeriesDimensionValue}` : ""}`;
  const lineSentencePreview = `${metricLabelByOp[primaryLineMetric.op]} de ${primaryLineMetricColumn === "__none__" ? "*" : primaryLineMetricColumn} por ${lineDimensionPreview}`;
  const buildTableColumnInstanceId = (source: string): string =>
    `${source}__${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const getTableColumnInstances = (): Array<{
    id: string;
    source: string;
    label?: string;
    aggregation?: TableColumnAggregation;
    format?: string;
    prefix?: string;
    suffix?: string;
  }> => {
    const fromConfig = Array.isArray(draft.config.table_column_instances) ? draft.config.table_column_instances : [];
    if (fromConfig.length > 0) {
      return fromConfig
        .filter((item) => resolvedColumns.some((column) => column.name === item.source))
        .map((item, index) => ({
          id: item.id || `${item.source}__${index}`,
          source: item.source,
          label: item.label,
          aggregation: item.aggregation || "none",
          format: item.format,
          prefix: item.prefix,
          suffix: item.suffix,
        }));
    }
    const legacySelected = (draft.config.columns || []).filter((name) => resolvedColumns.some((column) => column.name === name));
    return legacySelected.map((source, index) => ({
      id: `${source}__${index}`,
      source,
      label: draft.config.table_column_labels?.[source] || undefined,
      aggregation: draft.config.table_column_aggs?.[source] || "none",
      format: draft.config.table_column_formats?.[source] || undefined,
      prefix: draft.config.table_column_prefixes?.[source] || undefined,
      suffix: draft.config.table_column_suffixes?.[source] || undefined,
    }));
  };
  const selectedTableColumnDefs = getTableColumnInstances();
  const selectedTableColumns = Array.from(new Set(selectedTableColumnDefs.map((item) => item.source)));
  const isDraggingSelectedTableColumn = !!draggedTableColumn
    && draggedTableColumn.startsWith("instance:")
    && selectedTableColumnDefs.some((item) => item.id === draggedTableColumn.replace("instance:", ""));
  const allTableColumnsSelected = resolvedColumns.length > 0 && selectedTableColumns.length === resolvedColumns.length;
  const availableTableColumnDefs = resolvedColumns.filter((column) => !selectedTableColumns.includes(column.name));
  const getColumnType = (name: string) => columnTypeByName[name] || "text";
  const getDefaultTableColumnFormat = (columnName: string): string => {
    const columnType = getColumnType(columnName);
    if (columnType === "numeric") return "number_2";
    if (columnType === "temporal") return "datetime";
    return "text";
  };
  const getEffectiveTableColumnAggregation = (value: TableColumnAggregation | undefined, columnName: string): TableColumnAggregation => {
    const rawValue = value;
    if (!rawValue || rawValue === "none") return "none";
    if (rawValue === "count") return "count";
    return getColumnType(columnName) === "numeric" ? rawValue : "none";
  };
  const getTableFormatOptions = (columnName: string): Array<{ value: string; label: string }> => {
    const columnType = getColumnType(columnName);
    if (columnType === "numeric") {
      return [
        { value: "number_2", label: "Numero (2 casas)" },
        { value: "integer", label: "Inteiro" },
        { value: "currency_brl", label: "Moeda (R$)" },
        { value: "native", label: "Nativo" },
        { value: "text", label: "Texto" },
      ];
    }
    if (columnType === "temporal") {
      return [
        { value: "datetime", label: "Data e hora" },
        { value: "date", label: "So data" },
        { value: "time", label: "So hora" },
        { value: "year", label: "So ano" },
        { value: "month", label: "So mes" },
        { value: "day", label: "So dia" },
        { value: "native", label: "Nativo" },
        { value: "text", label: "Texto" },
      ];
    }
    return [
      { value: "text", label: "Texto" },
      { value: "native", label: "Nativo" },
    ];
  };
  const setTableColumnInstances = (instances: Array<{ id: string; source: string; label?: string; aggregation?: TableColumnAggregation; format?: string; prefix?: string; suffix?: string }>) => {
    setConfig({
      table_column_instances: instances,
      columns: Array.from(new Set(instances.map((item) => item.source))),
    });
  };
  const updateTableColumnInstance = (
    instanceId: string,
    patch: Partial<{ label?: string; aggregation?: TableColumnAggregation; format?: string; prefix?: string; suffix?: string }>,
  ) => {
    const nextInstances = selectedTableColumnDefs.map((item) => item.id === instanceId ? { ...item, ...patch } : item);
    setTableColumnInstances(nextInstances);
  };
  const addTableColumn = (source: string, insertBeforeInstanceId?: string, template?: { label?: string; aggregation?: TableColumnAggregation; format?: string; prefix?: string; suffix?: string }) => {
    const nextInstance = {
      id: buildTableColumnInstanceId(source),
      source,
      label: template?.label,
      aggregation: template?.aggregation || "none",
      format: template?.format || getDefaultTableColumnFormat(source),
      prefix: template?.prefix,
      suffix: template?.suffix,
    };
    const nextInstances = [...selectedTableColumnDefs];
    const targetIndex = insertBeforeInstanceId ? nextInstances.findIndex((item) => item.id === insertBeforeInstanceId) : -1;
    if (targetIndex >= 0) nextInstances.splice(targetIndex, 0, nextInstance);
    else nextInstances.push(nextInstance);
    setTableColumnInstances(nextInstances);
  };
  const duplicateTableColumn = (instanceId: string) => {
    const source = selectedTableColumnDefs.find((item) => item.id === instanceId);
    if (!source) return;
    const index = selectedTableColumnDefs.findIndex((item) => item.id === instanceId);
    const nextInstance = { ...source, id: buildTableColumnInstanceId(source.source) };
    const nextInstances = [...selectedTableColumnDefs];
    nextInstances.splice(index + 1, 0, nextInstance);
    setTableColumnInstances(nextInstances);
  };
  const removeTableColumn = (instanceId: string) => {
    setTableColumnInstances(selectedTableColumnDefs.filter((item) => item.id !== instanceId));
  };
  const moveTableColumn = (payload: string, destination: "selected" | "available", targetInstanceId?: string) => {
    if (payload.startsWith("source:")) {
      const source = payload.replace("source:", "");
      if (destination === "selected") addTableColumn(source, targetInstanceId);
      return;
    }
    const instanceId = payload.replace("instance:", "");
    if (destination === "available") {
      removeTableColumn(instanceId);
      return;
    }
    const nextInstances = selectedTableColumnDefs.filter((item) => item.id !== instanceId);
    const moving = selectedTableColumnDefs.find((item) => item.id === instanceId);
    if (!moving) return;
    const targetIndex = targetInstanceId ? nextInstances.findIndex((item) => item.id === targetInstanceId) : -1;
    if (targetIndex >= 0) nextInstances.splice(targetIndex, 0, moving);
    else nextInstances.push(moving);
    setTableColumnInstances(nextInstances);
  };
  const resetTableDragState = () => {
    setDraggedTableColumn(null);
    setTableDropZone(null);
    setTableDropColumn(null);
  };
  const handleTableDragStart = (event: DragEvent<HTMLButtonElement>, payload: string) => {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", payload);
    setDraggedTableColumn(payload);
    setTableDropZone(null);
    setTableDropColumn(null);
  };

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

  const createDefaultDreRow = (
    rowType: "result" | "deduction" | "detail" = "detail",
    sourceRow?: (typeof dreRowsForUi)[number],
  ) => {
    const fallbackColumn = (numericColumns[0] || resolvedColumns[0])?.name;
    const sourceMetrics = sourceRow?.metrics && sourceRow.metrics.length > 0
      ? sourceRow.metrics
      : [{ op: "sum" as const, column: fallbackColumn }];
    const normalizedMetrics = sourceMetrics.map((metric) => {
      const preferredColumn = metric.column;
      const nextColumn = preferredColumn && numericColumns.some((item) => item.name === preferredColumn)
        ? preferredColumn
        : fallbackColumn;
      return { op: "sum" as const, column: nextColumn };
    });
    return {
      title: sourceRow?.title || "",
      row_type: rowType,
      impact: rowType === "result"
        ? ((sourceRow?.impact === "subtract" ? "subtract" : "add") as "add" | "subtract")
        : (sourceRow?.impact || (rowType === "deduction" ? "subtract" as const : "add" as const)),
      metrics: normalizedMetrics,
    };
  };

  const updateDreRows = (
    updater: (
      rows: Array<{ title: string; row_type: "result" | "deduction" | "detail"; impact?: "add" | "subtract"; metrics: Array<{ op: MetricOp; column?: string }> }>,
    ) => Array<{ title: string; row_type: "result" | "deduction" | "detail"; impact?: "add" | "subtract"; metrics: Array<{ op: MetricOp; column?: string }> }>,
  ) => {
    const nextRows = updater(dreRowsForUi).map((row) => {
      const fallbackColumn = (numericColumns[0] || resolvedColumns[0])?.name;
      const sourceMetrics = row.metrics && row.metrics.length > 0
        ? row.metrics
        : [{ op: "sum" as const, column: fallbackColumn }];
      const normalizedMetrics = sourceMetrics.map((metric) => {
        const preferredColumn = metric.column;
        const nextColumn = preferredColumn && numericColumns.some((item) => item.name === preferredColumn)
          ? preferredColumn
          : fallbackColumn;
        return { op: "sum" as const, column: nextColumn };
      });
      return {
        ...row,
        title: row.title || "",
        impact: row.row_type === "result"
          ? (row.impact === "subtract" ? "subtract" : "add")
          : (row.impact || (row.row_type === "deduction" ? "subtract" : "add")),
        metrics: normalizedMetrics,
      };
    });
    setConfig({
      dre_rows: nextRows,
      dre_percent_base_row_index: resolveDrePercentBaseRowIndex(nextRows, draft.config.dre_percent_base_row_index),
      top_n: undefined,
      limit: undefined,
    });
  };

  const moveDreRow = (fromIndex: number, targetIndex: number) => {
    if (fromIndex === targetIndex) return;
    updateDreRows((rows) => {
      const next = [...rows];
      const [moving] = next.splice(fromIndex, 1);
      const boundedTarget = Math.max(0, Math.min(targetIndex, next.length));
      next.splice(boundedTarget, 0, moving);
      return next;
    });
  };

  const setMetric = (patch: Partial<(typeof metric)>) => {
    const nextMetrics = [...(draft.config.metrics || [{ op: "count", column: resolvedColumns[0]?.name }])];
    nextMetrics[0] = { ...nextMetrics[0], ...patch };
    setConfig({ metrics: nextMetrics });
  };
  const setBarLikeMetrics = (nextMetrics: Array<{ op: MetricOp; column?: string; alias?: string; prefix?: string; suffix?: string }>) => {
    const fallbackMetric = { op: "count" as const, column: undefined };
    setConfig({ metrics: nextMetrics.length > 0 ? nextMetrics : [fallbackMetric] });
  };
  const updateBarLikeMetricAt = (
    index: number,
    patch: Partial<{ op: MetricOp; column?: string; alias?: string; prefix?: string; suffix?: string }>,
  ) => {
    if (index < 0) return;
    const base = barLikeMetrics.length > 0 ? barLikeMetrics : [{ op: "count" as const, column: undefined }];
    if (index >= base.length) return;
    const next = [...base];
    next[index] = { ...next[index], ...patch };
    setBarLikeMetrics(next);
  };
  const addBarLikeMetric = () => {
    if (!isColumnWidget) return;
    const fallbackMetric = { op: "count" as const, column: undefined };
    const next = [...(barLikeMetrics.length > 0 ? barLikeMetrics : [fallbackMetric])];
    next.push({ op: "count" as const, column: undefined });
    setBarLikeMetrics(next);
  };
  const removeBarLikeMetric = (index: number) => {
    if (!isColumnWidget) return;
    if (index <= 0) return;
    const next = barLikeMetrics.filter((_, metricIndex) => metricIndex !== index);
    setBarLikeMetrics(next);
  };
  const setLineMetrics = (nextMetrics: Array<{ op: MetricOp; column?: string; alias?: string; prefix?: string; suffix?: string; line_style?: "solid" | "dashed" | "dotted"; line_y_axis?: "left" | "right" }>) => {
    setConfig({
      metrics: nextMetrics.map((item, index) => ({
        ...item,
        line_y_axis: item.line_y_axis === "right" ? "right" : index === 0 ? "left" : "right",
      })),
    });
  };
  const barFormattingMetrics = (barLikeMetrics.length > 0 ? barLikeMetrics : [{ op: "count" as const, column: undefined }]).map((item) => ({
    ...item,
    line_style: (item as { line_style?: "solid" | "dashed" | "dotted" }).line_style || "solid",
    line_y_axis: "left" as const,
  }));
  const setBarFormattingMetrics = (
    nextMetrics: Array<{ op: MetricOp; column?: string; alias?: string; prefix?: string; suffix?: string; line_style?: "solid" | "dashed" | "dotted"; line_y_axis?: "left" | "right" }>,
  ) => {
    const sanitized = nextMetrics.map(({ op, column, alias, prefix, suffix }) => ({ op, column, alias, prefix, suffix }));
    setBarLikeMetrics(sanitized.length > 0 ? sanitized : [{ op: "count" as const, column: undefined }]);
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
  const setDonutSentenceAgg = (value: string) => {
    const nextAgg = value as MetricOp;
    const nextColumn = countLikeOps.has(nextAgg)
      ? metric.column
      : (metric.column && numericColumns.some((column) => column.name === metric.column)
        ? metric.column
        : numericColumns[0]?.name);
    setMetric({ op: nextAgg, column: nextColumn });
  };
  const setDonutSentenceColumn = (value: string) => {
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
            prefix: item.prefix,
            suffix: item.suffix,
            line_style: item.line_style === "dashed" || item.line_style === "dotted" ? item.line_style : "solid",
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
    } else if (normalizedDraft.config.widget_type === "bar" || normalizedDraft.config.widget_type === "column") {
      const existingMetrics = (normalizedDraft.config.metrics || []).filter((metric) => !!metric.op);
      const fallbackMetric = { op: "count" as const, column: undefined };
      const nextMetrics = normalizedDraft.config.widget_type === "bar"
        ? [(existingMetrics[0] || fallbackMetric)]
        : (existingMetrics.length > 0 ? existingMetrics : [fallbackMetric]);
      normalizedDraft = {
        ...normalizedDraft,
        config: {
          ...normalizedDraft.config,
          metrics: nextMetrics,
        },
      };
    } else if (normalizedDraft.config.widget_type === "table") {
      const fallbackSources = resolvedColumns.slice(0, Math.min(5, resolvedColumns.length)).map((column) => column.name);
      const rawInstances: Array<{
        id: string;
        source: string;
        label?: string;
        aggregation?: TableColumnAggregation;
        format?: string;
        prefix?: string;
        suffix?: string;
      }> = (Array.isArray(normalizedDraft.config.table_column_instances) && normalizedDraft.config.table_column_instances.length > 0
        ? normalizedDraft.config.table_column_instances
        : (normalizedDraft.config.columns || fallbackSources).map((source, index) => ({
          id: `${source}__${index}`,
          source,
          label: normalizedDraft.config.table_column_labels?.[source],
          aggregation: normalizedDraft.config.table_column_aggs?.[source] || "none",
          format: normalizedDraft.config.table_column_formats?.[source],
          prefix: normalizedDraft.config.table_column_prefixes?.[source],
          suffix: normalizedDraft.config.table_column_suffixes?.[source],
        })))
        .filter((item) => resolvedColumns.some((column) => column.name === item.source));
      const nextInstances = (rawInstances.length > 0
        ? rawInstances
        : fallbackSources.map((source, index) => ({ id: `${source}__${index}`, source, aggregation: "none" as TableColumnAggregation })))
        .map((item, index) => {
          const source = item.source;
          const safeAgg = getEffectiveTableColumnAggregation(item.aggregation as TableColumnAggregation | undefined, source);
          const label = typeof item.label === "string" && item.label.trim() && item.label.trim() !== source ? item.label : undefined;
          return {
            id: item.id || `${source}__${index}`,
            source,
            label,
            aggregation: safeAgg,
            format: item.format || getDefaultTableColumnFormat(source),
            prefix: typeof item.prefix === "string" && item.prefix ? item.prefix : undefined,
            suffix: typeof item.suffix === "string" && item.suffix ? item.suffix : undefined,
          };
        });
      const nextColumns = Array.from(new Set(nextInstances.map((item) => item.source)));
      const nextLabels = nextInstances.reduce<Record<string, string>>((acc, item) => {
        if (!acc[item.source] && item.label) acc[item.source] = item.label;
        return acc;
      }, {});
      const nextAggs = nextInstances.reduce<Record<string, TableColumnAggregation>>((acc, item) => {
        if (!acc[item.source] && item.aggregation && item.aggregation !== "none") acc[item.source] = item.aggregation;
        return acc;
      }, {});
      const nextFormats = nextInstances.reduce<Record<string, string>>((acc, item) => {
        if (!acc[item.source]) acc[item.source] = item.format || getDefaultTableColumnFormat(item.source);
        return acc;
      }, {});
      const nextPrefixes = nextInstances.reduce<Record<string, string>>((acc, item) => {
        if (!acc[item.source] && item.prefix) acc[item.source] = item.prefix;
        return acc;
      }, {});
      const nextSuffixes = nextInstances.reduce<Record<string, string>>((acc, item) => {
        if (!acc[item.source] && item.suffix) acc[item.source] = item.suffix;
        return acc;
      }, {});
      normalizedDraft = {
        ...normalizedDraft,
        config: {
          ...normalizedDraft.config,
          metrics: [],
          dimensions: [],
          top_n: undefined,
          limit: undefined,
          time: undefined,
          columns: nextColumns,
          table_column_instances: nextInstances,
          table_column_labels: nextLabels,
          table_column_aggs: nextAggs,
          table_column_formats: nextFormats,
          table_column_prefixes: nextPrefixes,
          table_column_suffixes: nextSuffixes,
          table_page_size: Math.max(1, Number(normalizedDraft.config.table_page_size) || 25),
          table_density: normalizedDraft.config.table_density === "compact" || normalizedDraft.config.table_density === "comfortable"
            ? normalizedDraft.config.table_density
            : "normal",
          table_zebra_rows: normalizedDraft.config.table_zebra_rows !== false,
          table_sticky_header: normalizedDraft.config.table_sticky_header !== false,
          table_borders: normalizedDraft.config.table_borders !== false,
          table_default_text_align: normalizedDraft.config.table_default_text_align === "center" || normalizedDraft.config.table_default_text_align === "right"
            ? normalizedDraft.config.table_default_text_align
            : "left",
          table_default_number_align: normalizedDraft.config.table_default_number_align === "left" || normalizedDraft.config.table_default_number_align === "center"
            ? normalizedDraft.config.table_default_number_align
            : "right",
        },
      };
    } else if (normalizedDraft.config.widget_type === "dre") {
      const sourceRows = normalizedDraft.config.dre_rows || [];
      const normalizedRows = sourceRows.map((row, index, rows) => {
        const fallbackColumn = (numericColumns[0] || resolvedColumns[0])?.name;
        const sourceMetrics = row.metrics && row.metrics.length > 0
          ? row.metrics
          : [{ op: "sum" as const, column: fallbackColumn }];
        const normalizedMetrics = sourceMetrics.map((metric) => {
          const preferredColumn = metric.column;
          const normalizedColumn = preferredColumn && numericColumns.some((columnItem) => columnItem.name === preferredColumn)
            ? preferredColumn
            : fallbackColumn;
          return { op: "sum" as const, column: normalizedColumn };
        });
        const rowType = row.row_type || "detail";
        const impact = rowType === "result"
          ? (row.impact === "subtract" ? "subtract" : "add")
          : resolveInheritedDreImpact(rows, index);
        return {
          ...row,
          title: row.title || "",
          row_type: rowType,
          impact,
          metrics: normalizedMetrics,
        };
      });
      normalizedDraft = {
        ...normalizedDraft,
        config: {
          ...normalizedDraft.config,
          metrics: [],
          dimensions: [],
          time: undefined,
          columns: undefined,
          order_by: [],
          top_n: undefined,
          limit: undefined,
          dre_rows: normalizedRows,
          dre_percent_base_row_index: resolveDrePercentBaseRowIndex(normalizedRows, normalizedDraft.config.dre_percent_base_row_index),
        },
      };
    }
    normalizedDraft = {
      ...normalizedDraft,
      type: normalizedDraft.config.widget_type,
      props: normalizedDraft.config,
    };
    onUpdate(normalizedDraft);
    onClose();
  };

  const handlePanelKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Enter" || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.nativeEvent.isComposing) return;
    const target = event.target as HTMLElement | null;
    if (!target) return;
    const tagName = target.tagName.toLowerCase();
    if (tagName === "textarea") return;
    if (target.closest("[data-column-rename-input='true']")) return;
    if (target.closest("[data-dre-row-title-input='true']")) return;
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
                title={draft.config.widget_type === "table"
                  ? "Colunas da tabela"
                  : (isDreWidget ? "Estrutura DRE" : (draft.config.widget_type === "text" ? "Conteudo" : "Metricas"))}
                icon={draft.config.widget_type === "table" ? Table2 : (isDreWidget ? Columns3 : (draft.config.widget_type === "text" ? Type : Hash))}
                badge={draft.config.widget_type === "table"
                  ? (selectedTableColumnDefs.length || undefined)
                  : (isDreWidget
                    ? (dreRows.length || undefined)
                    : (isKpiWidget ? kpiModeLabel[kpiMode] : (draft.config.widget_type === "text" ? undefined : (draft.config.metrics.length || undefined))))}
              >
                {draft.config.widget_type === "table" ? (
                  <TableWidgetDataSection
                    allTableColumnsSelected={allTableColumnsSelected}
                    setConfig={setConfig}
                    selectedTableColumnDefs={selectedTableColumnDefs}
                    resolvedColumns={resolvedColumns}
                    buildTableColumnInstanceId={buildTableColumnInstanceId}
                    getDefaultTableColumnFormat={getDefaultTableColumnFormat}
                    setTableColumnInstances={setTableColumnInstances}
                    tableDropZone={tableDropZone}
                    draggedTableColumn={draggedTableColumn}
                    tableDropColumn={tableDropColumn}
                    setTableDropZone={setTableDropZone}
                    setTableDropColumn={setTableDropColumn}
                    moveTableColumn={moveTableColumn}
                    resetTableDragState={resetTableDragState}
                    getColumnType={getColumnType}
                    updateTableColumnInstance={updateTableColumnInstance}
                    openTableColumnMenu={openTableColumnMenu}
                    setOpenTableColumnMenu={setOpenTableColumnMenu}
                    getTableFormatOptions={getTableFormatOptions}
                    duplicateTableColumn={duplicateTableColumn}
                    removeTableColumn={removeTableColumn}
                    handleTableDragStart={handleTableDragStart}
                    availableTableColumnDefs={availableTableColumnDefs}
                    addTableColumn={addTableColumn}
                    draft={draft}
                    columnTypeBadgeMeta={columnTypeBadgeMeta}
                  />
                ) : isDreWidget ? (
                  <DreWidgetDataSection
                    numericColumns={numericColumns}
                    updateDreRows={updateDreRows}
                    createDefaultDreRow={createDefaultDreRow}
                    dreRowsForUi={dreRowsForUi}
                    setConfig={setConfig}
                    drePercentBaseRowIndex={effectiveDrePercentBaseRowIndex}
                    draggedDreRowIndex={draggedDreRowIndex}
                    dreDropRowIndex={dreDropRowIndex}
                    setDreDropRowIndex={setDreDropRowIndex}
                    moveDreRow={moveDreRow}
                    setDraggedDreRowIndex={setDraggedDreRowIndex}
                    openDreRowMenu={openDreRowMenu}
                    setOpenDreRowMenu={setOpenDreRowMenu}
                  />
                ) : isKpiWidget ? (
                  <KpiWidgetDataSection
                    kpiMode={kpiMode}
                    handleKpiModeChange={handleKpiModeChange}
                    kpiModeOptions={kpiModeOptions}
                    isCompositeSentence={isCompositeSentence}
                    SentenceTokenSelect={SentenceTokenSelect}
                    kpiSentenceFinalAgg={kpiSentenceFinalAgg}
                    setKpiSentenceFinalAgg={setKpiSentenceFinalAgg}
                    kpiFinalAggOptions={kpiFinalAggOptions}
                    kpiSentenceBaseAgg={kpiSentenceBaseAgg}
                    setKpiSentenceBaseAgg={setKpiSentenceBaseAgg}
                    kpiBaseAggOptions={kpiBaseAggOptions}
                    numericColumns={numericColumns}
                    countLikeOps={countLikeOps}
                    kpiSentenceColumn={kpiSentenceColumn}
                    setKpiSentenceColumn={setKpiSentenceColumn}
                    kpiAllowedColumns={kpiAllowedColumns}
                    kpiTimeTokenValue={kpiTimeTokenValue}
                    setKpiSentenceTimeToken={setKpiSentenceTimeToken}
                    kpiTimeTokenOptions={kpiTimeTokenOptions}
                    kpiSentencePreview={kpiSentencePreview}
                    normalizedDerivedDeps={normalizedDerivedDeps}
                    draft={draft}
                    setConfig={setConfig}
                    resolvedColumns={resolvedColumns}
                    normalizeKpiDependencyWidgetId={normalizeKpiDependencyWidgetId}
                    availableDashboardKpiWidgets={availableDashboardKpiWidgets}
                    createDefaultKpiDependency={createDefaultKpiDependency}
                    derivedMetricAliases={derivedMetricAliases}
                    extractKpiFormulaRefs={extractKpiFormulaRefs}
                  />
                ) : draft.config.widget_type === "text" ? (
                  <TextWidgetDataSection
                    draft={draft}
                    setConfig={setConfig}
                  />
                ) : (
                  isLineWidget ? (
                    <LineWidgetDataConfig
                      lineMetrics={lineMetrics}
                      setLineMetrics={setLineMetrics}
                      metricOps={metricOps}
                      metricLabelByOp={metricLabelByOp}
                      countLikeOps={countLikeOps}
                      numericColumns={numericColumns}
                      resolvedColumns={resolvedColumns}
                      temporalColumns={temporalColumns}
                      categoricalColumns={categoricalColumns}
                      lineTimeColumnValue={lineTimeColumnValue}
                      lineTimeGranularityValue={lineTimeGranularityValue}
                      lineSeriesDimensionValue={lineSeriesDimensionValue}
                      setConfig={setConfig}
                      draftTimeGranularity={draft.config.time?.granularity}
                      draftTimeColumn={draft.config.time?.column}
                      SentenceTokenSelect={SentenceTokenSelect}
                    />
                  ) : isDonutWidget ? (
                    <DonutWidgetDataSection
                      metricOps={metricOps}
                      metricLabelByOp={metricLabelByOp}
                      numericColumns={numericColumns}
                      SentenceTokenSelect={SentenceTokenSelect}
                      donutSentenceAgg={donutSentenceAgg}
                      setDonutSentenceAgg={setDonutSentenceAgg}
                      donutSentenceColumn={donutSentenceColumn}
                      setDonutSentenceColumn={setDonutSentenceColumn}
                      donutSentenceColumnOptions={donutSentenceColumnOptions}
                      donutDimensionValue={donutDimensionValue}
                      setConfig={setConfig}
                      categoricalColumns={categoricalColumns}
                      temporalColumns={temporalColumns}
                      donutSentencePreview={donutSentencePreview}
                    />
                  ) : isBarLikeWidget ? (
                    <div className="space-y-2">
                      {!isColumnWidget && (
                        <BarLikeWidgetDataSection
                        SentenceTokenSelect={SentenceTokenSelect}
                        barSentenceAgg={barSentenceAgg}
                        setBarSentenceAgg={setBarSentenceAgg}
                        metricOps={metricOps}
                        metricLabelByOp={metricLabelByOp}
                        numericColumns={numericColumns}
                        barSentenceColumn={barSentenceColumn}
                        setBarSentenceColumn={setBarSentenceColumn}
                        barSentenceColumnOptions={barSentenceColumnOptions}
                        barLikeDimensionIsTemporal={barLikeDimensionIsTemporal}
                        barLikeDimensionColumn={barLikeDimensionColumn}
                        setConfig={setConfig}
                        temporalColumns={temporalColumns}
                        categoricalColumns={categoricalColumns}
                        buildTemporalDimensionToken={buildTemporalDimensionToken}
                        draft={draft}
                        barLikeDimensionGranularity={barLikeDimensionGranularity}
                        temporalDimensionGranularityOptions={temporalDimensionGranularityOptions}
                        barSentencePreview={barSentencePreview}
                        barLikeDimensionPreview={barLikeDimensionPreview}
                        />
                      )}
                      {isColumnWidget && (
                        <div className="rounded-lg border border-border/60 bg-background/70 p-2.5 space-y-2">
                        <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2">
                          <div className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
                            <SentenceTokenSelect
                              tone="agg"
                              value={barLikeMetrics[0]?.op || "count"}
                              onChange={(value) => {
                                const nextAgg = value as MetricOp;
                                const current = barLikeMetrics[0] || { op: "count" as const, column: undefined };
                                const nextColumn = countLikeOps.has(nextAgg)
                                  ? current.column
                                  : (current.column && numericColumns.some((column) => column.name === current.column)
                                    ? current.column
                                    : numericColumns[0]?.name);
                                updateBarLikeMetricAt(0, { op: nextAgg, column: nextColumn });
                              }}
                              options={metricOps.map((op) => ({
                                value: op,
                                label: metricLabelByOp[op] || op,
                                disabled: (op === "sum" || op === "avg" || op === "min" || op === "max") && numericColumns.length === 0,
                              }))}
                            />
                            <span>de</span>
                            <SentenceTokenSelect
                              tone="column"
                              value={barLikeMetrics[0]?.column || "__none__"}
                              onChange={(value) => updateBarLikeMetricAt(0, { column: value === "__none__" ? undefined : value })}
                              options={[
                                ...(countLikeOps.has(barLikeMetrics[0]?.op || "count") ? [{ value: "__none__", label: "sem coluna" }] : []),
                                ...(countLikeOps.has(barLikeMetrics[0]?.op || "count") ? resolvedColumns : numericColumns)
                                  .map((column) => ({ value: column.name, label: column.name })),
                              ]}
                              placeholder="coluna"
                            />
                          </div>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="h-5 w-5 text-muted-foreground hover:text-foreground"
                            onClick={addBarLikeMetric}
                            aria-label="Adicionar metrica"
                          >
                            <Plus className="h-3 w-3" />
                          </Button>
                        </div>

                        {barLikeMetrics.slice(1).map((barMetric, metricIndex) => {
                          const actualIndex = metricIndex + 1;
                          return (
                            <div key={`column-metric-${actualIndex}`} className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
                              <SentenceTokenSelect
                                tone="agg"
                                value={barMetric.op || "count"}
                                onChange={(value) => {
                                  const nextAgg = value as MetricOp;
                                  const nextColumn = countLikeOps.has(nextAgg)
                                    ? barMetric.column
                                    : (barMetric.column && numericColumns.some((column) => column.name === barMetric.column)
                                      ? barMetric.column
                                      : numericColumns[0]?.name);
                                  updateBarLikeMetricAt(actualIndex, { op: nextAgg, column: nextColumn });
                                }}
                                options={metricOps.map((op) => ({
                                  value: op,
                                  label: metricLabelByOp[op] || op,
                                  disabled: (op === "sum" || op === "avg" || op === "min" || op === "max") && numericColumns.length === 0,
                                }))}
                              />
                              <span>de</span>
                              <SentenceTokenSelect
                                tone="column"
                                value={barMetric.column || "__none__"}
                                onChange={(value) => updateBarLikeMetricAt(actualIndex, { column: value === "__none__" ? undefined : value })}
                                options={[
                                  ...(countLikeOps.has(barMetric.op || "count") ? [{ value: "__none__", label: "sem coluna" }] : []),
                                  ...(countLikeOps.has(barMetric.op || "count") ? resolvedColumns : numericColumns)
                                    .map((column) => ({ value: column.name, label: column.name })),
                                ]}
                                placeholder="coluna"
                              />
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                className="h-7 w-7 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                                onClick={() => removeBarLikeMetric(actualIndex)}
                                aria-label={`Remover metrica ${actualIndex + 1}`}
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </Button>
                            </div>
                          );
                        })}
                        <div className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
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
                              setConfig({
                                dimensions: [nextDimension],
                                order_by: [{ column: nextDimension, direction: "asc" }],
                              });
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
                                  setConfig({
                                    dimensions: [nextDimension],
                                    order_by: [{ column: nextDimension, direction: "asc" }],
                                  });
                                }}
                                options={temporalDimensionGranularityOptions.map((option) => ({ value: option.value, label: option.label.toLowerCase() }))}
                              />
                            </>
                          )}
                        </div>
                        </div>
                      )}
                    </div>
                  ) : (
                    <GenericMetricDataSection
                      metric={metric}
                      setMetric={setMetric}
                      metricOps={metricOps}
                      countLikeOps={countLikeOps}
                      resolvedColumns={resolvedColumns}
                      numericColumns={numericColumns}
                    />
                  )
                )}
              </ConfigSection>

              {(isBarLikeWidget || isLineWidget || isDonutWidget) && (
                <ConfigSection title="Formatacao" icon={Type} defaultOpen={false}>
                  {isBarLikeWidget && (
                    isColumnWidget ? (
                      <div className="space-y-1.5">
                        {barLikeMetrics.map((barMetric, metricIndex) => (
                          <div key={`bar-like-alias-${metricIndex}`} className="grid grid-cols-[120px_minmax(0,1fr)] items-center gap-2">
                            <Label className="text-caption text-muted-foreground">{barMetric.column || "sem coluna"}</Label>
                            <Input
                              className="h-8 text-xs"
                              value={barMetric.alias || ""}
                              placeholder={`Ex: Serie ${metricIndex + 1}`}
                              onChange={(event) => {
                                const value = event.target.value.trim();
                                updateBarLikeMetricAt(metricIndex, { alias: value || undefined });
                              }}
                            />
                          </div>
                        ))}
                      </div>
                    ) : (
                      <LineWidgetFormattingGroup
                        lineMetrics={barFormattingMetrics}
                        setLineMetrics={setBarFormattingMetrics}
                      />
                    )
                  )}
                  {isLineWidget && (
                    <LineWidgetFormattingGroup
                      lineMetrics={lineMetrics}
                      setLineMetrics={setLineMetrics}
                    />
                  )}
                  {isDonutWidget && (
                    <div className="grid grid-cols-[120px_minmax(0,1fr)] items-center gap-2">
                      <Label className="text-caption text-muted-foreground">Alias da metrica</Label>
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
                  {isDonutWidget && (
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
                  )}
                </ConfigSection>
              )}

              {(isCategoricalChart || isLineWidget || draft.config.widget_type === "table") && (
                <ConfigSection title="Ordenacao" icon={ArrowUpDown} badge={currentOrder ? 1 : undefined}>
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
                          <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="Sem ordenacao" /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="__none__">Sem ordenacao</SelectItem>
                            <SelectItem value="__metric__">Pela metrica</SelectItem>
                            {draft.config.dimensions[0] && <SelectItem value={draft.config.dimensions[0]}>Pela dimensao</SelectItem>}
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
                            value={isDonutWidget ? donutTopNInputValue : (draft.config.top_n ?? "")}
                            placeholder="Limite de categorias (ex: 5)"
                            onChange={(event) => {
                              const raw = event.target.value.trim();
                              if (!raw) {
                                if (isDonutWidget) {
                                  setConfig({
                                    top_n: undefined,
                                    donut_group_others_enabled: false,
                                    donut_group_others_top_n: undefined,
                                  });
                                  return;
                                }
                                setConfig({ top_n: undefined });
                                return;
                              }
                              const parsed = Math.max(1, Math.trunc(Number(raw) || 1));
                              if (isDonutWidget && draft.config.donut_group_others_enabled) {
                                setConfig({ top_n: undefined, donut_group_others_top_n: parsed });
                                return;
                              }
                              if (isDonutWidget) {
                                setConfig({ top_n: parsed, donut_group_others_top_n: parsed });
                                return;
                              }
                              setConfig({ top_n: parsed });
                            }}
                          />
                        </div>
                      )}
                      {donutShouldShowGroupOthersToggle && (
                        <div className="flex items-center justify-between">
                          <Label className="text-caption text-muted-foreground">Agrupar em outros</Label>
                          <Switch
                            checked={!!draft.config.donut_group_others_enabled}
                            onCheckedChange={(checked) => {
                              const n = Math.max(1, Math.trunc(Number(draft.config.donut_group_others_top_n ?? draft.config.top_n ?? 3) || 3));
                              if (checked) {
                                setConfig({
                                  donut_group_others_enabled: true,
                                  donut_group_others_top_n: n,
                                  top_n: undefined,
                                });
                                return;
                              }
                              setConfig({
                                donut_group_others_enabled: false,
                                donut_group_others_top_n: n,
                                top_n: n,
                              });
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
                        <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="Sem ordenacao" /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="__none__">Sem ordenacao</SelectItem>
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
                <ConfigSection title="Formatacao" icon={Type} defaultOpen={false}>
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

            </div>
          )}

          {activeTab === "visual" && (
            <div className="space-y-3">
              <ConfigSection title="Layout" icon={Palette}>
                <div className="flex items-center justify-between"><Label className="text-caption text-muted-foreground">Mostrar titulo</Label><Switch checked={draft.config.show_title !== false} onCheckedChange={(checked) => setConfig({ show_title: checked })} /></div>
              </ConfigSection>

              {draft.config.widget_type === "table" && (
                <ConfigSection title="Opcoes da tabela" icon={Table2}>
                  <div className="grid grid-cols-[140px_minmax(0,1fr)] items-center gap-2">
                    <Label className="text-caption text-muted-foreground">Densidade</Label>
                    <Select
                      value={draft.config.table_density || "normal"}
                      onValueChange={(value) => setConfig({ table_density: value as "compact" | "normal" | "comfortable" })}
                    >
                      <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="compact">Compacta</SelectItem>
                        <SelectItem value="normal">Normal</SelectItem>
                        <SelectItem value="comfortable">Confortavel</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="flex items-center justify-between">
                    <Label className="text-caption text-muted-foreground">Zebra rows</Label>
                    <Switch checked={draft.config.table_zebra_rows !== false} onCheckedChange={(checked) => setConfig({ table_zebra_rows: checked })} />
                  </div>
                  <div className="flex items-center justify-between">
                    <Label className="text-caption text-muted-foreground">Sticky header</Label>
                    <Switch checked={draft.config.table_sticky_header !== false} onCheckedChange={(checked) => setConfig({ table_sticky_header: checked })} />
                  </div>
                  <div className="flex items-center justify-between">
                    <Label className="text-caption text-muted-foreground">Bordas</Label>
                    <Switch checked={draft.config.table_borders !== false} onCheckedChange={(checked) => setConfig({ table_borders: checked })} />
                  </div>
                  <div className="grid grid-cols-[140px_minmax(0,1fr)] items-center gap-2">
                    <Label className="text-caption text-muted-foreground">Texto padrao</Label>
                    <Select
                      value={draft.config.table_default_text_align || "left"}
                      onValueChange={(value) => setConfig({ table_default_text_align: value as "left" | "center" | "right" })}
                    >
                      <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="left">Esquerda</SelectItem>
                        <SelectItem value="center">Centro</SelectItem>
                        <SelectItem value="right">Direita</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="grid grid-cols-[140px_minmax(0,1fr)] items-center gap-2">
                    <Label className="text-caption text-muted-foreground">Numero padrao</Label>
                    <Select
                      value={draft.config.table_default_number_align || "right"}
                      onValueChange={(value) => setConfig({ table_default_number_align: value as "left" | "center" | "right" })}
                    >
                      <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="left">Esquerda</SelectItem>
                        <SelectItem value="center">Centro</SelectItem>
                        <SelectItem value="right">Direita</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </ConfigSection>
              )}

              {draft.config.widget_type === "dre" && (
                <ConfigSection title="Visualizacao DRE" icon={Table2}>
                  <div className="space-y-1.5 rounded-md border border-border/60 p-2">
                    <Label className="text-[11px] text-muted-foreground">Mostrar percentual sobre</Label>
                    <Select
                      value={typeof effectiveDrePercentBaseRowIndex === "number" ? String(effectiveDrePercentBaseRowIndex) : "__none__"}
                      onValueChange={(value) => setConfig({ dre_percent_base_row_index: value === "__none__" ? undefined : Number(value) })}
                    >
                      <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="Selecione uma conta total" /></SelectTrigger>
                      <SelectContent>
                        {dreResultRowOptions.length === 0 && <SelectItem value="__none__">Nenhuma linha Total disponivel</SelectItem>}
                        {dreResultRowOptions.map(({ row, index }) => (
                          <SelectItem key={`dre-percent-base-${index}`} value={String(index)}>
                            {row.title.trim() || `Total ${index + 1}`}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </ConfigSection>
              )}

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
                        <Label className="text-caption text-muted-foreground">Mostrar rotulos de dados</Label>
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
                        <Label className="text-caption text-muted-foreground">Mostrar rotulos de dados</Label>
                        <Switch checked={!!draft.config.donut_data_labels_enabled} onCheckedChange={(checked) => setConfig({ donut_data_labels_enabled: checked })} />
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
            <ConfigSection title="Interacoes" icon={Wand2} defaultOpen={false}>
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




