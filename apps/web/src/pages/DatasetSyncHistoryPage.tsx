
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { motion } from "framer-motion";
import {
  AlertTriangle, CheckCircle2, FileText, Loader2, Pause, RefreshCw, Search, Square, Zap,
} from "lucide-react";

import { useCoreData } from "@/hooks/use-core-data";
import { ApiAdminDatasetSyncRun, ApiDatasetSyncRun, ApiError, api } from "@/lib/api";
import { parseApiDate } from "@/lib/datetime";
import { useToast } from "@/hooks/use-toast";
import EmptyState from "@/components/shared/EmptyState";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

const ACTIVE_STATUSES = new Set(["queued", "running"]);
const FAILURE_STATUSES = new Set(["failed", "drift_blocked"]);
const RETRYABLE_STATUSES = new Set(["failed", "drift_blocked", "canceled", "skipped"]);

type RunRef = { datasetId: number; runId: number };
type DetailsTab = "logs" | "details" | "metrics";
type StatusFilter = "all" | "failure" | "running" | "queued" | "success" | "failed" | "drift_blocked" | "canceled" | "skipped";
type PeriodFilter = "all" | "today" | "7d" | "30d";
type TriggerFilter = "all" | "manual" | "scheduled" | "webhook" | "retry" | "initial";

const STATUS_FILTER_OPTIONS: Array<{ value: StatusFilter; label: string }> = [
  { value: "all", label: "Todos" },
  { value: "failure", label: "Falha (todas)" },
  { value: "failed", label: "Falha" },
  { value: "drift_blocked", label: "Drift bloqueado" },
  { value: "running", label: "Em execucao" },
  { value: "queued", label: "Na fila" },
  { value: "canceled", label: "Cancelado" },
  { value: "skipped", label: "Ignorado" },
  { value: "success", label: "Sucesso" },
];

const PERIOD_FILTER_OPTIONS: Array<{ value: PeriodFilter; label: string }> = [
  { value: "all", label: "Todos" },
  { value: "today", label: "Hoje" },
  { value: "7d", label: "7 dias" },
  { value: "30d", label: "30 dias" },
];

const TRIGGER_FILTER_OPTIONS: Array<{ value: TriggerFilter; label: string }> = [
  { value: "all", label: "Todos" },
  { value: "manual", label: "Manual" },
  { value: "scheduled", label: "Agendado" },
  { value: "webhook", label: "Webhook" },
  { value: "retry", label: "Reexecucao" },
  { value: "initial", label: "Inicial" },
];

const formatCompactDateTime = (value?: string | null): string => {
  const parsed = parseApiDate(value);
  if (!parsed) return "-";
  return parsed.toLocaleString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
};

const toTs = (value?: string | null): number | null => {
  const parsed = parseApiDate(value);
  if (!parsed) return null;
  return parsed.getTime();
};

const formatDuration = (durationMs?: number | null): string => {
  if (durationMs === null || durationMs === undefined || Number.isNaN(durationMs)) return "-";
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
};

const runDurationMs = (run: Pick<ApiAdminDatasetSyncRun, "status" | "started_at" | "finished_at">): number | null => {
  const start = toTs(run.started_at);
  if (start === null) return null;
  const end = run.status === "running" ? Date.now() : toTs(run.finished_at);
  if (end === null) return null;
  return Math.max(0, end - start);
};

const runRowsProcessed = (run: Pick<ApiAdminDatasetSyncRun, "stats">): number | null => {
  const stats = run.stats || {};
  const values = [Number(stats.rows_processed), Number(stats.rows_written), Number(stats.rows_read)]
    .filter((value) => Number.isFinite(value) && value > 0);
  if (values.length === 0) return null;
  return Math.max(...values);
};

const statusLabel = (status: string): string => {
  if (status === "queued") return "Na fila";
  if (status === "running") return "Em execucao";
  if (status === "success") return "Sucesso";
  if (status === "failed" || status === "drift_blocked") return "Falha";
  if (status === "canceled") return "Cancelado";
  if (status === "skipped") return "Ignorado";
  return status;
};

const statusBadgeClass = (status: string): string => {
  if (status === "success") return "border-success/40 bg-success/15 text-success";
  if (status === "running") return "border-info/40 bg-info/15 text-info";
  if (status === "queued") return "border-warning/40 bg-warning/15 text-warning";
  if (status === "failed" || status === "drift_blocked") return "border-destructive/40 bg-destructive/15 text-destructive";
  if (status === "canceled") return "border-border-default bg-muted/70 text-muted-foreground";
  return "border-border-default bg-muted/70 text-muted-foreground";
};

