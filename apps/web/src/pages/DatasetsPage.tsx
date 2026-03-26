import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion } from "framer-motion";
import {
  ArrowRight, Search, LayoutGrid, List,
  Layers, BarChart3, FolderOpen, Plus, Trash2,
} from "lucide-react";

import ConfirmDialog from "@/components/shared/ConfirmDialog";
import StatusBadge from "@/components/shared/StatusBadge";
import EmptyState from "@/components/shared/EmptyState";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useCoreData } from "@/hooks/use-core-data";
import { api, ApiError } from "@/lib/api";
import { getStoredUser } from "@/lib/auth";
import type { Dataset, View } from "@/types";
import { useToast } from "@/hooks/use-toast";
import SkeletonCard from "@/components/shared/SkeletonCard";

const datasetModeLabel = (mode: Dataset["accessMode"]): string => (
  mode === "imported" ? "Imported" : "Direct"
);

const datasetDataStatusLabel = (status: Dataset["dataStatus"]): string => {
  switch (status) {
    case "initializing":
      return "Inicializando";
    case "ready":
      return "Pronto";
    case "syncing":
      return "Sincronizando";
    case "error":
      return "Erro";
    case "drift_blocked":
      return "Drift bloqueado";
    case "paused":
      return "Pausado";
    case "draft":
      return "Rascunho";
    default:
      return status;
  }
};

const datasetStatusClassName = (status: Dataset["dataStatus"]): string => {
  switch (status) {
    case "ready":
      return "bg-success/10 text-success";
    case "syncing":
    case "initializing":
      return "bg-warning/10 text-warning";
    case "error":
    case "drift_blocked":
      return "bg-destructive/10 text-destructive";
    case "paused":
      return "bg-muted text-muted-foreground";
    default:
      return "bg-muted text-muted-foreground";
  }
};

