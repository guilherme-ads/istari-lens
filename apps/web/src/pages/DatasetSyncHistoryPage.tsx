
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

const ACTIVE_STATUSES = new Set(["queued", "running"]);
const FAILURE_STATUSES = new Set(["failed", "drift_blocked"]);
const RETRYABLE_STATUSES = new Set(["failed", "drift_blocked", "canceled", "skipped"]);

type RunRef = { datasetId: number; runId: number };

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
  const [statusFilter, setStatusFilter] = useState("all");
  const [periodFilter, setPeriodFilter] = useState("all");
  const [datasetFilter, setDatasetFilter] = useState("all");
  const [triggerTypeFilter, setTriggerTypeFilter] = useState("all");
  const [runDatasetId, setRunDatasetId] = useState("all");
  const [selectedRunRef, setSelectedRunRef] = useState<RunRef | null>(null);
  const [detailsTab, setDetailsTab] = useState("logs");

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
      if (statusFilter !== "all" && run.status !== statusFilter) return false;
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
  const totalLoadedRuns = runsQuery.data?.items.length || 0;

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

  const actionButtons = (run: ApiAdminDatasetSyncRun) => (
    <div className="flex justify-end gap-1">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="icon" className="h-8 w-8" disabled={runActionsBusy} onClick={(event) => { event.stopPropagation(); triggerDatasetSync.mutate(run.dataset_id); }}>
            <Zap className="h-3.5 w-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Rodar</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="icon" className="h-8 w-8" disabled={pauseDataset.isPending || !run.import_enabled} onClick={(event) => { event.stopPropagation(); pauseDataset.mutate(run.dataset_id); }}>
            <Pause className="h-3.5 w-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Pausar</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive hover:bg-destructive/10 hover:text-destructive" disabled={!ACTIVE_STATUSES.has(run.status) || cancelRun.isPending} onClick={(event) => { event.stopPropagation(); cancelRun.mutate(run.id); }}>
            <Square className="h-3.5 w-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Cancelar</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="icon" className="h-8 w-8" disabled={!RETRYABLE_STATUSES.has(run.status) || retryRun.isPending} onClick={(event) => { event.stopPropagation(); retryRun.mutate(run); }}>
            <RefreshCw className="h-3.5 w-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Reexecutar</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={(event) => { event.stopPropagation(); setSelectedRunRef({ datasetId: run.dataset_id, runId: run.id }); setDetailsTab("logs"); }}>
            <FileText className="h-3.5 w-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Logs</TooltipContent>
      </Tooltip>
    </div>
  );

  const renderRows = (rows: ApiAdminDatasetSyncRun[], dateSource: "start" | "end") => rows.map((run) => {
    const selected = selectedRunRef?.runId === run.id && selectedRunRef?.datasetId === run.dataset_id;
    const dateValue = dateSource === "start" ? (run.started_at || run.queued_at) : (run.finished_at || run.queued_at);
    return (
      <TableRow key={`${run.dataset_id}-${run.id}`} onClick={() => setSelectedRunRef({ datasetId: run.dataset_id, runId: run.id })} className={`cursor-pointer border-b border-border/70 transition-colors hover:bg-muted/40 ${selected ? "bg-accent/15 hover:bg-accent/20" : ""}`}>
        <TableCell>
          <div className="font-medium text-foreground">{run.dataset_name}</div>
          <div className="text-caption text-muted-foreground">{run.datasource_name}</div>
        </TableCell>
        <TableCell>
          <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold ${statusBadgeClass(run.status)}`}>
            {statusLabel(run.status)}
          </span>
        </TableCell>
        <TableCell className="text-caption">{triggerTypeLabel(run.trigger_type)}</TableCell>
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
                    <SelectTrigger className="w-[250px]"><SelectValue placeholder="Selecionar dataset" /></SelectTrigger>
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

              <div className="grid gap-3 md:grid-cols-5">
                <StatTile label="Total de Runs" value={summary.total} />
                <StatTile label="Em Execucao" value={summary.running} tone="info" />
                <StatTile label="Na Fila" value={summary.queued} tone="warning" />
                <StatTile label="Falhas" value={summary.failed} tone="danger" />
                <StatTile label="Ultima Sync" value={summary.lastSuccessLabel} tone="success" />
              </div>

              {summary.recentFailures > 0 ? (
                <div className="flex items-center justify-between rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-body">
                  <span className="inline-flex items-center gap-2 text-destructive"><AlertTriangle className="h-4 w-4" />{summary.recentFailures} falha(s) nas ultimas 24 horas.</span>
                  <Button variant="outline" size="sm" onClick={() => setStatusFilter("failed")}>Ver falhas</Button>
                </div>
              ) : null}
            </CardContent>
          </Card>
        </motion.section>

        <Card className="glass-card border-border-default">
          <CardHeader className="pb-3"><CardTitle className="text-heading-md text-foreground">Filtros</CardTitle></CardHeader>
          <CardContent className="grid gap-3 lg:grid-cols-5">
            <div className="relative lg:col-span-2">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Buscar dataset, fonte, erro ou correlation ID" className="pl-9" />
            </div>
            <Select value={datasetFilter} onValueChange={setDatasetFilter}>
              <SelectTrigger><SelectValue placeholder="Dataset" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Todos os datasets</SelectItem>
                {importedDatasets.map((dataset) => <SelectItem key={`dataset-filter-${dataset.id}`} value={dataset.id}>{dataset.name}</SelectItem>)}
              </SelectContent>
            </Select>
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger><SelectValue placeholder="Status" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Todos</SelectItem>
                <SelectItem value="failed">Falha</SelectItem>
                <SelectItem value="running">Em execucao</SelectItem>
                <SelectItem value="canceled">Cancelado</SelectItem>
                <SelectItem value="queued">Na fila</SelectItem>
                <SelectItem value="success">Sucesso</SelectItem>
              </SelectContent>
            </Select>
            <div className="grid grid-cols-2 gap-2">
              <Select value={periodFilter} onValueChange={setPeriodFilter}>
                <SelectTrigger><SelectValue placeholder="Periodo" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Todos</SelectItem>
                  <SelectItem value="today">Hoje</SelectItem>
                  <SelectItem value="7d">7 dias</SelectItem>
                  <SelectItem value="30d">30 dias</SelectItem>
                </SelectContent>
              </Select>
              <Select value={triggerTypeFilter} onValueChange={setTriggerTypeFilter}>
                <SelectTrigger><SelectValue placeholder="Tipo" /></SelectTrigger>
                <SelectContent><SelectItem value="all">Todos</SelectItem><SelectItem value="manual">Manual</SelectItem><SelectItem value="scheduled">Agendado</SelectItem><SelectItem value="webhook">Webhook</SelectItem><SelectItem value="retry">Reexecucao</SelectItem></SelectContent>
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

        {!runsQuery.isLoading && !runsQuery.isError && totalLoadedRuns > 0 && filteredRuns.length === 0 ? (
          <Card className="border-warning/40 bg-warning/10">
            <CardContent className="p-4 text-body text-warning">
              Existem {totalLoadedRuns} run(s) carregados, mas nenhum corresponde aos filtros atuais.
            </CardContent>
          </Card>
        ) : null}

        <div className="grid gap-4 xl:grid-cols-[2fr_1fr]">
          <div className="space-y-4">
            <RunsTableCard title="Em Execucao" subtitle={`${runningRuns.length} run(s)`} isLoading={runsQuery.isLoading} emptyLabel="Nenhuma execucao em andamento." rows={runningRuns} dateSource="start" renderRows={renderRows} />
            <RunsTableCard title="Historico" subtitle={`${historyRuns.length} run(s)`} isLoading={runsQuery.isLoading} emptyLabel="Sem runs no historico para os filtros atuais." rows={historyRuns} dateSource="end" renderRows={renderRows} />
          </div>

          <Card className="glass-card border-border-default">
            <CardHeader className="pb-3"><CardTitle className="text-heading-md">Run Selecionado</CardTitle></CardHeader>
            <CardContent>
              {!selectedRun ? (
                <EmptyState icon={<FileText className="h-5 w-5" />} title="Nenhum run selecionado" description="Selecione um run para abrir logs e metricas detalhadas." />
              ) : (
                <Tabs value={detailsTab} onValueChange={setDetailsTab}>
                  <TabsList className="grid w-full grid-cols-3"><TabsTrigger value="logs">Logs</TabsTrigger><TabsTrigger value="details">Detalhes</TabsTrigger><TabsTrigger value="metrics">Metricas</TabsTrigger></TabsList>
                  <TabsContent value="logs" className="mt-3 space-y-3">
                    <div className="rounded-md border border-border p-3 text-caption">
                      <p className="font-semibold text-foreground">{selectedRun.dataset_name}</p>
                      <p className="text-muted-foreground">Run #{selectedRun.id}</p>
                      {selectedRun.error_message ? <div className="mt-2 rounded-md border border-destructive/40 bg-destructive/10 p-2 text-destructive">{selectedRun.error_message}</div> : <div className="mt-2 rounded-md border border-success/40 bg-success/10 p-2 text-success"><span className="inline-flex items-center gap-1"><CheckCircle2 className="h-3.5 w-3.5" /> Sem erro registrado</span></div>}
                    </div>
                    <pre className="max-h-72 overflow-auto rounded-md border border-border bg-muted/35 p-2 text-[11px] leading-snug">{toPrettyJson({ error_details: selectedRun.error_details || null, drift_summary: selectedRun.drift_summary || null, details_response: selectedRunDetails || null })}</pre>
                  </TabsContent>
                  <TabsContent value="details" className="mt-3"><div className="space-y-2 rounded-md border border-border p-3 text-caption">
                    <p><strong>Dataset:</strong> {selectedRun.dataset_name}</p>
                    <p><strong>Status:</strong> {statusLabel(selectedRun.status)}</p>
                    <p><strong>Inicio:</strong> {formatCompactDateTime(selectedRun.started_at)}</p>
                    <p><strong>Fim:</strong> {formatCompactDateTime(selectedRun.finished_at)}</p>
                    <p><strong>Duracao:</strong> {formatDuration(runDurationMs(selectedRun))}</p>
                    <p><strong>Linhas:</strong> {runRowsProcessed(selectedRun)?.toLocaleString("pt-BR") || "-"}</p>
                    <p><strong>Fonte:</strong> {selectedRun.datasource_name}</p>
                    <p><strong>Tipo:</strong> {triggerTypeLabel(selectedRun.trigger_type)}</p>
                  </div></TabsContent>
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
        </div>
      </main>
    </div>
  );
};

const RunsTableCard = ({
  title,
  subtitle,
  isLoading,
  emptyLabel,
  rows,
  dateSource,
  renderRows,
}: {
  title: string;
  subtitle: string;
  isLoading: boolean;
  emptyLabel: string;
  rows: ApiAdminDatasetSyncRun[];
  dateSource: "start" | "end";
  renderRows: (rows: ApiAdminDatasetSyncRun[], dateSource: "start" | "end") => JSX.Element[];
}) => (
  <Card className="glass-card border-border-default">
    <CardHeader className="pb-3">
      <CardTitle className="flex items-center justify-between text-heading-md">
        <span>{title}</span>
        <span className="rounded-full border border-border-default bg-muted/60 px-2 py-0.5 text-caption font-medium text-muted-foreground">{subtitle}</span>
      </CardTitle>
    </CardHeader>
    <CardContent>
      <div className="overflow-hidden rounded-md border border-border-default bg-card/60">
        <Table>
          <TableHeader className="bg-muted/35">
            <TableRow>
              <TableHead>Dataset</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Tipo</TableHead>
              <TableHead>Data</TableHead>
              <TableHead className="text-right">Duracao</TableHead>
              <TableHead className="text-right">Linhas</TableHead>
              <TableHead className="text-right">Acoes</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? <TableRow><TableCell colSpan={7} className="text-center text-muted-foreground">Carregando...</TableCell></TableRow> : null}
            {!isLoading && rows.length === 0 ? <TableRow><TableCell colSpan={7} className="text-center text-muted-foreground">{emptyLabel}</TableCell></TableRow> : null}
            {renderRows(rows, dateSource)}
          </TableBody>
        </Table>
      </div>
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
