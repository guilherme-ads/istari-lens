import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams, useLocation } from "react-router-dom";
import { motion } from "framer-motion";
import { ChevronLeft, Pencil, Share2, Database, Plus, Trash2, CalendarIcon, Monitor, X, SlidersHorizontal, Link2, Globe, Lock, UserRound } from "lucide-react";
import type { DateRange } from "react-day-picker";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Calendar } from "@/components/ui/calendar";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { WidgetRenderer } from "@/components/builder/WidgetRenderer";
import { gridRowsToWidgetHeight, type DashboardSection, type SectionColumns, type WidgetWidth } from "@/types/dashboard";
import { useCoreData } from "@/hooks/use-core-data";
import { api, type ApiDashboardWidgetDataResponse } from "@/lib/api";
import { mapDashboard } from "@/lib/mappers";
import EmptyState from "@/components/shared/EmptyState";
import ContextualBreadcrumb from "@/components/shared/ContextualBreadcrumb";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import { getStoredUser } from "@/lib/auth";
import { useSimulatedLoading } from "@/hooks/use-simulated-loading";

type FilterOp = "eq" | "neq" | "gt" | "lt" | "gte" | "lte" | "contains" | "between" | "relative" | "in" | "not_in" | "is_null" | "not_null";
type RelativeDatePreset = "today" | "yesterday" | "last_7_days" | "last_30_days" | "this_year" | "this_month" | "last_month";
type DraftGlobalFilter = {
  id: string;
  column: string;
  op: FilterOp;
  value: string;
  dateValue?: Date;
  dateRange?: DateRange;
  relativePreset?: RelativeDatePreset;
};
type AppliedGlobalFilter = {
  column: string;
  op: FilterOp;
  value: string | string[] | { relative: RelativeDatePreset };
};
type ComparableDateWindow = {
  column: string;
  currentStart: string;
  currentEnd: string;
  previousStart: string;
  previousEnd: string;
};
type KpiComparisonMap = Record<string, { previousData?: ApiDashboardWidgetDataResponse; label: string }>;

const commonOps: Array<{ value: FilterOp; label: string }> = [
  { value: "eq", label: "=" },
  { value: "neq", label: "!=" },
  { value: "gt", label: ">" },
  { value: "lt", label: "<" },
  { value: "gte", label: ">=" },
  { value: "lte", label: "<=" },
  { value: "in", label: "in" },
  { value: "not_in", label: "not in" },
  { value: "between", label: "entre" },
  { value: "contains", label: "contem" },
  { value: "is_null", label: "nulo" },
  { value: "not_null", label: "nao nulo" },
];

const temporalOps: Array<{ value: FilterOp; label: string }> = [
  { value: "eq", label: "=" },
  { value: "neq", label: "!=" },
  { value: "gt", label: ">" },
  { value: "lt", label: "<" },
  { value: "gte", label: ">=" },
  { value: "lte", label: "<=" },
  { value: "between", label: "entre datas" },
  { value: "relative", label: "data relativa" },
  { value: "in", label: "in" },
  { value: "not_in", label: "not in" },
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
const DAY_MS = 24 * 60 * 60 * 1000;

const toYmdLocal = (date: Date): string => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

const parseYmdLocal = (value: string): Date | null => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day);
  if (
    date.getFullYear() !== year
    || date.getMonth() !== month - 1
    || date.getDate() !== day
  ) {
    return null;
  }
  date.setHours(0, 0, 0, 0);
  return date;
};

const resolveRelativeDateRange = (preset: RelativeDatePreset): [string, string] | null => {
  const today = new Date();
  const end = new Date(today.getFullYear(), today.getMonth(), today.getDate());

  if (preset === "today") return [toYmdLocal(end), toYmdLocal(end)];
  if (preset === "yesterday") {
    const day = new Date(end);
    day.setDate(day.getDate() - 1);
    return [toYmdLocal(day), toYmdLocal(day)];
  }
  if (preset === "last_7_days") {
    const start = new Date(end);
    start.setDate(start.getDate() - 6);
    return [toYmdLocal(start), toYmdLocal(end)];
  }
  if (preset === "last_30_days") {
    const start = new Date(end);
    start.setDate(start.getDate() - 29);
    return [toYmdLocal(start), toYmdLocal(end)];
  }
  if (preset === "this_year") {
    const start = new Date(end.getFullYear(), 0, 1);
    return [toYmdLocal(start), toYmdLocal(end)];
  }
  if (preset === "this_month") {
    const start = new Date(end.getFullYear(), end.getMonth(), 1);
    return [toYmdLocal(start), toYmdLocal(end)];
  }
  if (preset === "last_month") {
    const start = new Date(end.getFullYear(), end.getMonth() - 1, 1);
    const monthEnd = new Date(end.getFullYear(), end.getMonth(), 0);
    return [toYmdLocal(start), toYmdLocal(monthEnd)];
  }
  return null;
};

const resolveTemporalBetweenValue = (rawValue: AppliedGlobalFilter["value"]): [string, string] | null => {
  if (Array.isArray(rawValue) && rawValue.length === 2) {
    const start = String(rawValue[0] || "").trim();
    const end = String(rawValue[1] || "").trim();
    if (!start || !end) return null;
    return [start, end];
  }
  if (rawValue && typeof rawValue === "object" && "relative" in rawValue) {
    const preset = (rawValue as { relative?: RelativeDatePreset }).relative;
    if (!preset) return null;
    return resolveRelativeDateRange(preset);
  }
  return null;
};

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