const DatasetsPage = () => {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [search, setSearch] = useState("");
  const [viewMode, setViewMode] = useState<"grid" | "list">("grid");
  const [deleteTarget, setDeleteTarget] = useState<Dataset | null>(null);
  const isAdmin = !!getStoredUser()?.is_admin;
  const { datasets: allDatasets, views, isLoading, isError, errorMessage } = useCoreData();
  const showLoadingSkeleton = isLoading;

  const datasets = useMemo(() => {
    if (!search) return allDatasets;
    const q = search.toLowerCase();
    return allDatasets.filter(
      (d) =>
        d.name.toLowerCase().includes(q)
        || d.description.toLowerCase().includes(q),
    );
  }, [allDatasets, search]);

  const totalDashboards = useMemo(
    () => allDatasets.reduce((s, d) => s + d.dashboardIds.length, 0),
    [allDatasets],
  );

  const deleteDataset = useMutation({
    mutationFn: (datasetId: string) => api.deleteDataset(Number(datasetId)),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["datasets"] }),
        queryClient.invalidateQueries({ queryKey: ["dashboards"] }),
      ]);
      setDeleteTarget(null);
      toast({ title: "Dataset excluido com sucesso" });
    },
    onError: (error: unknown) => {
      const message = error instanceof ApiError ? error.detail || error.message : "Falha ao excluir dataset";
      toast({ title: "Erro ao excluir dataset", description: message, variant: "destructive" });
    },
  });

  return (
    <div className="bg-background">
      <main className="app-container py-6 space-y-8">
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between"
        >
          <div>
            <h1 className="text-display text-foreground">Datasets</h1>
            <p className="mt-1.5 text-body text-muted-foreground">
              Explore os datasets disponiveis e crie dashboards.
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <Button
              className="bg-accent text-accent-foreground hover:bg-accent/90"
              onClick={() => navigate("/datasets/new")}
            >
              <Plus className="h-4 w-4 mr-2" />
              Novo Dataset
            </Button>
          </div>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.05 }}
          className="flex flex-wrap gap-4 text-sm"
        >
          <div className="flex items-center gap-2 text-muted-foreground">
            <Layers className="h-4 w-4 text-accent" />
            <span className="font-semibold text-foreground">{showLoadingSkeleton ? "..." : datasets.length}</span> datasets
          </div>
          <div className="h-4 w-px bg-border hidden sm:block" />
          <div className="flex items-center gap-2 text-muted-foreground">
            <BarChart3 className="h-4 w-4 text-accent" />
            <span className="font-semibold text-foreground">{showLoadingSkeleton ? "..." : totalDashboards}</span> dashboards
          </div>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1 }}
          className="flex items-center gap-3"
        >
          <div className="relative flex-1 max-w-sm">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Buscar por nome ou descricao..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9 h-9"
            />
          </div>
          <div className="flex items-center rounded-lg border border-border bg-card p-0.5">
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={() => setViewMode("grid")}
                  className={`rounded-md p-1.5 transition-colors ${viewMode === "grid" ? "bg-secondary text-foreground" : "text-muted-foreground hover:text-foreground"}`}
                >
                  <LayoutGrid className="h-4 w-4" />
                </button>
              </TooltipTrigger>
              <TooltipContent className="text-xs">Grid</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={() => setViewMode("list")}
                  className={`rounded-md p-1.5 transition-colors ${viewMode === "list" ? "bg-secondary text-foreground" : "text-muted-foreground hover:text-foreground"}`}
                >
                  <List className="h-4 w-4" />
                </button>
              </TooltipTrigger>
              <TooltipContent className="text-xs">Lista</TooltipContent>
            </Tooltip>
          </div>
        </motion.div>

        {isError ? (
          <EmptyState
            icon={<FolderOpen className="h-5 w-5" />}
            title="Erro ao carregar datasets"
            description={errorMessage}
          />
        ) : (
          <AnimatePresence mode="wait">
            {showLoadingSkeleton ? (
              <motion.div
                key="datasets-skeleton"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3"
              >
                {Array.from({ length: 6 }).map((_, index) => (
                  <SkeletonCard key={`dataset-skeleton-${index}`} variant="dataset" />
                ))}
              </motion.div>
            ) : datasets.length === 0 ? (
              <motion.div key="datasets-empty" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                <EmptyState
                  icon={<FolderOpen className="h-5 w-5" />}
                  title={search ? "Nenhum resultado encontrado" : "Nenhum dataset disponivel"}
                  description={search ? "Tente ajustar sua busca." : "Crie seu primeiro dataset para comecar."}
                  action={
                    !search ? (
                      <Button variant="outline" size="sm" onClick={() => navigate("/datasets/new")}>
                        <Plus className="h-3.5 w-3.5 mr-1.5" /> Criar dataset
                      </Button>
                    ) : undefined
                  }
                />
              </motion.div>
            ) : viewMode === "grid" ? (
              <motion.div
                key="datasets-grid"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3"
              >
                {datasets.map((dataset, i) => (
                  <DatasetGridCard
                    key={dataset.id}
                    dataset={dataset}
                    views={views}
                    delay={i * 0.04}
                    onClick={() => navigate(`/datasets/${dataset.id}`)}
                    onDelete={isAdmin ? () => setDeleteTarget(dataset) : undefined}
                  />
                ))}
              </motion.div>
            ) : (
              <motion.div
                key="datasets-list"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="space-y-2"
              >
                {datasets.map((dataset, i) => (
                  <DatasetListItem
                    key={dataset.id}
                    dataset={dataset}
                    views={views}
                    delay={i * 0.03}
                    onClick={() => navigate(`/datasets/${dataset.id}`)}
                    onDelete={isAdmin ? () => setDeleteTarget(dataset) : undefined}
                  />
                ))}
              </motion.div>
            )}
          </AnimatePresence>
        )}
      </main>

      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        title="Excluir dataset?"
        description={`Esta acao excluira "${deleteTarget?.name}" e os dashboards vinculados.`}
        confirmLabel={deleteDataset.isPending ? "Excluindo..." : "Excluir"}
        destructive
        onConfirm={() => {
          if (!deleteTarget || deleteDataset.isPending) return;
          deleteDataset.mutate(deleteTarget.id);
        }}
      />
    </div>
  );
};

