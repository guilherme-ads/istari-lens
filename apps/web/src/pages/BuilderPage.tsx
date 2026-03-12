
import { useState, useCallback, useMemo, useEffect, useRef, type ChangeEvent, type CSSProperties } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { motion } from "framer-motion";
import { LayoutDashboard, Plus, Trash2, Keyboard, Wand2, CalendarIcon, Sparkles, X, SlidersHorizontal, Eye, EyeOff, Hash, BarChart3, LineChart, PieChart, Table2, Columns3 } from "lucide-react";
import type { DateRange } from "react-day-picker";

import type { View, VisualizationType } from "@/types";
import type { ApiDashboardNativeFilter } from "@/lib/api";
import {
  SECTION_GRID_COLS,
  createSection,
  createDefaultWidgetConfig,
  gridRowsToWidgetHeight,
  normalizeLayoutItem,
  type DashboardNativeFilter,
  type DashboardLayoutItem,
  type DashboardSection,
  type DashboardWidget,
  type WidgetConfig,
  type WidgetType,
} from "@/types/dashboard";
import { api, ApiError } from "@/lib/api";
import { mapDashboard, sectionsToLayoutConfig, syncSectionWidgetsWithLayout } from "@/lib/mappers";
import { useCoreData } from "@/hooks/use-core-data";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { getWidgetCatalogByType, getWidgetCatalogByVisualization, WIDGET_CATALOG } from "@/components/builder/widget-catalog";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Calendar } from "@/components/ui/calendar";
import { Separator } from "@/components/ui/separator";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";

import { DashboardCanvas } from "@/components/builder/DashboardCanvas";
import BuilderTopBar from "@/components/builder/BuilderTopBar";
import BuilderLeftPanel from "@/components/builder/BuilderLeftPanel";
import BuilderRightPanel from "@/components/builder/BuilderRightPanel";
import { FilterRuleRow } from "@/components/builder/FilterRuleRow";
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from "@/components/ui/resizable";

import EmptyState from "@/components/shared/EmptyState";
import ConfirmDialog from "@/components/shared/ConfirmDialog";
import { ChatInput, ChatMessages, type ChatMessageData } from "@/components/shared/Chat";

type SemanticColumnType = "numeric" | "temporal" | "text" | "boolean";
type DatasetColumn = { name: string; type: SemanticColumnType };
type DashboardFilterOp = "eq" | "neq" | "gt" | "lt" | "gte" | "lte" | "contains" | "between" | "relative" | "in" | "not_in" | "is_null" | "not_null";
type RelativeDatePreset = "today" | "yesterday" | "last_7_days" | "last_30_days" | "this_year" | "this_month" | "last_month";
type DraftGlobalFilter = {
  id: string;
  column: string;
  op: DashboardFilterOp;
  value: string | string[];
  dateValue?: Date;
  dateRange?: DateRange;
  relativePreset?: RelativeDatePreset;
  visible: boolean;
};
type PreparedGlobalFilter = DashboardNativeFilter & {
  op: DashboardFilterOp;
  value?: string | string[] | { relative: RelativeDatePreset };
};
type CategoricalValueHint = {
  values: string[];
  truncated: boolean;
};

const CATEGORICAL_VALUES_LIMIT = 60;
const CATEGORICAL_DROPDOWN_THRESHOLD = 25;
const exactValueOps = new Set<DashboardFilterOp>(["eq", "neq", "gt", "lt", "gte", "lte"]);

const normalizeSemanticColumnType = (rawType: string): SemanticColumnType => {
  const value = (rawType || "").toLowerCase();
  if (value === "numeric" || value === "temporal" || value === "text" || value === "boolean") {
    return value;
  }
  if (["int", "numeric", "decimal", "real", "double", "float", "money"].some((token) => value.includes(token))) {
    return "numeric";
  }
  if (["date", "time", "timestamp"].some((token) => value.includes(token))) {
    return "temporal";
  }
  if (value.includes("bool")) {
    return "boolean";
  }
  return "text";
};

const mergeColumnType = (currentType: SemanticColumnType, nextType: SemanticColumnType): SemanticColumnType => {
  if (currentType !== "text" && nextType === "text") return currentType;
  if (currentType === "text" && nextType !== "text") return nextType;
  return nextType;
};

const makeTempWidgetId = () => `tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const findNextSequentialPlacement = (
  layout: DashboardLayoutItem[],
  width: number,
  height: number,
): Pick<DashboardLayoutItem, "x" | "y" | "w" | "h"> | null => {
  const targetWidth = Math.max(1, Math.min(SECTION_GRID_COLS, width));
  const maxStart = SECTION_GRID_COLS - targetWidth;
  for (let x = 0; x <= maxStart; x += 1) {
    const start = x;
    const end = x + targetWidth;
    const occupied = layout.some((item) => {
      const itemStart = Math.max(0, item.x);
      const itemEnd = Math.min(SECTION_GRID_COLS, item.x + item.w);
      return itemStart < end && itemEnd > start;
    });
    if (!occupied) {
      return { x, y: 0, w: targetWidth, h: Math.max(1, height) };
    }
  }
  return null;
};

const insertLayoutItemWithShift = (
  layout: DashboardLayoutItem[],
  itemToInsert: DashboardLayoutItem,
): DashboardLayoutItem[] | null => {
  const normalizedExisting = layout
    .filter((item) => item.i !== itemToInsert.i)
    .map((item) => normalizeLayoutItem(item))
    .sort((a, b) => a.x - b.x);
  const desiredX = Math.max(0, Math.min(SECTION_GRID_COLS - itemToInsert.w, itemToInsert.x));
  const insertIndex = normalizedExisting.findIndex((item) => desiredX < (item.x + item.w));
  const ordered = insertIndex >= 0
    ? [...normalizedExisting.slice(0, insertIndex), itemToInsert, ...normalizedExisting.slice(insertIndex)]
    : [...normalizedExisting, itemToInsert];

  let cursor = 0;
  const placed: DashboardLayoutItem[] = [];
  for (const item of ordered) {
    const preferredX = item.i === itemToInsert.i
      ? desiredX
      : Math.max(0, Math.min(SECTION_GRID_COLS - item.w, item.x));
    const nextX = Math.max(cursor, preferredX);
    if (nextX + item.w > SECTION_GRID_COLS) {
      return null;
    }
    placed.push(normalizeLayoutItem({
      ...item,
      x: nextX,
      y: 0,
    }));
    cursor = nextX + item.w;
  }

  return placed;
};

const mapVisualizationToWidgetType = (type: VisualizationType): WidgetType => {
  if (type === "pie") return "donut";
  return type;
};

const metricOpTitleMap: Record<"count" | "distinct_count" | "sum" | "avg" | "min" | "max", string> = {
  count: "CONTAGEM",
  distinct_count: "CONTAGEM UNICA",
  sum: "SOMA",
  avg: "MEDIA",
  min: "MINIMO",
  max: "MAXIMO",
};

const toTitleToken = (value?: string): string => {
  const normalized = String(value || "")
    .replace(/^__time_[^:]+:/, "")
    .replace(/[_\-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return "TOTAL";
  return normalized.toUpperCase();
};

const summarizeKpiTitle = (config: WidgetConfig): string => {
  if (config.kpi_type === "derived" && (config.formula || "").trim()) {
    return `FORMULA: ${(config.formula || "").trim().toUpperCase()}`;
  }
  if (config.composite_metric) {
    const inner = config.composite_metric.inner_agg || "count";
    const outer = config.composite_metric.outer_agg || "avg";
    const columnToken = toTitleToken(config.composite_metric.value_column);
    return `${metricOpTitleMap[outer]} DE ${metricOpTitleMap[inner]} DE ${columnToken}`;
  }
  const metric = config.metrics[0];
  if (!metric) return "KPI";
  const op = metric.op || "count";
  const columnToken = toTitleToken(metric.column);
  return `${metricOpTitleMap[op]} DE ${columnToken}`;
};

const commonOps: Array<{ value: DashboardFilterOp; label: string }> = [
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

const temporalOps: Array<{ value: DashboardFilterOp; label: string }> = [
  { value: "eq", label: "=" },
  { value: "neq", label: "!=" },
  { value: "gt", label: ">" },
  { value: "lt", label: "<" },
  { value: "gte", label: ">=" },
  { value: "lte", label: "<=" },
  { value: "in", label: "in" },
  { value: "not_in", label: "not in" },
  { value: "between", label: "entre datas" },
  { value: "relative", label: "data relativa" },
  { value: "is_null", label: "nulo" },
  { value: "not_null", label: "nao nulo" },
];

const relativeDateOptions: Array<{ value: RelativeDatePreset; label: string }> = [
  { value: "today", label: "Hoje" },
  { value: "yesterday", label: "Ontem" },
  { value: "last_7_days", label: "Ultimos 7 dias" },
  { value: "last_30_days", label: "Ultimos 30 dias" },
  { value: "this_year", label: "Este ano" },
  { value: "this_month", label: "Este mes" },
  { value: "last_month", label: "Mes passado" },
];

const operatorLabel: Record<DashboardFilterOp, string> = {
  eq: "=",
  neq: "!=",
  gt: ">",
  lt: "<",
  gte: ">=",
  lte: "<=",
  contains: "contem",
  in: "in",
  not_in: "not in",
  is_null: "nulo",
  not_null: "nao nulo",
  between: "entre",
  relative: "relativa",
};

const appliedFilterSignature = (filter: PreparedGlobalFilter) =>
  `${filter.column}|${filter.op}|${JSON.stringify(filter.value)}`;

const appliedFilterLabel = (filter: PreparedGlobalFilter) => {
  if (filter.op === "is_null" || filter.op === "not_null") return `${filter.column} ${operatorLabel[filter.op]}`;
  const valueLabel = typeof filter.value === "object" && filter.value !== null && !Array.isArray(filter.value)
    ? String((filter.value as { relative?: string }).relative || "")
    : Array.isArray(filter.value)
      ? filter.value.join(" .. ")
      : String(filter.value || "");
  return `${filter.column} ${operatorLabel[filter.op]} ${valueLabel}`.trim();
};

const formatDateBR = (date: Date) =>
  new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" }).format(date);

const dateToApi = (date: Date) => date.toISOString().slice(0, 10);

const parseDate = (value: unknown): Date | undefined => {
  if (typeof value !== "string") return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  return date;
};

const normalizeDashboardFilterOp = (value: string): DashboardFilterOp =>
  (["eq", "neq", "gt", "lt", "gte", "lte", "contains", "between", "relative", "in", "not_in", "is_null", "not_null"].includes(value) ? value : "eq") as DashboardFilterOp;

const prepareGlobalFilters = (
  filters: DraftGlobalFilter[],
  temporalColumnNames: Set<string>,
): PreparedGlobalFilter[] => {
  const parsedFilters: PreparedGlobalFilter[] = [];
  for (const filter of filters) {
    if (!filter.column) continue;
    const isTemporal = temporalColumnNames.has(filter.column);

    if (filter.op === "is_null" || filter.op === "not_null") {
      parsedFilters.push({ column: filter.column, op: filter.op, visible: filter.visible });
      continue;
    }
    if (isTemporal && filter.op === "relative") {
      parsedFilters.push({
        column: filter.column,
        op: "between",
        value: { relative: (filter.relativePreset || "last_7_days") as RelativeDatePreset },
        visible: filter.visible,
      });
      continue;
    }
    if (isTemporal && filter.op === "between") {
      if (!filter.dateRange?.from || !filter.dateRange?.to) continue;
      parsedFilters.push({
        column: filter.column,
        op: "between",
        value: [dateToApi(filter.dateRange.from), dateToApi(filter.dateRange.to)],
        visible: filter.visible,
      });
      continue;
    }
    if (isTemporal) {
      if (!filter.dateValue) continue;
      const temporalOp = filter.op === "relative" ? "eq" : filter.op;
      parsedFilters.push({ column: filter.column, op: temporalOp, value: dateToApi(filter.dateValue), visible: filter.visible });
      continue;
    }
    if (filter.op === "in" || filter.op === "not_in") {
      const values = Array.isArray(filter.value)
        ? filter.value.map((value) => String(value).trim()).filter(Boolean)
        : String(filter.value || "").split(",").map((value) => value.trim()).filter(Boolean);
      if (values.length === 0) continue;
      parsedFilters.push({ column: filter.column, op: filter.op, value: values, visible: filter.visible });
      continue;
    }
    if (filter.op === "between") {
      const rangeValues = Array.isArray(filter.value)
        ? filter.value.map((value) => String(value).trim())
        : String(filter.value || "").split(",").map((value) => value.trim());
      if (rangeValues.length < 2 || !rangeValues[0] || !rangeValues[1]) continue;
      parsedFilters.push({ column: filter.column, op: "between", value: [rangeValues[0], rangeValues[1]], visible: filter.visible });
      continue;
    }
    const scalar = Array.isArray(filter.value) ? String(filter.value[0] || "") : String(filter.value || "");
    if (!scalar.trim()) continue;
    const scalarOp = filter.op === "relative" ? "eq" : filter.op;
    parsedFilters.push({ column: filter.column, op: scalarOp, value: scalar, visible: filter.visible });
  }
  return parsedFilters;
};

const createBlankGlobalFilter = (): DraftGlobalFilter => ({
  id: `gf-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
  column: "",
  op: "eq",
  value: "",
  visible: true,
});

