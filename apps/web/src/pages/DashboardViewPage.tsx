import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams, Link, useLocation } from "react-router-dom";
import { motion } from "framer-motion";
import { ChevronLeft, Pencil, Share2, Database, Plus, Trash2, CalendarIcon, Monitor, FileDown, X, SlidersHorizontal, Link2, Globe, Lock, UserRound } from "lucide-react";
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
import type { DashboardSection } from "@/types/dashboard";
import { useCoreData } from "@/hooks/use-core-data";
import { api } from "@/lib/api";
import { exportDashboardToPdf } from "@/lib/dashboard-pdf";
import EmptyState from "@/components/shared/EmptyState";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import { getStoredUser } from "@/lib/auth";

type FilterOp = "eq" | "neq" | "gt" | "lt" | "gte" | "lte" | "contains" | "between";
type DraftGlobalFilter = {
  id: string;
  column: string;
  op: FilterOp;
  value: string;
  dateValue?: Date;
  dateRange?: DateRange;
};
type AppliedGlobalFilter = {
  column: string;
  op: FilterOp;
  value: string | string[];
};

const commonOps: Array<{ value: FilterOp; label: string }> = [
  { value: "eq", label: "=" },
  { value: "neq", label: "!=" },
  { value: "gt", label: ">" },
  { value: "lt", label: "<" },
  { value: "gte", label: ">=" },
  { value: "lte", label: "<=" },
  { value: "contains", label: "contém" },
];

const temporalOps: Array<{ value: FilterOp; label: string }> = [
  { value: "eq", label: "=" },
  { value: "neq", label: "!=" },
  { value: "gt", label: ">" },
  { value: "lt", label: "<" },
  { value: "gte", label: ">=" },
  { value: "lte", label: "<=" },
  { value: "between", label: "entre datas" },
];

const formatDateBR = (date: Date) =>
  new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" }).format(date);

const dateToApi = (date: Date) => date.toISOString().slice(0, 10);

const operatorLabel: Record<FilterOp, string> = {
  eq: "=",
  neq: "!=",
  gt: ">",
  lt: "<",
  gte: ">=",
  lte: "<=",
  contains: "contém",
  between: "entre",
};

const appliedFilterSignature = (filter: AppliedGlobalFilter) =>
  `${filter.column}|${filter.op}|${JSON.stringify(filter.value)}`;

const appliedFilterLabel = (filter: AppliedGlobalFilter) => {
  const valueLabel = Array.isArray(filter.value) ? filter.value.join(" .. ") : String(filter.value);
  return `${filter.column} ${operatorLabel[filter.op]} ${valueLabel}`;
};

const getWidgetWidthClass = (sectionColumns: 1 | 2 | 3 | 4, width: 1 | 2 | 3 | 4) => {
  const clampedWidth = Math.min(width, sectionColumns) as 1 | 2 | 3 | 4;
  if (sectionColumns === 1) return "col-span-1";
  if (sectionColumns === 2) return clampedWidth >= 2 ? "md:col-span-2" : "md:col-span-1";
  if (sectionColumns === 3) {
    if (clampedWidth >= 3) return "md:col-span-2 lg:col-span-3";
    if (clampedWidth === 2) return "md:col-span-2 lg:col-span-2";
    return "md:col-span-1 lg:col-span-1";
  }
  if (clampedWidth >= 4) return "md:col-span-2 lg:col-span-4";
  if (clampedWidth === 3) return "md:col-span-2 lg:col-span-3";
  if (clampedWidth === 2) return "md:col-span-2 lg:col-span-2";
  return "md:col-span-1 lg:col-span-1";
};

