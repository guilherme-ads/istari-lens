import { useState, useCallback, useMemo, useEffect, useRef, type ChangeEvent } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { motion } from "framer-motion";
import { Plus, Save, Share2, ChevronLeft, Check, LayoutDashboard, Eye, EyeOff, Pencil, Monitor, Trash2, CalendarIcon, Code2, RefreshCw, Download, Upload, History } from "lucide-react";
import type { DateRange } from "react-day-picker";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Calendar } from "@/components/ui/calendar";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { useToast } from "@/hooks/use-toast";
import { DashboardCanvas } from "@/components/builder/DashboardCanvas";
import { AddWidgetDialog } from "@/components/builder/AddWidgetDialog";
import { WidgetConfigPanel } from "@/components/builder/WidgetConfigPanel";
import DashboardSetup from "@/components/builder/DashboardSetup";
import {
  createSection,
  createDefaultWidgetConfig,
  type DashboardSection,
  type DashboardWidget,
  type WidgetType,
} from "@/types/dashboard";
import { useCoreData } from "@/hooks/use-core-data";
import { api, ApiError, type ApiDashboardImportPreviewResponse } from "@/lib/api";
import { getStoredUser } from "@/lib/auth";
import { mapDashboard, sectionsToLayoutConfig } from "@/lib/mappers";
import EmptyState from "@/components/shared/EmptyState";
import ContextualBreadcrumb from "@/components/shared/ContextualBreadcrumb";
import { cn } from "@/lib/utils";
import ConfirmDialog from "@/components/shared/ConfirmDialog";

type DashboardFilterOp = "eq" | "neq" | "gt" | "lt" | "gte" | "lte" | "contains" | "between" | "relative" | "in" | "not_in" | "is_null" | "not_null";
type RelativeDatePreset = "today" | "yesterday" | "last_7_days" | "last_30_days" | "this_year" | "this_month" | "last_month";
type DraftNativeFilter = {
  id: string;
  column: string;
  op: DashboardFilterOp;
  value: string | string[];
  dateValue?: Date;
  dateRange?: DateRange;
  relativePreset?: RelativeDatePreset;
  visible: boolean;
};
type PreparedNativeFilter = {
  column: string;
  op: DashboardFilterOp;
  value?: string | string[] | { relative: RelativeDatePreset };
  visible?: boolean;
};
type CategoricalValueHint = {
  values: string[];
  truncated: boolean;
};

const CATEGORICAL_VALUES_LIMIT = 60;
const CATEGORICAL_DROPDOWN_THRESHOLD = 25;
const exactValueOps = new Set<DashboardFilterOp>(["eq", "neq", "gt", "lt", "gte", "lte"]);

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