const quickWidgetIconByType: Record<WidgetType, typeof Hash> = {
  kpi: Hash,
  bar: BarChart3,
  line: LineChart,
  donut: PieChart,
  table: Table2,
  column: BarChart3,
  text: Table2,
  dre: Columns3,
};

const quickWidgetOptions: Array<{ type: VisualizationType; preferredWidgetType?: WidgetType; label: string; icon: typeof Hash }> = WIDGET_CATALOG.map((entry) => ({
  type: entry.visualizationType,
  preferredWidgetType: entry.widgetType,
  label: entry.title,
  icon: quickWidgetIconByType[entry.widgetType] || Hash,
}));

const BUILDER_ONBOARDING_STORAGE_KEY = "istari-builder-onboarding-v1";
const BUILDER_ONBOARDING_SELECTORS = {
  title: '[data-tour="builder-dashboard-title"]',
  widgetSource: '[data-tour="builder-widget-source"]',
  canvas: '[data-tour="builder-canvas"]',
} as const;
const BUILDER_ONBOARDING_CARD_WIDTH = 300;

type BuilderOnboardingPlacement = "bottom-start" | "right" | "top";
type BuilderOnboardingStep = {
  id: "dashboard-name" | "drag-widget-source" | "drop-widget-canvas";
  title: string;
  text: string;
  selector: string;
  placement: BuilderOnboardingPlacement;
};

const BUILDER_ONBOARDING_STEPS: BuilderOnboardingStep[] = [
  {
    id: "dashboard-name",
    title: "Nome do dashboard",
    text: "Clique aqui para editar o nome do dashboard.",
    selector: BUILDER_ONBOARDING_SELECTORS.title,
    placement: "bottom-start",
  },
  {
    id: "drag-widget-source",
    title: "Escolha um widget",
    text: "Arraste um widget da esquerda para o canvas.",
    selector: BUILDER_ONBOARDING_SELECTORS.widgetSource,
    placement: "right",
  },
  {
    id: "drop-widget-canvas",
    title: "Solte no canvas",
    text: "Solte o widget no canvas para adicionar o primeiro grafico.",
    selector: BUILDER_ONBOARDING_SELECTORS.canvas,
    placement: "top",
  },
];

const getOnboardingCardStyle = (
  targetRect: DOMRect | null,
  placement: BuilderOnboardingPlacement,
): CSSProperties => {
  const fallback: CSSProperties = { top: 24, left: 24 };
  if (!targetRect || typeof window === "undefined") return fallback;

  const offset = 12;
  const viewportPadding = 12;
  const estimatedCardHeight = 210;
  let left = targetRect.left;
  let top = targetRect.bottom + offset;

  if (placement === "right") {
    left = targetRect.right + offset;
    top = targetRect.top;
  } else if (placement === "top") {
    left = targetRect.left;
    top = targetRect.top - estimatedCardHeight - offset;
  }

  left = Math.max(viewportPadding, Math.min(left, window.innerWidth - BUILDER_ONBOARDING_CARD_WIDTH - viewportPadding));
  top = Math.max(viewportPadding, Math.min(top, window.innerHeight - estimatedCardHeight - viewportPadding));

  return { left, top };
};