const operatorLabel: Record<FilterOp, string> = {
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

const appliedFilterSignature = (filter: AppliedGlobalFilter) =>
  `${filter.column}|${filter.op}|${JSON.stringify(filter.value)}`;

const appliedFilterLabel = (filter: AppliedGlobalFilter) => {
  if (filter.op === "is_null" || filter.op === "not_null") {
    return `${filter.column} ${operatorLabel[filter.op]}`;
  }
  const valueLabel = typeof filter.value === "object" && filter.value !== null && !Array.isArray(filter.value)
    ? String((filter.value as { relative?: string }).relative || "")
    : Array.isArray(filter.value)
      ? filter.value.join(" .. ")
      : String(filter.value);
  return `${filter.column} ${operatorLabel[filter.op]} ${valueLabel}`;
};

const getWidgetWidthClass = (sectionColumns: SectionColumns, width: WidgetWidth) => {
  const clampedWidth = Math.min(width, sectionColumns) as WidgetWidth;
  if (sectionColumns === 1) return "col-span-1";
  if (sectionColumns === 2) return clampedWidth >= 2 ? "md:col-span-2" : "md:col-span-1";
  if (clampedWidth >= 6) return "md:col-span-2 xl:col-span-6";
  if (clampedWidth === 5) return "md:col-span-2 xl:col-span-5";
  if (clampedWidth === 4) return "md:col-span-2 xl:col-span-4";
  if (clampedWidth === 3) return "md:col-span-2 xl:col-span-3";
  if (clampedWidth === 2) return "md:col-span-2 xl:col-span-2";
  return "md:col-span-1 xl:col-span-1";
};

const getWidgetPaddingClass = (padding?: "compact" | "normal" | "comfortable"): string => {
  if (padding === "compact") return "p-2";
  if (padding === "comfortable") return "p-4";
  return "p-3";
};

const getWidgetMinHeightClass = (height?: 0.5 | 1 | 2): string => {
  if (height === 0.5) return "min-h-[100px]";
  if (height === 2) return "min-h-[320px]";
  return "min-h-[180px]";
};

const getWidgetHeightClass = (height?: 0.5 | 1 | 2): string => {
  if (height === 0.5) return "h-[100px]";
  if (height === 2) return "h-[320px]";
  return "h-[180px]";
};

const VIEW_GRID_ROW_HEIGHT = 36;
const VIEW_GRID_MARGIN_Y = 16;

const gridRowsToWidgetCardHeightPx = (rows: number): number => (
  (Math.max(1, rows) * VIEW_GRID_ROW_HEIGHT) + ((Math.max(1, rows) - 1) * VIEW_GRID_MARGIN_Y)
);

const BuilderRouteTransitionSkeleton = () => (
  <div className="bg-background min-h-screen">
    <main className="h-[calc(100vh-56px)] min-h-0 overflow-hidden">
      <div className="flex h-full min-h-0">
        <aside className="hidden h-full w-[240px] shrink-0 border-r border-border/60 bg-card/20 p-4 lg:block">
          <div className="space-y-4">
            <Skeleton className="h-8 w-full rounded-md" />
            <Skeleton className="h-8 w-full rounded-md" />
            <Skeleton className="h-8 w-full rounded-md" />
          </div>
          <div className="mt-6 space-y-2">
            {Array.from({ length: 8 }).map((_, index) => (
              <Skeleton key={`dashboard-to-builder-left-nav-skeleton-${index}`} className="h-7 w-full rounded-md" />
            ))}
          </div>
        </aside>

        <div className="min-w-0 flex-1 p-4 md:p-5">
          <div className="mb-4 flex items-center gap-2">
            <Skeleton className="h-8 w-60 rounded-md" />
            <Skeleton className="ml-auto h-8 w-24 rounded-md" />
            <Skeleton className="h-8 w-28 rounded-md" />
          </div>
          <div className="h-[calc(100%-48px)] min-h-0 rounded-xl border border-border/60 bg-card/10 p-4">
            <div className="grid h-full min-h-0 grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
              <Skeleton className="h-36 rounded-lg" />
              <Skeleton className="h-48 rounded-lg" />
              <Skeleton className="h-28 rounded-lg" />
              <Skeleton className="h-44 rounded-lg" />
              <Skeleton className="h-32 rounded-lg" />
              <Skeleton className="h-52 rounded-lg" />
            </div>
          </div>
        </div>
      </div>
    </main>
  </div>
);

const DashboardViewPage = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { datasetId, dashboardId } = useParams<{ datasetId?: string; dashboardId?: string }>();
  const { datasets, views, dashboards, hasToken, isLoading, isError, errorMessage } = useCoreData();
  const { isLoading: isSimulatedLoading } = useSimulatedLoading();
  const [routeTransitionLoading, setRouteTransitionLoading] = useState(false);
  const routeTransitionTimeoutRef = useRef<number | null>(null);
  const isPresentationMode = location.pathname.startsWith("/presentation/");
  const isPublicMode = location.pathname.startsWith("/public/");
  const shouldUsePublicApi = isPublicMode;

  const publicDashboardQuery = useQuery({
    queryKey: ["public-dashboard", dashboardId],
    queryFn: () => api.getPublicDashboard(String(dashboardId)),
    enabled: !!dashboardId && shouldUsePublicApi,
    retry: false,
  });
  const showLoadingSkeleton = isLoading || isSimulatedLoading || publicDashboardQuery.isLoading;
  useEffect(() => {
    const state = location.state as { dashboardBuilderTransition?: boolean } | null;
    if (!state?.dashboardBuilderTransition) return;
    setRouteTransitionLoading(true);
    if (routeTransitionTimeoutRef.current) {
      window.clearTimeout(routeTransitionTimeoutRef.current);
    }
    routeTransitionTimeoutRef.current = window.setTimeout(() => {
      setRouteTransitionLoading(false);
      routeTransitionTimeoutRef.current = null;
    }, 220);
  }, [location.state]);
  useEffect(() => () => {
    if (routeTransitionTimeoutRef.current) {
      window.clearTimeout(routeTransitionTimeoutRef.current);
    }
  }, []);
  const mappedPublicDashboard = useMemo(
    () => (publicDashboardQuery.data
      ? mapDashboard({
          ...publicDashboardQuery.data,
          created_by_id: null,
          is_owner: false,
          access_level: "view",
          access_source: "public",
        })
      : undefined),
    [publicDashboardQuery.data],
  );
  const dashboard = useMemo(
    () => dashboards.find((item) => item.id === dashboardId) || mappedPublicDashboard,
    [dashboards, dashboardId, mappedPublicDashboard],
  );
  const resolvedDatasetId = datasetId
    || dashboard?.datasetId
    || (publicDashboardQuery.data ? String(publicDashboardQuery.data.dataset_id) : undefined);
  const dataset = useMemo(
    () => datasets.find((item) => item.id === resolvedDatasetId)
      || (publicDashboardQuery.data
        ? {
            id: String(publicDashboardQuery.data.dataset_id),
            datasourceId: "",
            name: "Dashboard público",
            description: "",
            viewId: undefined,
            baseQuerySpec: null,
            semanticColumns: [],
            dashboardIds: [String(publicDashboardQuery.data.id)],
            createdAt: publicDashboardQuery.data.created_at,
          }
        : undefined),
    [datasets, resolvedDatasetId, publicDashboardQuery.data],
  );
  const canEditDashboard = (dashboard?.accessLevel || "view") !== "view";
  const view = useMemo(() => (dataset ? views.find((item) => item.id === dataset.viewId) : undefined), [dataset, views]);
  const datasetSourceLabel = useMemo(() => {
    const primaryResource = (dataset?.baseQuerySpec?.base as { primary_resource?: string } | undefined)?.primary_resource;
    if (typeof primaryResource === "string" && primaryResource.trim()) return primaryResource.trim();
    if (view) return `${view.schema}.${view.name}`;
    return "__dataset_base";
  }, [dataset, view]);
  const effectiveColumns = useMemo(
    () => {
      const merged = new Map<string, { name: string; type: string }>();
      const upsert = (columnName: string, columnType: string) => {
        const current = merged.get(columnName);
        if (!current) {
          merged.set(columnName, { name: columnName, type: normalizeSemanticColumnType(columnType) });
          return;
        }
        merged.set(columnName, { name: columnName, type: mergeColumnType(current.type, columnType) });
      };
      (view?.columns || []).forEach((column) => upsert(column.name, column.type));
      (dataset?.semanticColumns || []).forEach((column) => upsert(column.name, column.type));
      return Array.from(merged.values());
    },
    [view?.columns, dataset?.semanticColumns],
  );
  const [draftFilters, setDraftFilters] = useState<DraftGlobalFilter[]>([
    { id: `gf-${Date.now()}`, column: "", op: "eq", value: "" },
  ]);
  const [appliedFilters, setAppliedFilters] = useState<AppliedGlobalFilter[]>([]);
  const [shareOpen, setShareOpen] = useState(false);
  const sections = dashboard?.sections || [];
  const widgetCount = sections.reduce((total, section) => total + section.widgets.length, 0);
  const widgets = useMemo(() => sections.flatMap((section) => section.widgets), [sections]);
  const enforcedHiddenFilters = useMemo<AppliedGlobalFilter[]>(() => {
    const hidden = (dashboard?.nativeFilters || [])
      .filter((filter) => filter.visible === false && !!filter.column && !!filter.op)
      .map((filter) => ({
        column: filter.column,
        op: filter.op as FilterOp,
        value: (filter.value as AppliedGlobalFilter["value"]) ?? "",
      }));
    const deduped = new Map<string, AppliedGlobalFilter>();
    hidden.forEach((filter) => {
      deduped.set(appliedFilterSignature(filter), filter);
    });
    return Array.from(deduped.values());
  }, [dashboard?.nativeFilters, dashboard?.updatedAt]);
  const effectiveAppliedFilters = useMemo<AppliedGlobalFilter[]>(() => {
    const deduped = new Map<string, AppliedGlobalFilter>();
    [...enforcedHiddenFilters, ...appliedFilters].forEach((filter) => {
      deduped.set(appliedFilterSignature(filter), filter);
    });
    return Array.from(deduped.values());
  }, [enforcedHiddenFilters, appliedFilters]);

  const preparedGlobalFilters = useMemo<AppliedGlobalFilter[]>(() => {
    const temporalColumnNames = new Set(
      effectiveColumns.filter((column) => normalizeSemanticColumnType(column.type) === "temporal").map((column) => column.name),
    );
    const parsedFilters: AppliedGlobalFilter[] = [];
    for (const filter of draftFilters) {
      if (!filter.column) continue;
      const isTemporal = temporalColumnNames.has(filter.column);
      if (filter.op === "is_null" || filter.op === "not_null") {
        parsedFilters.push({ column: filter.column, op: filter.op, value: "" });
        continue;
      }
      if (isTemporal && filter.op === "relative") {
        parsedFilters.push({
          column: filter.column,
          op: "between",
          value: { relative: (filter.relativePreset || "last_7_days") as RelativeDatePreset },
        });
        continue;
      }
      if (isTemporal && filter.op === "between") {
        if (!filter.dateRange?.from || !filter.dateRange?.to) continue;
        parsedFilters.push({
          column: filter.column,
          op: "between",
          value: [dateToApi(filter.dateRange.from), dateToApi(filter.dateRange.to)],
        });
        continue;
      }
      if (isTemporal) {
        if (!filter.dateValue) continue;
        parsedFilters.push({
          column: filter.column,
          op: filter.op,
          value: dateToApi(filter.dateValue),
        });
        continue;
      }
      if (filter.op === "between") {
        const values = String(filter.value || "").split(",").map((item) => item.trim()).filter(Boolean);
        if (values.length < 2) continue;
        parsedFilters.push({ column: filter.column, op: "between", value: [values[0], values[1]] });
        continue;
      }
      if (filter.op === "in" || filter.op === "not_in") {
        const values = String(filter.value || "").split(",").map((item) => item.trim()).filter(Boolean);
        if (values.length === 0) continue;
        parsedFilters.push({ column: filter.column, op: filter.op, value: values });
        continue;
      }
      if (!filter.value.trim()) continue;
      parsedFilters.push({
        column: filter.column,
        op: filter.op,
        value: filter.value,
      });
    }
    return parsedFilters;
  }, [draftFilters, effectiveColumns]);
  useEffect(() => {
    if (!dashboard) return;
    const visibleNativeFilters = (dashboard.nativeFilters || []).filter((item) => item.visible);
    if (visibleNativeFilters.length === 0) {
      setDraftFilters([{ id: `gf-${Date.now()}`, column: "", op: "eq", value: "" }]);
      setAppliedFilters([]);
      return;
    }
    const nextDrafts: DraftGlobalFilter[] = [];
    const nextApplied: AppliedGlobalFilter[] = [];
    visibleNativeFilters.forEach((filter, index) => {
      if (!filter.column) return;
      const relativePreset = typeof filter.value === "object" && filter.value !== null && "relative" in filter.value
        ? (String((filter.value as Record<string, unknown>).relative) as RelativeDatePreset)
        : undefined;
      const op = (relativePreset ? "relative" : filter.op) as FilterOp;
      const isBetween = op === "between" && Array.isArray(filter.value) && filter.value.length === 2;
      const from = isBetween && typeof filter.value[0] === "string" ? new Date(filter.value[0]) : undefined;
      const to = isBetween && typeof filter.value[1] === "string" ? new Date(filter.value[1]) : undefined;
      const value = Array.isArray(filter.value)
        ? filter.value.map((item) => String(item)).join(", ")
        : typeof filter.value === "string"
          ? filter.value
          : "";
      nextDrafts.push({
        id: `gf-native-${dashboard.id}-${index}`,
        column: filter.column,
        op: op,
        value,
        dateValue: !isBetween && !relativePreset && typeof filter.value === "string" ? new Date(filter.value) : undefined,
        dateRange: isBetween ? { from, to } : undefined,
        relativePreset: relativePreset || "last_7_days",
      });
      if (filter.op === "is_null" || filter.op === "not_null") {
        nextApplied.push({ column: filter.column, op: filter.op as FilterOp, value: "" });
        return;
      }
      if (relativePreset) {
        nextApplied.push({
          column: filter.column,
          op: "between",
          value: { relative: relativePreset },
        });
        return;
      }
      if (isBetween && Array.isArray(filter.value)) {
        nextApplied.push({
          column: filter.column,
          op: "between",
          value: [String(filter.value[0]), String(filter.value[1])],
        });
        return;
      }
      if ((filter.op === "in" || filter.op === "not_in") && Array.isArray(filter.value)) {
        nextApplied.push({
          column: filter.column,
          op: filter.op as FilterOp,
          value: filter.value.map((item) => String(item)),
        });
        return;
      }
      if (typeof filter.value === "string" && filter.value.trim()) {
        nextApplied.push({
          column: filter.column,
          op: filter.op as FilterOp,
          value: filter.value,
        });
      }
    });
    setDraftFilters(nextDrafts.length > 0 ? nextDrafts : [{ id: `gf-${Date.now()}`, column: "", op: "eq", value: "" }]);
    setAppliedFilters(nextApplied);
  }, [dashboard?.id, dashboard?.updatedAt]);

  const canLoadWidgetData = shouldUsePublicApi ? !!publicDashboardQuery.data : hasToken;
  const kpiWidgetIds = useMemo(
    () => widgets
      .filter((widget) => widget.config.widget_type === "kpi" && widget.config.kpi_show_trend === true)
      .map((widget) => Number(widget.id))
      .filter((id) => Number.isFinite(id) && id > 0),
    [widgets],
  );
  const comparableDateWindow = useMemo<ComparableDateWindow | null>(() => {
    const temporalColumns = new Set(
      effectiveColumns.filter((column) => normalizeSemanticColumnType(column.type) === "temporal").map((column) => column.name),
    );
    let best: ComparableDateWindow | null = null;
    let bestDurationDays = Number.POSITIVE_INFINITY;
    for (const filter of effectiveAppliedFilters) {
      if (filter.op !== "between" || !temporalColumns.has(filter.column)) continue;
      const range = resolveTemporalBetweenValue(filter.value);
      if (!range) continue;
      const currentStartDate = parseYmdLocal(range[0]);
      const currentEndDate = parseYmdLocal(range[1]);
      if (!currentStartDate || !currentEndDate) continue;
      if (currentEndDate.getTime() < currentStartDate.getTime()) continue;
      const durationDays = Math.floor((currentEndDate.getTime() - currentStartDate.getTime()) / DAY_MS) + 1;
      if (durationDays <= 0) continue;
      const previousEndDate = new Date(currentStartDate.getTime() - DAY_MS);
      const previousStartDate = new Date(previousEndDate.getTime() - ((durationDays - 1) * DAY_MS));
      if (durationDays >= bestDurationDays) continue;
      bestDurationDays = durationDays;
      best = {
        column: filter.column,
        currentStart: toYmdLocal(currentStartDate),
        currentEnd: toYmdLocal(currentEndDate),
        previousStart: toYmdLocal(previousStartDate),
        previousEnd: toYmdLocal(previousEndDate),
      };
    }
    return best;
  }, [effectiveAppliedFilters, effectiveColumns]);
  const previousPeriodFilters = useMemo<AppliedGlobalFilter[]>(() => {
    if (!comparableDateWindow) return [];
    let replaced = false;
    return effectiveAppliedFilters.map((filter) => {
      if (replaced || filter.op !== "between" || filter.column !== comparableDateWindow.column) {
        return filter;
      }
      const currentRange = resolveTemporalBetweenValue(filter.value);
      if (!currentRange) return filter;
      if (currentRange[0] !== comparableDateWindow.currentStart || currentRange[1] !== comparableDateWindow.currentEnd) {
        return filter;
      }
      replaced = true;
      return {
        ...filter,
        value: [comparableDateWindow.previousStart, comparableDateWindow.previousEnd],
      };
    });
  }, [comparableDateWindow, effectiveAppliedFilters]);

  const widgetsDataQuery = useQuery({
    queryKey: [
      "dashboard-widget-data",
      dashboardId,
      widgets.map((widget) => widget.id).join(","),
      JSON.stringify(effectiveAppliedFilters),
    ],
    queryFn: () => {
      if (!shouldUsePublicApi) {
        return api.getDashboardWidgetsData(
          Number(dashboardId),
          widgets.map((widget) => Number(widget.id)),
          effectiveAppliedFilters,
        );
      }
      return api.getPublicDashboardWidgetsData(
        String(dashboardId),
        widgets.map((widget) => Number(widget.id)),
        effectiveAppliedFilters,
      );
    },
    enabled: canLoadWidgetData && !!dashboardId && widgets.length > 0,
  });
  const previousKpiDataQuery = useQuery({
    queryKey: [
      "dashboard-widget-data-previous-period-kpi",
      dashboardId,
      kpiWidgetIds.join(","),
      JSON.stringify(previousPeriodFilters),
      comparableDateWindow?.column || "",
      comparableDateWindow?.currentStart || "",
      comparableDateWindow?.currentEnd || "",
    ],
    queryFn: () => {
      if (!shouldUsePublicApi) {
        return api.getDashboardWidgetsData(
          Number(dashboardId),
          kpiWidgetIds,
          previousPeriodFilters,
        );
      }
      return api.getPublicDashboardWidgetsData(
        String(dashboardId),
        kpiWidgetIds,
        previousPeriodFilters,
      );
    },
    enabled: canLoadWidgetData && !!dashboardId && !!comparableDateWindow && kpiWidgetIds.length > 0,
  });

  const widgetDataById = useMemo(() => {
    const mapped: Record<string, ApiDashboardWidgetDataResponse> = {};
    (widgetsDataQuery.data?.results || []).forEach((result) => {
      mapped[String(result.widget_id)] = {
        columns: result.columns,
        rows: result.rows,
        row_count: result.row_count,
      };
    });
    return mapped;
  }, [widgetsDataQuery.data]);
  const previousKpiDataByWidgetId = useMemo(() => {
    const mapped: Record<string, ApiDashboardWidgetDataResponse> = {};
    (previousKpiDataQuery.data?.results || []).forEach((result) => {
      mapped[String(result.widget_id)] = {
        columns: result.columns,
        rows: result.rows,
        row_count: result.row_count,
      };
    });
    return mapped;
  }, [previousKpiDataQuery.data]);
  const kpiComparisonByWidgetId = useMemo<KpiComparisonMap>(() => {
    if (!comparableDateWindow || previousKpiDataQuery.isLoading || previousKpiDataQuery.isError) return {};
    const mapped: KpiComparisonMap = {};
    widgets.forEach((widget) => {
      if (widget.config.widget_type !== "kpi" || widget.config.kpi_show_trend !== true) return;
      mapped[widget.id] = {
        previousData: previousKpiDataByWidgetId[widget.id],
        label: "vs periodo anterior",
      };
    });
    return mapped;
  }, [comparableDateWindow, previousKpiDataByWidgetId, previousKpiDataQuery.isError, previousKpiDataQuery.isLoading, widgets]);

  const previewErrorMessage = widgetsDataQuery.isError
    ? (widgetsDataQuery.error as Error).message || "Falha ao carregar dados"
    : null;
  const sharingQuery = useQuery({
    queryKey: ["dashboard-sharing", dashboardId],
    queryFn: () => api.getDashboardSharing(Number(dashboardId)),
    enabled: shareOpen && !!dashboardId && !!dashboard?.isOwner,
  });
  const publicShareKey = sharingQuery.data?.public_share_key
    || dashboard?.publicShareKey
    || publicDashboardQuery.data?.public_share_key
    || dashboardId;
  const publicShareUrl = `${window.location.origin}/public/dashboard/${publicShareKey || ""}`;
  const internalShareUrl = `${window.location.origin}/datasets/${resolvedDatasetId || dashboard?.datasetId || ""}/dashboard/${dashboardId || ""}`;
  const effectiveVisibility = sharingQuery.data?.visibility || dashboard?.visibility;
  const shareUrl = effectiveVisibility === "public_view" ? publicShareUrl : internalShareUrl;

  const updateVisibilityMutation = useMutation({
    mutationFn: (visibility: "private" | "workspace_view" | "workspace_edit" | "public_view") =>
      api.updateDashboardVisibility(Number(dashboardId), { visibility }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["dashboard-sharing", dashboardId] });
      await queryClient.invalidateQueries({ queryKey: ["dashboard-catalog"] });
      await queryClient.invalidateQueries({ queryKey: ["dashboards"] });
      toast({ title: "Compartilhamento atualizado" });
    },
    onError: (error: unknown) => {
      const message = error instanceof Error ? error.message : "Falha ao atualizar visibilidade";
      toast({ title: "Erro ao compartilhar", description: message, variant: "destructive" });
    },
  });

  const upsertEmailShareMutation = useMutation({
    mutationFn: (payload: { email: string; permission: "view" | "edit" }) =>
      api.upsertDashboardEmailShare(Number(dashboardId), payload),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["dashboard-sharing", dashboardId] });
      await queryClient.invalidateQueries({ queryKey: ["dashboard-catalog"] });
      await queryClient.invalidateQueries({ queryKey: ["dashboards"] });
      toast({ title: "Convite atualizado" });
    },
    onError: (error: unknown) => {
      const message = error instanceof Error ? error.message : "Falha ao compartilhar por e-mail";
      toast({ title: "Erro ao compartilhar", description: message, variant: "destructive" });
    },
  });

  const deleteEmailShareMutation = useMutation({
    mutationFn: (shareId: number) => api.deleteDashboardEmailShare(Number(dashboardId), shareId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["dashboard-sharing", dashboardId] });
      await queryClient.invalidateQueries({ queryKey: ["dashboard-catalog"] });
      await queryClient.invalidateQueries({ queryKey: ["dashboards"] });
      toast({ title: "Acesso removido" });
    },
    onError: (error: unknown) => {
      const message = error instanceof Error ? error.message : "Falha ao remover compartilhamento";
      toast({ title: "Erro ao compartilhar", description: message, variant: "destructive" });
    },
  });
  const removeAppliedFilter = (filter: AppliedGlobalFilter) => {
    const signature = appliedFilterSignature(filter);
    setAppliedFilters((prev) => prev.filter((item) => appliedFilterSignature(item) !== signature));
    setDraftFilters((prev) => {
      let removed = false;
      return prev.filter((item) => {
        if (removed || !item.column) return true;
        const selectedColumn = (effectiveColumns || []).find((column) => column.name === item.column);
        const isTemporal = !!selectedColumn && normalizeSemanticColumnType(selectedColumn.type) === "temporal";
        let normalized: AppliedGlobalFilter | null = null;
        if (isTemporal && item.op === "relative") {
          normalized = {
            column: item.column,
            op: "between",
            value: { relative: (item.relativePreset || "last_7_days") as RelativeDatePreset },
          };
        } else if (item.op === "is_null" || item.op === "not_null") {
          normalized = { column: item.column, op: item.op, value: "" };
        } else if (isTemporal && item.op === "between" && item.dateRange?.from && item.dateRange?.to) {
          normalized = { column: item.column, op: "between", value: [dateToApi(item.dateRange.from), dateToApi(item.dateRange.to)] };
        } else if (isTemporal && item.dateValue) {
          normalized = { column: item.column, op: item.op, value: dateToApi(item.dateValue) };
        } else if (item.op === "between" && item.value.trim()) {
          const values = item.value.split(",").map((entry) => entry.trim()).filter(Boolean);
          if (values.length >= 2) {
            normalized = { column: item.column, op: "between", value: [values[0], values[1]] };
          }
        } else if ((item.op === "in" || item.op === "not_in") && item.value.trim()) {
          normalized = {
            column: item.column,
            op: item.op,
            value: item.value.split(",").map((entry) => entry.trim()).filter(Boolean),
          };
        } else if (!isTemporal && item.value.trim()) {
          normalized = { column: item.column, op: item.op, value: item.value };
        }
        if (normalized && appliedFilterSignature(normalized) === signature) {
          removed = true;
          return false;
        }
        return true;
      });
    });
  };
  const clearAllFilters = () => {
    setDraftFilters([{ id: `gf-${Date.now()}`, column: "", op: "eq", value: "" }]);
    setAppliedFilters([]);
  };

  if (!hasToken && !isPublicMode) {
    return (
      <div className="bg-background min-h-screen flex flex-col">
        <main className="app-container py-8 flex-1 flex items-center justify-center">
          <EmptyState
            icon={<Database className="h-5 w-5" />}
            title="Sessão necessária"
            description="Para abrir este dashboard em modo apresentação, faça login novamente."
            action={(
              <Button size="sm" onClick={() => navigate("/login")}>
                Ir para login
              </Button>
            )}
          />
        </main>
      </div>
    );
  }

  if (isError || publicDashboardQuery.isError) {
    return (
      <div className="bg-background min-h-screen">
        <main className="app-container py-6">
          <EmptyState
            icon={<Database className="h-5 w-5" />}
            title="Erro ao carregar dashboard"
            description={errorMessage || (publicDashboardQuery.error as Error | undefined)?.message || "Falha ao carregar dashboard"}
          />
        </main>
      </div>
    );
  }

  if (routeTransitionLoading) {
    return <BuilderRouteTransitionSkeleton />;
  }

  if (showLoadingSkeleton) {
    return (
      <div className="bg-background min-h-screen">
        <main className="app-container py-6 space-y-6">
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-3">
            <Skeleton className="h-4 w-72 max-w-full" />
            <Skeleton className="h-8 w-96 max-w-full" />
            <Skeleton className="h-4 w-64 max-w-full" />
          </motion.div>
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.05 }} className="grid gap-4 md:grid-cols-2">
            {Array.from({ length: 6 }).map((_, index) => (
              <div key={`dashboard-widget-skeleton-${index}`} className="glass-card overflow-hidden">
                <div className="border-b border-border/50 px-4 py-2.5">
                  <Skeleton className="h-5 w-36" />
                </div>
                <div className="p-3">
                  <div className="h-[180px] w-full rounded-lg border border-border/40 bg-muted/20 p-4">
                    <div className="flex h-full w-full flex-col items-center justify-center gap-3">
                      <Skeleton className="h-3 w-28" />
                      <Skeleton className="h-10 w-40" />
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </motion.div>
        </main>
      </div>
    );
  }

  if (!dataset || !dashboard) {
    return (
      <div className="bg-background min-h-screen flex flex-col flex-1">
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center space-y-3">
            <h2 className="text-title text-foreground">Dashboard não encontrado</h2>
            <Button variant="outline" onClick={() => navigate(resolvedDatasetId ? `/datasets/${resolvedDatasetId}` : "/datasets")}>
              <ChevronLeft className="h-4 w-4 mr-1" /> Voltar
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-background min-h-screen flex flex-col flex-1">
      {!isPresentationMode && !isPublicMode && <div className="sticky top-12 z-40 border-b border-border bg-card/90 backdrop-blur-sm print:hidden">
        <div className="app-container flex items-center justify-between h-12 gap-4">
          <div className="flex items-center gap-2 min-w-0">
            <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" onClick={() => navigate(resolvedDatasetId ? `/datasets/${resolvedDatasetId}` : "/datasets")}>
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <ContextualBreadcrumb
              className="hidden sm:block min-w-0"
              items={[
                { label: "Datasets", href: "/datasets" },
                { label: dataset.name, href: resolvedDatasetId ? `/datasets/${resolvedDatasetId}` : "/datasets" },
                { label: dashboard.title },
              ]}
            />
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <span className="text-xs text-muted-foreground hidden sm:inline">
              <Database className="h-3 w-3 inline mr-1" />
              Base semantica: {datasetSourceLabel}
            </span>
            {dashboard.visibility === "public_view" && (
              <Badge variant="secondary" className="text-[11px]">
                Público
              </Badge>
            )}
            <div className="h-4 w-px bg-border hidden sm:block" />
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8 text-xs"
                  onClick={() => {
                    if (!resolvedDatasetId || !dashboardId) return;
                    navigate(`/datasets/${resolvedDatasetId}/builder/${dashboardId}`, { state: { dashboardBuilderTransition: true } });
                  }}
                  disabled={!canEditDashboard}
                >
                  <Pencil className="h-3 w-3 sm:mr-1" />
                  <span className="hidden sm:inline">Editar</span>
                </Button>
              </TooltipTrigger>
              <TooltipContent className="text-xs">
                {canEditDashboard ? "Editar dashboard" : "Sem permissão de edição"}
              </TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8 text-xs"
                  onClick={() => setShareOpen(true)}
                  disabled={!dashboard.isOwner}
                >
                  <Share2 className="h-3 w-3 sm:mr-1" />
                  <span className="hidden sm:inline">Compartilhar</span>
                </Button>
              </TooltipTrigger>
              <TooltipContent className="text-xs">
                {dashboard.isOwner ? "Compartilhar" : "Somente o dono pode compartilhar"}
              </TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8 text-xs"
                  onClick={() => {
                    if (!resolvedDatasetId || !dashboardId) return;
                    navigate(`/presentation/datasets/${resolvedDatasetId}/dashboard/${dashboardId}`);
                  }}
                >
                  <Monitor className="h-3 w-3 sm:mr-1" />
                  <span className="hidden sm:inline">Apresentação</span>
                </Button>
              </TooltipTrigger>
              <TooltipContent className="text-xs">Abrir modo apresentação</TooltipContent>
            </Tooltip>
          </div>
        </div>
      </div>}

      <div className="flex-1 app-container py-6">
        <div className="mb-6 py-1">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
            <div className="min-w-0 lg:w-[28%]">
              <h1 className="text-display text-foreground truncate">{dashboard.title}</h1>
              <p className="text-caption mt-1">Identificador principal do dashboard</p>
            </div>
            <div className="min-w-0 flex-1">
              {appliedFilters.length > 0 && (
                <div className="flex flex-wrap items-center justify-end gap-2">
                  {appliedFilters.map((filter) => (
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
                  <Button size="sm" variant="ghost" className="h-7 text-xs px-2.5" onClick={clearAllFilters}>
                    Limpar
                  </Button>
                </div>
              )}
            </div>
            <div className="lg:shrink-0 flex flex-col items-start lg:items-end gap-1">
              <Popover>
                <PopoverTrigger asChild>
                  <Button size="sm" variant="outline" className="h-8 text-xs">
                    <SlidersHorizontal className="h-3.5 w-3.5 mr-1.5" /> Filtros
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-[min(92vw,760px)] p-4" align="end">
                  <div className="space-y-3">
                    <Label className="text-xs font-semibold text-muted-foreground">Filtros globais</Label>
                    {draftFilters.map((filter) => {
                      const selectedColumn = (effectiveColumns || []).find((column) => column.name === filter.column);
                      const isTemporal = !!selectedColumn && normalizeSemanticColumnType(selectedColumn.type) === "temporal";
                      const operatorOptions = isTemporal ? temporalOps : commonOps;
                      return (
                        <div key={filter.id} className="grid grid-cols-1 md:grid-cols-[1fr_150px_1fr_auto] gap-2 items-center">
                          <Select
                            value={filter.column || "__none__"}
                            onValueChange={(value) =>
                              setDraftFilters((prev) => prev.map((item) => item.id === filter.id
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
                              {(effectiveColumns || []).map((column) => (
                                <SelectItem key={column.name} value={column.name}>{column.name}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          <Select
                            value={filter.op}
                            onValueChange={(value) =>
                              setDraftFilters((prev) => prev.map((item) => item.id === filter.id
                                ? {
                                    ...item,
                                    op: value as FilterOp,
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
                              value={filter.value}
                              onChange={(e) =>
                                setDraftFilters((prev) => prev.map((item) => item.id === filter.id ? { ...item, value: e.target.value } : item))}
                              disabled={!filter.column}
                            />
                          )}

                          {!isTemporal && !(filter.op === "is_null" || filter.op === "not_null" || filter.op === "in" || filter.op === "not_in") && (
                            <Input
                              className="h-8 text-xs"
                              placeholder="Valor"
                              value={filter.value}
                              onChange={(e) =>
                                setDraftFilters((prev) => prev.map((item) => item.id === filter.id ? { ...item, value: e.target.value } : item))}
                              disabled={!filter.column}
                            />
                          )}

                          {isTemporal && filter.op === "relative" && (
                            <Select
                              value={filter.relativePreset || "last_7_days"}
                              onValueChange={(value) =>
                                setDraftFilters((prev) => prev.map((item) => item.id === filter.id
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
                              value={filter.value}
                              onChange={(e) =>
                                setDraftFilters((prev) => prev.map((item) => item.id === filter.id ? { ...item, value: e.target.value } : item))}
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
                                    setDraftFilters((prev) => prev.map((item) => item.id === filter.id ? { ...item, dateValue: date } : item))}
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
                                    setDraftFilters((prev) => prev.map((item) => item.id === filter.id ? { ...item, dateRange: range } : item))}
                                  numberOfMonths={2}
                                />
                              </PopoverContent>
                            </Popover>
                          )}

                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-8 w-8 destructive-icon-btn"
                            disabled={draftFilters.length === 1}
                            onClick={() => setDraftFilters((prev) => prev.filter((item) => item.id !== filter.id))}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      );
                    })}

                    <div className="flex items-center justify-between pt-1">
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="h-8 text-xs"
                        onClick={() =>
                          setDraftFilters((prev) => [...prev, { id: `gf-${Date.now()}-${Math.random()}`, column: "", op: "eq", value: "" }])}
                      >
                        <Plus className="h-3.5 w-3.5 mr-1.5" /> Adicionar filtro
                      </Button>
                      <div className="flex items-center gap-2">
                        <Button
                          size="sm"
                          className="h-8 text-xs"
                          onClick={() => setAppliedFilters(preparedGlobalFilters)}
                        >
                          Aplicar ({preparedGlobalFilters.length})
                        </Button>
                        <Button size="sm" variant="outline" className="h-8 text-xs" onClick={clearAllFilters}>
                          Limpar
                        </Button>
                      </div>
                    </div>
                  </div>
                </PopoverContent>
              </Popover>
              {appliedFilters.length === 0 && (
                <p className="text-xs text-muted-foreground">Nenhum filtro global ativo.</p>
              )}
            </div>
          </div>
        </div>

        {dashboard.sections.length === 0 || widgetCount === 0 ? (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="flex flex-col items-center justify-center py-24 gap-4"
          >
            <p className="text-sm text-muted-foreground">Este dashboard ainda não possui widgets.</p>
            <Button
              variant="outline"
              onClick={() => {
                if (!resolvedDatasetId || !dashboardId) return;
                navigate(`/datasets/${resolvedDatasetId}/builder/${dashboardId}`, { state: { dashboardBuilderTransition: true } });
              }}
              disabled={!canEditDashboard || !resolvedDatasetId || !dashboardId}
            >
              <Pencil className="h-4 w-4 mr-1.5" /> Editar dashboard
            </Button>
          </motion.div>
        ) : (
          <div className="space-y-8">
            {dashboard.sections.map((section, idx) => (
              <ViewSection
                key={section.id}
                section={section}
                dashboardId={dashboardId}
                delay={idx * 0.06}
                dataByWidgetId={widgetDataById}
                kpiComparisonByWidgetId={kpiComparisonByWidgetId}
                loading={widgetsDataQuery.isLoading}
                errorMessage={previewErrorMessage}
              />
            ))}
          </div>
        )}
      </div>

      {dashboard.isOwner && (
        <ShareDashboardDialog
          open={shareOpen}
          onOpenChange={setShareOpen}
          dashboardTitle={dashboard.title}
          shareUrl={shareUrl}
          visibility={sharingQuery.data?.visibility}
          shares={sharingQuery.data?.shares || []}
          loading={sharingQuery.isLoading}
          updatingVisibility={updateVisibilityMutation.isPending}
          sharingByEmail={upsertEmailShareMutation.isPending}
          removingShare={deleteEmailShareMutation.isPending}
          onVisibilityChange={(visibility) => updateVisibilityMutation.mutate(visibility)}
          onShareByEmail={(payload) => upsertEmailShareMutation.mutate(payload)}
          onRemoveShare={(shareId) => deleteEmailShareMutation.mutate(shareId)}
        />
      )}
    </div>
  );
};

const ShareDashboardDialog = ({
  open,
  onOpenChange,
  dashboardTitle,
  shareUrl,
  visibility,
  shares,
  loading,
  updatingVisibility,
  sharingByEmail,
  removingShare,
  onVisibilityChange,
  onShareByEmail,
  onRemoveShare,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  dashboardTitle: string;
  shareUrl: string;
  visibility?: "private" | "workspace_view" | "workspace_edit" | "public_view";
  shares: Array<{ id: number; email: string; permission: "view" | "edit" }>;
  loading: boolean;
  updatingVisibility: boolean;
  sharingByEmail: boolean;
  removingShare: boolean;
  onVisibilityChange: (visibility: "private" | "workspace_view" | "workspace_edit" | "public_view") => void;
  onShareByEmail: (payload: { email: string; permission: "view" | "edit" }) => void;
  onRemoveShare: (shareId: number) => void;
}) => {
  const { toast } = useToast();
  const currentUser = getStoredUser();
  const [email, setEmail] = useState("");
  const [permission, setPermission] = useState<"view" | "edit">("view");
  const [copied, setCopied] = useState(false);
  const [selectedEmail, setSelectedEmail] = useState<string | null>(null);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const normalizedEmail = email.trim().toLowerCase();
  const shareableUsersQuery = useQuery({
    queryKey: ["dashboard-shareable-users", normalizedEmail],
    queryFn: () => api.listDashboardShareableUsers(normalizedEmail, 8),
    enabled: open && normalizedEmail.length > 0,
  });
  const suggestions = (shareableUsersQuery.data || []).filter((user) =>
    user.email.toLowerCase().includes(normalizedEmail)
    || (user.full_name || "").toLowerCase().includes(normalizedEmail),
  );
  const canInvite = !!selectedEmail && selectedEmail === normalizedEmail;

  const visibilityLabel = visibility === "workspace_edit"
    ? "Todos podem editar"
    : visibility === "workspace_view"
      ? "Todos podem ver"
      : visibility === "public_view"
        ? "Público (sem login)"
      : "Restrito";
  const visibilityDescription = visibility === "workspace_edit"
    ? "Todas as pessoas do ambiente podem abrir e editar."
    : visibility === "workspace_view"
      ? "Todas as pessoas do ambiente podem abrir e visualizar."
      : visibility === "public_view"
        ? "Qualquer pessoa com o link pode abrir sem autenticação."
      : "Somente pessoas convidadas podem abrir este dashboard.";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl p-0 overflow-hidden">
        <DialogHeader className="px-6 pt-6">
          <DialogTitle className="text-title">Compartilhar "{dashboardTitle}"</DialogTitle>
          <DialogDescription className="sr-only">Defina permissões de acesso para este dashboard.</DialogDescription>
        </DialogHeader>

        <div className="px-6 pb-6 space-y-6">
          <div className="grid gap-2 sm:grid-cols-[1fr_170px_auto]">
            <div className="relative">
              <Input
                type="email"
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                  setSelectedEmail(null);
                  setShowSuggestions(true);
                }}
                onFocus={() => setShowSuggestions(true)}
                onBlur={() => {
                  window.setTimeout(() => setShowSuggestions(false), 120);
                }}
                placeholder="Adicionar participantes por e-mail"
                disabled={sharingByEmail}
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="none"
                spellCheck={false}
                className="h-11"
              />
              {showSuggestions && normalizedEmail.length > 0 && suggestions.length > 0 && (
                <div className="absolute z-50 mt-1 w-full overflow-hidden rounded-md border border-border bg-popover shadow-lg">
                  {suggestions.map((user) => (
                    <button
                      key={user.id}
                      type="button"
                      className="w-full px-3 py-2 text-left hover:bg-accent/10"
                      onMouseDown={(e) => {
                        e.preventDefault();
                        setEmail(user.email);
                        setSelectedEmail(user.email.toLowerCase());
                        setShowSuggestions(false);
                      }}
                    >
                      <p className="text-sm font-medium truncate">{user.full_name || user.email}</p>
                      <p className="text-xs text-muted-foreground truncate">{user.email}</p>
                    </button>
                  ))}
                </div>
              )}
              {normalizedEmail.length > 0 && !canInvite && (
                <p className="mt-1 text-xs text-muted-foreground">Selecione um e-mail cadastrado na lista.</p>
              )}
            </div>
            <Select value={permission} onValueChange={(value) => setPermission(value as "view" | "edit")} disabled={sharingByEmail}>
              <SelectTrigger className="h-11">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="view">Leitor</SelectItem>
                <SelectItem value="edit">Editor</SelectItem>
              </SelectContent>
            </Select>
            <Button
              className="h-11"
              onClick={() => {
                if (!canInvite) return;
                onShareByEmail({ email: normalizedEmail, permission });
                setEmail("");
                setSelectedEmail(null);
              }}
              disabled={sharingByEmail || !canInvite}
            >
              Enviar
            </Button>
          </div>

          <div className="space-y-3">
            <h3 className="text-title">Pessoas com acesso</h3>
            <div className="rounded-xl border border-border bg-card">
              <div className="flex items-center justify-between px-4 py-3">
                <div className="flex items-center gap-3 min-w-0">
                  <span className="h-9 w-9 rounded-full bg-accent/15 text-accent inline-flex items-center justify-center">
                    <UserRound className="h-4 w-4" />
                  </span>
                  <div className="min-w-0">
                    <p className="font-medium truncate">{currentUser?.full_name || "Você"} (você)</p>
                    <p className="text-sm text-muted-foreground truncate">{currentUser?.email || "-"}</p>
                  </div>
                </div>
                <span className="text-sm text-muted-foreground">Proprietário</span>
              </div>

              {shares.map((share) => (
                <div key={share.id} className="flex items-center justify-between gap-3 px-4 py-3 border-t border-border">
                  <div className="min-w-0">
                    <p className="font-medium truncate">{share.email}</p>
                    <p className="text-sm text-muted-foreground truncate">Convidado por e-mail</p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <Select
                      value={share.permission}
                      onValueChange={(value) => onShareByEmail({ email: share.email, permission: value as "view" | "edit" })}
                      disabled={sharingByEmail}
                    >
                      <SelectTrigger className="h-8 w-[120px]">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="view">Leitor</SelectItem>
                        <SelectItem value="edit">Editor</SelectItem>
                      </SelectContent>
                    </Select>
                    <Button variant="ghost" size="icon" disabled={removingShare} onClick={() => onRemoveShare(share.id)}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              ))}

              {shares.length === 0 && (
                <div className="px-4 py-3 border-t border-border text-sm text-muted-foreground">
                  Nenhum convidado adicional.
                </div>
              )}
            </div>
          </div>

          <div className="space-y-3">
            <h3 className="text-title">Acesso geral</h3>
            <div className="rounded-xl border border-border bg-muted/30 px-4 py-3 flex items-center justify-between gap-3">
              <div className="flex items-center gap-3 min-w-0">
                <span className="h-9 w-9 rounded-full bg-background inline-flex items-center justify-center">
                  {visibility === "private" ? <Lock className="h-4 w-4 text-muted-foreground" /> : <Globe className="h-4 w-4 text-emerald-600" />}
                </span>
                <div className="min-w-0">
                  <p className="font-medium truncate">{visibilityLabel}</p>
                  <p className="text-sm text-muted-foreground">{visibilityDescription}</p>
                </div>
              </div>
              <Select
              value={visibility || "private"}
              onValueChange={(value) => onVisibilityChange(value as "private" | "workspace_view" | "workspace_edit" | "public_view")}
              disabled={loading || updatingVisibility}
            >
                <SelectTrigger className="h-9 w-[210px] bg-background">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                <SelectItem value="private">Restrito</SelectItem>
                <SelectItem value="workspace_view">Todos podem ver</SelectItem>
                <SelectItem value="workspace_edit">Todos podem editar</SelectItem>
                <SelectItem value="public_view">Público (sem login)</SelectItem>
              </SelectContent>
            </Select>
            </div>
          </div>

          <div className="flex items-center justify-between pt-2">
            <Button
              type="button"
              variant="outline"
              className="h-11 rounded-full px-5"
              onClick={async () => {
                await navigator.clipboard.writeText(shareUrl);
                setCopied(true);
                toast({ title: "Link copiado" });
                window.setTimeout(() => setCopied(false), 1800);
              }}
            >
              <Link2 className="h-4 w-4 mr-2" />
              {copied ? "Copiado!" : "Copiar link"}
            </Button>
            <Button type="button" className="h-11 rounded-full px-8" onClick={() => onOpenChange(false)}>
              Concluído
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};

const ViewSection = ({
  section,
  dashboardId,
  delay,
  dataByWidgetId,
  kpiComparisonByWidgetId,
  loading,
  errorMessage,
}: {
  section: DashboardSection;
  dashboardId: string;
  delay: number;
  dataByWidgetId: Record<string, ApiDashboardWidgetDataResponse>;
  kpiComparisonByWidgetId: KpiComparisonMap;
  loading: boolean;
  errorMessage: string | null;
}) => {
  const gridCols = {
    1: "grid-cols-1",
    2: "grid-cols-1 md:grid-cols-2",
    3: "grid-cols-1 md:grid-cols-2 xl:grid-cols-3",
    4: "grid-cols-1 md:grid-cols-2 xl:grid-cols-4",
    5: "grid-cols-1 md:grid-cols-2 xl:grid-cols-5",
    6: "grid-cols-1 md:grid-cols-2 xl:grid-cols-6",
  }[section.columns];

  const layoutByWidgetId = useMemo(() => {
    const mapped: Record<string, { w: number; h: number; x: number; y: number }> = {};
    (section.layout || []).forEach((item) => {
      mapped[item.i] = { w: item.w, h: item.h, x: item.x, y: item.y };
    });
    return mapped;
  }, [section.layout]);

  const orderedWidgets = useMemo(
    () => [...section.widgets].sort((a, b) => {
      const aLayout = layoutByWidgetId[a.id];
      const bLayout = layoutByWidgetId[b.id];
      const aY = aLayout?.y ?? 0;
      const bY = bLayout?.y ?? 0;
      if (aY !== bY) return aY - bY;
      const aX = aLayout?.x ?? 0;
      const bX = bLayout?.x ?? 0;
      if (aX !== bX) return aX - bX;
      return (a.position || 0) - (b.position || 0);
    }),
    [layoutByWidgetId, section.widgets],
  );

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay, duration: 0.35 }}
      data-pdf-section-id={section.id}
    >
      {section.showTitle !== false && section.title && <h3 className="text-heading text-foreground mb-3">{section.title}</h3>}
      <div className={`grid ${gridCols} gap-4`}>
        {orderedWidgets.map((widget) => {
          const props = widget.props || widget.config;
          const layout = layoutByWidgetId[widget.id];
          const width = (layout?.w ?? props.size?.width ?? 1) as WidgetWidth;
          const height = layout ? gridRowsToWidgetHeight(layout.h) : (props.size?.height || 1);
          const isKpiWidget = props.widget_type === "kpi";
          const hasExplicitHeightFromLayout = typeof layout?.h === "number";
          const widgetCardHeightPx = hasExplicitHeightFromLayout ? gridRowsToWidgetCardHeightPx(layout.h) : null;
          const widgetForRender = {
            ...widget,
            props: {
              ...props,
              size: {
                width,
                height,
              },
            },
          };
          widgetForRender.config = widgetForRender.props;

          return (
            <div
              key={widget.id}
              data-pdf-widget-id={widget.id}
              data-pdf-widget-type={widgetForRender.props.widget_type}
              className={`glass-card interactive-card self-start flex flex-col overflow-hidden ${getWidgetWidthClass(section.columns, width)}`}
              style={widgetCardHeightPx ? { height: `${widgetCardHeightPx}px` } : undefined}
            >
              {widgetForRender.props.show_title !== false && (
                <div className="px-4 py-2.5 border-b border-border/50">
                  <h4 className="text-body font-semibold text-foreground truncate">{widget.title || "Sem titulo"}</h4>
                </div>
              )}
              <div className={cn(
                getWidgetPaddingClass(widgetForRender.props.visual_padding),
                "min-h-0 flex-1",
                !hasExplicitHeightFromLayout && (isKpiWidget ? getWidgetHeightClass(height) : getWidgetMinHeightClass(height)),
              )}
              >
                <div className="h-full w-full">
                  <WidgetRenderer
                    widget={widgetForRender}
                    dashboardId={dashboardId}
                    disableFetch
                    heightMultiplier={height as 0.5 | 1 | 2}
                    layoutRows={layout?.h}
                    preloadedData={dataByWidgetId[widget.id]}
                    kpiComparison={kpiComparisonByWidgetId[widget.id]}
                    preloadedLoading={loading}
                    preloadedError={errorMessage}
                  />
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </motion.div>
  );
};
export default DashboardViewPage;