const DashboardViewPage = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { datasetId, dashboardId } = useParams<{ datasetId: string; dashboardId: string }>();
  const { datasets, views, dashboards, hasToken, isLoading, isError, errorMessage } = useCoreData();
  const isPresentationMode = location.pathname.startsWith("/presentation/");

  const dataset = useMemo(() => datasets.find((item) => item.id === datasetId), [datasets, datasetId]);
  const dashboard = useMemo(() => dashboards.find((item) => item.id === dashboardId), [dashboards, dashboardId]);
  const canEditDashboard = (dashboard?.accessLevel || "view") !== "view";
  const view = useMemo(() => (dataset ? views.find((item) => item.id === dataset.viewId) : undefined), [dataset, views]);
  const [draftFilters, setDraftFilters] = useState<DraftGlobalFilter[]>([
    { id: `gf-${Date.now()}`, column: "", op: "eq", value: "" },
  ]);
  const [appliedFilters, setAppliedFilters] = useState<AppliedGlobalFilter[]>([]);
  const [shareOpen, setShareOpen] = useState(false);
  const sections = dashboard?.sections || [];
  const widgetCount = sections.reduce((total, section) => total + section.widgets.length, 0);
  const widgets = useMemo(() => sections.flatMap((section) => section.widgets), [sections]);

  const preparedGlobalFilters = useMemo<AppliedGlobalFilter[]>(() => {
    const temporalColumnNames = new Set((view?.columns || []).filter((column) => column.type === "temporal").map((column) => column.name));
    const parsedFilters: AppliedGlobalFilter[] = [];
    for (const filter of draftFilters) {
      if (!filter.column) continue;
      const isTemporal = temporalColumnNames.has(filter.column);
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
      if (!filter.value.trim()) continue;
      parsedFilters.push({
        column: filter.column,
        op: filter.op,
        value: filter.value,
      });
    }
    return parsedFilters;
  }, [draftFilters, view?.columns]);

  const widgetsDataQuery = useQuery({
    queryKey: [
      "dashboard-widget-data",
      dashboardId,
      widgets.map((widget) => widget.id).join(","),
      JSON.stringify(appliedFilters),
    ],
    queryFn: () =>
      api.getDashboardWidgetsData(
        Number(dashboardId),
        widgets.map((widget) => Number(widget.id)),
        appliedFilters,
      ),
    enabled: hasToken && !!dashboardId && widgets.length > 0,
  });

  const widgetDataById = useMemo(() => {
    const mapped: Record<string, { columns: string[]; rows: Record<string, unknown>[]; row_count: number }> = {};
    (widgetsDataQuery.data?.results || []).forEach((result) => {
      mapped[String(result.widget_id)] = {
        columns: result.columns,
        rows: result.rows,
        row_count: result.row_count,
      };
    });
    return mapped;
  }, [widgetsDataQuery.data]);

  const previewErrorMessage = widgetsDataQuery.isError
    ? (widgetsDataQuery.error as Error).message || "Falha ao carregar dados"
    : null;
  const sharingQuery = useQuery({
    queryKey: ["dashboard-sharing", dashboardId],
    queryFn: () => api.getDashboardSharing(Number(dashboardId)),
    enabled: shareOpen && !!dashboardId && !!dashboard?.isOwner,
  });

  const updateVisibilityMutation = useMutation({
    mutationFn: (visibility: "private" | "workspace_view" | "workspace_edit") =>
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
  const handleExportPdf = () => {
    exportDashboardToPdf({
      dashboardTitle: dashboard.title,
      datasetLabel: dataset?.name,
      sections: dashboard.sections,
      dataByWidgetId: widgetDataById,
      appliedFilters,
    });
  };
  const removeAppliedFilter = (filter: AppliedGlobalFilter) => {
    const signature = appliedFilterSignature(filter);
    setAppliedFilters((prev) => prev.filter((item) => appliedFilterSignature(item) !== signature));
    setDraftFilters((prev) => {
      let removed = false;
      return prev.filter((item) => {
        if (removed || !item.column) return true;
        const selectedColumn = (view?.columns || []).find((column) => column.name === item.column);
        const isTemporal = selectedColumn?.type === "temporal";
        let normalized: AppliedGlobalFilter | null = null;
        if (isTemporal && item.op === "between" && item.dateRange?.from && item.dateRange?.to) {
          normalized = { column: item.column, op: "between", value: [dateToApi(item.dateRange.from), dateToApi(item.dateRange.to)] };
        } else if (isTemporal && item.dateValue) {
          normalized = { column: item.column, op: item.op, value: dateToApi(item.dateValue) };
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

  if (!hasToken) {
    return (
      <div className="bg-background min-h-screen flex flex-col">
        <main className="container py-8 flex-1 flex items-center justify-center">
          <EmptyState
            icon={<Database className="h-5 w-5" />}
            title="Sessão necessaria"
            description="Para abrir este dashboard em modo apresentação, faca login novamente."
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

  if (isError) {
    return (
      <div className="bg-background min-h-screen">
        <main className="container py-6">
          <EmptyState icon={<Database className="h-5 w-5" />} title="Erro ao carregar dashboard" description={errorMessage} />
        </main>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="bg-background min-h-screen">
        <main className="container py-6">
          <EmptyState icon={<Database className="h-5 w-5" />} title="Carregando dashboard" description="Aguarde enquanto buscamos os dados." />
        </main>
      </div>
    );
  }

  if (!dataset || !dashboard) {
    return (
      <div className="bg-background min-h-screen flex flex-col flex-1">
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center space-y-3">
            <h2 className="text-lg font-semibold text-foreground">Dashboard não encontrado</h2>
            <Button variant="outline" onClick={() => navigate(datasetId ? `/datasets/${datasetId}` : "/datasets")}>
              <ChevronLeft className="h-4 w-4 mr-1" /> Voltar
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-background min-h-screen flex flex-col flex-1">
      {!isPresentationMode && <div className="sticky top-12 z-40 border-b border-border bg-card/90 backdrop-blur-sm print:hidden">
        <div className="container flex items-center justify-between h-12 gap-4">
          <div className="flex items-center gap-2 min-w-0">
            <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" onClick={() => navigate(`/datasets/${datasetId}`)}>
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <div className="flex items-center gap-1.5 min-w-0 text-xs">
              <Link to="/datasets" className="text-muted-foreground hover:text-foreground transition-colors hidden sm:inline">
                Datasets
              </Link>
              <span className="text-muted-foreground hidden sm:inline">/</span>
              <Link to={`/datasets/${datasetId}`} className="text-muted-foreground hover:text-foreground transition-colors hidden sm:inline truncate max-w-[120px]">
                {dataset.name}
              </Link>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {view && (
              <span className="text-xs text-muted-foreground hidden sm:inline">
                <Database className="h-3 w-3 inline mr-1" />
                {view.schema}.{view.name}
              </span>
            )}
            <div className="h-4 w-px bg-border hidden sm:block" />
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8 text-xs"
                  onClick={() => navigate(`/datasets/${datasetId}/builder/${dashboardId}`)}
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
                  onClick={() => navigate(`/presentation/datasets/${datasetId}/dashboard/${dashboardId}`)}
                >
                  <Monitor className="h-3 w-3 sm:mr-1" />
                  <span className="hidden sm:inline">Apresentação</span>
                </Button>
              </TooltipTrigger>
              <TooltipContent className="text-xs">Abrir modo apresentação</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button size="sm" variant="outline" className="h-8 text-xs" onClick={handleExportPdf}>
                  <FileDown className="h-3 w-3 sm:mr-1" />
                  <span className="hidden sm:inline">Exportar PDF</span>
                </Button>
              </TooltipTrigger>
              <TooltipContent className="text-xs">Exportar dashboard em PDF</TooltipContent>
            </Tooltip>
          </div>
        </div>
      </div>}

      <div className="flex-1 container py-6">
        <div className="mb-6 py-1">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
            <div className="min-w-0 lg:w-[28%]">
              <h1 className="text-2xl font-extrabold text-foreground truncate">{dashboard.title}</h1>
              <p className="text-xs text-muted-foreground mt-1">Identificador principal do dashboard</p>
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
                      const selectedColumn = (view?.columns || []).find((column) => column.name === filter.column);
                      const isTemporal = selectedColumn?.type === "temporal";
                      const operatorOptions = isTemporal ? temporalOps : commonOps;
                      return (
                        <div key={filter.id} className="grid grid-cols-1 md:grid-cols-[1fr_150px_1fr_auto] gap-2 items-center">
                          <Select
                            value={filter.column || "__none__"}
                            onValueChange={(value) =>
                              setDraftFilters((prev) => prev.map((item) => item.id === filter.id
                                ? { ...item, column: value === "__none__" ? "" : value, op: "eq", value: "", dateValue: undefined, dateRange: undefined }
                                : item))}
                          >
                            <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="Coluna" /></SelectTrigger>
                            <SelectContent>
                              <SelectItem value="__none__">Sem coluna</SelectItem>
                              {(view?.columns || []).map((column) => (
                                <SelectItem key={column.name} value={column.name}>{column.name}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          <Select
                            value={filter.op}
                            onValueChange={(value) =>
                              setDraftFilters((prev) => prev.map((item) => item.id === filter.id
                                ? { ...item, op: value as FilterOp, value: "", dateValue: undefined, dateRange: undefined }
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
                                setDraftFilters((prev) => prev.map((item) => item.id === filter.id ? { ...item, value: e.target.value } : item))}
                              disabled={!filter.column}
                            />
                          )}

                          {isTemporal && filter.op !== "between" && (
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
                            className="h-8 w-8 text-destructive hover:text-destructive"
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
            <Button variant="outline" onClick={() => navigate(`/datasets/${datasetId}/builder/${dashboardId}`)} disabled={!canEditDashboard}>
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
          shareUrl={`${window.location.origin}/presentation/datasets/${datasetId}/dashboard/${dashboardId}`}
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
  visibility?: "private" | "workspace_view" | "workspace_edit";
  shares: Array<{ id: number; email: string; permission: "view" | "edit" }>;
  loading: boolean;
  updatingVisibility: boolean;
  sharingByEmail: boolean;
  removingShare: boolean;
  onVisibilityChange: (visibility: "private" | "workspace_view" | "workspace_edit") => void;
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
      : "Restrito";
  const visibilityDescription = visibility === "workspace_edit"
    ? "Todas as pessoas do ambiente podem abrir e editar."
    : visibility === "workspace_view"
      ? "Todas as pessoas do ambiente podem abrir e visualizar."
      : "Somente pessoas convidadas podem abrir este dashboard.";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl p-0 overflow-hidden">
        <DialogHeader className="px-6 pt-6">
          <DialogTitle className="text-3xl font-semibold tracking-tight">Compartilhar "{dashboardTitle}"</DialogTitle>
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
            <h3 className="text-lg font-semibold">Pessoas com acesso</h3>
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
            <h3 className="text-lg font-semibold">Acesso geral</h3>
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
                onValueChange={(value) => onVisibilityChange(value as "private" | "workspace_view" | "workspace_edit")}
                disabled={loading || updatingVisibility}
              >
                <SelectTrigger className="h-9 w-[210px] bg-background">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="private">Restrito</SelectItem>
                  <SelectItem value="workspace_view">Todos podem ver</SelectItem>
                  <SelectItem value="workspace_edit">Todos podem editar</SelectItem>
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
  loading,
  errorMessage,
}: {
  section: DashboardSection;
  dashboardId: string;
  delay: number;
  dataByWidgetId: Record<string, { columns: string[]; rows: Record<string, unknown>[]; row_count: number }>;
  loading: boolean;
  errorMessage: string | null;
}) => {
  const gridCols = {
    1: "grid-cols-1",
    2: "grid-cols-1 md:grid-cols-2",
    3: "grid-cols-1 md:grid-cols-2 lg:grid-cols-3",
    4: "grid-cols-1 md:grid-cols-2 lg:grid-cols-4",
  }[section.columns];

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay, duration: 0.35 }}
      data-pdf-section-id={section.id}
    >
      {section.showTitle !== false && section.title && <h3 className="text-sm font-semibold text-foreground mb-3">{section.title}</h3>}
      <div className={`grid ${gridCols} gap-4`}>
        {section.widgets.map((widget) => (
          <div
            key={widget.id}
            data-pdf-widget-id={widget.id}
            data-pdf-widget-type={widget.config.widget_type}
            className={`glass-card self-start flex flex-col overflow-hidden ${getWidgetWidthClass(section.columns, widget.config.size?.width || 1)}`}
          >
            {widget.config.show_title !== false && (
              <div className="px-4 py-2.5 border-b border-border/50">
                <h4 className="text-sm font-semibold text-foreground truncate">{widget.title || "Sem título"}</h4>
              </div>
            )}
            <div className={`p-3 flex items-center justify-center ${widget.config.size?.height === 0.5 ? "min-h-[100px]" : "min-h-[180px]"}`}>
              <WidgetRenderer
                widget={widget}
                dashboardId={dashboardId}
                disableFetch
                heightMultiplier={widget.config.size?.height || 1}
                preloadedData={dataByWidgetId[widget.id]}
                preloadedLoading={loading}
                preloadedError={errorMessage}
              />
            </div>
          </div>
        ))}
      </div>
    </motion.div>
  );
};

export default DashboardViewPage;