const BuilderPage = () => {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { datasetId, dashboardId } = useParams<{ datasetId: string; dashboardId?: string }>();
  const { toast } = useToast();
  const { datasets, views, dashboards, isLoading, isError, errorMessage } = useCoreData();

  const dataset = useMemo(() => datasets.find((item) => item.id === datasetId), [datasets, datasetId]);
  const view = useMemo(() => (dataset ? views.find((item) => item.id === dataset.viewId) : undefined), [dataset, views]);
  const existingDashboard = useMemo(() => dashboards.find((item) => item.id === dashboardId), [dashboards, dashboardId]);

  const datasetSourceLabel = useMemo(() => {
    const primaryResource = (dataset?.baseQuerySpec?.base as { primary_resource?: string } | undefined)?.primary_resource;
    if (typeof primaryResource === "string" && primaryResource.trim()) return primaryResource.trim();
    if (view) return `${view.schema}.${view.name}`;
    return dataset?.name || "__dataset_base";
  }, [dataset, view]);

  const isEditingExistingDashboard = !!dashboardId;
  const canEditExistingDashboard = !!existingDashboard && existingDashboard.accessLevel !== "view";

  const [activeDashboardId, setActiveDashboardId] = useState<string | undefined>(dashboardId);
  const [dashboardTitle, setDashboardTitle] = useState("Novo Dashboard");
  const [sections, setSections] = useState<DashboardSection[]>([]);
  const [editingWidget, setEditingWidget] = useState<DashboardWidget | null>(null);
  const [isSaved, setIsSaved] = useState(false);
  const [isPreview, setIsPreview] = useState(false);
  const [draftGlobalFilters, setDraftGlobalFilters] = useState<DraftGlobalFilter[]>([]);
  const [appliedGlobalFilters, setAppliedGlobalFilters] = useState<PreparedGlobalFilter[]>([]);
  const [categoricalValueHints, setCategoricalValueHints] = useState<Record<string, CategoricalValueHint>>({});
  const [loadingCategoricalColumns, setLoadingCategoricalColumns] = useState<Record<string, boolean>>({});
  const [deleteDashboardOpen, setDeleteDashboardOpen] = useState(false);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [assistantInput, setAssistantInput] = useState("");
  const [assistantMessages, setAssistantMessages] = useState<ChatMessageData[]>([]);
  const [filtersPopoverOpen, setFiltersPopoverOpen] = useState(false);
  const [quickWidgetPickerOpen, setQuickWidgetPickerOpen] = useState(false);
  const [leftPanelCollapsed, setLeftPanelCollapsed] = useState(false);
  const [onboardingActive, setOnboardingActive] = useState(false);
  const [onboardingStepIndex, setOnboardingStepIndex] = useState(0);
  const [onboardingTargetRect, setOnboardingTargetRect] = useState<DOMRect | null>(null);

  const hydratedDashboardIdRef = useRef<string | null>(null);
  const savedSnapshotRef = useRef<string | null>(null);
  const importInputRef = useRef<HTMLInputElement | null>(null);

  const viewColumnsQuery = useQuery({
    queryKey: ["view-columns", view?.schema, view?.name],
    queryFn: () => api.getViewColumns(view!.name, view!.schema),
    enabled: !!view,
  });

  const datasetColumns = useMemo<DatasetColumn[]>(() => {
    const merged = new Map<string, DatasetColumn>();

    const upsert = (name: string, rawType: string) => {
      const nextType = normalizeSemanticColumnType(rawType);
      const current = merged.get(name);
      if (!current) {
        merged.set(name, { name, type: nextType });
        return;
      }
      merged.set(name, { name, type: mergeColumnType(current.type, nextType) });
    };

    (viewColumnsQuery.data || []).forEach((column) => {
      upsert(column.column_name, column.normalized_type);
    });

    (dataset?.semanticColumns || []).forEach((column) => {
      upsert(column.name, column.type);
    });

    if (merged.size === 0) {
      (view?.columns || []).forEach((column) => {
        upsert(column.name, column.type);
      });
    }

    return Array.from(merged.values());
  }, [dataset?.semanticColumns, view?.columns, viewColumnsQuery.data]);

  const temporalColumnNames = useMemo(
    () => new Set(datasetColumns.filter((column) => normalizeSemanticColumnType(column.type) === "temporal").map((column) => column.name)),
    [datasetColumns],
  );
  const columnTypeByName = useMemo(
    () => Object.fromEntries(datasetColumns.map((column) => [column.name, normalizeSemanticColumnType(column.type)])),
    [datasetColumns],
  );
  const isCategoricalColumn = useCallback((columnName: string) => {
    const type = columnTypeByName[columnName];
    return type === "text" || type === "boolean";
  }, [columnTypeByName]);

  const loadCategoricalValues = useCallback(async (columnName: string) => {
    if (!datasetId || !columnName || !isCategoricalColumn(columnName)) return;
    if (categoricalValueHints[columnName] || loadingCategoricalColumns[columnName]) return;

    setLoadingCategoricalColumns((prev) => ({ ...prev, [columnName]: true }));
    try {
      const result = await api.previewQuery({
        datasetId: Number(datasetId),
        metrics: [{ field: columnName, agg: "count" }],
        dimensions: [columnName],
        filters: [],
        sort: [{ field: "m0", dir: "desc" }],
        limit: CATEGORICAL_VALUES_LIMIT,
        offset: 0,
      });
      const values = Array.from(new Set(
        result.rows
          .map((row) => row[columnName])
          .filter((value): value is string | number | boolean => value !== null && value !== undefined && String(value).trim().length > 0)
          .map((value) => String(value).trim()),
      ));
      setCategoricalValueHints((prev) => ({
        ...prev,
        [columnName]: {
          values,
          truncated: values.length >= CATEGORICAL_VALUES_LIMIT,
        },
      }));
    } catch {
      // Nao bloquear o fluxo de configuracao caso o hint falhe.
    } finally {
      setLoadingCategoricalColumns((prev) => ({ ...prev, [columnName]: false }));
    }
  }, [categoricalValueHints, datasetId, isCategoricalColumn, loadingCategoricalColumns]);

  const effectiveView = useMemo<View | undefined>(() => {
    if (!dataset) return undefined;
    if (view) return view;
    return {
      id: `dataset-${dataset.id}`,
      schema: "dataset",
      name: dataset.name,
      status: "active",
      description: dataset.description,
      rowCount: 0,
      datasourceId: dataset.datasourceId,
      columns: datasetColumns.map((column) => ({ name: column.name, type: column.type })),
    };
  }, [dataset, view, datasetColumns]);

  const normalizeSectionsForBuilder = useCallback((incoming: DashboardSection[]): DashboardSection[] => {
    const seeded = incoming.length > 0 ? incoming : [{ ...createSection(), title: "Visao Geral" }];
    return seeded.map((section) => {
      const widgets = section.widgets.map((widget) => {
        const props = widget.config || widget.props;
        return {
          ...widget,
          sectionId: section.id,
          type: props.widget_type,
          props,
          config: props,
        };
      });
      return syncSectionWidgetsWithLayout({
        ...section,
        columns: SECTION_GRID_COLS,
        layout: section.layout || [],
        widgets,
      });
    });
  }, []);

  const serializeBuilderState = useCallback((
    title: string,
    valueSections: DashboardSection[],
    valueFilters: PreparedGlobalFilter[],
  ) => JSON.stringify({
    title,
    sections: sectionsToLayoutConfig(valueSections),
    filters: valueFilters,
  }), []);

  useEffect(() => {
    if (!existingDashboard) return;
    if (hydratedDashboardIdRef.current === existingDashboard.id) return;

    hydratedDashboardIdRef.current = existingDashboard.id;
    setActiveDashboardId(existingDashboard.id);
    setDashboardTitle(existingDashboard.title);
    setSections(normalizeSectionsForBuilder(existingDashboard.sections));
    const seededDrafts: DraftGlobalFilter[] = existingDashboard.nativeFilters.length > 0
      ? existingDashboard.nativeFilters.map((filter, index) => {
        const relativePreset = typeof filter.value === "object" && filter.value !== null && "relative" in filter.value
          ? (String((filter.value as Record<string, unknown>).relative) as RelativeDatePreset)
          : undefined;
        const normalizedOp = relativePreset ? "relative" : normalizeDashboardFilterOp(filter.op);
        const isBetween = normalizedOp === "between" && Array.isArray(filter.value) && filter.value.length === 2;
        const from = isBetween ? parseDate(filter.value[0]) : undefined;
        const to = isBetween ? parseDate(filter.value[1]) : undefined;

        return {
          id: `gf-native-${existingDashboard.id}-${index}`,
          column: filter.column,
          op: normalizedOp,
          value: Array.isArray(filter.value)
            ? filter.value.map((item) => String(item))
            : typeof filter.value === "string"
              ? filter.value
              : "",
          dateValue: !isBetween && !relativePreset ? parseDate(filter.value) : undefined,
          dateRange: isBetween ? { from, to } : undefined,
          relativePreset: relativePreset || "last_7_days",
          visible: typeof filter.visible === "boolean" ? filter.visible : true,
        };
      })
      : [];
    const prepared = prepareGlobalFilters(seededDrafts, temporalColumnNames);
    setDraftGlobalFilters(seededDrafts);
    setAppliedGlobalFilters(prepared);
    setEditingWidget(null);
    setIsPreview(false);

    savedSnapshotRef.current = serializeBuilderState(
      existingDashboard.title,
      normalizeSectionsForBuilder(existingDashboard.sections),
      prepared,
    );
    setIsSaved(true);
  }, [existingDashboard, normalizeSectionsForBuilder, serializeBuilderState, temporalColumnNames]);

  useEffect(() => {
    if (dashboardId) return;
    hydratedDashboardIdRef.current = null;
    setActiveDashboardId(undefined);
    setDashboardTitle("Novo Dashboard");
    setSections([]);
    setDraftGlobalFilters([]);
    setAppliedGlobalFilters([]);
    setEditingWidget(null);
    setIsPreview(false);
    setIsSaved(false);
    savedSnapshotRef.current = null;
  }, [dashboardId]);

  useEffect(() => {
    const columnsToLoad = new Set<string>();
    draftGlobalFilters.forEach((filter) => {
      if (filter.column && isCategoricalColumn(filter.column) && exactValueOps.has(filter.op)) {
        columnsToLoad.add(filter.column);
      }
    });
    columnsToLoad.forEach((columnName) => {
      void loadCategoricalValues(columnName);
    });
  }, [draftGlobalFilters, isCategoricalColumn, loadCategoricalValues]);

  useEffect(() => {
    if (!savedSnapshotRef.current) {
      setIsSaved(false);
      return;
    }
    const currentPrepared = prepareGlobalFilters(draftGlobalFilters, temporalColumnNames);
    const currentSnapshot = serializeBuilderState(dashboardTitle, sections, currentPrepared);
    setIsSaved(currentSnapshot === savedSnapshotRef.current);
  }, [dashboardTitle, draftGlobalFilters, sections, serializeBuilderState, temporalColumnNames]);

  useEffect(() => {
    if (!editingWidget) return;
    const updated = sections
      .flatMap((section) => section.widgets)
      .find((widget) => widget.id === editingWidget.id);

    if (!updated) {
      setEditingWidget(null);
      return;
    }

    if (updated !== editingWidget) {
      setEditingWidget(updated);
    }
  }, [editingWidget, sections]);

  useEffect(() => {
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      if (isSaved) return;
      event.preventDefault();
      event.returnValue = "";
    };

    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [isSaved]);

  const onboardingStep = onboardingActive ? BUILDER_ONBOARDING_STEPS[onboardingStepIndex] : null;
  const onboardingCardStyle = useMemo(
    () => getOnboardingCardStyle(onboardingTargetRect, onboardingStep?.placement || "bottom-start"),
    [onboardingStep?.placement, onboardingTargetRect],
  );

  const markBuilderOnboardingAsDismissed = useCallback(() => {
    try {
      window.localStorage.setItem(BUILDER_ONBOARDING_STORAGE_KEY, "1");
    } catch {
      // Ignora falhas de storage para nao bloquear o fluxo do builder.
    }
  }, []);

  const closeBuilderOnboarding = useCallback((persist = true) => {
    setOnboardingActive(false);
    setOnboardingStepIndex(0);
    setOnboardingTargetRect(null);
    if (persist) {
      markBuilderOnboardingAsDismissed();
    }
  }, [markBuilderOnboardingAsDismissed]);

  const startBuilderOnboarding = useCallback((force = false) => {
    if (isPreview) return;
    if (!force) {
      try {
        if (window.localStorage.getItem(BUILDER_ONBOARDING_STORAGE_KEY) === "1") return;
      } catch {
        // Ignora falhas de storage para manter o onboarding funcional.
      }
    }

    const missingTarget = BUILDER_ONBOARDING_STEPS.some((step) => !document.querySelector(step.selector));
    if (missingTarget) return;

    const firstStep = BUILDER_ONBOARDING_STEPS[0];
    const firstTarget = document.querySelector<HTMLElement>(firstStep.selector);
    if (!firstTarget) return;

    setOnboardingStepIndex(0);
    setOnboardingTargetRect(firstTarget.getBoundingClientRect());
    setOnboardingActive(true);
  }, [isPreview]);

  const handleReplayOnboarding = useCallback(() => {
    if (isPreview) {
      setIsPreview(false);
      window.setTimeout(() => {
        startBuilderOnboarding(true);
      }, 120);
      return;
    }
    startBuilderOnboarding(true);
  }, [isPreview, startBuilderOnboarding]);

  const handleOnboardingBack = useCallback(() => {
    setOnboardingStepIndex((current) => Math.max(0, current - 1));
  }, []);

  const handleOnboardingNext = useCallback(() => {
    if (onboardingStepIndex >= BUILDER_ONBOARDING_STEPS.length - 1) {
      closeBuilderOnboarding(true);
      return;
    }
    setOnboardingStepIndex((current) => Math.min(BUILDER_ONBOARDING_STEPS.length - 1, current + 1));
  }, [closeBuilderOnboarding, onboardingStepIndex]);

  useEffect(() => {
    if (!onboardingActive || !onboardingStep) return;
    const updateTargetRect = () => {
      const target = document.querySelector<HTMLElement>(onboardingStep.selector);
      if (!target) {
        closeBuilderOnboarding(true);
        return;
      }
      setOnboardingTargetRect(target.getBoundingClientRect());
    };

    updateTargetRect();
    const intervalId = window.setInterval(updateTargetRect, 120);
    window.addEventListener("resize", updateTargetRect);
    window.addEventListener("scroll", updateTargetRect, true);
    return () => {
      window.clearInterval(intervalId);
      window.removeEventListener("resize", updateTargetRect);
      window.removeEventListener("scroll", updateTargetRect, true);
    };
  }, [closeBuilderOnboarding, onboardingActive, onboardingStep]);

  useEffect(() => {
    if (isLoading || !dataset || isPreview) return;
    if (isEditingExistingDashboard && !canEditExistingDashboard) return;

    const timeoutId = window.setTimeout(() => {
      startBuilderOnboarding();
    }, 400);

    return () => window.clearTimeout(timeoutId);
  }, [
    canEditExistingDashboard,
    dataset,
    isEditingExistingDashboard,
    isLoading,
    isPreview,
    startBuilderOnboarding,
  ]);

  useEffect(() => {
    if (isPreview && onboardingActive) {
      closeBuilderOnboarding(true);
    }
  }, [closeBuilderOnboarding, isPreview, onboardingActive]);

  const preparedFiltersForSave = useMemo<PreparedGlobalFilter[]>(
    () => prepareGlobalFilters(draftGlobalFilters, temporalColumnNames),
    [draftGlobalFilters, temporalColumnNames],
  );

  const buildWidgetsPayload = useCallback((sourceSections: DashboardSection[]) => (
    sourceSections.flatMap((section, sectionIndex) =>
      [...section.widgets]
        .sort((a, b) => {
          const aLayout = section.layout.find((item) => item.i === a.id);
          const bLayout = section.layout.find((item) => item.i === b.id);
          const aY = aLayout?.y ?? 0;
          const bY = bLayout?.y ?? 0;
          if (aY !== bY) return aY - bY;
          const aX = aLayout?.x ?? 0;
          const bX = bLayout?.x ?? 0;
          return aX - bX;
        })
        .map((widget, widgetIndex) => {
        const numericId = Number(widget.id);
        return {
          id: Number.isFinite(numericId) ? numericId : widget.id,
          widget_type: widget.type || widget.props.widget_type,
          title: widget.title || `${(widget.type || widget.props.widget_type).toUpperCase()} - ${datasetSourceLabel}`,
          position: (sectionIndex * 1000) + widgetIndex,
          config: widget.props as never,
          config_version: widget.configVersion || 1,
        };
      }),
    )
  ), [datasetSourceLabel]);

  const saveDashboardMutation = useMutation({
    mutationFn: async () => {
      if (!datasetId) throw new Error("Dataset invalido");

      let targetId = activeDashboardId;
      if (!targetId) {
        const created = await api.createDashboard({
          dataset_id: Number(datasetId),
          name: dashboardTitle,
          description: null,
          is_active: true,
          layout_config: [],
          native_filters: [],
        });
        targetId = String(created.id);
        setActiveDashboardId(targetId);
      }

      const saved = await api.saveDashboard(Number(targetId), {
        name: dashboardTitle,
        description: null,
        is_active: true,
        layout_config: sectionsToLayoutConfig(sections),
        native_filters: preparedFiltersForSave as ApiDashboardNativeFilter[],
        widgets: buildWidgetsPayload(sections),
      });

      return saved;
    },
    onSuccess: async (saved) => {
      const mapped = mapDashboard(saved);
      const normalizedSections = normalizeSectionsForBuilder(mapped.sections);
      setActiveDashboardId(String(saved.id));
      setDashboardTitle(mapped.title);
      setSections(normalizedSections);
      const seededDrafts: DraftGlobalFilter[] = mapped.nativeFilters.length > 0
        ? mapped.nativeFilters.map((filter, index) => {
          const relativePreset = typeof filter.value === "object" && filter.value !== null && "relative" in filter.value
            ? (String((filter.value as Record<string, unknown>).relative) as RelativeDatePreset)
            : undefined;
          const normalizedOp = relativePreset ? "relative" : normalizeDashboardFilterOp(filter.op);
          const isBetween = normalizedOp === "between" && Array.isArray(filter.value) && filter.value.length === 2;
          const from = isBetween ? parseDate(filter.value[0]) : undefined;
          const to = isBetween ? parseDate(filter.value[1]) : undefined;

          return {
            id: `gf-saved-${saved.id}-${index}`,
            column: filter.column,
            op: normalizedOp,
            value: Array.isArray(filter.value)
              ? filter.value.map((item) => String(item))
              : typeof filter.value === "string"
                ? filter.value
                : "",
            dateValue: !isBetween && !relativePreset ? parseDate(filter.value) : undefined,
            dateRange: isBetween ? { from, to } : undefined,
            relativePreset: relativePreset || "last_7_days",
            visible: typeof filter.visible === "boolean" ? filter.visible : true,
          };
        })
        : [createBlankGlobalFilter()];
      const prepared = prepareGlobalFilters(seededDrafts, temporalColumnNames);
      setDraftGlobalFilters(seededDrafts);
      setAppliedGlobalFilters(prepared);
      setEditingWidget(null);
      savedSnapshotRef.current = serializeBuilderState(mapped.title, normalizedSections, prepared);
      setIsSaved(true);

      await queryClient.invalidateQueries({ queryKey: ["dashboards"] });
      if (datasetId) {
        navigate(`/datasets/${datasetId}/dashboard/${saved.id}`);
      } else {
        navigate("/dashboards");
      }
      toast({ title: "Dashboard salvo" });
    },
    onError: (error: unknown) => {
      const message = error instanceof ApiError ? String(error.detail || error.message) : "Falha ao salvar dashboard";
      toast({ title: "Erro ao salvar", description: message, variant: "destructive" });
    },
  });

  const persistSectionLayoutMutation = useMutation({
    mutationFn: async (payload: { dashboardId: number; sections: DashboardSection[] }) => {
      await api.updateDashboard(payload.dashboardId, {
        layout_config: sectionsToLayoutConfig(payload.sections),
      });
    },
    onError: (error: unknown) => {
      const message = error instanceof ApiError ? String(error.detail || error.message) : "Falha ao persistir layout";
      toast({ title: "Erro ao persistir layout", description: message, variant: "destructive" });
    },
  });

  const handleSaveDashboard = useCallback(() => {
    if (saveDashboardMutation.isPending) return;
    saveDashboardMutation.mutate();
  }, [saveDashboardMutation]);

  const handleUpdateWidget = useCallback((updatedWidget: DashboardWidget) => {
    setSections((prev) => prev.map((section) => {
      const target = section.widgets.find((widget) => widget.id === updatedWidget.id);
      if (!target) return section;
      const nextProps = updatedWidget.config || updatedWidget.props;
      const normalizedWidget: DashboardWidget = {
        ...updatedWidget,
        sectionId: section.id,
        type: nextProps.widget_type,
        props: nextProps,
        config: nextProps,
      };
      return {
        ...section,
        widgets: section.widgets.map((widget) => (widget.id === updatedWidget.id ? normalizedWidget : widget)),
        layout: section.layout,
      };
    }));
    const nextProps = updatedWidget.config || updatedWidget.props;
    setEditingWidget({
      ...updatedWidget,
      type: nextProps.widget_type,
      props: nextProps,
      config: nextProps,
    });
  }, []);

  const handleDeleteWidgetById = useCallback((widgetId: string) => {
    setSections((prev) => prev.map((section) => ({
      ...section,
      widgets: section.widgets.filter((widget) => widget.id !== widgetId),
      layout: section.layout.filter((item) => item.i !== widgetId),
    })));
    setEditingWidget((current) => (current?.id === widgetId ? null : current));
    toast({ title: "Widget removido" });
  }, [toast]);

  const handleDuplicateWidget = useCallback((widget: DashboardWidget) => {
    const baseProps = widget.config || widget.props;
    const duplicateBase: DashboardWidget = {
      ...widget,
      id: makeTempWidgetId(),
      title: widget.title ? `${widget.title} (copia)` : widget.title,
      props: JSON.parse(JSON.stringify(baseProps)),
      config: JSON.parse(JSON.stringify(baseProps)),
    };
    duplicateBase.type = duplicateBase.props.widget_type;
    let duplicated = false;
    let blockedReason = "Nao ha coluna livre a direita para duplicar este widget.";

    setSections((prev) => prev.map((section) => {
      const index = section.widgets.findIndex((item) => item.id === widget.id);
      if (index === -1) return section;
      const sourceLayout = section.layout.find((item) => item.i === widget.id);
      if (!sourceLayout) {
        blockedReason = "Nao foi possivel localizar a posicao do widget original.";
        return section;
      }

      const occupiedColumns = new Set<number>();
      section.layout.forEach((item) => {
        if (item.i === widget.id) return;
        const start = Math.max(0, item.x);
        const end = Math.min(SECTION_GRID_COLS, item.x + item.w);
        for (let column = start; column < end; column += 1) {
          occupiedColumns.add(column);
        }
      });

      const sourceEnd = Math.min(SECTION_GRID_COLS, sourceLayout.x + sourceLayout.w);
      let duplicatedLayout: DashboardLayoutItem | null = null;

      for (let column = sourceEnd; column < SECTION_GRID_COLS; column += 1) {
        if (occupiedColumns.has(column)) continue;

        let contiguousFree = 0;
        for (let cursor = column; cursor < SECTION_GRID_COLS; cursor += 1) {
          if (occupiedColumns.has(cursor)) break;
          contiguousFree += 1;
        }
        if (contiguousFree <= 0) continue;

        const availableToEdge = SECTION_GRID_COLS - column;
        const targetW = Math.min(sourceLayout.w, availableToEdge, contiguousFree);
        if (targetW <= 0) continue;

        duplicatedLayout = normalizeLayoutItem({
          ...sourceLayout,
          i: duplicateBase.id,
          x: column,
          w: targetW,
        });
        break;
      }

      if (!duplicatedLayout) {
        blockedReason = "Sem colunas livres na direita para encaixar a copia do widget.";
        return section;
      }

      const duplicate: DashboardWidget = {
        ...duplicateBase,
        props: {
          ...duplicateBase.props,
          size: {
            width: duplicatedLayout.w as 1 | 2 | 3 | 4 | 5 | 6,
            height: gridRowsToWidgetHeight(duplicatedLayout.h),
          },
        },
      };
      duplicate.config = duplicate.props;
      duplicate.type = duplicate.props.widget_type;

      const widgets = [...section.widgets];
      widgets.splice(index + 1, 0, duplicate);
      const layout = [...section.layout, duplicatedLayout];
      duplicated = true;
      return syncSectionWidgetsWithLayout({ ...section, widgets, layout });
    }));

    if (duplicated) {
      toast({ title: "Widget duplicado" });
      return;
    }
    toast({
      title: "Nao foi possivel duplicar",
      description: blockedReason,
      variant: "destructive",
    });
  }, [toast]);

  const handleToggleWidgetTitle = useCallback((widget: DashboardWidget) => {
    const baseProps = widget.config || widget.props;
    const nextProps = {
      ...baseProps,
      show_title: baseProps.show_title === false,
    };
    const updated: DashboardWidget = {
      ...widget,
      type: nextProps.widget_type,
      props: nextProps,
      config: nextProps,
    };
    handleUpdateWidget(updated);
  }, [handleUpdateWidget]);

  const handleAddSection = useCallback((afterIndex?: number) => {
    setSections((prev) => {
      const section = createSection();
      section.title = `Seção ${prev.length + 1}`;

      if (afterIndex === undefined || afterIndex < 0 || afterIndex >= prev.length) {
        return [...prev, section];
      }

      const next = [...prev];
      next.splice(afterIndex, 0, section);
      return next;
    });
  }, []);

  const handleAddWidgetType = useCallback((
    type: VisualizationType,
    targetSectionId?: string,
    placement?: Pick<DashboardLayoutItem, "x" | "y" | "w" | "h">,
    preferredWidgetType?: WidgetType,
  ) => {
    if (datasetColumns.length === 0) {
      toast({ title: "Nao foi possivel carregar colunas do dataset", variant: "destructive" });
      return;
    }

    const catalog = preferredWidgetType ? getWidgetCatalogByType(preferredWidgetType) : getWidgetCatalogByVisualization(type);
    const widgetType = preferredWidgetType || catalog.widgetType || mapVisualizationToWidgetType(type);
    const viewName = view ? `${view.schema}.${view.name}` : "__dataset_base";
    const numericColumn = datasetColumns.find((column) => column.type === "numeric")?.name;
    const temporalColumn = datasetColumns.find((column) => column.type === "temporal")?.name;
    const dimensionColumn = datasetColumns.find((column) => column.type === "text" || column.type === "boolean" || column.type === "temporal")?.name;
    const fallbackColumn = datasetColumns[0]?.name;

    const defaultConfig = createDefaultWidgetConfig({
      type: widgetType,
      viewName,
      columns: datasetColumns,
    });

    const nextMetrics = [...(defaultConfig.metrics || [])];
    if (nextMetrics.length > 0) {
      const first = nextMetrics[0];
      const preferredMetricColumn = first.op === "count" ? (numericColumn || fallbackColumn) : (numericColumn || first.column || fallbackColumn);
      nextMetrics[0] = {
        ...first,
        column: preferredMetricColumn,
      };
    }

    const nextConfig = {
      ...defaultConfig,
      ...catalog.defaultProps,
      metrics: nextMetrics,
      dimensions: defaultConfig.dimensions,
      size: defaultConfig.size,
    };

    if (widgetType === "line") {
      nextConfig.time = {
        column: temporalColumn || dimensionColumn || fallbackColumn || "",
        granularity: defaultConfig.time?.granularity || "day",
      };
    }

    if (widgetType === "bar" || widgetType === "column" || widgetType === "donut") {
      if (dimensionColumn) {
        nextConfig.dimensions = [dimensionColumn];
      }
    }

    if (widgetType === "table" && (!nextConfig.columns || nextConfig.columns.length === 0)) {
      nextConfig.columns = datasetColumns.slice(0, Math.min(8, datasetColumns.length)).map((column) => column.name);
    }

    let createdWidget: DashboardWidget | null = null;
    let blockedReason: string | null = null;

    setSections((prev) => {
      let next = [...prev];
      const ensureSection = (): DashboardSection => {
        const appended = createSection();
        appended.title = `Seção ${next.length + 1}`;
        next = [...next, appended];
        return appended;
      };
      if (next.length === 0) {
        ensureSection();
      }

      const tryInsertInSection = (
        sectionId: string,
        desiredPlacement?: Pick<DashboardLayoutItem, "x" | "y" | "w" | "h">,
      ): boolean => {
        const sectionIndex = next.findIndex((section) => section.id === sectionId);
        if (sectionIndex < 0) return false;
        const section = next[sectionIndex];
        const defaultTitle = widgetType === "kpi" ? summarizeKpiTitle(nextConfig) : catalog.title;
        const newWidget: DashboardWidget = {
          id: makeTempWidgetId(),
          title: defaultTitle,
          position: section.widgets.length,
          configVersion: 1,
          type: widgetType,
          sectionId: section.id,
          props: nextConfig,
          config: nextConfig,
        };

        let nextLayout: DashboardLayoutItem[] | null = null;
        if (desiredPlacement) {
          const insertedItem = normalizeLayoutItem({
            i: newWidget.id,
            x: desiredPlacement.x,
            y: 0,
            w: desiredPlacement.w ?? catalog.minW,
            h: desiredPlacement.h ?? catalog.minH,
          });
          nextLayout = insertLayoutItemWithShift(section.layout, insertedItem);
        } else {
          const resolvedPlacement = findNextSequentialPlacement(section.layout, catalog.minW, catalog.minH);
          if (resolvedPlacement) {
            nextLayout = [...section.layout, normalizeLayoutItem({
              i: newWidget.id,
              ...resolvedPlacement,
            })];
          }
        }

        if (!nextLayout) {
          return false;
        }

        createdWidget = newWidget;
        const widgets = [...section.widgets, newWidget];
        const nextSection: DashboardSection = {
          ...section,
          columns: SECTION_GRID_COLS,
          widgets,
          layout: nextLayout,
        };
        next[sectionIndex] = syncSectionWidgetsWithLayout(nextSection);
        return true;
      };

      const resolvedTargetSectionId = targetSectionId
        ? (next.some((section) => section.id === targetSectionId) ? targetSectionId : next[0].id)
        : undefined;

      let inserted = false;
      if (resolvedTargetSectionId) {
        inserted = tryInsertInSection(resolvedTargetSectionId, placement);
      } else {
        const sectionWithSpace = next.find((section) => !!findNextSequentialPlacement(section.layout, catalog.minW, catalog.minH));
        if (sectionWithSpace) {
          inserted = tryInsertInSection(sectionWithSpace.id);
        }
      }

      if (!inserted) {
        const fallbackSection = ensureSection();
        inserted = tryInsertInSection(fallbackSection.id, placement);
      }

      if (!inserted) {
        blockedReason = "Nao foi possivel alocar o widget em nenhuma seção.";
      }

      return next;
    });

    if (!createdWidget && blockedReason) {
      toast({ title: "Nao foi possivel adicionar widget", description: blockedReason, variant: "destructive" });
      return;
    }

    if (createdWidget) {
      setEditingWidget(createdWidget);
    }
  }, [datasetColumns, datasetSourceLabel, toast, view]);

  const confirmDiscardIfDirty = useCallback(() => {
    if (isSaved) return true;
    return window.confirm("Existem alteracoes nao salvas. Deseja sair mesmo assim?");
  }, [isSaved]);

  const handleBack = useCallback(() => {
    if (!confirmDiscardIfDirty()) return;
    const targetId = activeDashboardId || dashboardId;
    if (datasetId && targetId) {
      navigate(`/datasets/${datasetId}/dashboard/${targetId}`);
      return;
    }
    if (datasetId) {
      navigate(`/datasets/${datasetId}`);
      return;
    }
    navigate("/datasets");
  }, [activeDashboardId, confirmDiscardIfDirty, dashboardId, datasetId, navigate]);

  const handleShare = useCallback(async () => {
    const targetId = activeDashboardId || dashboardId;
    if (!targetId || !datasetId) {
      toast({ title: "Salve o dashboard antes de compartilhar", variant: "destructive" });
      return;
    }

    let shareUrl = `${window.location.origin}/datasets/${datasetId}/dashboard/${targetId}`;
    try {
      const dashboard = await api.getDashboard(Number(targetId));
      if (dashboard.visibility === "public_view" && dashboard.public_share_key) {
        shareUrl = `${window.location.origin}/public/dashboard/${dashboard.public_share_key}`;
      }
    } catch {
      // Mantem URL interna se nao conseguir consultar visibilidade.
    }

    await navigator.clipboard.writeText(shareUrl);
    toast({ title: "Link copiado" });
  }, [activeDashboardId, dashboardId, datasetId, toast]);

  const handleExportDashboardJson = useCallback(async () => {
    const targetId = activeDashboardId || dashboardId;
    if (!targetId) {
      toast({ title: "Salve o dashboard antes de exportar", variant: "destructive" });
      return;
    }

    try {
      const payload = await api.exportDashboard(Number(targetId));
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `dashboard-${targetId}.json`;
      link.click();
      window.URL.revokeObjectURL(url);
      toast({ title: "Dashboard exportado" });
    } catch (error) {
      const message = error instanceof ApiError ? String(error.detail || error.message) : "Falha ao exportar";
      toast({ title: "Erro ao exportar", description: message, variant: "destructive" });
    }
  }, [activeDashboardId, dashboardId, toast]);

  const handleImportDashboardJson = useCallback(async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file || !datasetId) return;

    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as { dashboard?: Record<string, unknown> } | Record<string, unknown>;
      const rawDashboard = ((parsed as { dashboard?: Record<string, unknown> }).dashboard || parsed) as Record<string, unknown>;
      const imported = await api.importDashboard({
        dataset_id: Number(datasetId),
        dashboard: rawDashboard,
      });

      await queryClient.invalidateQueries({ queryKey: ["dashboards"] });
      toast({ title: "Dashboard importado" });
      navigate(`/datasets/${datasetId}/builder/${imported.id}`);
    } catch (error) {
      const message = error instanceof ApiError ? String(error.detail || error.message) : "JSON invalido para importacao";
      toast({ title: "Erro ao importar", description: message, variant: "destructive" });
    } finally {
      if (importInputRef.current) importInputRef.current.value = "";
    }
  }, [datasetId, navigate, queryClient, toast]);

  const handleRefreshData = useCallback(async () => {
    try {
      await queryClient.invalidateQueries({ queryKey: ["widget-data"] });
      await queryClient.invalidateQueries({ queryKey: ["widget-draft-data"] });
      toast({ title: "Dados atualizados" });
    } catch {
      toast({ title: "Falha ao atualizar dados", variant: "destructive" });
    }
  }, [queryClient, toast]);

  const handleDeleteDashboard = useCallback(async () => {
    if (!activeDashboardId) {
      handleBack();
      return;
    }

    try {
      await api.deleteDashboard(Number(activeDashboardId));
      await queryClient.invalidateQueries({ queryKey: ["dashboards"] });
      setDeleteDashboardOpen(false);
      toast({ title: "Dashboard excluido" });
      if (datasetId) {
        navigate(`/datasets/${datasetId}`);
        return;
      }
      navigate("/datasets");
    } catch (error) {
      const message = error instanceof ApiError ? String(error.detail || error.message) : "Falha ao excluir dashboard";
      toast({ title: "Erro ao excluir", description: message, variant: "destructive" });
    }
  }, [activeDashboardId, datasetId, handleBack, navigate, queryClient, toast]);

  const handleGenerateWithAI = useCallback((mode: "widget" | "dashboard" | "explore") => {
    if (mode === "widget") {
      toast({ title: "Gerar widget em breve" });
      return;
    }

    if (mode === "dashboard") {
      toast({ title: "Gerar dashboard em breve" });
      return;
    }

    toast({ title: "Exploracao de dataset em breve" });
  }, [toast]);

  const handleAssistantSend = useCallback(() => {
    const prompt = assistantInput.trim();
    if (!prompt) return;
    const userMessage: ChatMessageData = {
      id: `user-${Date.now()}`,
      role: "user",
      content: prompt,
    };
    const assistantMessage: ChatMessageData = {
      id: `assistant-${Date.now() + 1}`,
      role: "assistant",
      content: "Posso ajudar a gerar widgets, secoes e filtros. Use os atalhos W, S, Cmd/Ctrl+S e Cmd/Ctrl+Shift+S para agilizar o fluxo.",
      status: "done",
    };
    setAssistantMessages((prev) => [...prev, userMessage, assistantMessage]);
    setAssistantInput("");
  }, [assistantInput]);

  const handleEditWidget = useCallback((widget: DashboardWidget) => {
    setEditingWidget(widget);
  }, []);

  const handleSectionsChange = useCallback((nextSections: DashboardSection[]) => {
    setSections(normalizeSectionsForBuilder(nextSections));
  }, [normalizeSectionsForBuilder]);

  const handleCommitSectionLayout = useCallback((sectionId: string, layout: DashboardLayoutItem[]) => {
    const targetId = activeDashboardId || dashboardId;
    const nextSections = normalizeSectionsForBuilder(
      sections.map((section) => (
        section.id === sectionId
          ? {
            ...section,
            columns: SECTION_GRID_COLS,
            layout,
          }
          : section
      )),
    );
    setSections(nextSections);
    if (!targetId) return;
    persistSectionLayoutMutation.mutate({
      dashboardId: Number(targetId),
      sections: nextSections,
    });
  }, [activeDashboardId, dashboardId, normalizeSectionsForBuilder, persistSectionLayoutMutation, sections]);

  const handleDeleteWidgetFromRightPanel = useCallback(() => {
    if (!editingWidget) return;
    handleDeleteWidgetById(editingWidget.id);
  }, [editingWidget, handleDeleteWidgetById]);

  const removeAppliedFilter = useCallback((filter: PreparedGlobalFilter) => {
    const signature = appliedFilterSignature(filter);
    setAppliedGlobalFilters((prev) => prev.filter((item) => appliedFilterSignature(item) !== signature));
    setDraftGlobalFilters((prev) => {
      let removed = false;
      return prev.filter((item) => {
        if (removed || !item.column) return true;
        const normalized = prepareGlobalFilters([item], temporalColumnNames)[0];
        if (normalized && appliedFilterSignature(normalized) === signature) {
          removed = true;
          return false;
        }
        return true;
      });
    });
  }, [temporalColumnNames]);

  const clearAllFilters = useCallback(() => {
    setDraftGlobalFilters([]);
    setAppliedGlobalFilters([]);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.key === "Escape") {
        if (editingWidget) {
          event.preventDefault();
          setEditingWidget(null);
        }
        return;
      }

      const target = event.target as HTMLElement | null;
      const tagName = target?.tagName?.toLowerCase();
      const isTyping = target?.isContentEditable || tagName === "input" || tagName === "textarea" || tagName === "select";

      if (isTyping) return;

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        handleSaveDashboard();
        return;
      }

      if (!event.metaKey && !event.ctrlKey && !event.altKey && event.key.toLowerCase() === "w") {
        event.preventDefault();
        setQuickWidgetPickerOpen(true);
        return;
      }

      if (!event.metaKey && !event.ctrlKey && !event.altKey && event.key.toLowerCase() === "s") {
        event.preventDefault();
        handleAddSection();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [editingWidget, handleAddSection, handleAddWidgetType, handleSaveDashboard]);

  const widgetCount = useMemo(
    () => sections.reduce((total, section) => total + section.widgets.length, 0),
    [sections],
  );
  const isTitleOnboardingStep = onboardingActive && onboardingStep?.id === "dashboard-name";

  const hasEmptyCanvas = sections.length === 0 && widgetCount === 0;
  const targetDashboardId = activeDashboardId || dashboardId;

  if (isError) {
    return (
      <div className="bg-background">
        <main className="app-container py-6">
          <EmptyState icon={<LayoutDashboard className="h-5 w-5" />} title="Erro ao carregar builder" description={errorMessage} />
        </main>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="bg-background">
        <main className="app-container py-6">
          <EmptyState icon={<LayoutDashboard className="h-5 w-5" />} title="Carregando builder" description="Aguarde enquanto buscamos os dados." />
        </main>
      </div>
    );
  }

  if (!dataset) {
    return (
      <div className="bg-background">
        <main className="app-container py-6">
          <EmptyState icon={<LayoutDashboard className="h-5 w-5" />} title="Dataset nao encontrado" description="O dataset solicitado nao existe." />
        </main>
      </div>
    );
  }

  if (isEditingExistingDashboard && !existingDashboard) {
    return (
      <div className="bg-background">
        <main className="app-container py-6">
          <EmptyState
            icon={<LayoutDashboard className="h-5 w-5" />}
            title="Dashboard nao encontrado"
            description="Voce nao tem permissao para editar este dashboard ou ele nao existe."
          />
        </main>
      </div>
    );
  }

  if (isEditingExistingDashboard && !canEditExistingDashboard) {
    return (
      <div className="bg-background">
        <main className="app-container py-6">
          <EmptyState
            icon={<LayoutDashboard className="h-5 w-5" />}
            title="Acesso negado"
            description="Voce tem acesso somente de visualizacao para este dashboard."
          />
        </main>
      </div>
    );
  }

  const renderCanvas = () => (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-border/50 bg-card/30 px-8 py-2">
        <div className="flex flex-wrap items-center justify-end gap-2">
          {(isPreview ? appliedGlobalFilters.filter((filter) => filter.visible !== false) : appliedGlobalFilters).map((filter) => (
            <Badge key={appliedFilterSignature(filter)} variant="secondary" className="gap-1.5 py-1">
              <span className="truncate max-w-[220px]" title={appliedFilterLabel(filter)}>{appliedFilterLabel(filter)}</span>
              <button
                type="button"
                className="rounded-full hover:bg-muted-foreground/20 p-0.5"
                onClick={() => removeAppliedFilter(filter)}
                aria-label={`Remover filtro ${appliedFilterLabel(filter)}`}
              >
                <X className="h-3 w-3" />
              </button>
            </Badge>
          ))}
          {appliedGlobalFilters.length > 0 && (
            <Button size="sm" variant="ghost" className="h-7 text-xs px-2.5" onClick={clearAllFilters}>
              Limpar
            </Button>
          )}
          <Popover open={filtersPopoverOpen} onOpenChange={setFiltersPopoverOpen}>
            <PopoverTrigger asChild>
              <Button size="sm" variant="outline" className="h-8 text-xs">
                <SlidersHorizontal className="h-3.5 w-3.5 mr-1.5" /> Filtros
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-[min(92vw,760px)] p-4" align="end">
              <div className="space-y-3">
            <Label className="text-xs font-semibold text-muted-foreground">Filtros globais</Label>
            {draftGlobalFilters.length === 0 && (
              <p className="text-xs text-muted-foreground">Nenhum filtro global ativo.</p>
            )}
            {draftGlobalFilters.map((filter) => {
              const isTemporal = temporalColumnNames.has(filter.column);
              const columnType = columnTypeByName[filter.column];
              const isCategorical = columnType === "text" || columnType === "boolean";
              const operatorOptions = isTemporal ? temporalOps : commonOps;
              const hint = filter.column ? categoricalValueHints[filter.column] : undefined;
              const showCategoricalDropdown = !!(
                filter.column
                && isCategorical
                && exactValueOps.has(filter.op)
                && hint
                && !hint.truncated
                && hint.values.length > 0
                && hint.values.length <= CATEGORICAL_DROPDOWN_THRESHOLD
              );
              const scalarValue = Array.isArray(filter.value) ? String(filter.value[0] || "") : String(filter.value || "");
              const listValue = Array.isArray(filter.value) ? filter.value.map((item) => String(item)).join(",") : String(filter.value || "");
              const betweenValues = Array.isArray(filter.value)
                ? [String(filter.value[0] || ""), String(filter.value[1] || "")]
                : ["", ""];

              return (
                <FilterRuleRow key={filter.id} variant="global">
                  <Select
                    value={filter.column || "__none__"}
                    onValueChange={(value) =>
                      setDraftGlobalFilters((prev) => prev.map((item) => item.id === filter.id
                        ? {
                          ...item,
                          column: value === "__none__" ? "" : value,
                          op: "eq",
                          value: "",
                          dateValue: undefined,
                          dateRange: undefined,
                          relativePreset: "last_7_days",
                        }
                        : item))}
                  >
                    <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="Coluna" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none__">Sem coluna</SelectItem>
                      {(datasetColumns || []).map((column) => (
                        <SelectItem key={column.name} value={column.name}>{column.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>

                  <Select
                    value={filter.op}
                    onValueChange={(value) =>
                      setDraftGlobalFilters((prev) => prev.map((item) => item.id === filter.id
                        ? {
                          ...item,
                          op: value as DashboardFilterOp,
                          value: "",
                          dateValue: undefined,
                          dateRange: undefined,
                          relativePreset: "last_7_days",
                        }
                        : item))}
                    disabled={!filter.column}
                  >
                    <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {operatorOptions.map((op) => (
                        <SelectItem key={op.value} value={op.value}>{op.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>

                  {!isTemporal && (filter.op === "is_null" || filter.op === "not_null") && (
                    <div className="h-8" />
                  )}

                  {!isTemporal && (filter.op === "in" || filter.op === "not_in") && (
                    <Input
                      className="h-8 text-xs"
                      placeholder="Ex: A, B, C"
                      value={listValue}
                      onChange={(event) =>
                        setDraftGlobalFilters((prev) => prev.map((item) => item.id === filter.id
                          ? { ...item, value: event.target.value.split(",").map((v) => v.trim()).filter(Boolean) }
                          : item))}
                      disabled={!filter.column}
                    />
                  )}

                  {!isTemporal && filter.op === "between" && (
                    <div className="flex items-center gap-1">
                      <Input
                        className="h-8 text-xs"
                        placeholder="De"
                        value={betweenValues[0]}
                        onChange={(event) =>
                          setDraftGlobalFilters((prev) => prev.map((item) => item.id === filter.id
                            ? { ...item, value: [event.target.value, betweenValues[1]] }
                            : item))}
                        disabled={!filter.column}
                      />
                      <Input
                        className="h-8 text-xs"
                        placeholder="Ate"
                        value={betweenValues[1]}
                        onChange={(event) =>
                          setDraftGlobalFilters((prev) => prev.map((item) => item.id === filter.id
                            ? { ...item, value: [betweenValues[0], event.target.value] }
                            : item))}
                        disabled={!filter.column}
                      />
                    </div>
                  )}

                  {!isTemporal && !(filter.op === "is_null" || filter.op === "not_null" || filter.op === "in" || filter.op === "not_in" || filter.op === "between") && (
                    showCategoricalDropdown ? (
                      <Select
                        value={scalarValue || "__none__"}
                        onValueChange={(value) =>
                          setDraftGlobalFilters((prev) => prev.map((item) => item.id === filter.id
                            ? { ...item, value: value === "__none__" ? "" : value }
                            : item))}
                        disabled={!filter.column}
                      >
                        <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="Valor" /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="__none__">Sem valor</SelectItem>
                          {hint?.values.map((value) => (
                            <SelectItem key={`${filter.id}-${value}`} value={value}>{value}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : (
                      <Input
                        className="h-8 text-xs"
                        placeholder={loadingCategoricalColumns[filter.column] ? "Carregando valores..." : "Valor"}
                        value={scalarValue}
                        onChange={(event) =>
                          setDraftGlobalFilters((prev) => prev.map((item) => item.id === filter.id ? { ...item, value: event.target.value } : item))}
                        disabled={!filter.column}
                      />
                    )
                  )}

                  {isTemporal && filter.op === "relative" && (
                    <Select
                      value={filter.relativePreset || "last_7_days"}
                      onValueChange={(value) =>
                        setDraftGlobalFilters((prev) => prev.map((item) => item.id === filter.id
                          ? { ...item, relativePreset: value as RelativeDatePreset }
                          : item))}
                      disabled={!filter.column}
                    >
                      <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {relativeDateOptions.map((option) => (
                          <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}

                  {isTemporal && (filter.op === "is_null" || filter.op === "not_null") && (
                    <div className="h-8" />
                  )}

                  {isTemporal && (filter.op === "in" || filter.op === "not_in") && (
                    <Input
                      className="h-8 text-xs"
                      placeholder="Ex: 2025-01-01, 2025-01-15"
                      value={listValue}
                      onChange={(event) =>
                        setDraftGlobalFilters((prev) => prev.map((item) => item.id === filter.id
                          ? { ...item, value: event.target.value.split(",").map((v) => v.trim()).filter(Boolean) }
                          : item))}
                      disabled={!filter.column}
                    />
                  )}

                  {isTemporal && filter.op !== "between" && filter.op !== "relative" && filter.op !== "is_null" && filter.op !== "not_null" && filter.op !== "in" && filter.op !== "not_in" && (
                    <Popover>
                      <PopoverTrigger asChild>
                        <Button
                          variant="outline"
                          className={cn("h-8 justify-start text-left text-xs font-normal", !filter.dateValue && "text-muted-foreground")}
                          disabled={!filter.column}
                        >
                          <CalendarIcon className="mr-2 h-3.5 w-3.5" />
                          {filter.dateValue ? formatDateBR(filter.dateValue) : "Selecionar data"}
                        </Button>
                      </PopoverTrigger>
                      <PopoverContent className="w-auto p-0" align="start">
                        <Calendar
                          mode="single"
                          selected={filter.dateValue}
                          onSelect={(date) => setDraftGlobalFilters((prev) => prev.map((item) => item.id === filter.id ? { ...item, dateValue: date } : item))}
                        />
                      </PopoverContent>
                    </Popover>
                  )}

                  {isTemporal && filter.op === "between" && (
                    <Popover>
                      <PopoverTrigger asChild>
                        <Button
                          variant="outline"
                          className={cn("h-8 justify-start text-left text-xs font-normal", (!filter.dateRange?.from || !filter.dateRange?.to) && "text-muted-foreground")}
                          disabled={!filter.column}
                        >
                          <CalendarIcon className="mr-2 h-3.5 w-3.5" />
                          {filter.dateRange?.from && filter.dateRange?.to
                            ? `${formatDateBR(filter.dateRange.from)} - ${formatDateBR(filter.dateRange.to)}`
                            : "Selecionar intervalo"}
                        </Button>
                      </PopoverTrigger>
                      <PopoverContent className="w-auto p-0" align="start">
                        <Calendar
                          mode="range"
                          selected={filter.dateRange}
                          onSelect={(range) => setDraftGlobalFilters((prev) => prev.map((item) => item.id === filter.id ? { ...item, dateRange: range } : item))}
                          numberOfMonths={2}
                        />
                      </PopoverContent>
                    </Popover>
                  )}

                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    className="h-8 w-8"
                    onClick={() => setDraftGlobalFilters((prev) => prev.map((item) => item.id === filter.id ? { ...item, visible: !item.visible } : item))}
                    title={filter.visible ? "Ocultar no dashboard" : "Mostrar no dashboard"}
                  >
                    {filter.visible ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5 text-muted-foreground" />}
                  </Button>

                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    className="h-8 w-8 destructive-icon-btn"
                    disabled={draftGlobalFilters.length === 1}
                    onClick={() => setDraftGlobalFilters((prev) => prev.filter((item) => item.id !== filter.id))}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </FilterRuleRow>
              );
            })}

            <div className="flex items-center justify-between pt-1">
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-8 text-xs"
                onClick={() => setDraftGlobalFilters((prev) => [...prev, createBlankGlobalFilter()])}
              >
                <Plus className="h-3.5 w-3.5 mr-1.5" /> Adicionar filtro
              </Button>
              <div className="flex items-center justify-end gap-2">
                <Button
                  type="button"
                  size="sm"
                  className="h-8 text-xs"
                  onClick={() => {
                    setAppliedGlobalFilters(prepareGlobalFilters(draftGlobalFilters, temporalColumnNames));
                    setFiltersPopoverOpen(false);
                  }}
                >
                  Aplicar ({prepareGlobalFilters(draftGlobalFilters, temporalColumnNames).length})
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-8 text-xs"
                  onClick={clearAllFilters}
                >
                  Limpar
                </Button>
              </div>
            </div>
              </div>
            </PopoverContent>
          </Popover>
        </div>
      </div>

      <div className={cn(
        "min-h-0 flex-1 overflow-auto",
        hasEmptyCanvas ? "px-4 py-4" : "p-6",
      )}
      >
        {hasEmptyCanvas ? (
          <div className="flex h-full min-h-[420px] items-center justify-center">
            <motion.div
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              className="w-full max-w-lg rounded-2xl border border-border/60 bg-[hsl(var(--card)/0.45)] p-8 text-center"
            >
              <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-xl bg-accent/10 text-accent">
                <LayoutDashboard className="h-7 w-7" />
              </div>

              <h2 className="text-sm font-semibold text-foreground">Seu canvas esta vazio</h2>
              <p className="mt-2 text-xs text-muted-foreground">
                Crie secoes e widgets para comecar a montar o dashboard analitico.
              </p>

              <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
                <motion.div whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }}>
                  <Button className="h-8 text-xs rounded-xl bg-accent text-accent-foreground" onClick={() => handleAddSection()}>
                    <Plus className="mr-1.5 h-4 w-4" /> Criar seção
                  </Button>
                </motion.div>
              </div>

              <Separator className="my-5" />

              <div className="space-y-2">
                <p className="inline-flex items-center gap-1 text-label font-medium text-muted-foreground">
                  <Keyboard className="h-3.5 w-3.5" /> Atalhos
                </p>
                <div className="grid grid-cols-1 gap-1 text-caption text-muted-foreground sm:grid-cols-2">
                  <span><kbd className="rounded border px-1 py-0.5">W</kbd> novo widget</span>
                  <span><kbd className="rounded border px-1 py-0.5">S</kbd> nova seção</span>
                  <span><kbd className="rounded border px-1 py-0.5">Ctrl+S</kbd> salvar</span>
                  <span><kbd className="rounded border px-1 py-0.5">Cmd+S</kbd> salvar</span>
                  <span><kbd className="rounded border px-1 py-0.5">Ctrl+Shift+S</kbd> salvar e fechar widget</span>
                  <span><kbd className="rounded border px-1 py-0.5">Cmd+Shift+S</kbd> salvar e fechar widget</span>
                </div>
              </div>
            </motion.div>
          </div>
        ) : (
          <DashboardCanvas
            dashboardId={targetDashboardId}
            datasetId={Number(dataset.id)}
            nativeFilters={appliedGlobalFilters}
            sections={sections}
            onSectionsChange={handleSectionsChange}
            onAddWidget={(sectionId, type, placement, preferredWidgetType) => handleAddWidgetType(type, sectionId, placement, preferredWidgetType)}
            onEditWidget={handleEditWidget}
            onDeleteWidget={(widget) => handleDeleteWidgetById(widget.id)}
            onDuplicateWidget={handleDuplicateWidget}
            onToggleWidgetTitle={handleToggleWidgetTitle}
            onAddSection={handleAddSection}
            onCommitSectionLayout={handleCommitSectionLayout}
            readOnly={isPreview}
            builderMode={!isPreview}
          />
        )}
      </div>
    </div>
  );

  return (
    <div className="bg-background h-[calc(100vh-56px)] min-h-0 flex flex-col overflow-hidden">
      <BuilderTopBar
        title={dashboardTitle}
        onTitleChange={setDashboardTitle}
        titleOnboardingActive={isTitleOnboardingStep}
        view={effectiveView!}
        datasetName={dataset.name}
        widgetCount={widgetCount}
        sectionCount={sections.length}
        isSaved={isSaved}
        isPreview={isPreview}
        onSave={handleSaveDashboard}
        onTogglePreview={() => setIsPreview((current) => !current)}
        onBack={handleBack}
        onDelete={() => setDeleteDashboardOpen(true)}
        onShare={() => {
          void handleShare();
        }}
        onExport={() => {
          void handleExportDashboardJson();
        }}
        onImport={() => importInputRef.current?.click()}
        onRefreshData={() => {
          void handleRefreshData();
        }}
        onReplayOnboarding={handleReplayOnboarding}
      />

      <div className="min-h-0 flex-1 overflow-hidden">
        {isPreview ? (
          <div className="h-full overflow-auto">
            <div className="container py-6">{renderCanvas()}</div>
          </div>
        ) : (
          <ResizablePanelGroup direction="horizontal" className="h-full min-h-0">
            <ResizablePanel
              defaultSize={16}
              minSize={6}
              maxSize={22}
              onResize={(size) => setLeftPanelCollapsed(size <= 8)}
              className="overflow-hidden"
            >
              <BuilderLeftPanel
                onAddWidget={(type, preferredWidgetType) => handleAddWidgetType(type, undefined, undefined, preferredWidgetType)}
                onGenerateWithAI={handleGenerateWithAI}
                collapsed={leftPanelCollapsed}
              />
            </ResizablePanel>

            <ResizableHandle withHandle />

            <ResizablePanel defaultSize={editingWidget ? 56 : 84} minSize={40} className="min-w-0 overflow-hidden">
              {renderCanvas()}
            </ResizablePanel>

            {editingWidget && (
              <>
                <ResizableHandle withHandle />
                <ResizablePanel defaultSize={28} minSize={22} maxSize={38} className="overflow-hidden">
                  <BuilderRightPanel
                    widget={editingWidget}
                    columns={datasetColumns}
                    dashboardWidgets={sections.flatMap((section) => section.widgets)}
                    onUpdate={handleUpdateWidget}
                    onDelete={handleDeleteWidgetFromRightPanel}
                    onClose={() => setEditingWidget(null)}
                  />
                </ResizablePanel>
              </>
            )}
          </ResizablePanelGroup>
        )}
      </div>

      <input
        ref={importInputRef}
        type="file"
        accept="application/json,.json"
        className="hidden"
        onChange={(event) => {
          void handleImportDashboardJson(event);
        }}
      />

      <ConfirmDialog
        open={deleteDashboardOpen}
        onOpenChange={setDeleteDashboardOpen}
        title="Excluir dashboard?"
        description={`Esta acao removera permanentemente o dashboard "${dashboardTitle}" e todos os widgets dele.`}
        confirmLabel="Excluir dashboard"
        destructive
        onConfirm={() => {
          void handleDeleteDashboard();
        }}
      />

      <Dialog open={quickWidgetPickerOpen} onOpenChange={setQuickWidgetPickerOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Adicionar widget</DialogTitle>
            <DialogDescription>Selecione o tipo para criar (atalho W).</DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-1 gap-2">
            {quickWidgetOptions.map((option) => (
              <Button
                key={option.type}
                type="button"
                variant="outline"
                className="justify-start gap-2 h-9"
                onClick={() => {
                  handleAddWidgetType(option.type, undefined, undefined, option.preferredWidgetType);
                  setQuickWidgetPickerOpen(false);
                }}
              >
                <option.icon className="h-4 w-4" />
                {option.label}
              </Button>
            ))}
          </div>
        </DialogContent>
      </Dialog>

      {!assistantOpen && !editingWidget && (
        <motion.button
          type="button"
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          onClick={() => setAssistantOpen(true)}
          className="fixed bottom-6 right-6 z-50 inline-flex h-12 items-center gap-2 rounded-full bg-accent px-5 text-accent-foreground shadow-lg"
        >
          <Sparkles className="h-4 w-4" />
          <span className="hidden sm:inline text-sm font-medium">Assistente IA</span>
        </motion.button>
      )}

      {assistantOpen && (
        <motion.aside
          initial={{ x: 420, opacity: 0 }}
          animate={{ x: 0, opacity: 1 }}
          exit={{ x: 420, opacity: 0 }}
          transition={{ type: "spring", stiffness: 320, damping: 28 }}
          className="fixed inset-y-0 right-0 z-50 w-full border-l border-border bg-card shadow-2xl sm:w-[400px]"
        >
          <div className="flex h-full flex-col">
            <div className="border-b border-border px-4 py-3">
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-start gap-2.5">
                  <span className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-accent/10">
                    <Sparkles className="h-4 w-4 text-accent" />
                  </span>
                  <div>
                    <p className="text-sm font-semibold">Assistente IA</p>
                    <p className="text-[11px] text-muted-foreground">Ajuda com criacao de widgets e dashboard</p>
                  </div>
                </div>
                <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setAssistantOpen(false)}>
                  <X className="h-4 w-4" />
                </Button>
              </div>
            </div>

            <ChatMessages messages={assistantMessages} className="px-4 py-4">
              {assistantMessages.length === 0 && (
                <div className="flex flex-wrap gap-2">
                  {[
                    "Sugira 3 secoes para este dataset",
                    "Crie um widget de tendencia mensal",
                    "Quais filtros globais devo usar?",
                  ].map((suggestion) => (
                    <button
                      key={suggestion}
                      type="button"
                      className="rounded-full bg-secondary px-2.5 py-1.5 text-[11px]"
                      onClick={() => setAssistantInput(suggestion)}
                    >
                      {suggestion}
                    </button>
                  ))}
                </div>
              )}
            </ChatMessages>

            <div className="border-t border-border p-3">
              <ChatInput
                value={assistantInput}
                onChange={setAssistantInput}
                onSend={handleAssistantSend}
                variant="textarea"
                placeholder="Peça para gerar secoes, widgets ou filtros..."
              />
            </div>
          </div>
        </motion.aside>
      )}

      {onboardingActive && onboardingStep && onboardingTargetRect && (
        <>
          <div className="pointer-events-none fixed inset-0 z-[110] bg-black/35" />
          <div
            className="pointer-events-none fixed z-[111] rounded-xl border-2 border-accent shadow-[0_0_0_1px_hsl(var(--accent)/0.4)]"
            style={{
              top: Math.max(0, onboardingTargetRect.top - 6),
              left: Math.max(0, onboardingTargetRect.left - 6),
              width: onboardingTargetRect.width + 12,
              height: onboardingTargetRect.height + 12,
            }}
          />
          <div
            className="fixed z-[112] w-[300px] rounded-xl border border-border/70 bg-card p-4 shadow-2xl"
            style={onboardingCardStyle}
          >
            <p className="text-[11px] font-medium text-muted-foreground">
              Passo {onboardingStepIndex + 1} de {BUILDER_ONBOARDING_STEPS.length}
            </p>
            <p className="mt-1 text-sm font-semibold text-foreground">{onboardingStep.title}</p>
            <p className="mt-1.5 text-xs text-muted-foreground">{onboardingStep.text}</p>
            <div className="mt-4 flex items-center justify-between gap-2">
              <Button type="button" size="sm" variant="ghost" className="h-8 text-xs" onClick={() => closeBuilderOnboarding(true)}>
                Pular
              </Button>
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-8 text-xs"
                  onClick={handleOnboardingBack}
                  disabled={onboardingStepIndex === 0}
                >
                  Voltar
                </Button>
                <Button type="button" size="sm" className="h-8 text-xs" onClick={handleOnboardingNext}>
                  {onboardingStepIndex === BUILDER_ONBOARDING_STEPS.length - 1 ? "Concluir" : "Proximo"}
                </Button>
              </div>
            </div>
          </div>
        </>
      )}

      {saveDashboardMutation.isPending && (
        <div className={cn(
          "pointer-events-none fixed bottom-4 right-4 rounded-md border border-border/50 bg-card/95 px-3 py-1.5",
          "text-caption text-muted-foreground shadow-sm backdrop-blur-sm",
        )}
        >
          Salvando dashboard...
        </div>
      )}
    </div>
  );
};

export default BuilderPage;