const normalizeSemanticColumnType = (rawType: string): "numeric" | "temporal" | "text" | "boolean" => {
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

const mergeColumnType = (currentType: string, nextType: string): "numeric" | "temporal" | "text" | "boolean" => {
  const current = normalizeSemanticColumnType(currentType);
  const next = normalizeSemanticColumnType(nextType);
  if (current !== "text" && next === "text") return current;
  if (current === "text" && next !== "text") return next;
  return next;
};

const prepareNativeFilters = (
  nativeFilters: DraftNativeFilter[],
  temporalColumnNames: Set<string>,
): PreparedNativeFilter[] => {
  const parsedFilters: PreparedNativeFilter[] = [];
  for (const filter of nativeFilters) {
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
      parsedFilters.push({ column: filter.column, op: filter.op, value: dateToApi(filter.dateValue), visible: filter.visible });
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
    parsedFilters.push({ column: filter.column, op: filter.op, value: scalar, visible: filter.visible });
  }
  return parsedFilters;
};

const BuilderPage = () => {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { datasetId, dashboardId } = useParams<{ datasetId: string; dashboardId?: string }>();
  const { toast } = useToast();
  const { datasets, views, dashboards, isLoading, isError, errorMessage } = useCoreData();

  const dataset = useMemo(() => datasets.find((item) => item.id === datasetId), [datasets, datasetId]);
  const view = useMemo(() => (dataset ? views.find((item) => item.id === dataset.viewId) : undefined), [dataset, views]);
  const datasetSourceLabel = useMemo(() => {
    const primaryResource = (dataset?.baseQuerySpec?.base as { primary_resource?: string } | undefined)?.primary_resource;
    if (typeof primaryResource === "string" && primaryResource.trim()) return primaryResource.trim();
    if (view) return `${view.schema}.${view.name}`;
    return "__dataset_base";
  }, [dataset, view]);
  const existingDashboard = useMemo(() => dashboards.find((item) => item.id === dashboardId), [dashboards, dashboardId]);
  const isEditingExistingDashboard = !!dashboardId;
  const canEditExistingDashboard = !!existingDashboard && existingDashboard.accessLevel !== "view";

  const [activeDashboardId, setActiveDashboardId] = useState<string | undefined>(dashboardId);
  const [setupDone, setSetupDone] = useState(!!dashboardId);
  const [dashboardTitle, setDashboardTitle] = useState("Novo Dashboard");
  const [sections, setSections] = useState<DashboardSection[]>([]);
  const [nativeFilters, setNativeFilters] = useState<DraftNativeFilter[]>([
    { id: `nf-${Date.now()}`, column: "", op: "eq", value: "", visible: true },
  ]);
  const [refreshingWidgetIds, setRefreshingWidgetIds] = useState<Set<string>>(() => new Set());
  const [categoricalValueHints, setCategoricalValueHints] = useState<Record<string, CategoricalValueHint>>({});
  const [loadingCategoricalColumns, setLoadingCategoricalColumns] = useState<Record<string, boolean>>({});
  const hydratedDashboardIdRef = useRef<string | null>(null);
  const refreshTimersRef = useRef<Record<string, number>>({});
  const importInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => () => {
    Object.values(refreshTimersRef.current).forEach((timerId) => window.clearTimeout(timerId));
  }, []);

  useEffect(() => {
    if (!existingDashboard) return;
    if (hydratedDashboardIdRef.current === existingDashboard.id) return;
    hydratedDashboardIdRef.current = existingDashboard.id;
    setActiveDashboardId(existingDashboard.id);
    setDashboardTitle(existingDashboard.title);
    setSections(() => {
      if (existingDashboard.sections.length > 0) return existingDashboard.sections;
      const section = createSection();
      section.title = "Visao Geral";
      return [section];
    });
    setNativeFilters(
      existingDashboard.nativeFilters.length > 0
        ? existingDashboard.nativeFilters.map((filter, index) => {
          const isBetween = filter.op === "between" && Array.isArray(filter.value) && filter.value.length === 2;
          const relativePreset = typeof filter.value === "object" && filter.value !== null && "relative" in filter.value
            ? (String((filter.value as Record<string, unknown>).relative) as RelativeDatePreset)
            : undefined;
          const normalizedOp = relativePreset ? "relative" : normalizeDashboardFilterOp(filter.op);
          const from = isBetween ? parseDate(filter.value[0]) : undefined;
          const to = isBetween ? parseDate(filter.value[1]) : undefined;
          return {
            id: `nf-${existingDashboard.id}-${index}`,
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
            visible: filter.visible ?? false,
          };
        })
        : [{ id: `nf-${Date.now()}`, column: "", op: "eq", value: "", visible: true }],
    );
    setSetupDone(true);
  }, [existingDashboard]);

  useEffect(() => {
    if (dashboardId) {
      setSetupDone(true);
      return;
    }
    setSetupDone(false);
    setSections([]);
    setDashboardTitle("Novo Dashboard");
    initialSnapshotRef.current = null;
  }, [dashboardId]);

  const viewColumnsQuery = useQuery({
    queryKey: ["view-columns", view?.schema, view?.name],
    queryFn: () => api.getViewColumns(view!.name, view!.schema),
    enabled: !!view,
  });
  const effectiveColumns = useMemo(
    () => (
      (viewColumnsQuery.data || []).map((column) => ({
        name: column.column_name,
        type: column.normalized_type,
      }))
    ),
    [viewColumnsQuery.data],
  );
  const semanticColumns = useMemo(
    () => (dataset?.semanticColumns || []).map((column) => ({ name: column.name, type: column.type })),
    [dataset],
  );
  const datasetColumns = useMemo(() => {
    const merged = new Map<string, { name: string; type: string }>();
    const upsert = (columnName: string, columnType: string) => {
      const current = merged.get(columnName);
      if (!current) {
        merged.set(columnName, { name: columnName, type: normalizeSemanticColumnType(columnType) });
        return;
      }
      merged.set(columnName, {
        name: columnName,
        type: mergeColumnType(current.type, columnType),
      });
    };
    (effectiveColumns || []).forEach((column) => upsert(column.name, column.type));
    (semanticColumns || []).forEach((column) => upsert(column.name, column.type));
    if (merged.size === 0) {
      (view?.columns || []).forEach((column) => upsert(column.name, column.type));
    }
    return Array.from(merged.values());
  }, [effectiveColumns, semanticColumns, view]);
  const temporalColumnNames = useMemo(
    () => new Set(datasetColumns.filter((column) => normalizeSemanticColumnType(column.type) === "temporal").map((column) => column.name)),
    [datasetColumns],
  );
  const buildBlankNativeFilter = useCallback((visible = true): DraftNativeFilter => ({
    id: `nf-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    column: "",
    op: "eq",
    value: "",
    visible,
  }), []);
  const buildInitialGlobalNativeFilter = useCallback((): DraftNativeFilter => {
    const temporalColumn = datasetColumns.find((column) => normalizeSemanticColumnType(column.type) === "temporal");
    if (!temporalColumn) return buildBlankNativeFilter(true);
    return {
      id: `nf-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      column: temporalColumn.name,
      op: "relative",
      value: "",
      relativePreset: "last_30_days",
      visible: true,
    };
  }, [buildBlankNativeFilter, datasetColumns]);
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
      // Silencioso para nao degradar UX dos filtros.
    } finally {
      setLoadingCategoricalColumns((prev) => ({ ...prev, [columnName]: false }));
    }
  }, [categoricalValueHints, datasetId, isCategoricalColumn, loadingCategoricalColumns]);
  const effectiveView = useMemo(() => {
    if (!dataset) return undefined;
    return {
      id: view?.id || `dataset-${dataset.id}`,
      schema: view?.schema || "dataset",
      name: view?.name || dataset.name,
      status: (view?.status || "active") as "active" | "inactive",
      description: dataset.description,
      rowCount: view?.rowCount || 0,
      datasourceId: dataset.datasourceId,
      columns: datasetColumns.map((column) => ({ name: column.name, type: column.type })),
    };
  }, [view, dataset, datasetColumns]);

  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [targetSectionId, setTargetSectionId] = useState<string | null>(null);
  const [editingWidget, setEditingWidget] = useState<DashboardWidget | null>(null);
  const [configOpen, setConfigOpen] = useState(false);
  const [editingWidgetSectionColumns, setEditingWidgetSectionColumns] = useState<1 | 2 | 3 | 4>(2);
  const [previewMode, setPreviewMode] = useState(false);
  const [devModeOpen, setDevModeOpen] = useState(false);
  const [devModeSqlView, setDevModeSqlView] = useState<"widget" | "dashboard">("widget");
  const [refreshingData, setRefreshingData] = useState(false);
  const [shareSuccess, setShareSuccess] = useState(false);
  const [deleteDashboardOpen, setDeleteDashboardOpen] = useState(false);
  const [importConfirmOpen, setImportConfirmOpen] = useState(false);
  const [importPreview, setImportPreview] = useState<ApiDashboardImportPreviewResponse | null>(null);
  const [pendingImportDashboard, setPendingImportDashboard] = useState<Record<string, unknown> | null>(null);
  const [importingDashboard, setImportingDashboard] = useState(false);
  const [versionsPanelOpen, setVersionsPanelOpen] = useState(false);
  const [selectedVersionId, setSelectedVersionId] = useState<number | null>(null);
  const isAdmin = !!getStoredUser()?.is_admin;

  useEffect(() => {
    const columnsToLoad = new Set<string>();
    nativeFilters.forEach((filter) => {
      if (filter.column && isCategoricalColumn(filter.column) && exactValueOps.has(filter.op)) {
        columnsToLoad.add(filter.column);
      }
    });
    (editingWidget?.config.filters || []).forEach((filter) => {
      if (filter.column && isCategoricalColumn(filter.column) && exactValueOps.has(filter.op as DashboardFilterOp)) {
        columnsToLoad.add(filter.column);
      }
    });
    columnsToLoad.forEach((columnName) => {
      void loadCategoricalValues(columnName);
    });
  }, [editingWidget?.config.filters, isCategoricalColumn, loadCategoricalValues, nativeFilters]);

  const preparedNativeFilters = useMemo<PreparedNativeFilter[]>(() => {
    return prepareNativeFilters(nativeFilters, temporalColumnNames);
  }, [nativeFilters, temporalColumnNames]);
  const serializeSections = useCallback((value: DashboardSection[]) => JSON.stringify(sectionsToLayoutConfig(value)), []);
  const serializeNativeFilters = useCallback((value: PreparedNativeFilter[]) => JSON.stringify(value), []);
  const initialSnapshotRef = useRef<{ title: string; sections: string; nativeFilters: string } | null>(null);
  const makeTempWidgetId = useCallback(() => `tmp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, []);

  useEffect(() => {
    if (!setupDone && !existingDashboard) return;
    if (!initialSnapshotRef.current && !existingDashboard) {
      initialSnapshotRef.current = {
        title: dashboardTitle,
        sections: serializeSections(sections),
        nativeFilters: serializeNativeFilters(preparedNativeFilters),
      };
      return;
    }
    if (!existingDashboard) return;
    initialSnapshotRef.current = {
      title: existingDashboard.title,
      sections: serializeSections(existingDashboard.sections),
      nativeFilters: serializeNativeFilters(
        existingDashboard.nativeFilters.map((filter) => ({
          column: filter.column,
          op: normalizeDashboardFilterOp(filter.op),
          value: filter.value as PreparedNativeFilter["value"],
          visible: filter.visible,
        })),
      ),
    };
  }, [dashboardTitle, existingDashboard, preparedNativeFilters, sections, serializeNativeFilters, serializeSections, setupDone]);

  const isDirty = useMemo(() => {
    if (!setupDone && !existingDashboard) return false;
    const baseline = initialSnapshotRef.current;
    if (!baseline) return true;
    return (
      baseline.title !== dashboardTitle
      || baseline.sections !== serializeSections(sections)
      || baseline.nativeFilters !== serializeNativeFilters(preparedNativeFilters)
    );
  }, [dashboardTitle, existingDashboard, preparedNativeFilters, sections, serializeNativeFilters, serializeSections, setupDone]);

  useEffect(() => {
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!isDirty) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [isDirty]);

  const buildWidgetsPayload = useCallback((sourceSections: DashboardSection[]) => (
    sourceSections.flatMap((section, sectionIndex) =>
      section.widgets.map((widget, widgetIndex) => {
        const numericId = Number(widget.id);
        return {
          id: Number.isFinite(numericId) ? numericId : undefined,
          widget_type: widget.config.widget_type,
          title: widget.title || `${widget.config.widget_type.toUpperCase()} - ${datasetSourceLabel}`,
          position: (sectionIndex * 1000) + widgetIndex,
          config: widget.config as never,
          config_version: widget.configVersion || 1,
        };
      }),
    )
  ), [datasetSourceLabel]);

  const upsertDashboard = useMutation({
    mutationFn: async () => {
      if (!datasetId) throw new Error("Dataset invalido");
      let dashboardIdToSave = activeDashboardId;
      if (!dashboardIdToSave) {
        const created = await api.createDashboard({
          dataset_id: Number(datasetId),
          name: dashboardTitle,
          description: null,
          is_active: true,
          layout_config: [],
          native_filters: [],
        });
        dashboardIdToSave = String(created.id);
        setActiveDashboardId(dashboardIdToSave);
        navigate(`/datasets/${datasetId}/builder/${dashboardIdToSave}`, { replace: true });
      }
      const widgetsPayload = buildWidgetsPayload(sections);
      const updatedDashboard = await api.saveDashboard(Number(dashboardIdToSave), {
        name: dashboardTitle,
        description: null,
        is_active: true,
        layout_config: sectionsToLayoutConfig(sections),
        native_filters: preparedNativeFilters,
        widgets: widgetsPayload,
      });
      const mapped = mapDashboard(updatedDashboard);
      setSections(mapped.sections);
      setDashboardTitle(mapped.title);
      initialSnapshotRef.current = {
        title: mapped.title,
        sections: serializeSections(mapped.sections),
        nativeFilters: serializeNativeFilters(preparedNativeFilters),
      };
      return updatedDashboard;
    },
    onSuccess: async (dashboard) => {
      setActiveDashboardId(String(dashboard.id));
      await queryClient.invalidateQueries({ queryKey: ["dashboards"] });
      toast({ title: "Dashboard salvo" });
      navigate(`/datasets/${datasetId}/dashboard/${dashboard.id}`);
    },
    onError: (error: unknown) => {
      const message = error instanceof ApiError ? String(error.detail || error.message) : "Falha ao salvar dashboard";
      toast({ title: "Erro ao salvar", description: message, variant: "destructive" });
    },
  });

  const handleAddWidget = useCallback((sectionId: string) => {
    setTargetSectionId(sectionId);
    setAddDialogOpen(true);
  }, []);

  const handleWidgetCreated = useCallback(async (widgetType: WidgetType) => {
    if (!targetSectionId || !dataset) return;
    if (datasetColumns.length === 0) {
      toast({ title: "Não foi possivel carregar colunas do dataset", variant: "destructive" });
      return;
    }
    const viewName = view ? `${view.schema}.${view.name}` : "__dataset_base";
    const defaultConfig = createDefaultWidgetConfig({
      type: widgetType,
      viewName,
      columns: datasetColumns,
    });
    const mappedWidget: DashboardWidget = {
      id: makeTempWidgetId(),
      title: `${widgetType.toUpperCase()} - ${datasetSourceLabel}`,
      position: 0,
      configVersion: 1,
      config: defaultConfig,
    };

    const nextSections = sections.map((section) =>
      section.id === targetSectionId ? { ...section, widgets: [...section.widgets, mappedWidget] } : section,
    );
    setSections(nextSections);
    toast({ title: "Widget adicionado (rascunho)" });
  }, [dataset, datasetColumns, datasetSourceLabel, makeTempWidgetId, sections, targetSectionId, toast, view]);

  const handleDuplicateWidgetFromCard = useCallback(async (widget: DashboardWidget) => {
    const duplicatedWidget: DashboardWidget = {
      ...widget,
      id: makeTempWidgetId(),
      title: widget.title ? `${widget.title} (copia)` : widget.title,
      config: JSON.parse(JSON.stringify(widget.config)),
    };

    const nextSections = sections.map((section) => {
      const index = section.widgets.findIndex((item) => item.id === widget.id);
      if (index === -1) return section;
      const widgets = [...section.widgets];
      widgets.splice(index + 1, 0, duplicatedWidget);
      return { ...section, widgets };
    });

    setSections(nextSections);
    toast({ title: "Widget duplicado (rascunho)" });
  }, [makeTempWidgetId, sections, toast]);

  const handleEditWidget = useCallback((widget: DashboardWidget) => {
    setEditingWidget(widget);
    const hostSection = sections.find((section) => section.widgets.some((item) => item.id === widget.id));
    setEditingWidgetSectionColumns(hostSection?.columns || 2);
    setConfigOpen(true);
  }, [sections]);

  const handleSaveWidget = useCallback(async (updated: DashboardWidget) => {
    setRefreshingWidgetIds((prev) => {
      const next = new Set(prev);
      next.add(updated.id);
      return next;
    });
    try {
      const nextSections = sections.map((section) => ({
        ...section,
        widgets: section.widgets.map((item) => (item.id === updated.id ? updated : item)),
      }));
      setSections(nextSections);
      setEditingWidget(updated);
      if (refreshTimersRef.current[updated.id]) {
        window.clearTimeout(refreshTimersRef.current[updated.id]);
      }
      refreshTimersRef.current[updated.id] = window.setTimeout(() => {
        setRefreshingWidgetIds((prev) => {
          const next = new Set(prev);
          next.delete(updated.id);
          return next;
        });
        delete refreshTimersRef.current[updated.id];
      }, 900);
      toast({ title: "Widget atualizado (rascunho)" });
    } catch (error) {
      setRefreshingWidgetIds((prev) => {
        const next = new Set(prev);
        next.delete(updated.id);
        return next;
      });
      const message = error instanceof ApiError ? JSON.stringify(error.detail || error.message) : "Falha ao salvar widget";
      toast({ title: "Erro ao salvar widget", description: message, variant: "destructive" });
    }
  }, [sections, toast]);

  const handleDeleteWidget = useCallback(async () => {
    if (!editingWidget) return;
    try {
      if (refreshTimersRef.current[editingWidget.id]) {
        window.clearTimeout(refreshTimersRef.current[editingWidget.id]);
        delete refreshTimersRef.current[editingWidget.id];
      }
      setRefreshingWidgetIds((prev) => {
        const next = new Set(prev);
        next.delete(editingWidget.id);
        return next;
      });
      const nextSections = sections.map((section) => ({
        ...section,
        widgets: section.widgets.filter((item) => item.id !== editingWidget.id),
      }));
      setSections(nextSections);
      setConfigOpen(false);
      setEditingWidget(null);
      toast({ title: "Widget removido (rascunho)" });
    } catch (error) {
      const message = error instanceof ApiError ? String(error.detail || error.message) : "Falha ao remover widget";
      toast({ title: "Erro ao remover widget", description: message, variant: "destructive" });
    }
  }, [editingWidget, sections, toast]);

  const handleToggleWidgetTitle = useCallback(async (widget: DashboardWidget) => {
    const nextShowTitle = widget.config.show_title === false;
    const updatedWidget: DashboardWidget = {
      ...widget,
      config: {
        ...widget.config,
        show_title: nextShowTitle,
      },
    };
    await handleSaveWidget(updatedWidget);
  }, [handleSaveWidget]);

  const handleDeleteWidgetFromCard = useCallback(async (widget: DashboardWidget) => {
    try {
      if (refreshTimersRef.current[widget.id]) {
        window.clearTimeout(refreshTimersRef.current[widget.id]);
        delete refreshTimersRef.current[widget.id];
      }
      setRefreshingWidgetIds((prev) => {
        const next = new Set(prev);
        next.delete(widget.id);
        return next;
      });
      const nextSections = sections.map((section) => ({
        ...section,
        widgets: section.widgets.filter((item) => item.id !== widget.id),
      }));
      setSections(nextSections);
      if (editingWidget?.id === widget.id) {
        setConfigOpen(false);
        setEditingWidget(null);
      }
      toast({ title: "Widget removido (rascunho)" });
    } catch (error) {
      const message = error instanceof ApiError ? String(error.detail || error.message) : "Falha ao remover widget";
      toast({ title: "Erro ao remover widget", description: message, variant: "destructive" });
    }
  }, [editingWidget?.id, sections, toast]);

  const handleAddSection = useCallback((afterIndex?: number) => {
    setSections((prev) => {
      const section = createSection();
      section.title = `Secao ${prev.length + 1}`;

      let next: DashboardSection[];
      if (afterIndex === undefined || afterIndex < 0 || afterIndex >= prev.length) {
        next = [...prev, section];
      } else {
        next = [...prev];
        next.splice(afterIndex, 0, section);
      }
      return next;
    });
  }, []);

  const handleSectionsChange = useCallback((nextSections: DashboardSection[]) => {
    setSections(nextSections);
  }, []);

  const resolvePublicShareKey = useCallback(async (targetDashboardId: string) => {
    const targetDashboard = dashboards.find((item) => item.id === targetDashboardId);
    if (targetDashboard?.publicShareKey) return targetDashboard.publicShareKey;
    const dashboard = await api.getDashboard(Number(targetDashboardId));
    return dashboard.public_share_key || undefined;
  }, [dashboards]);

  const handleShare = async () => {
    const targetDashboardId = activeDashboardId || dashboardId;
    if (!targetDashboardId) return;
    const cachedDashboard = dashboards.find((item) => item.id === targetDashboardId);
    let visibility = cachedDashboard?.visibility;
    let publicShareKey = cachedDashboard?.publicShareKey;
    if (!visibility || (visibility === "public_view" && !publicShareKey)) {
      const dashboard = await api.getDashboard(Number(targetDashboardId));
      visibility = dashboard.visibility;
      publicShareKey = dashboard.public_share_key || undefined;
    }
    if (visibility === "public_view" && !publicShareKey) {
      toast({ title: "Não foi possível gerar link público", variant: "destructive" });
      return;
    }
    const internalUrl = `${window.location.origin}/datasets/${datasetId}/dashboard/${targetDashboardId}`;
    const shareUrl = visibility === "public_view"
      ? `${window.location.origin}/public/dashboard/${publicShareKey}`
      : internalUrl;
    await navigator.clipboard.writeText(shareUrl);
    setShareSuccess(true);
    toast({ title: "Link copiado" });
    setTimeout(() => setShareSuccess(false), 2000);
  };
  const handleOpenPublicPresentation = async () => {
    const targetDashboardId = activeDashboardId || dashboardId;
    if (!targetDashboardId) return;
    const publicShareKey = await resolvePublicShareKey(targetDashboardId);
    if (!publicShareKey) {
      toast({ title: "Não foi possível gerar link público", variant: "destructive" });
      return;
    }
    navigateWithDiscard(`/public/dashboard/${publicShareKey}`);
  };
  const handleRefreshWidgetData = useCallback(async () => {
    const targetId = activeDashboardId || dashboardId;
    if (!targetId) {
      toast({ title: "Salve o dashboard para atualizar os dados", variant: "destructive" });
      return;
    }

    const minLoadingMs = 700;
    const startedAt = Date.now();
    setRefreshingData(true);
    try {
      await queryClient.invalidateQueries({ queryKey: ["widget-data", targetId], refetchType: "active" });
      toast({ title: "Dados atualizados" });
    } catch {
      toast({ title: "Falha ao atualizar dados", variant: "destructive" });
    } finally {
      const elapsed = Date.now() - startedAt;
      if (elapsed < minLoadingMs) {
        await new Promise((resolve) => setTimeout(resolve, minLoadingMs - elapsed));
      }
      setRefreshingData(false);
    }
  }, [activeDashboardId, dashboardId, queryClient, toast]);
  const confirmDiscardIfDirty = useCallback(() => {
    if (!isDirty) return true;
    return window.confirm("Existem alteracoes nao salvas. Deseja sair mesmo assim?");
  }, [isDirty]);
  const navigateWithDiscard = useCallback((to: string) => {
    if (!confirmDiscardIfDirty()) return;
    navigate(to);
  }, [confirmDiscardIfDirty, navigate]);
  const handleSetupStart = useCallback(async (
    title: string,
    setupSections: DashboardSection[],
    setupNativeFilters?: PreparedNativeFilter[],
  ) => {
    const normalizedTitle = title.trim() || "Novo Dashboard";
    const normalizedSections = setupSections.length > 0 ? setupSections : [{ ...createSection(), title: "Visao Geral" }];
    const seededNativeFilters: DraftNativeFilter[] = (setupNativeFilters && setupNativeFilters.length > 0)
      ? setupNativeFilters.map((filter, index) => {
          const relativePreset = typeof filter.value === "object" && filter.value !== null && "relative" in filter.value
            ? (String((filter.value as Record<string, unknown>).relative) as RelativeDatePreset)
            : undefined;
          const normalizedOp = relativePreset ? "relative" : normalizeDashboardFilterOp(filter.op);
          const isBetween = normalizedOp === "between" && Array.isArray(filter.value) && filter.value.length === 2;
          const from = isBetween ? parseDate(filter.value[0]) : undefined;
          const to = isBetween ? parseDate(filter.value[1]) : undefined;
          return {
            id: `nf-setup-${Date.now()}-${index}`,
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
            visible: filter.visible ?? true,
          };
        })
      : [buildInitialGlobalNativeFilter()];
    const seededPreparedNativeFilters = prepareNativeFilters(seededNativeFilters, temporalColumnNames);
    setDashboardTitle(normalizedTitle);
    setSections(normalizedSections);
    setNativeFilters(seededNativeFilters);
    setSetupDone(true);

    if (!datasetId || normalizedSections.length === 0 || normalizedSections.every((section) => section.widgets.length === 0)) {
      initialSnapshotRef.current = {
        title: normalizedTitle,
        sections: serializeSections(normalizedSections),
        nativeFilters: serializeNativeFilters(seededPreparedNativeFilters),
      };
      return;
    }

    try {
      const created = await api.createDashboard({
        dataset_id: Number(datasetId),
        name: normalizedTitle,
        description: null,
        is_active: true,
        layout_config: [],
        native_filters: seededPreparedNativeFilters,
      });
      const saved = await api.saveDashboard(Number(created.id), {
        name: normalizedTitle,
        description: null,
        is_active: true,
        layout_config: sectionsToLayoutConfig(normalizedSections),
        native_filters: seededPreparedNativeFilters,
        widgets: buildWidgetsPayload(normalizedSections),
      });
      const mapped = mapDashboard(saved);
      setActiveDashboardId(String(saved.id));
      setDashboardTitle(mapped.title);
      setSections(mapped.sections);
      initialSnapshotRef.current = {
        title: mapped.title,
        sections: serializeSections(mapped.sections),
        nativeFilters: serializeNativeFilters(seededPreparedNativeFilters),
      };
      await queryClient.invalidateQueries({ queryKey: ["dashboards"] });
      navigate(`/datasets/${datasetId}/builder/${saved.id}`, { replace: true });
      toast({ title: "Dashboard inicial criado" });
    } catch (error) {
      const message = error instanceof ApiError ? String(error.detail || error.message) : "Falha ao criar dashboard inicial";
      toast({ title: "Erro no setup", description: message, variant: "destructive" });
    }
  }, [
    buildInitialGlobalNativeFilter,
    buildWidgetsPayload,
    datasetId,
    navigate,
    queryClient,
    serializeNativeFilters,
    serializeSections,
    temporalColumnNames,
    toast,
  ]);

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

  const executeDashboardImport = useCallback(async (rawDashboard: Record<string, unknown>) => {
    if (!datasetId) return;
    setImportingDashboard(true);
    try {
      const imported = await api.importDashboard({
        dataset_id: Number(datasetId),
        dashboard: rawDashboard,
      });
      await queryClient.invalidateQueries({ queryKey: ["dashboards"] });
      toast({ title: "Dashboard importado com sucesso" });
      setImportConfirmOpen(false);
      setImportPreview(null);
      setPendingImportDashboard(null);
      navigate(`/datasets/${datasetId}/builder/${imported.id}`);
    } catch (error) {
      const message = error instanceof ApiError ? String(error.detail || error.message) : "Falha ao importar dashboard";
      toast({ title: "Erro ao importar", description: message, variant: "destructive" });
    } finally {
      setImportingDashboard(false);
      if (importInputRef.current) importInputRef.current.value = "";
    }
  }, [datasetId, navigate, queryClient, toast]);

  const handleImportDashboardJson = useCallback(async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file || !datasetId) return;
    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as { dashboard?: Record<string, unknown> } | Record<string, unknown>;
      const rawDashboard = ((parsed as { dashboard?: Record<string, unknown> }).dashboard || parsed) as Record<string, unknown>;
      const preview = await api.previewDashboardImport({
        dataset_id: Number(datasetId),
        dashboard: rawDashboard,
      });
      const needsConfirmation = preview.compatibility === "partial" || !preview.same_dataset;
      if (preview.compatibility === "incompatible") {
        const firstConflict = preview.conflicts[0]?.message || "Dashboard incompativel com o dataset de destino.";
        toast({
          title: "Importacao bloqueada",
          description: firstConflict,
          variant: "destructive",
        });
        return;
      }
      if (!needsConfirmation) {
        await executeDashboardImport(rawDashboard);
        return;
      }
      setImportPreview(preview);
      setPendingImportDashboard(rawDashboard);
      setImportConfirmOpen(true);
    } catch (error) {
      const message = error instanceof ApiError ? String(error.detail || error.message) : "JSON invalido para importacao";
      toast({ title: "Erro ao importar", description: message, variant: "destructive" });
    } finally {
      if (importInputRef.current) importInputRef.current.value = "";
    }
  }, [datasetId, executeDashboardImport, toast]);
  const handleConfirmImportDashboard = useCallback(async () => {
    if (!pendingImportDashboard || importingDashboard) return;
    await executeDashboardImport(pendingImportDashboard);
  }, [executeDashboardImport, importingDashboard, pendingImportDashboard]);

  const widgetCount = sections.reduce((total, section) => total + section.widgets.length, 0);
  const targetDashboardId = activeDashboardId || dashboardId;
  const versionsQuery = useQuery({
    queryKey: ["dashboard-versions", targetDashboardId],
    queryFn: () => api.listDashboardVersions(Number(targetDashboardId)),
    enabled: versionsPanelOpen && !!targetDashboardId,
  });
  useEffect(() => {
    if (!versionsPanelOpen) return;
    if (!versionsQuery.data || versionsQuery.data.length === 0) {
      setSelectedVersionId(null);
      return;
    }
    setSelectedVersionId((current) => current ?? versionsQuery.data[0].id);
  }, [versionsPanelOpen, versionsQuery.data]);
  const restoreVersionMutation = useMutation({
    mutationFn: async () => {
      const targetId = activeDashboardId || dashboardId;
      if (!targetId || !selectedVersionId) {
        throw new Error("Selecione uma versao para restaurar.");
      }
      return api.restoreDashboardVersion(Number(targetId), selectedVersionId);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["dashboards"] });
      toast({ title: "Versao restaurada" });
      setVersionsPanelOpen(false);
      navigate(0);
    },
    onError: (error: unknown) => {
      const message = error instanceof ApiError ? String(error.detail || error.message) : "Falha ao restaurar versao";
      toast({ title: "Erro ao restaurar", description: message, variant: "destructive" });
    },
  });

  const debugQueriesQuery = useQuery({
    queryKey: ["dashboard-debug-queries", targetDashboardId, preparedNativeFilters, devModeSqlView],
    queryFn: () =>
      api.getDashboardDebugQueries(Number(targetDashboardId), {
        native_filters_override: preparedNativeFilters,
        mode: devModeSqlView,
      }),
    enabled: isAdmin && devModeOpen && !!targetDashboardId,
  });
  const handleDeleteDashboard = async () => {
    if (!activeDashboardId) {
      navigate(datasetId ? `/datasets/${datasetId}` : "/datasets");
      return;
    }
    try {
      await api.deleteDashboard(Number(activeDashboardId));
      await queryClient.invalidateQueries({ queryKey: ["dashboards"] });
      setDeleteDashboardOpen(false);
      toast({ title: "Dashboard excluido" });
      navigate(datasetId ? `/datasets/${datasetId}` : "/datasets");
    } catch (error) {
      const message = error instanceof ApiError ? String(error.detail || error.message) : "Falha ao excluir dashboard";
      toast({ title: "Erro ao excluir", description: message, variant: "destructive" });
    }
  };
  const importConflictsPreview = useMemo(() => {
    if (!importPreview) return [];
    return importPreview.conflicts.slice(0, 6);
  }, [importPreview]);
  const importDialogDescription = useMemo(() => {
    if (!importPreview) return "";
    if (importPreview.compatibility === "partial") {
      return "Encontramos incompatibilidades parciais. Voce pode continuar, mas alguns widgets podem exigir ajustes.";
    }
    return "O dashboard foi criado em outro dataset. Revise os detalhes antes de importar.";
  }, [importPreview]);

  if (isError) {
    return (
      <div className="bg-background">
        <main className="container py-6">
          <EmptyState icon={<LayoutDashboard className="h-5 w-5" />} title="Erro ao carregar builder" description={errorMessage} />
        </main>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="bg-background">
        <main className="container py-6">
          <EmptyState icon={<LayoutDashboard className="h-5 w-5" />} title="Carregando builder" description="Aguarde enquanto buscamos os dados." />
        </main>
      </div>
    );
  }

  if (!dataset) {
    return (
      <div className="bg-background flex flex-col flex-1">
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center space-y-3">
            <h2 className="text-title text-foreground">Dataset não encontrado</h2>
            <p className="text-body text-muted-foreground">O dataset solicitado não existe.</p>
            <Button variant="outline" onClick={() => navigateWithDiscard("/datasets")}>
              <ChevronLeft className="h-4 w-4 mr-1" /> Voltar aos Datasets
            </Button>
          </div>
        </div>
      </div>
    );
  }

  if (!isEditingExistingDashboard && !setupDone) {
    return (
      <div className="bg-background min-h-screen">
        <DashboardSetup
          columns={datasetColumns}
          datasetId={Number(dataset.id)}
          viewName={datasetSourceLabel}
          initialTitle={dashboardTitle}
          onStart={handleSetupStart}
        />
      </div>
    );
  }

  if (isEditingExistingDashboard && !existingDashboard) {
    return (
      <div className="bg-background flex flex-col flex-1">
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center space-y-3">
            <h2 className="text-title text-foreground">Dashboard não encontrado</h2>
            <p className="text-body text-muted-foreground">Você não tem permissão para editar este dashboard ou ele não existe.</p>
            <Button variant="outline" onClick={() => navigateWithDiscard(datasetId ? `/datasets/${datasetId}/dashboard/${dashboardId}` : "/dashboards")}>
              <ChevronLeft className="h-4 w-4 mr-1" /> Voltar
            </Button>
          </div>
        </div>
      </div>
    );
  }

  if (isEditingExistingDashboard && !canEditExistingDashboard) {
    return (
      <div className="bg-background flex flex-col flex-1">
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center space-y-3">
            <h2 className="text-title text-foreground">Acesso negado</h2>
            <p className="text-body text-muted-foreground">Você tem acesso somente de visualização para este dashboard.</p>
            <Button variant="outline" onClick={() => navigateWithDiscard(datasetId ? `/datasets/${datasetId}/dashboard/${dashboardId}` : "/dashboards")}>
              <ChevronLeft className="h-4 w-4 mr-1" /> Ir para visualização
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-background flex flex-col flex-1">
      <div className="sticky top-12 z-40 border-b border-border bg-card/90 backdrop-blur-sm">
        <div className="container flex items-center justify-between h-12 gap-4">
          <div className="flex items-center gap-2 min-w-0">
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 shrink-0"
              onClick={() => {
                if (!confirmDiscardIfDirty()) return;
                navigate("/datasets");
              }}
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <ContextualBreadcrumb
              className="hidden sm:block min-w-0"
              items={[
                { label: "Datasets", href: "/datasets" },
                { label: dataset.name, href: `/datasets/${datasetId}` },
                { label: "Builder" },
              ]}
            />
          </div>

          <div className="flex items-center gap-2 text-caption shrink-0">
            <span className="hidden sm:inline">
              Base semantica: {datasetSourceLabel}
            </span>
            <div className="h-4 w-px bg-border hidden sm:block" />
            <Tooltip>
              <TooltipTrigger asChild>
                <Button size="sm" variant="outline" className="h-8 text-xs" onClick={() => upsertDashboard.mutate()}>
                  <Save className="h-3 w-3 sm:mr-1" />
                  <span className="hidden sm:inline">{upsertDashboard.isPending ? "Salvando..." : "Salvar"}</span>
                </Button>
              </TooltipTrigger>
              <TooltipContent className="text-xs">Salvar dashboard</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button size="sm" variant="outline" className="h-8 text-xs" onClick={handleExportDashboardJson}>
                  <Download className="h-3 w-3 sm:mr-1" />
                  <span className="hidden sm:inline">Exportar</span>
                </Button>
              </TooltipTrigger>
              <TooltipContent className="text-xs">Exportar dashboard em JSON</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8 text-xs"
                  onClick={() => {
                    if (!confirmDiscardIfDirty()) return;
                    importInputRef.current?.click();
                  }}
                >
                  <Upload className="h-3 w-3 sm:mr-1" />
                  <span className="hidden sm:inline">Importar</span>
                </Button>
              </TooltipTrigger>
              <TooltipContent className="text-xs">Importar dashboard de JSON</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8 text-xs"
                  onClick={() => {
                    if (!targetDashboardId) {
                      toast({ title: "Salve o dashboard antes de restaurar versoes", variant: "destructive" });
                      return;
                    }
                    setVersionsPanelOpen(true);
                  }}
                >
                  <History className="h-3 w-3 sm:mr-1" />
                  <span className="hidden sm:inline">Restaurar</span>
                </Button>
              </TooltipTrigger>
              <TooltipContent className="text-xs">Restaurar última versão salva</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8 text-xs"
                  disabled={!targetDashboardId || refreshingData}
                  onClick={handleRefreshWidgetData}
                >
                  <RefreshCw className={cn("h-3 w-3 sm:mr-1", refreshingData && "animate-spin")} />
                  <span className="hidden sm:inline">{refreshingData ? "Atualizando..." : "Atualizar"}</span>
                </Button>
              </TooltipTrigger>
              <TooltipContent className="text-xs">Recarregar dados de todos os widgets</TooltipContent>
            </Tooltip>
            {isAdmin && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    size="sm"
                    variant={devModeOpen ? "secondary" : "outline"}
                    className="h-8 text-xs"
                    onClick={() => setDevModeOpen((prev) => !prev)}
                  >
                    <Code2 className="h-3 w-3 sm:mr-1" />
                    <span className="hidden sm:inline">Dev</span>
                  </Button>
                </TooltipTrigger>
                <TooltipContent className="text-xs">Ver QuerySpecs resultantes por widget (admin)</TooltipContent>
              </Tooltip>
            )}
            {previewMode && (
              <>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-8 text-xs"
                      disabled={!datasetId || !(activeDashboardId || dashboardId)}
                      onClick={handleShare}
                    >
                      {shareSuccess ? <Check className="h-3 w-3 text-success" /> : <Share2 className="h-3 w-3 sm:mr-1" />}
                      <span className="hidden sm:inline">{shareSuccess ? "Copiado!" : "Compartilhar"}</span>
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent className="text-xs">Copiar link</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-8 text-xs"
                      disabled={!(activeDashboardId || dashboardId)}
                      onClick={handleOpenPublicPresentation}
                    >
                      <Monitor className="h-3 w-3 sm:mr-1" />
                      <span className="hidden sm:inline">Apresentação</span>
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent className="text-xs">Abrir dashboard em modo apresentação</TooltipContent>
                </Tooltip>
              </>
            )}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="sm"
                  variant="destructive"
                  className="h-8 text-xs"
                  disabled={!activeDashboardId}
                  onClick={() => setDeleteDashboardOpen(true)}
                >
                  <Trash2 className="h-3 w-3 sm:mr-1" />
                  <span className="hidden sm:inline">Excluir</span>
                </Button>
              </TooltipTrigger>
              <TooltipContent className="text-xs">Excluir dashboard</TooltipContent>
            </Tooltip>
          </div>
        </div>
      </div>

      <div className="flex-1 container py-6">
        <div className="glass-card mb-6 p-4">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div className="min-w-0 lg:w-1/3">
              <label className="text-heading">Titulo do dashboard</label>
              <Input
                value={dashboardTitle}
                onChange={(e) => setDashboardTitle(e.target.value)}
                className="h-9 mt-1.5 text-title"
                placeholder="Titulo do dashboard"
              />
            </div>
            <div className="lg:w-2/3">
              <Label className="text-heading">Filtros nativos e globais</Label>
              <div className="mt-2 space-y-2">
                {nativeFilters.map((filter, filterIndex) => {
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
                  const rowLayoutClass = isTemporal
                    ? "grid grid-cols-1 md:grid-cols-[minmax(180px,1fr)_120px_minmax(200px,1fr)_auto_auto] gap-2 items-center"
                    : "grid grid-cols-1 md:grid-cols-[minmax(180px,1fr)_120px_minmax(220px,1fr)_auto_auto] gap-2 items-center";
                  return (
                    <div key={filter.id} className={rowLayoutClass}>
                      <Select
                        value={filter.column || "__none__"}
                        onValueChange={(value) =>
                          setNativeFilters((prev) => prev.map((item) => item.id === filter.id
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
                          setNativeFilters((prev) => prev.map((item) => item.id === filter.id
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
                          onChange={(e) =>
                            setNativeFilters((prev) => prev.map((item) => item.id === filter.id
                              ? { ...item, value: e.target.value.split(",").map((value) => value.trim()).filter(Boolean) }
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
                            onChange={(e) =>
                              setNativeFilters((prev) => prev.map((item) => item.id === filter.id
                                ? { ...item, value: [e.target.value, betweenValues[1]] }
                                : item))}
                            disabled={!filter.column}
                          />
                          <Input
                            className="h-8 text-xs"
                            placeholder="Ate"
                            value={betweenValues[1]}
                            onChange={(e) =>
                              setNativeFilters((prev) => prev.map((item) => item.id === filter.id
                                ? { ...item, value: [betweenValues[0], e.target.value] }
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
                              setNativeFilters((prev) => prev.map((item) => item.id === filter.id
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
                            placeholder="Valor"
                            value={scalarValue}
                            onChange={(e) =>
                              setNativeFilters((prev) => prev.map((item) => item.id === filter.id ? { ...item, value: e.target.value } : item))}
                            disabled={!filter.column}
                          />
                        )
                      )}

                      {isTemporal && filter.op === "relative" && (
                        <Select
                          value={filter.relativePreset || "last_7_days"}
                          onValueChange={(value) =>
                            setNativeFilters((prev) => prev.map((item) => item.id === filter.id
                              ? { ...item, relativePreset: value as RelativeDatePreset }
                              : item))}
                          disabled={!filter.column}
                        >
                          <SelectTrigger className="h-8 text-xs">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {relativeDateOptions.map((opt) => (
                              <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
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
                          onChange={(e) =>
                            setNativeFilters((prev) => prev.map((item) => item.id === filter.id
                              ? { ...item, value: e.target.value.split(",").map((value) => value.trim()).filter(Boolean) }
                              : item))}
                          disabled={!filter.column}
                        />
                      )}

                      {isTemporal && filter.op !== "between" && filter.op !== "relative" && filter.op !== "is_null" && filter.op !== "not_null" && filter.op !== "in" && filter.op !== "not_in" && (
                        <Popover>
                          <PopoverTrigger asChild>
                            <Button
                              variant="outline"
                              className={cn(
                                "h-8 justify-start text-left text-xs font-normal",
                                !filter.dateValue && "text-muted-foreground",
                              )}
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
                              onSelect={(date) =>
                                setNativeFilters((prev) => prev.map((item) => item.id === filter.id ? { ...item, dateValue: date } : item))}
                            />
                          </PopoverContent>
                        </Popover>
                      )}

                      {isTemporal && filter.op === "between" && (
                        <Popover>
                          <PopoverTrigger asChild>
                            <Button
                              variant="outline"
                              className={cn(
                                "h-8 justify-start text-left text-xs font-normal",
                                (!filter.dateRange?.from || !filter.dateRange?.to) && "text-muted-foreground",
                              )}
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
                              onSelect={(range) =>
                                setNativeFilters((prev) => prev.map((item) => item.id === filter.id ? { ...item, dateRange: range } : item))}
                              numberOfMonths={2}
                            />
                          </PopoverContent>
                        </Popover>
                      )}

                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-8 w-8"
                        onClick={() =>
                          setNativeFilters((prev) => prev.map((item) => (item.id === filter.id ? { ...item, visible: !item.visible } : item)))
                        }
                        title={filter.visible ? "Ocultar no filtro global" : "Exibir no filtro global"}
                      >
                        {filter.visible ? <Eye className="h-3.5 w-3.5 text-foreground" /> : <EyeOff className="h-3.5 w-3.5 text-muted-foreground" />}
                      </Button>

                      {filterIndex > 0 ? (
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-8 w-8 text-destructive hover:text-destructive"
                          onClick={() => setNativeFilters((prev) => prev.filter((item) => item.id !== filter.id))}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      ) : (
                        <div className="h-8 w-8" />
                      )}
                    </div>
                  );
                })}
                <div className="flex justify-between items-center pt-1">
                  <div className="flex items-center gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="h-8 text-xs"
                      onClick={() => setNativeFilters((prev) => [...prev, buildBlankNativeFilter(true)])}
                    >
                      <Plus className="h-3.5 w-3.5 mr-1.5" /> Adicionar filtro nativo
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="h-8 text-xs"
                      onClick={() => setNativeFilters([buildInitialGlobalNativeFilter()])}
                    >
                      Limpar filtros
                    </Button>
                  </div>
                  <span className="text-[11px] text-muted-foreground">Use o ícone de olho para definir se o filtro aparece como global.</span>
                </div>
              </div>
            </div>
          </div>
        </div>

        {isAdmin && devModeOpen && (
          <div className="glass-card mb-6 p-4 space-y-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h3 className="text-title text-foreground">Dev Mode QuerySpec</h3>
                <p className="text-xs text-muted-foreground">
                  {devModeSqlView === "widget"
                    ? "QuerySpec efetiva por widget para este dashboard."
                    : "QuerySpecs finais que serao executadas por dashboard apos dedupe/fusao."}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Select value={devModeSqlView} onValueChange={(value) => setDevModeSqlView(value as "widget" | "dashboard")}>
                  <SelectTrigger className="h-8 w-[220px] text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="widget">Por widget</SelectItem>
                    <SelectItem value="dashboard">Por dashboard</SelectItem>
                  </SelectContent>
                </Select>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8 text-xs"
                  onClick={() => debugQueriesQuery.refetch()}
                  disabled={!targetDashboardId || debugQueriesQuery.isFetching}
                >
                  <RefreshCw className={cn("h-3 w-3 sm:mr-1", debugQueriesQuery.isFetching && "animate-spin")} />
                  <span className="hidden sm:inline">Atualizar</span>
                </Button>
              </div>
            </div>
            {!targetDashboardId && (
              <p className="text-xs text-muted-foreground">
                Salve o dashboard para gerar as queries de debug.
              </p>
            )}
            {targetDashboardId && debugQueriesQuery.isLoading && (
              <p className="text-xs text-muted-foreground">Carregando queries...</p>
            )}
            {targetDashboardId && debugQueriesQuery.isError && (
              <p className="text-xs text-destructive">
                Falha ao carregar queries: {(debugQueriesQuery.error as Error).message}
              </p>
            )}
            {targetDashboardId && debugQueriesQuery.data && (
              <div className="space-y-3">
                <p className="text-xs text-muted-foreground">
                  Dashboard #{debugQueriesQuery.data.dashboard_id} . Tabela {debugQueriesQuery.data.view_name || "-"} . Datasource {debugQueriesQuery.data.datasource_id ?? "-"}
                </p>
                {devModeSqlView === "widget" && (
                  <>
                    {debugQueriesQuery.data.items.length === 0 && (
                      <p className="text-xs text-muted-foreground">Nenhum widget encontrado.</p>
                    )}
                    {debugQueriesQuery.data.items.map((item) => (
                      <div key={item.widget_id} className="rounded-md border border-border/70 bg-background/60 p-3 space-y-2">
                        <div className="flex items-center justify-between gap-2">
                          <p className="text-xs font-medium text-foreground">
                            Widget #{item.widget_id} . {item.title || "(sem título)"} . {item.widget_type}
                          </p>
                          <span
                            className={cn(
                              "text-[11px] px-2 py-0.5 rounded-full border",
                              item.status === "ok" && "text-success border-success/40 bg-success/10",
                              item.status === "text_widget" && "text-muted-foreground border-border bg-muted/30",
                              item.status === "error" && "text-destructive border-destructive/40 bg-destructive/10",
                            )}
                          >
                            {item.status}
                          </span>
                        </div>
                        {item.status === "ok" && (
                          <>
                            <pre className="text-[11px] leading-5 whitespace-pre-wrap break-all rounded bg-muted/40 p-2 border border-border/50">
                              {JSON.stringify(item.query_spec || { sql: item.sql }, null, 2)}
                            </pre>
                            <pre className="text-[11px] leading-5 whitespace-pre-wrap break-all rounded bg-muted/40 p-2 border border-border/50">{JSON.stringify(item.params || [], null, 2)}</pre>
                          </>
                        )}
                        {item.status === "text_widget" && (
                          <p className="text-[11px] text-muted-foreground">Widget textual não executa SQL.</p>
                        )}
                        {item.status === "error" && (
                          <pre className="text-[11px] leading-5 whitespace-pre-wrap break-all rounded bg-destructive/5 p-2 border border-destructive/30 text-destructive">{item.error}</pre>
                        )}
                      </div>
                    ))}
                  </>
                )}
                {devModeSqlView === "dashboard" && (
                  <>
                    {debugQueriesQuery.data.final_items.length === 0 && (
                      <p className="text-xs text-muted-foreground">Nenhuma QuerySpec final para execucao.</p>
                    )}
                    {debugQueriesQuery.data.final_items.map((item, index) => (
                      <div key={`${item.fingerprint_key}-${index}`} className="rounded-md border border-border/70 bg-background/60 p-3 space-y-2">
                        <div className="flex items-center justify-between gap-2">
                          <p className="text-xs font-medium text-foreground">
                            Execucao #{index + 1} . {item.execution_kind} . widgets [{item.widget_ids.join(", ")}]
                          </p>
                          <span className="text-[11px] px-2 py-0.5 rounded-full border text-accent-foreground border-accent/40 bg-accent/20">
                            {item.execution_kind}
                          </span>
                        </div>
                        <pre className="text-[11px] leading-5 whitespace-pre-wrap break-all rounded bg-muted/40 p-2 border border-border/50">
                          {JSON.stringify(item.query_spec || { sql: item.sql }, null, 2)}
                        </pre>
                        <pre className="text-[11px] leading-5 whitespace-pre-wrap break-all rounded bg-muted/40 p-2 border border-border/50">{JSON.stringify(item.params || [], null, 2)}</pre>
                        <p className="text-[11px] text-muted-foreground break-all">fingerprint: {item.fingerprint_key}</p>
                      </div>
                    ))}
                  </>
                )}
              </div>
            )}
          </div>
        )}

        {sections.length === 0 && widgetCount === 0 ? (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="flex flex-col items-center justify-center py-24 gap-4"
          >
            <div className="h-16 w-16 rounded-2xl bg-accent/10 flex items-center justify-center">
              <LayoutDashboard className="h-8 w-8 text-accent" />
            </div>
            <h2 className="text-title text-foreground">Comece seu dashboard</h2>
            <p className="text-body text-muted-foreground text-center max-w-md">
              Adicione secoes e widgets para montar seu dashboard usando dados de <strong>{datasetSourceLabel}</strong>.
            </p>
            <Button className="bg-accent text-accent-foreground hover:bg-accent/90" onClick={() => handleAddSection()}>
              <Plus className="h-4 w-4 mr-1.5" /> Criar primeira secao
            </Button>
          </motion.div>
        ) : (
          <DashboardCanvas
            dashboardId={targetDashboardId}
            sections={sections}
            onSectionsChange={handleSectionsChange}
            onAddWidget={handleAddWidget}
            onEditWidget={handleEditWidget}
            onDeleteWidget={handleDeleteWidgetFromCard}
            onDuplicateWidget={handleDuplicateWidgetFromCard}
            onToggleWidgetTitle={handleToggleWidgetTitle}
            onAddSection={handleAddSection}
            readOnly={previewMode}
            refreshingWidgetIds={refreshingWidgetIds}
          />
        )}
      </div>

      <input
        ref={importInputRef}
        type="file"
        accept="application/json,.json"
        className="hidden"
        onChange={handleImportDashboardJson}
      />

      <Sheet open={versionsPanelOpen} onOpenChange={setVersionsPanelOpen}>
        <SheetContent side="right" className="w-full sm:max-w-md overflow-y-auto">
          <SheetHeader>
            <SheetTitle>Historico de versoes</SheetTitle>
            <SheetDescription>Selecione uma versao para restaurar o dashboard.</SheetDescription>
          </SheetHeader>
          <div className="mt-6 space-y-3">
            {!targetDashboardId && (
              <p className="text-sm text-muted-foreground">Salve o dashboard para visualizar versoes.</p>
            )}
            {targetDashboardId && versionsQuery.isLoading && (
              <p className="text-sm text-muted-foreground">Carregando versoes...</p>
            )}
            {targetDashboardId && versionsQuery.isError && (
              <p className="text-sm text-destructive">Falha ao carregar versoes.</p>
            )}
            {targetDashboardId && versionsQuery.data && versionsQuery.data.length === 0 && (
              <p className="text-sm text-muted-foreground">Nenhuma versao disponivel.</p>
            )}
            {targetDashboardId && (versionsQuery.data || []).map((version) => {
              const date = new Date(version.created_at);
              const label = Number.isNaN(date.getTime())
                ? version.created_at
                : new Intl.DateTimeFormat("pt-BR", {
                  day: "2-digit",
                  month: "2-digit",
                  year: "numeric",
                  hour: "2-digit",
                  minute: "2-digit",
                }).format(date);
              const selected = selectedVersionId === version.id;
              return (
                <button
                  key={version.id}
                  type="button"
                  className={cn(
                    "w-full rounded-md border p-3 text-left transition-colors",
                    selected ? "border-accent bg-accent/10" : "border-border hover:bg-muted/40",
                  )}
                  onClick={() => setSelectedVersionId(version.id)}
                >
                  <p className="text-sm font-medium text-foreground">Versao #{version.version_number}</p>
                  <p className="text-xs text-muted-foreground mt-1">{label}</p>
                </button>
              );
            })}
          </div>
          <div className="mt-6">
            <Button
              className="w-full"
              disabled={!selectedVersionId || restoreVersionMutation.isPending}
              onClick={() => restoreVersionMutation.mutate()}
            >
              {restoreVersionMutation.isPending ? "Restaurando..." : "Restaurar versao selecionada"}
            </Button>
          </div>
        </SheetContent>
      </Sheet>

      <AddWidgetDialog
        open={addDialogOpen}
        onOpenChange={setAddDialogOpen}
        onAdd={handleWidgetCreated}
        viewLabel={datasetSourceLabel}
      />
      <WidgetConfigPanel
        widget={editingWidget}
        dashboardWidgets={sections.flatMap((section) => section.widgets)}
        view={effectiveView}
        datasetId={dataset ? Number(dataset.id) : undefined}
        categoricalValueHints={categoricalValueHints}
        categoricalDropdownThreshold={CATEGORICAL_DROPDOWN_THRESHOLD}
        sectionColumns={editingWidgetSectionColumns}
        open={configOpen}
        onClose={() => setConfigOpen(false)}
        onSave={handleSaveWidget}
        onDelete={handleDeleteWidget}
      />
      <ConfirmDialog
        open={importConfirmOpen}
        onOpenChange={(open) => {
          setImportConfirmOpen(open);
          if (!open && !importingDashboard) {
            setImportPreview(null);
            setPendingImportDashboard(null);
          }
        }}
        title="Confirmar importacao de dashboard"
        description={importDialogDescription}
        confirmLabel={importingDashboard ? "Importando..." : "Importar mesmo assim"}
        onConfirm={() => {
          void handleConfirmImportDashboard();
        }}
        details={importPreview ? (
          <div className="mt-3 space-y-2">
            <p className="text-xs text-muted-foreground">
              Dataset origem: {importPreview.source_dataset_id ?? "-"} . Dataset destino: {importPreview.target_dataset_id}
            </p>
            <p className="text-xs text-muted-foreground">
              Widgets validos: {importPreview.valid_widgets}/{importPreview.total_widgets} . Invalidos: {importPreview.invalid_widgets}
            </p>
            {importConflictsPreview.length > 0 && (
              <ul className="list-disc pl-4 text-xs text-muted-foreground space-y-1 max-h-32 overflow-auto">
                {importConflictsPreview.map((conflict, index) => (
                  <li key={`${conflict.code}-${conflict.field || "field"}-${index}`}>
                    {conflict.widget_title ? `${conflict.widget_title}: ` : ""}{conflict.message}
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : undefined}
      />
      <ConfirmDialog
        open={deleteDashboardOpen}
        onOpenChange={setDeleteDashboardOpen}
        title="Excluir dashboard?"
        description={`Esta ação removera permanentemente o dashboard "${dashboardTitle}" e todos os widgets dele.`}
        confirmLabel="Excluir dashboard"
        destructive
        onConfirm={handleDeleteDashboard}
      />
    </div>
  );
};

export default BuilderPage;







