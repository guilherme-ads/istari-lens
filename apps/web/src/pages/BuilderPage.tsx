import { useState, useCallback, useMemo, useEffect } from "react";
import { useNavigate, useParams, Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { motion } from "framer-motion";
import { Plus, Save, Share2, ChevronLeft, Check, LayoutDashboard, Eye, Pencil, Monitor, Trash2, CalendarIcon, Code2, RefreshCw } from "lucide-react";
import type { DateRange } from "react-day-picker";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Calendar } from "@/components/ui/calendar";
import { useToast } from "@/hooks/use-toast";
import { DashboardCanvas } from "@/components/builder/DashboardCanvas";
import { AddWidgetDialog } from "@/components/builder/AddWidgetDialog";
import { WidgetConfigPanel } from "@/components/builder/WidgetConfigPanel";
import {
  createSection,
  createDefaultWidgetConfig,
  type DashboardSection,
  type DashboardWidget,
  type WidgetType,
} from "@/types/dashboard";
import { useCoreData } from "@/hooks/use-core-data";
import { api, ApiError } from "@/lib/api";
import { getStoredUser } from "@/lib/auth";
import { sectionsToLayoutConfig } from "@/lib/mappers";
import EmptyState from "@/components/shared/EmptyState";
import { cn } from "@/lib/utils";
import ConfirmDialog from "@/components/shared/ConfirmDialog";

type DashboardFilterOp = "eq" | "neq" | "gt" | "lt" | "gte" | "lte" | "contains" | "between" | "relative";
type RelativeDatePreset = "today" | "yesterday" | "last_7_days" | "last_30_days" | "this_year" | "this_month" | "last_month";
type DraftNativeFilter = {
  id: string;
  column: string;
  op: DashboardFilterOp;
  value: string;
  dateValue?: Date;
  dateRange?: DateRange;
  relativePreset?: RelativeDatePreset;
};
type PreparedNativeFilter = {
  column: string;
  op: DashboardFilterOp;
  value: string | string[] | { relative: RelativeDatePreset };
};

const commonOps: Array<{ value: DashboardFilterOp; label: string }> = [
  { value: "eq", label: "=" },
  { value: "neq", label: "!=" },
  { value: "gt", label: ">" },
  { value: "lt", label: "<" },
  { value: "gte", label: ">=" },
  { value: "lte", label: "<=" },
  { value: "contains", label: "contém" },
];