const DatasetGridCard = ({
  dataset,
  views,
  delay,
  onClick,
  onDelete,
}: {
  dataset: Dataset;
  views: View[];
  delay: number;
  onClick: () => void;
  onDelete?: () => void;
}) => {
  const view = views.find((v) => v.id === dataset.viewId);
  const dashboardCount = dataset.dashboardIds.length;
  const sourceLabel = view
    ? `${view.schema}.${view.name}`
    : String((dataset.baseQuerySpec?.base as { primary_resource?: string } | undefined)?.primary_resource || "dataset semantico");
  const previewColumns = dataset.semanticColumns.length > 0
    ? dataset.semanticColumns.slice(0, 4).map((item) => item.name)
    : (view?.columns || []).slice(0, 4).map((item) => item.name);
  const totalColumns = dataset.semanticColumns.length > 0 ? dataset.semanticColumns.length : (view?.columns.length || 0);

  return (
    <motion.div
      initial={{ opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay, duration: 0.35 }}
      onClick={onClick}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onClick();
        }
      }}
      role="button"
      tabIndex={0}
      className="group glass-card interactive-card p-5 text-left flex flex-col gap-3 cursor-pointer"
    >
      <div className="flex items-start justify-between">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-accent/10 text-accent group-hover:bg-accent group-hover:text-accent-foreground transition-colors">
          <FolderOpen className="h-4 w-4" />
        </div>
        <div className="flex items-center gap-1">
          {view && <StatusBadge status={view.status} />}
          {onDelete && (
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 destructive-icon-btn"
              onClick={(event) => {
                event.stopPropagation();
                onDelete();
              }}
              aria-label={`Excluir dataset ${dataset.name}`}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      </div>
      <div className="space-y-1.5">
        <h3 className="font-bold text-foreground leading-tight">{dataset.name}</h3>
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-[10px] font-semibold text-muted-foreground">
            {datasetModeLabel(dataset.accessMode)}
          </span>
          <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold ${datasetStatusClassName(dataset.dataStatus)}`}>
            {datasetDataStatusLabel(dataset.dataStatus)}
          </span>
        </div>
        <code className="text-caption font-mono">{sourceLabel}</code>
        <p className="text-body text-muted-foreground line-clamp-2">{dataset.description}</p>
      </div>
      {previewColumns.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-auto">
          {previewColumns.map((col) => (
            <span key={`${dataset.id}-${col}`} className="inline-flex items-center rounded-md bg-muted px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground">
              {col}
            </span>
          ))}
          {totalColumns > 4 && (
            <span className="inline-flex items-center rounded-md bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
              +{totalColumns - 4}
            </span>
          )}
        </div>
      )}
      <div className="flex items-center justify-between text-caption pt-2.5 border-t border-border">
        <span className="flex items-center gap-2">
          {view && <span>{view.rowCount.toLocaleString()} linhas</span>}
          <span>. {dashboardCount} {dashboardCount === 1 ? "dashboard" : "dashboards"}</span>
        </span>
        <span className="flex items-center gap-1 text-accent font-semibold group-hover:gap-2 transition-all">
          Abrir <ArrowRight className="h-3 w-3" />
        </span>
      </div>
    </motion.div>
  );
};

const DatasetListItem = ({
  dataset,
  views,
  delay,
  onClick,
  onDelete,
}: {
  dataset: Dataset;
  views: View[];
  delay: number;
  onClick: () => void;
  onDelete?: () => void;
}) => {
  const view = views.find((v) => v.id === dataset.viewId);
  const dashboardCount = dataset.dashboardIds.length;
  const sourceLabel = view
    ? `${view.schema}.${view.name}`
    : String((dataset.baseQuerySpec?.base as { primary_resource?: string } | undefined)?.primary_resource || "dataset semantico");
  const totalColumns = dataset.semanticColumns.length > 0 ? dataset.semanticColumns.length : (view?.columns.length || 0);

  return (
    <motion.div
      initial={{ opacity: 0, x: -8 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ delay, duration: 0.3 }}
      onClick={onClick}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onClick();
        }
      }}
      role="button"
      tabIndex={0}
      className="group glass-card interactive-card w-full p-4 text-left flex items-center gap-4 cursor-pointer"
    >
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent group-hover:bg-accent group-hover:text-accent-foreground transition-colors">
        <FolderOpen className="h-4 w-4" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <h3 className="font-bold text-foreground truncate">{dataset.name}</h3>
          <code className="text-caption font-mono hidden sm:inline">{sourceLabel}</code>
          {view && <StatusBadge status={view.status} className="hidden sm:inline-flex" />}
          <span className="hidden sm:inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-[10px] font-semibold text-muted-foreground">
            {datasetModeLabel(dataset.accessMode)}
          </span>
          <span className={`hidden sm:inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold ${datasetStatusClassName(dataset.dataStatus)}`}>
            {datasetDataStatusLabel(dataset.dataStatus)}
          </span>
        </div>
        <p className="text-body text-muted-foreground truncate mt-0.5">{dataset.description}</p>
      </div>
      <div className="hidden md:flex items-center gap-4 shrink-0 text-caption">
        <span>{totalColumns} colunas</span>
        <span>{dashboardCount} dashboards</span>
      </div>
      {onDelete && (
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 destructive-icon-btn"
          onClick={(event) => {
            event.stopPropagation();
            onDelete();
          }}
          aria-label={`Excluir dataset ${dataset.name}`}
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      )}
      <ArrowRight className="h-4 w-4 text-muted-foreground group-hover:text-accent shrink-0 transition-colors" />
    </motion.div>
  );
};

export default DatasetsPage;