const triggerTypeLabel = (triggerType: string): string => {
  if (triggerType === "manual") return "Manual";
  if (triggerType === "scheduled") return "Agendado";
  if (triggerType === "webhook") return "Webhook";
  if (triggerType === "retry") return "Reexecucao";
  if (triggerType === "initial") return "Inicial";
  return triggerType;
};

const toPrettyJson = (value: unknown): string => JSON.stringify(value || {}, null, 2);

const DatasetSyncHistoryPage = () => {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { datasets, datasources } = useCoreData();

  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [periodFilter, setPeriodFilter] = useState<PeriodFilter>("all");
  const [datasetFilter, setDatasetFilter] = useState("all");
  const [triggerTypeFilter, setTriggerTypeFilter] = useState<TriggerFilter>("all");
  const [runDatasetId, setRunDatasetId] = useState("all");
  const [selectedRunRef, setSelectedRunRef] = useState<RunRef | null>(null);
  const [detailsTab, setDetailsTab] = useState<DetailsTab>("logs");
  const [historyPage, setHistoryPage] = useState(1);
  const [historyPageSize, setHistoryPageSize] = useState("10");

  const importedDatasets = useMemo(() => datasets.filter((dataset) => dataset.accessMode === "imported"), [datasets]);

  const runsQuery = useQuery({
    queryKey: ["admin-dataset-sync-runs", search, datasetFilter],
    queryFn: async () => {
      try {
        return await api.listAdminDatasetSyncRuns({
          search: search.trim() || undefined,
          dataset_id: datasetFilter === "all" ? undefined : Number(datasetFilter),
          limit: 300,
          offset: 0,
        });
      } catch {
        const targetDatasets = importedDatasets
          .filter((dataset) => datasetFilter === "all" || dataset.id === datasetFilter)
          .filter((dataset) => {
            const q = search.trim().toLowerCase();
            if (!q) return true;
            return dataset.name.toLowerCase().includes(q);
          });

        const datasourceNameById = new Map(datasources.map((item) => [item.id, item.name]));
        const results = await Promise.allSettled(
          targetDatasets.map(async (dataset) => {
            const response = await api.listDatasetSyncRuns(Number(dataset.id), 50);
            return response.items.map<ApiAdminDatasetSyncRun>((run) => ({
              id: run.id,
              dataset_id: Number(dataset.id),
              dataset_name: dataset.name,
              dataset_access_mode: dataset.accessMode,
              dataset_data_status: dataset.dataStatus,
              datasource_id: Number(dataset.datasourceId),
              datasource_name: datasourceNameById.get(dataset.datasourceId) || `Datasource ${dataset.datasourceId}`,
              import_enabled: dataset.dataStatus !== "paused",
              trigger_type: run.trigger_type,
              status: run.status,
              queued_at: run.queued_at,
              started_at: run.started_at,
              finished_at: run.finished_at,
              attempt: run.attempt,
              published_execution_view_id: run.published_execution_view_id,
              drift_summary: run.drift_summary,
              error_code: run.error_code,
              error_message: run.error_message,
              error_details: null,
              input_snapshot: run.input_snapshot || {},
              stats: run.stats || {},
              correlation_id: run.correlation_id,
            }));
          }),
        );
        const items = results
          .filter((item): item is PromiseFulfilledResult<ApiAdminDatasetSyncRun[]> => item.status === "fulfilled")
          .flatMap((item) => item.value);
        items.sort((a, b) => (toTs(b.queued_at) || 0) - (toTs(a.queued_at) || 0));
        return {
          items,
          total: items.length,
          limit: items.length,
          offset: 0,
        };
      }
    },
    refetchInterval: 8000,
  });

  const selectedRunDetailsQuery = useQuery({
    queryKey: ["dataset-sync-run-details", selectedRunRef?.datasetId, selectedRunRef?.runId],
    queryFn: () => api.getDatasetSyncRun(Number(selectedRunRef?.datasetId), Number(selectedRunRef?.runId)),
    enabled: !!selectedRunRef,
  });

  const filteredRuns = useMemo(() => {
    const source = runsQuery.data?.items || [];
    const now = Date.now();
    const minTs = periodFilter === "today"
      ? (() => {
        const start = new Date();
        start.setHours(0, 0, 0, 0);
        return start.getTime();
      })()
      : periodFilter === "7d"
        ? now - 7 * 24 * 60 * 60 * 1000
        : periodFilter === "30d"
          ? now - 30 * 24 * 60 * 60 * 1000
          : null;

    return source.filter((run) => {
      if (statusFilter === "failure") {
        if (!FAILURE_STATUSES.has(run.status)) return false;
      } else if (statusFilter !== "all" && run.status !== statusFilter) {
        return false;
      }
      if (triggerTypeFilter !== "all" && run.trigger_type !== triggerTypeFilter) return false;
      if (minTs !== null) {
        const queuedAt = toTs(run.queued_at);
        if (queuedAt === null || queuedAt < minTs) return false;
      }
      return true;
    });
  }, [periodFilter, runsQuery.data?.items, statusFilter, triggerTypeFilter]);

  const runningRuns = useMemo(() => filteredRuns.filter((run) => run.status === "running" || run.status === "queued"), [filteredRuns]);
  const historyRuns = useMemo(() => filteredRuns.filter((run) => run.status !== "running" && run.status !== "queued"), [filteredRuns]);
  const historyPageSizeNumber = useMemo(() => Math.max(1, Number.parseInt(historyPageSize, 10) || 10), [historyPageSize]);
  const historyTotalPages = useMemo(() => Math.max(1, Math.ceil(historyRuns.length / historyPageSizeNumber)), [historyRuns.length, historyPageSizeNumber]);
  const paginatedHistoryRuns = useMemo(() => {
    const start = (historyPage - 1) * historyPageSizeNumber;
    return historyRuns.slice(start, start + historyPageSizeNumber);
  }, [historyPage, historyPageSizeNumber, historyRuns]);

  useEffect(() => {
    setHistoryPage(1);
  }, [search, statusFilter, periodFilter, datasetFilter, triggerTypeFilter, historyPageSize]);

  useEffect(() => {
    if (historyPage > historyTotalPages) {
      setHistoryPage(historyTotalPages);
    }
  }, [historyPage, historyTotalPages]);

  useEffect(() => {
    if (filteredRuns.length === 0) {
      setSelectedRunRef(null);
      return;
    }
    if (!selectedRunRef) {
      setSelectedRunRef({ datasetId: filteredRuns[0].dataset_id, runId: filteredRuns[0].id });
      return;
    }
    const stillVisible = filteredRuns.some(
      (run) => run.id === selectedRunRef.runId && run.dataset_id === selectedRunRef.datasetId,
    );
    if (!stillVisible) {
      setSelectedRunRef({ datasetId: filteredRuns[0].dataset_id, runId: filteredRuns[0].id });
    }
  }, [filteredRuns, selectedRunRef]);

  const selectedRun = useMemo(() => {
    if (!selectedRunRef) return null;
    return filteredRuns.find(
      (run) => run.id === selectedRunRef.runId && run.dataset_id === selectedRunRef.datasetId,
    ) || null;
  }, [filteredRuns, selectedRunRef]);

  const selectedRunDetails = selectedRunDetailsQuery.data as ApiDatasetSyncRun | undefined;

  const summary = useMemo(() => {
    const total = filteredRuns.length;
    const running = filteredRuns.filter((run) => run.status === "running").length;
    const queued = filteredRuns.filter((run) => run.status === "queued").length;
    const failed = filteredRuns.filter((run) => FAILURE_STATUSES.has(run.status)).length;
    const lastSuccess = filteredRuns.find((run) => run.status === "success");
    const recentFailures = filteredRuns.filter((run) => {
      if (!FAILURE_STATUSES.has(run.status)) return false;
      const finishedOrQueuedAt = toTs(run.finished_at || run.queued_at);
      return finishedOrQueuedAt !== null && finishedOrQueuedAt >= Date.now() - 24 * 60 * 60 * 1000;
    }).length;
    return {
      total,
      running,
      queued,
      failed,
      recentFailures,
      lastSuccessLabel: lastSuccess ? formatCompactDateTime(lastSuccess.finished_at || lastSuccess.queued_at) : "-",
    };
  }, [filteredRuns]);
  const isRunsLoading = runsQuery.isLoading || (runsQuery.isFetching && !runsQuery.data);
  const totalLoadedRuns = runsQuery.data?.items.length || 0;
  const hasActiveFilters = search.trim().length > 0
    || statusFilter !== "all"
    || periodFilter !== "all"
    || datasetFilter !== "all"
    || triggerTypeFilter !== "all";

  const resetFilters = () => {
    setSearch("");
    setStatusFilter("all");
    setPeriodFilter("all");
    setDatasetFilter("all");
    setTriggerTypeFilter("all");
  };

  const invalidateRuns = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["admin-dataset-sync-runs"] }),
      queryClient.invalidateQueries({ queryKey: ["dataset-sync-run-details"] }),
      queryClient.invalidateQueries({ queryKey: ["datasets"] }),
    ]);
  };

  const triggerDatasetSync = useMutation({
    mutationFn: (datasetId: number) => api.triggerDatasetSync(datasetId),
    onSuccess: async () => {
      await invalidateRuns();
      toast({ title: "Sync enfileirado" });
    },
    onError: (error: unknown) => {
      const detail = error instanceof ApiError ? error.detail || error.message : "Falha ao enfileirar sync";
      toast({ title: "Erro ao enfileirar sync", description: detail, variant: "destructive" });
    },
  });

  const triggerAllSyncs = useMutation({
    mutationFn: () => Promise.allSettled(importedDatasets.map((dataset) => api.triggerDatasetSync(Number(dataset.id)))),
    onSuccess: async (result) => {
      await invalidateRuns();
      toast({
        title: "Sync em lote finalizado",
        description: `${result.filter((item) => item.status === "fulfilled").length} datasets enfileirados.`,
      });
    },
  });

  const triggerFailedSyncs = useMutation({
    mutationFn: () => {
      const failedDatasetIds = Array.from(new Set(
        filteredRuns.filter((run) => FAILURE_STATUSES.has(run.status)).map((run) => Number(run.dataset_id)),
      ));
      return Promise.allSettled(failedDatasetIds.map((id) => api.triggerDatasetSync(id)));
    },
    onSuccess: async (result) => {
      await invalidateRuns();
      toast({
        title: "Reexecucao de falhos",
        description: `${result.filter((item) => item.status === "fulfilled").length} datasets enfileirados.`,
      });
    },
  });

  const cancelRun = useMutation({
    mutationFn: (runId: number) => api.cancelAdminDatasetSyncRun(runId),
    onSuccess: async () => {
      await invalidateRuns();
      toast({ title: "Sync cancelado" });
    },
  });

  const pauseDataset = useMutation({
    mutationFn: (datasetId: number) => api.pauseAdminDatasetSync(datasetId),
    onSuccess: async () => {
      await invalidateRuns();
      toast({ title: "Sync pausado" });
    },
  });

  const retryRun = useMutation({
    mutationFn: (run: ApiAdminDatasetSyncRun) => api.retryDatasetSyncRun(run.dataset_id, run.id),
    onSuccess: async () => {
      await invalidateRuns();
      toast({ title: "Reexecucao enfileirada" });
    },
  });

  const runActionsBusy = triggerDatasetSync.isPending || triggerAllSyncs.isPending || triggerFailedSyncs.isPending;
  const selectRun = (run: ApiAdminDatasetSyncRun) => {
    setSelectedRunRef({ datasetId: run.dataset_id, runId: run.id });
  };

  const actionButtons = (run: ApiAdminDatasetSyncRun) => (
    <div className="flex justify-end gap-1" aria-label={`Acoes do run ${run.id}`}>
      <ActionIconButton
        label="Rodar dataset"
        disabled={runActionsBusy}
        onClick={() => {
          triggerDatasetSync.mutate(run.dataset_id);
        }}
      >
        <Zap className="h-3.5 w-3.5" />
      </ActionIconButton>
      <ActionIconButton
        label="Pausar dataset"
        disabled={pauseDataset.isPending || !run.import_enabled}
        onClick={() => {
          pauseDataset.mutate(run.dataset_id);
        }}
      >
        <Pause className="h-3.5 w-3.5" />
      </ActionIconButton>
      <ActionIconButton
        label="Cancelar run"
        destructive
        disabled={!ACTIVE_STATUSES.has(run.status) || cancelRun.isPending}
        onClick={() => {
          cancelRun.mutate(run.id);
        }}
      >
        <Square className="h-3.5 w-3.5" />
      </ActionIconButton>
      <ActionIconButton
        label="Reexecutar run"
        disabled={!RETRYABLE_STATUSES.has(run.status) || retryRun.isPending}
        onClick={() => {
          retryRun.mutate(run);
        }}
      >
        <RefreshCw className="h-3.5 w-3.5" />
      </ActionIconButton>
      <ActionIconButton
        label="Abrir logs"
        onClick={() => {
          selectRun(run);
          setDetailsTab("logs");
        }}
      >
        <FileText className="h-3.5 w-3.5" />
      </ActionIconButton>
    </div>
  );

  const renderRows = (rows: ApiAdminDatasetSyncRun[], dateSource: "start" | "end") => rows.map((run) => {
    const selected = selectedRunRef?.runId === run.id && selectedRunRef?.datasetId === run.dataset_id;
    const dateValue = dateSource === "start" ? (run.started_at || run.queued_at) : (run.finished_at || run.queued_at);
    const handleSelect = () => selectRun(run);
    return (
      <TableRow
        key={`${run.dataset_id}-${run.id}`}
        onClick={handleSelect}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            handleSelect();
          }
        }}
        role="button"
        tabIndex={0}
        aria-selected={selected}
        aria-label={`Selecionar run ${run.id} do dataset ${run.dataset_name}`}
        className={`cursor-pointer border-b border-border/70 transition-colors hover:bg-muted/40 ${selected ? "bg-accent/15 hover:bg-accent/20" : ""}`}
      >
        <TableCell>
          <div className="max-w-[220px] truncate font-medium text-foreground" title={run.dataset_name}>{run.dataset_name}</div>
          <div className="max-w-[220px] truncate text-caption text-muted-foreground" title={run.datasource_name}>{run.datasource_name}</div>
        </TableCell>
        <TableCell>
          <RunStatusBadge status={run.status} />
        </TableCell>
        <TableCell className="hidden text-caption lg:table-cell">{triggerTypeLabel(run.trigger_type)}</TableCell>
        <TableCell className="text-caption">{formatCompactDateTime(dateValue)}</TableCell>
        <TableCell className="text-right font-mono text-caption">{formatDuration(runDurationMs(run))}</TableCell>
        <TableCell className="text-right font-mono text-caption">{runRowsProcessed(run)?.toLocaleString("pt-BR") || "-"}</TableCell>
        <TableCell className="text-right">{actionButtons(run)}</TableCell>
      </TableRow>
    );
  });

  return (
    <div className="bg-background">
      <main className="app-container py-6 space-y-8">
        <motion.section initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
          <Card className="glass-card border-border-default">
            <CardContent className="p-6 space-y-5">
              <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
                <div>
                  <h1 className="text-display text-foreground">Operacao de Syncs</h1>
                  <p className="mt-1 text-body text-muted-foreground">Console operacional centralizado para syncs de datasets imported.</p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Select value={runDatasetId} onValueChange={setRunDatasetId}>
                    <SelectTrigger className="w-full sm:w-[250px]"><SelectValue placeholder="Selecionar dataset" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">Selecionar dataset</SelectItem>
                      {importedDatasets.map((dataset) => <SelectItem key={dataset.id} value={dataset.id}>{dataset.name}</SelectItem>)}
                    </SelectContent>
                  </Select>

                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button className="bg-accent text-accent-foreground hover:bg-accent/90">
                        {runActionsBusy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Zap className="mr-2 h-4 w-4" />}Rodar Sync
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem disabled={runDatasetId === "all" || runActionsBusy} onClick={() => triggerDatasetSync.mutate(Number(runDatasetId))}>Rodar dataset</DropdownMenuItem>
                      <DropdownMenuItem disabled={importedDatasets.length === 0 || runActionsBusy} onClick={() => triggerAllSyncs.mutate()}>Rodar todos</DropdownMenuItem>
                      <DropdownMenuItem disabled={summary.failed === 0 || runActionsBusy} onClick={() => triggerFailedSyncs.mutate()}>Rodar falhos</DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>

                  <Button variant="outline" asChild><Link to="/datasets">Voltar</Link></Button>
                </div>
              </div>

              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
                {isRunsLoading ? (
                  Array.from({ length: 5 }).map((_, index) => (
                    <div key={`sync-summary-skeleton-${index}`} className="rounded-lg border border-border-default bg-card p-3">
                      <Skeleton className="h-3 w-24" />
                      <Skeleton className="mt-2 h-6 w-20" />
                    </div>
                  ))
                ) : (
                  <>
                    <StatTile label="Total de Runs" value={summary.total} />
                    <StatTile label="Em Execucao" value={summary.running} tone="info" />
                    <StatTile label="Na Fila" value={summary.queued} tone="warning" />
                    <StatTile label="Falhas" value={summary.failed} tone="danger" />
                    <StatTile label="Ultima Sync" value={summary.lastSuccessLabel} tone="success" />
                  </>
                )}
              </div>

              {!isRunsLoading && summary.recentFailures > 0 ? (
                <div className="flex items-center justify-between rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-body">
                  <span className="inline-flex items-center gap-2 text-destructive"><AlertTriangle className="h-4 w-4" />{summary.recentFailures} falha(s) nas ultimas 24 horas.</span>
                  <Button variant="outline" size="sm" onClick={() => setStatusFilter("failure")}>Ver falhas</Button>
                </div>
              ) : null}
            </CardContent>
          </Card>
        </motion.section>

        <Card className="glass-card border-border-default">
          <CardHeader className="flex flex-row items-center justify-between gap-3 pb-3">
            <CardTitle className="text-heading-md text-foreground">Filtros</CardTitle>
            <Button type="button" variant="ghost" size="sm" disabled={!hasActiveFilters} onClick={resetFilters}>
              Limpar filtros
            </Button>
          </CardHeader>
          <CardContent className="grid gap-3 md:grid-cols-2 xl:grid-cols-6">
            <div className="space-y-1 md:col-span-2 xl:col-span-2">
              <Label htmlFor="sync-search" className="text-caption text-muted-foreground">Busca</Label>
              <div className="relative">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  id="sync-search"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Buscar dataset, fonte, erro ou correlation ID"
                  className="pl-9"
                />
              </div>
            </div>
            <div className="space-y-1">
              <Label className="text-caption text-muted-foreground">Dataset</Label>
              <Select value={datasetFilter} onValueChange={setDatasetFilter}>
                <SelectTrigger><SelectValue placeholder="Todos os datasets" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Todos os datasets</SelectItem>
                  {importedDatasets.map((dataset) => <SelectItem key={`dataset-filter-${dataset.id}`} value={dataset.id}>{dataset.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-caption text-muted-foreground">Status</Label>
              <Select value={statusFilter} onValueChange={(value) => setStatusFilter(value as StatusFilter)}>
                <SelectTrigger><SelectValue placeholder="Todos" /></SelectTrigger>
                <SelectContent>
                  {STATUS_FILTER_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-caption text-muted-foreground">Periodo</Label>
              <Select value={periodFilter} onValueChange={(value) => setPeriodFilter(value as PeriodFilter)}>
                <SelectTrigger><SelectValue placeholder="Todos" /></SelectTrigger>
                <SelectContent>
                  {PERIOD_FILTER_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-caption text-muted-foreground">Tipo de disparo</Label>
              <Select value={triggerTypeFilter} onValueChange={(value) => setTriggerTypeFilter(value as TriggerFilter)}>
                <SelectTrigger><SelectValue placeholder="Todos" /></SelectTrigger>
                <SelectContent>
                  {TRIGGER_FILTER_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </CardContent>
        </Card>

        {runsQuery.isError ? (
          <Card className="border-destructive/40 bg-destructive/10">
            <CardContent className="p-4 text-body text-destructive">
              Falha ao carregar historico de syncs: {runsQuery.error instanceof Error ? runsQuery.error.message : "erro desconhecido"}.
            </CardContent>
          </Card>
        ) : null}

        {!isRunsLoading && !runsQuery.isError && totalLoadedRuns > 0 && filteredRuns.length === 0 ? (
          <Card className="border-warning/40 bg-warning/10">
            <CardContent className="p-4 text-body text-warning">
              Existem {totalLoadedRuns} run(s) carregados, mas nenhum corresponde aos filtros atuais.
            </CardContent>
          </Card>
        ) : null}

        <div className="grid gap-4 xl:grid-cols-[2fr_1fr]">
          <div className="space-y-4">
            <RunsTableCard title="Em Execucao" subtitle={`${runningRuns.length} run(s)`} isLoading={isRunsLoading} emptyLabel="Nenhuma execucao em andamento." rows={runningRuns} dateSource="start" renderRows={renderRows} />
            <RunsTableCard
              title="Historico"
              subtitle={`${historyRuns.length} run(s)`}
              isLoading={isRunsLoading}
              emptyLabel="Sem runs no historico para os filtros atuais."
              rows={paginatedHistoryRuns}
              dateSource="end"
              renderRows={renderRows}
              footer={historyRuns.length > 0 ? (
                <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/70 px-2 pt-3">
                  <div className="flex items-center gap-2 text-caption text-muted-foreground">
                    <span>Itens por pagina</span>
                    <Select value={historyPageSize} onValueChange={setHistoryPageSize}>
                      <SelectTrigger className="h-8 w-[78px]"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="10">10</SelectItem>
                        <SelectItem value="20">20</SelectItem>
                        <SelectItem value="50">50</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-caption text-muted-foreground">Pagina {historyPage} de {historyTotalPages}</span>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="h-8"
                      disabled={historyPage <= 1}
                      onClick={() => setHistoryPage((prev) => Math.max(1, prev - 1))}
                    >
                      Anterior
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="h-8"
                      disabled={historyPage >= historyTotalPages}
                      onClick={() => setHistoryPage((prev) => Math.min(historyTotalPages, prev + 1))}
                    >
                      Proxima
                    </Button>
                  </div>
                </div>
              ) : null}
            />
          </div>

          <SelectedRunCard
            selectedRun={selectedRun}
            selectedRunDetails={selectedRunDetails}
            detailsTab={detailsTab}
            onTabChange={setDetailsTab}
            isRunsLoading={isRunsLoading}
            isDetailsLoading={selectedRunDetailsQuery.isLoading}
            detailsError={selectedRunDetailsQuery.isError
              ? (selectedRunDetailsQuery.error instanceof Error ? selectedRunDetailsQuery.error.message : "erro desconhecido")
              : null}
          />
        </div>
      </main>
    </div>
  );
};

const ActionIconButton = ({
  label,
  onClick,
  disabled,
  destructive,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  destructive?: boolean;
  children: JSX.Element;
}) => (
  <Tooltip>
    <TooltipTrigger asChild>
      <Button
        variant="ghost"
        size="icon"
        aria-label={label}
        title={label}
        className={`h-8 w-8 ${destructive ? "text-destructive hover:bg-destructive/10 hover:text-destructive" : ""}`}
        disabled={disabled}
        onClick={(event) => {
          event.stopPropagation();
          onClick();
        }}
      >
        {children}
      </Button>
    </TooltipTrigger>
    <TooltipContent>{label}</TooltipContent>
  </Tooltip>
);

const RunStatusBadge = ({ status }: { status: string }) => (
  <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold ${statusBadgeClass(status)}`}>
    {statusLabel(status)}
  </span>
);

const SelectedRunCard = ({
  selectedRun,
  selectedRunDetails,
  detailsTab,
  onTabChange,
  isRunsLoading,
  isDetailsLoading,
  detailsError,
}: {
  selectedRun: ApiAdminDatasetSyncRun | null;
  selectedRunDetails?: ApiDatasetSyncRun;
  detailsTab: DetailsTab;
  onTabChange: (tab: DetailsTab) => void;
  isRunsLoading: boolean;
  isDetailsLoading: boolean;
  detailsError: string | null;
}) => (
  <Card className="glass-card border-border-default">
    <CardHeader className="pb-3"><CardTitle className="text-heading-md">Run Selecionado</CardTitle></CardHeader>
    <CardContent>
      {isRunsLoading && !selectedRun ? (
        <div className="space-y-3">
          <Skeleton className="h-8 w-full" />
          <div className="rounded-md border border-border p-3 space-y-2">
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-3 w-1/3" />
            <Skeleton className="h-16 w-full" />
          </div>
          <Skeleton className="h-40 w-full" />
        </div>
      ) : !selectedRun ? (
        <EmptyState icon={<FileText className="h-5 w-5" />} title="Nenhum run selecionado" description="Selecione um run para abrir logs e metricas detalhadas." />
      ) : (
        <Tabs value={detailsTab} onValueChange={(value) => onTabChange(value as DetailsTab)}>
          <TabsList className="grid w-full grid-cols-3">
            <TabsTrigger value="logs">Logs</TabsTrigger>
            <TabsTrigger value="details">Detalhes</TabsTrigger>
            <TabsTrigger value="metrics">Metricas</TabsTrigger>
          </TabsList>
          <TabsContent value="logs" className="mt-3 space-y-3">
            <div className="rounded-md border border-border p-3 text-caption">
              <p className="font-semibold text-foreground">{selectedRun.dataset_name}</p>
              <p className="text-muted-foreground">Run #{selectedRun.id}</p>
              {selectedRun.error_message ? (
                <div className="mt-2 max-h-24 overflow-auto whitespace-pre-wrap break-all rounded-md border border-destructive/40 bg-destructive/10 p-2 text-destructive">
                  {selectedRun.error_message}
                </div>
              ) : (
                <div className="mt-2 rounded-md border border-success/40 bg-success/10 p-2 text-success">
                  <span className="inline-flex items-center gap-1"><CheckCircle2 className="h-3.5 w-3.5" /> Sem erro registrado</span>
                </div>
              )}
            </div>
            {isDetailsLoading ? (
              <p className="rounded-md border border-border-default bg-muted/40 px-3 py-2 text-caption text-muted-foreground">
                Carregando detalhes do run...
              </p>
            ) : null}
            {detailsError ? (
              <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-caption text-destructive">
                Falha ao carregar detalhes: {detailsError}
              </p>
            ) : null}
            <pre className="max-h-72 overflow-auto rounded-md border border-border bg-muted/35 p-2 text-[11px] leading-snug">{toPrettyJson({ error_details: selectedRun.error_details || null, drift_summary: selectedRun.drift_summary || null, details_response: selectedRunDetails || null })}</pre>
          </TabsContent>
          <TabsContent value="details" className="mt-3">
            <div className="space-y-2 rounded-md border border-border p-3 text-caption">
              <p><strong>Dataset:</strong> {selectedRun.dataset_name}</p>
              <p><strong>Status:</strong> {statusLabel(selectedRun.status)}</p>
              <p><strong>Inicio:</strong> {formatCompactDateTime(selectedRun.started_at)}</p>
              <p><strong>Fim:</strong> {formatCompactDateTime(selectedRun.finished_at)}</p>
              <p><strong>Duracao:</strong> {formatDuration(runDurationMs(selectedRun))}</p>
              <p><strong>Linhas:</strong> {runRowsProcessed(selectedRun)?.toLocaleString("pt-BR") || "-"}</p>
              <p><strong>Fonte:</strong> {selectedRun.datasource_name}</p>
              <p><strong>Tipo:</strong> {triggerTypeLabel(selectedRun.trigger_type)}</p>
            </div>
          </TabsContent>
          <TabsContent value="metrics" className="mt-3 space-y-3">
            <div className="grid grid-cols-2 gap-2 text-caption">
              <MetricBox label="Duracao" value={formatDuration(runDurationMs(selectedRun))} />
              <MetricBox label="Linhas" value={runRowsProcessed(selectedRun)?.toLocaleString("pt-BR") || "-"} />
              <MetricBox label="Status" value={statusLabel(selectedRun.status)} />
              <MetricBox label="Tipo" value={triggerTypeLabel(selectedRun.trigger_type)} />
            </div>
            <pre className="max-h-56 overflow-auto rounded-md border border-border bg-muted/35 p-2 text-[11px] leading-snug">{toPrettyJson(selectedRun.stats)}</pre>
          </TabsContent>
        </Tabs>
      )}
    </CardContent>
  </Card>
);

const RunsTableCard = ({
  title,
  subtitle,
  isLoading,
  emptyLabel,
  rows,
  dateSource,
  renderRows,
  footer,
}: {
  title: string;
  subtitle: string;
  isLoading: boolean;
  emptyLabel: string;
  rows: ApiAdminDatasetSyncRun[];
  dateSource: "start" | "end";
  renderRows: (rows: ApiAdminDatasetSyncRun[], dateSource: "start" | "end") => JSX.Element[];
  footer?: JSX.Element | null;
}) => (
  <Card className="glass-card border-border-default">
    <CardHeader className="pb-3">
      <CardTitle className="flex items-center justify-between text-heading-md">
        <span>{title}</span>
        <span className="rounded-full border border-border-default bg-muted/60 px-2 py-0.5 text-caption font-medium text-muted-foreground">{subtitle}</span>
      </CardTitle>
    </CardHeader>
    <CardContent>
      <div className="overflow-x-auto rounded-md border border-border-default bg-card/60">
        <Table className="min-w-[880px]">
          <TableHeader className="bg-muted/35">
            <TableRow>
              <TableHead>Dataset</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="hidden lg:table-cell">Tipo</TableHead>
              <TableHead>Data</TableHead>
              <TableHead className="text-right">Duracao</TableHead>
              <TableHead className="text-right">Linhas</TableHead>
              <TableHead className="text-right">Acoes</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              Array.from({ length: 5 }).map((_, index) => (
                <TableRow key={`run-row-skeleton-${title}-${index}`}>
                  <TableCell><Skeleton className="h-4 w-36" /></TableCell>
                  <TableCell><Skeleton className="h-4 w-20" /></TableCell>
                  <TableCell className="hidden lg:table-cell"><Skeleton className="h-4 w-20" /></TableCell>
                  <TableCell><Skeleton className="h-4 w-24" /></TableCell>
                  <TableCell className="text-right"><Skeleton className="ml-auto h-4 w-16" /></TableCell>
                  <TableCell className="text-right"><Skeleton className="ml-auto h-4 w-16" /></TableCell>
                  <TableCell className="text-right"><Skeleton className="ml-auto h-8 w-24" /></TableCell>
                </TableRow>
              ))
            ) : null}
            {!isLoading && rows.length === 0 ? <TableRow><TableCell colSpan={7} className="text-center text-muted-foreground">{emptyLabel}</TableCell></TableRow> : null}
            {!isLoading ? renderRows(rows, dateSource) : null}
          </TableBody>
        </Table>
      </div>
      {footer}
    </CardContent>
  </Card>
);

const MetricBox = ({ label, value }: { label: string; value: string }) => (
  <div className="rounded-md border border-border p-2">
    <p className="text-muted-foreground">{label}</p>
    <p className="font-semibold text-foreground">{value}</p>
  </div>
);

const StatTile = ({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: string | number;
  tone?: "default" | "success" | "warning" | "danger" | "info";
}) => {
  const toneClass = tone === "success"
    ? "border-success/30 bg-success/10 text-success"
    : tone === "warning"
      ? "border-warning/30 bg-warning/10 text-warning"
      : tone === "danger"
        ? "border-destructive/30 bg-destructive/10 text-destructive"
        : tone === "info"
          ? "border-info/30 bg-info/10 text-info"
          : "border-border-default bg-card text-foreground";

  return (
    <div className={`rounded-lg border p-3 ${toneClass}`}>
      <p className="text-[11px] uppercase tracking-wide opacity-90">{label}</p>
      <p className="mt-1 text-title">{value}</p>
    </div>
  );
};

export default DatasetSyncHistoryPage;