const temporalOps: Array<{ value: DashboardFilterOp; label: string }> = [
  { value: "eq", label: "=" },
  { value: "neq", label: "!=" },
  { value: "gt", label: ">" },
  { value: "lt", label: "<" },
  { value: "gte", label: ">=" },
  { value: "lte", label: "<=" },
  { value: "between", label: "entre datas" },
  { value: "relative", label: "data relativa" },
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
  (["eq", "neq", "gt", "lt", "gte", "lte", "contains", "between", "relative"].includes(value) ? value : "eq") as DashboardFilterOp;

const BuilderPage = () => {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { datasetId, dashboardId } = useParams<{ datasetId: string; dashboardId?: string }>();
  const { toast } = useToast();
  const { datasets, views, dashboards, isLoading, isError, errorMessage } = useCoreData();

  const dataset = useMemo(() => datasets.find((item) => item.id === datasetId), [datasets, datasetId]);
  const view = useMemo(() => (dataset ? views.find((item) => item.id === dataset.viewId) : undefined), [dataset, views]);
  const existingDashboard = useMemo(() => dashboards.find((item) => item.id === dashboardId), [dashboards, dashboardId]);
  const isEditingExistingDashboard = !!dashboardId;
  const canEditExistingDashboard = !!existingDashboard && existingDashboard.accessLevel !== "view";

  const [activeDashboardId, setActiveDashboardId] = useState<string | undefined>(dashboardId);
  const [dashboardTitle, setDashboardTitle] = useState("Novo Dashboard");
  const [sections, setSections] = useState<DashboardSection[]>(() => {
    const section = createSection();
    section.title = "Visao Geral";
    return [section];
  });
  const [nativeFilters, setNativeFilters] = useState<DraftNativeFilter[]>([
    { id: `nf-${Date.now()}`, column: "", op: "eq", value: "" },
  ]);

  useEffect(() => {
    if (!existingDashboard) return;
    setActiveDashboardId(existingDashboard.id);
    setDashboardTitle(existingDashboard.title);
    setSections(existingDashboard.sections.length > 0 ? existingDashboard.sections : sections);
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
            value: typeof filter.value === "string" ? filter.value : "",
            dateValue: !isBetween && !relativePreset ? parseDate(filter.value) : undefined,
            dateRange: isBetween ? { from, to } : undefined,
            relativePreset: relativePreset || "last_7_days",
          };
        })
        : [{ id: `nf-${Date.now()}`, column: "", op: "eq", value: "" }],
    );
  }, [existingDashboard]);

  const viewColumnsQuery = useQuery({
    queryKey: ["view-columns", view?.schema, view?.name],
    queryFn: () => api.getViewColumns(view!.name, view!.schema),
    enabled: !!view,
  });

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
  const [syncingNativeFilters, setSyncingNativeFilters] = useState(false);
  const isAdmin = !!getStoredUser()?.is_admin;
  const preparedNativeFilters = useMemo<PreparedNativeFilter[]>(() => {
    const temporalColumnNames = new Set((viewColumnsQuery.data || []).filter((column) => column.normalized_type === "temporal").map((column) => column.column_name));
    const parsedFilters: PreparedNativeFilter[] = [];
    for (const filter of nativeFilters) {
      if (!filter.column) continue;
      const isTemporal = temporalColumnNames.has(filter.column);
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
        parsedFilters.push({ column: filter.column, op: "between", value: [dateToApi(filter.dateRange.from), dateToApi(filter.dateRange.to)] });
        continue;
      }
      if (isTemporal) {
        if (!filter.dateValue) continue;
        parsedFilters.push({ column: filter.column, op: filter.op, value: dateToApi(filter.dateValue) });
        continue;
      }
      if (!filter.value.trim()) continue;
      parsedFilters.push({ column: filter.column, op: filter.op, value: filter.value });
    }
    return parsedFilters;
  }, [nativeFilters, viewColumnsQuery.data]);
  const preparedNativeFiltersKey = useMemo(() => JSON.stringify(preparedNativeFilters), [preparedNativeFilters]);

  useEffect(() => {
    if (!activeDashboardId) return;
    const debounceId = window.setTimeout(async () => {
      try {
        setSyncingNativeFilters(true);
        await api.updateDashboard(Number(activeDashboardId), { native_filters: preparedNativeFilters });
        await queryClient.invalidateQueries({ queryKey: ["widget-data", activeDashboardId], refetchType: "active" });
      } catch {
        // Intentionally silent to avoid noisy UX while typing filters.
      } finally {
        setSyncingNativeFilters(false);
      }
    }, 400);

    return () => window.clearTimeout(debounceId);
  }, [activeDashboardId, preparedNativeFiltersKey, preparedNativeFilters, queryClient]);

  const upsertDashboard = useMutation({
    mutationFn: async () => {
      if (!datasetId) throw new Error("Dataset invalido");
      const payload = {
        dataset_id: Number(datasetId),
        name: dashboardTitle,
        description: null,
        is_active: true,
        layout_config: sectionsToLayoutConfig(sections),
        native_filters: preparedNativeFilters,
      };

      if (activeDashboardId) {
        return api.updateDashboard(Number(activeDashboardId), {
          name: payload.name,
          description: null,
          is_active: payload.is_active,
          layout_config: payload.layout_config,
          native_filters: payload.native_filters,
        });
      }
      return api.createDashboard(payload);
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

  const ensureDashboard = useCallback(async (): Promise<string> => {
    if (activeDashboardId) return activeDashboardId;
    const created = await api.createDashboard({
      dataset_id: Number(datasetId),
      name: dashboardTitle,
      description: null,
      is_active: true,
      layout_config: sectionsToLayoutConfig(sections),
      native_filters: preparedNativeFilters,
    });
    const nextId = String(created.id);
    setActiveDashboardId(nextId);
    await queryClient.invalidateQueries({ queryKey: ["dashboards"] });
    navigate(`/datasets/${datasetId}/builder/${created.id}`);
    return nextId;
  }, [activeDashboardId, dashboardTitle, datasetId, navigate, preparedNativeFilters, queryClient, sections]);

  const persistLayout = useCallback(async (dashboardIdToSave: string, sectionsToSave: DashboardSection[]) => {
    await api.updateDashboard(Number(dashboardIdToSave), {
      layout_config: sectionsToLayoutConfig(sectionsToSave),
    });
  }, []);

  const handleAddWidget = useCallback((sectionId: string) => {
    setTargetSectionId(sectionId);
    setAddDialogOpen(true);
  }, []);

  const handleWidgetCreated = useCallback(async (widgetType: WidgetType) => {
    if (!targetSectionId || !dataset || !view) return;
    if (!viewColumnsQuery.data || viewColumnsQuery.data.length === 0) {
      toast({ title: "Não foi possivel carregar colunas da tabela", variant: "destructive" });
      return;
    }

    const dashboardIdToUse = await ensureDashboard();
    const viewName = `${view.schema}.${view.name}`;
    const defaultConfig = createDefaultWidgetConfig({
      type: widgetType,
      viewName,
      columns: viewColumnsQuery.data.map((column) => ({ name: column.column_name, type: column.normalized_type })),
    });

    try {
      const created = await api.createDashboardWidget(Number(dashboardIdToUse), {
        widget_type: widgetType,
        title: `${widgetType.toUpperCase()} - ${view.name}`,
        position: 0,
        config: defaultConfig,
        config_version: 1,
      });

      const mappedWidget: DashboardWidget = {
        id: String(created.id),
        title: created.title || "",
        position: created.position,
        configVersion: created.config_version || 1,
        config: created.query_config as unknown as DashboardWidget["config"],
      };

      const nextSections = sections.map((section) =>
        section.id === targetSectionId ? { ...section, widgets: [...section.widgets, mappedWidget] } : section,
      );
      setSections(nextSections);
      await persistLayout(dashboardIdToUse, nextSections);
      await queryClient.invalidateQueries({ queryKey: ["dashboards"] });
      toast({ title: "Widget adicionado" });
    } catch (error) {
      const message = error instanceof ApiError ? JSON.stringify(error.detail || error.message) : "Falha ao criar widget";
      toast({ title: "Erro ao criar widget", description: message, variant: "destructive" });
    }
  }, [dataset, ensureDashboard, persistLayout, queryClient, sections, targetSectionId, toast, view, viewColumnsQuery.data]);

  const handleDuplicateWidgetFromCard = useCallback(async (widget: DashboardWidget) => {
    if (!activeDashboardId) return;
    try {
      const created = await api.createDashboardWidget(Number(activeDashboardId), {
        widget_type: widget.config.widget_type,
        title: widget.title ? `${widget.title} (copia)` : undefined,
        position: 0,
        config: JSON.parse(JSON.stringify(widget.config)),
        config_version: widget.configVersion || 1,
      });

      const duplicatedWidget: DashboardWidget = {
        id: String(created.id),
        title: created.title || "",
        position: created.position,
        configVersion: created.config_version || 1,
        config: created.query_config as unknown as DashboardWidget["config"],
      };

      const nextSections = sections.map((section) => {
        const index = section.widgets.findIndex((item) => item.id === widget.id);
        if (index === -1) return section;
        const widgets = [...section.widgets];
        widgets.splice(index + 1, 0, duplicatedWidget);
        return { ...section, widgets };
      });

      setSections(nextSections);
      await persistLayout(activeDashboardId, nextSections);
      await queryClient.invalidateQueries({ queryKey: ["dashboards"] });
      toast({ title: "Widget duplicado" });
    } catch (error) {
      const message = error instanceof ApiError ? String(error.detail || error.message) : "Falha ao duplicar widget";
      toast({ title: "Erro ao duplicar widget", description: message, variant: "destructive" });
    }
  }, [activeDashboardId, persistLayout, queryClient, sections, toast]);

  const handleEditWidget = useCallback((widget: DashboardWidget) => {
    setEditingWidget(widget);
    const hostSection = sections.find((section) => section.widgets.some((item) => item.id === widget.id));
    setEditingWidgetSectionColumns(hostSection?.columns || 2);
    setConfigOpen(true);
  }, [sections]);

  const handleSaveWidget = useCallback(async (updated: DashboardWidget) => {
    if (!activeDashboardId) return;
    try {
      const response = await api.updateDashboardWidget(Number(activeDashboardId), Number(updated.id), {
        title: updated.title,
        widget_type: updated.config.widget_type,
        config: updated.config,
        config_version: updated.configVersion,
      });

      const persistedWidget: DashboardWidget = {
        id: String(response.id),
        title: response.title || "",
        position: response.position,
        configVersion: response.config_version || 1,
        config: response.query_config as unknown as DashboardWidget["config"],
      };

      const nextSections = sections.map((section) => ({
        ...section,
        widgets: section.widgets.map((item) => (item.id === persistedWidget.id ? persistedWidget : item)),
      }));
      setSections(nextSections);
      setEditingWidget(persistedWidget);
      await persistLayout(activeDashboardId, nextSections);
      await queryClient.invalidateQueries({ queryKey: ["dashboards"] });
      toast({ title: "Widget atualizado" });
    } catch (error) {
      const message = error instanceof ApiError ? JSON.stringify(error.detail || error.message) : "Falha ao salvar widget";
      toast({ title: "Erro ao salvar widget", description: message, variant: "destructive" });
    }
  }, [activeDashboardId, persistLayout, queryClient, sections, toast]);

  const handleDeleteWidget = useCallback(async () => {
    if (!editingWidget || !activeDashboardId) return;
    try {
      await api.deleteDashboardWidget(Number(activeDashboardId), Number(editingWidget.id));
      const nextSections = sections.map((section) => ({
        ...section,
        widgets: section.widgets.filter((item) => item.id !== editingWidget.id),
      }));
      setSections(nextSections);
      await persistLayout(activeDashboardId, nextSections);
      setConfigOpen(false);
      setEditingWidget(null);
      await queryClient.invalidateQueries({ queryKey: ["dashboards"] });
      toast({ title: "Widget removido" });
    } catch (error) {
      const message = error instanceof ApiError ? String(error.detail || error.message) : "Falha ao remover widget";
      toast({ title: "Erro ao remover widget", description: message, variant: "destructive" });
    }
  }, [activeDashboardId, editingWidget, persistLayout, queryClient, sections, toast]);

  const handleToggleWidgetTitle = useCallback(async (widget: DashboardWidget) => {
    if (!activeDashboardId) return;
    const nextShowTitle = widget.config.show_title === false;
    const updatedWidget: DashboardWidget = {
      ...widget,
      config: {
        ...widget.config,
        show_title: nextShowTitle,
      },
    };
    await handleSaveWidget(updatedWidget);
  }, [activeDashboardId, handleSaveWidget]);

  const handleDeleteWidgetFromCard = useCallback(async (widget: DashboardWidget) => {
    if (!activeDashboardId) return;
    try {
      await api.deleteDashboardWidget(Number(activeDashboardId), Number(widget.id));
      const nextSections = sections.map((section) => ({
        ...section,
        widgets: section.widgets.filter((item) => item.id !== widget.id),
      }));
      setSections(nextSections);
      await persistLayout(activeDashboardId, nextSections);
      if (editingWidget?.id === widget.id) {
        setConfigOpen(false);
        setEditingWidget(null);
      }
      await queryClient.invalidateQueries({ queryKey: ["dashboards"] });
      toast({ title: "Widget removido" });
    } catch (error) {
      const message = error instanceof ApiError ? String(error.detail || error.message) : "Falha ao remover widget";
      toast({ title: "Erro ao remover widget", description: message, variant: "destructive" });
    }
  }, [activeDashboardId, editingWidget?.id, persistLayout, queryClient, sections, toast]);

  const handleAddSection = useCallback((afterIndex?: number) => {
    const section = createSection();
    section.title = `Secao ${sections.length + 1}`;
    setSections((prev) => {
      if (afterIndex === undefined || afterIndex < 0 || afterIndex >= prev.length) {
        return [...prev, section];
      }
      const next = [...prev];
      next.splice(afterIndex, 0, section);
      return next;
    });
  }, [sections.length]);

  const handleShare = async () => {
    const targetDashboardId = activeDashboardId || dashboardId;
    if (!datasetId || !targetDashboardId) return;
    const shareUrl = `${window.location.origin}/presentation/datasets/${datasetId}/dashboard/${targetDashboardId}`;
    await navigator.clipboard.writeText(shareUrl);
    setShareSuccess(true);
    toast({ title: "Link copiado" });
    setTimeout(() => setShareSuccess(false), 2000);
  };
  const handleRefreshWidgetData = useCallback(async () => {
    const targetId = activeDashboardId || dashboardId;
    if (!targetId) {
      toast({ title: "Salve o dashboard para atualizar os dados", variant: "destructive" });
      return;
    }

    setRefreshingData(true);
    try {
      await queryClient.invalidateQueries({ queryKey: ["widget-data", targetId], refetchType: "active" });
      toast({ title: "Dados atualizados" });
    } catch {
      toast({ title: "Falha ao atualizar dados", variant: "destructive" });
    } finally {
      setRefreshingData(false);
    }
  }, [activeDashboardId, dashboardId, queryClient, toast]);

  const widgetCount = sections.reduce((total, section) => total + section.widgets.length, 0);
  const targetDashboardId = activeDashboardId || dashboardId;
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

  if (!dataset || !view) {
    return (
      <div className="bg-background flex flex-col flex-1">
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center space-y-3">
            <h2 className="text-lg font-semibold text-foreground">Dataset não encontrado</h2>
            <p className="text-sm text-muted-foreground">O dataset solicitado não existe.</p>
            <Button variant="outline" onClick={() => navigate("/datasets")}>
              <ChevronLeft className="h-4 w-4 mr-1" /> Voltar aos Datasets
            </Button>
          </div>
        </div>
      </div>
    );
  }

  if (isEditingExistingDashboard && !existingDashboard) {
    return (
      <div className="bg-background flex flex-col flex-1">
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center space-y-3">
            <h2 className="text-lg font-semibold text-foreground">Dashboard não encontrado</h2>
            <p className="text-sm text-muted-foreground">Você não tem permissão para editar este dashboard ou ele não existe.</p>
            <Button variant="outline" onClick={() => navigate(datasetId ? `/datasets/${datasetId}/dashboard/${dashboardId}` : "/dashboards")}>
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
            <h2 className="text-lg font-semibold text-foreground">Acesso negado</h2>
            <p className="text-sm text-muted-foreground">Você tem acesso somente de visualização para este dashboard.</p>
            <Button variant="outline" onClick={() => navigate(datasetId ? `/datasets/${datasetId}/dashboard/${dashboardId}` : "/dashboards")}>
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
            <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" onClick={() => navigate("/datasets")}>
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <div className="min-w-0">
              <div className="flex items-center gap-1.5">
                <Link to="/datasets" className="text-xs text-muted-foreground hover:text-foreground transition-colors hidden sm:inline">
                  Datasets
                </Link>
                <span className="text-xs text-muted-foreground hidden sm:inline">/</span>
                <span className="text-xs text-muted-foreground hidden sm:inline truncate max-w-[120px]">
                  {dataset.name}
                </span>
                <span className="text-xs text-muted-foreground hidden sm:inline">/</span>
                <span className="text-sm font-semibold text-foreground truncate">{dashboardTitle}</span>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2 text-xs text-muted-foreground shrink-0">
            <span className="hidden sm:inline">
              {view.schema}.{view.name} . {widgetCount} {widgetCount === 1 ? "widget" : "widgets"}
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
                <Button size="sm" variant="outline" className="h-8 text-xs" onClick={() => setPreviewMode((prev) => !prev)}>
                  {previewMode ? <Pencil className="h-3 w-3 sm:mr-1" /> : <Eye className="h-3 w-3 sm:mr-1" />}
                  <span className="hidden sm:inline">{previewMode ? "Editar" : "Preview"}</span>
                </Button>
              </TooltipTrigger>
              <TooltipContent className="text-xs">Visualizar dashboard sem modo de edicao</TooltipContent>
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
                  <span className="hidden sm:inline">{refreshingData ? "Atualizando..." : "Atualizar dados"}</span>
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
                    <span className="hidden sm:inline">Dev SQL</span>
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
                      disabled={!datasetId || !(activeDashboardId || dashboardId)}
                      onClick={() => navigate(`/presentation/datasets/${datasetId}/dashboard/${activeDashboardId || dashboardId}`)}
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
              <label className="text-xs font-semibold text-muted-foreground">Titulo do dashboard</label>
              <Input
                value={dashboardTitle}
                onChange={(e) => setDashboardTitle(e.target.value)}
                className="h-9 mt-1 text-sm font-semibold"
                placeholder="Titulo do dashboard"
              />
            </div>
            <div className="lg:w-2/3">
              <Label className="text-xs font-semibold text-muted-foreground">Filtro nativo (oculto no front)</Label>
              <div className="mt-2 space-y-2">
                {nativeFilters.map((filter, filterIndex) => {
                  const selectedColumn = (viewColumnsQuery.data || []).find((column) => column.column_name === filter.column);
                  const isTemporal = selectedColumn?.normalized_type === "temporal";
                  const operatorOptions = isTemporal ? temporalOps : commonOps;
                  const rowLayoutClass = isTemporal
                    ? "grid grid-cols-1 md:grid-cols-[minmax(180px,1fr)_120px_minmax(200px,1fr)_auto] gap-2 items-center"
                    : "grid grid-cols-1 md:grid-cols-[minmax(180px,1fr)_120px_minmax(220px,1fr)_auto] gap-2 items-center";
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
                          {(viewColumnsQuery.data || []).map((column) => (
                            <SelectItem key={column.column_name} value={column.column_name}>{column.column_name}</SelectItem>
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

                      {!isTemporal && (
                        <Input
                          className="h-8 text-xs"
                          placeholder="Valor"
                          value={filter.value}
                          onChange={(e) =>
                            setNativeFilters((prev) => prev.map((item) => item.id === filter.id ? { ...item, value: e.target.value } : item))}
                          disabled={!filter.column}
                        />
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

                      {isTemporal && filter.op !== "between" && filter.op !== "relative" && (
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
                      onClick={() => setNativeFilters((prev) => [...prev, { id: `nf-${Date.now()}-${Math.random()}`, column: "", op: "eq", value: "" }])}
                    >
                      <Plus className="h-3.5 w-3.5 mr-1.5" /> Adicionar filtro nativo
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="h-8 text-xs"
                      onClick={() => setNativeFilters([{ id: `nf-${Date.now()}-${Math.random()}`, column: "", op: "eq", value: "" }])}
                    >
                      Limpar filtros
                    </Button>
                  </div>
                  <span className="text-[11px] text-muted-foreground">
                    {syncingNativeFilters ? "Atualizando dados..." : "Aplicados antes de qualquer filtro visível"}
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>

        {isAdmin && devModeOpen && (
          <div className="glass-card mb-6 p-4 space-y-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold text-foreground">Dev Mode QuerySpec</h3>
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
            <h2 className="text-lg font-semibold text-foreground">Comece seu dashboard</h2>
            <p className="text-sm text-muted-foreground text-center max-w-md">
              Adicione secoes e widgets para montar seu dashboard usando dados de <strong>{view.schema}.{view.name}</strong>.
            </p>
            <Button className="bg-accent text-accent-foreground hover:bg-accent/90" onClick={() => handleAddSection()}>
              <Plus className="h-4 w-4 mr-1.5" /> Criar primeira secao
            </Button>
          </motion.div>
        ) : (
          <DashboardCanvas
            dashboardId={targetDashboardId}
            sections={sections}
            onSectionsChange={setSections}
            onAddWidget={handleAddWidget}
            onEditWidget={handleEditWidget}
            onDeleteWidget={handleDeleteWidgetFromCard}
            onDuplicateWidget={handleDuplicateWidgetFromCard}
            onToggleWidgetTitle={handleToggleWidgetTitle}
            onAddSection={handleAddSection}
            readOnly={previewMode}
          />
        )}
      </div>

      <AddWidgetDialog
        open={addDialogOpen}
        onOpenChange={setAddDialogOpen}
        onAdd={handleWidgetCreated}
        viewLabel={`${view.schema}.${view.name}`}
      />
      <WidgetConfigPanel
        widget={editingWidget}
        dashboardWidgets={sections.flatMap((section) => section.widgets)}
        view={view}
        sectionColumns={editingWidgetSectionColumns}
        open={configOpen}
        onClose={() => setConfigOpen(false)}
        onSave={handleSaveWidget}
        onDelete={handleDeleteWidget}
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
