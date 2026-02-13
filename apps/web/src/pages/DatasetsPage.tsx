import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { motion } from "framer-motion";
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
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useCoreData } from "@/hooks/use-core-data";
import { api, ApiError } from "@/lib/api";
import { getStoredUser } from "@/lib/auth";
import type { Dataset, Datasource, View } from "@/types";
import { useToast } from "@/hooks/use-toast";

const DatasetsPage = () => {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [search, setSearch] = useState("");
  const [viewMode, setViewMode] = useState<"grid" | "list">("grid");
  const [createOpen, setCreateOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Dataset | null>(null);
  const isAdmin = !!getStoredUser()?.is_admin;
  const { datasets: allDatasets, views, datasources, isLoading, isError, errorMessage } = useCoreData();

  const datasets = useMemo(() => {
    if (!search) return allDatasets;
    const q = search.toLowerCase();
    return allDatasets.filter(
      (d) =>
        d.name.toLowerCase().includes(q) ||
        d.description.toLowerCase().includes(q),
    );
  }, [allDatasets, search]);

  const totalDashboards = useMemo(
    () => allDatasets.reduce((s, d) => s + d.dashboardIds.length, 0),
    [allDatasets],
  );

  const createDataset = useMutation({
    mutationFn: (payload: { name: string; description: string; datasourceId: string; viewId: string }) => {
      return api.createDataset({
        datasource_id: Number(payload.datasourceId),
        view_id: Number(payload.viewId),
        name: payload.name,
        description: payload.description,
      });
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["datasets"] }),
        queryClient.invalidateQueries({ queryKey: ["dashboards"] }),
      ]);
      toast({ title: "Dataset criado com sucesso" });
      setCreateOpen(false);
    },
    onError: (error: unknown) => {
      const message = error instanceof ApiError ? error.detail || error.message : "Falha ao criar dataset";
      toast({ title: "Erro ao criar dataset", description: message, variant: "destructive" });
    },
  });

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
      <main className="container py-6 space-y-6">
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between"
        >
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-foreground">Datasets</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Explore os datasets disponiveis e crie dashboards.
            </p>
          </div>
          {isAdmin && (
            <Button
              className="bg-accent text-accent-foreground hover:bg-accent/90 shrink-0"
              onClick={() => setCreateOpen(true)}
            >
              <Plus className="h-4 w-4 mr-2" />
              Novo Dataset
            </Button>
          )}
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.05 }}
          className="flex flex-wrap gap-4 text-sm"
        >
          <div className="flex items-center gap-2 text-muted-foreground">
            <Layers className="h-4 w-4 text-accent" />
            <span className="font-semibold text-foreground">{isLoading ? "..." : datasets.length}</span> datasets
          </div>
          <div className="h-4 w-px bg-border hidden sm:block" />
          <div className="flex items-center gap-2 text-muted-foreground">
            <BarChart3 className="h-4 w-4 text-accent" />
            <span className="font-semibold text-foreground">{isLoading ? "..." : totalDashboards}</span> dashboards
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
        ) : isLoading ? (
          <EmptyState
            icon={<FolderOpen className="h-5 w-5" />}
            title="Carregando datasets"
            description="Aguarde enquanto buscamos os dados."
          />
        ) : datasets.length === 0 ? (
          <EmptyState
            icon={<FolderOpen className="h-5 w-5" />}
            title={search ? "Nenhum resultado encontrado" : "Nenhum dataset disponivel"}
            description={search ? "Tente ajustar sua busca." : "Crie seu primeiro dataset para comecar."}
            action={
              !search && isAdmin ? (
                <Button variant="outline" size="sm" onClick={() => setCreateOpen(true)}>
                  <Plus className="h-3.5 w-3.5 mr-1.5" /> Criar dataset
                </Button>
              ) : undefined
            }
          />
        ) : viewMode === "grid" ? (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
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
          </div>
        ) : (
          <div className="space-y-2">
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
          </div>
        )}
      </main>

      {isAdmin && (
        <CreateDatasetDialog
          open={createOpen}
          onOpenChange={setCreateOpen}
          datasources={datasources}
          views={views}
          submitting={createDataset.isPending}
          onCreate={({ name, description, datasourceId, viewId }) => createDataset.mutate({ name, description, datasourceId, viewId })}
        />
      )}
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

const CreateDatasetDialog = ({
  open,
  onOpenChange,
  datasources,
  views,
  submitting,
  onCreate,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  datasources: Datasource[];
  views: View[];
  submitting: boolean;
  onCreate: (payload: { name: string; description: string; datasourceId: string; viewId: string }) => void;
}) => {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [datasourceId, setDatasourceId] = useState("");
  const [viewId, setViewId] = useState("");
  const activeDatasources = datasources.filter((ds) => ds.status === "active");
  const activeViews = views.filter((v) => v.status === "active" && (!datasourceId || v.datasourceId === datasourceId));

  const handleCreate = () => {
    if (!name || !datasourceId || !viewId) return;
    onCreate({ name, description, datasourceId, viewId });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Novo Dataset</DialogTitle>
          <DialogDescription>Selecione o datasource e a view para criar um novo dataset.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4 pt-2">
          <div className="space-y-1.5">
            <Label className="text-xs font-semibold text-muted-foreground">Nome <span className="text-destructive">*</span></Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Ex: Sales Pipeline" />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs font-semibold text-muted-foreground">Descricao</Label>
            <Textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Descreva o proposito deste dataset..." rows={2} />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs font-semibold text-muted-foreground">Datasource <span className="text-destructive">*</span></Label>
            <Select
              value={datasourceId}
              onValueChange={(value) => {
                setDatasourceId(value);
                setViewId("");
              }}
            >
              <SelectTrigger className="h-9 text-sm">
                <SelectValue placeholder="Selecione um datasource..." />
              </SelectTrigger>
              <SelectContent>
                {activeDatasources.map((ds) => (
                  <SelectItem key={ds.id} value={ds.id}>
                    {ds.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs font-semibold text-muted-foreground">View <span className="text-destructive">*</span></Label>
            <Select value={viewId} onValueChange={setViewId} disabled={!datasourceId}>
              <SelectTrigger className="h-9 text-sm">
                <SelectValue placeholder={datasourceId ? "Selecione uma view..." : "Selecione um datasource primeiro"} />
              </SelectTrigger>
              <SelectContent>
                {activeViews.map((v) => (
                  <SelectItem key={v.id} value={v.id}>
                    <span className="font-medium">{v.schema}.{v.name}</span>
                    <span className="text-muted-foreground text-xs ml-2">({v.columns.length} cols)</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button
            className="w-full bg-accent text-accent-foreground hover:bg-accent/90"
            disabled={!name || !datasourceId || !viewId || submitting}
            onClick={handleCreate}
          >
            {submitting ? "Criando..." : "Criar Dataset"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
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
      className="group glass-card p-5 text-left transition-all hover:shadow-card-hover flex flex-col gap-3 cursor-pointer"
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
              className="h-7 w-7 text-destructive hover:text-destructive"
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
        <h3 className="font-semibold text-foreground leading-tight">{dataset.name}</h3>
        {view && <code className="text-xs font-mono text-muted-foreground">{view.schema}.{view.name}</code>}
        <p className="text-sm text-muted-foreground line-clamp-2">{dataset.description}</p>
      </div>
      {view && (
        <div className="flex flex-wrap gap-1 mt-auto">
          {view.columns.slice(0, 4).map((col) => (
            <span key={col.name} className="inline-flex items-center rounded-md bg-muted px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground">
              {col.name}
            </span>
          ))}
          {view.columns.length > 4 && (
            <span className="inline-flex items-center rounded-md bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
              +{view.columns.length - 4}
            </span>
          )}
        </div>
      )}
      <div className="flex items-center justify-between text-xs text-muted-foreground pt-2.5 border-t border-border">
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
      className="group glass-card w-full p-4 text-left flex items-center gap-4 transition-all hover:shadow-card-hover cursor-pointer"
    >
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent group-hover:bg-accent group-hover:text-accent-foreground transition-colors">
        <FolderOpen className="h-4 w-4" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <h3 className="font-semibold text-foreground truncate">{dataset.name}</h3>
          {view && <code className="text-xs font-mono text-muted-foreground hidden sm:inline">{view.schema}.{view.name}</code>}
          {view && <StatusBadge status={view.status} className="hidden sm:inline-flex" />}
        </div>
        <p className="text-sm text-muted-foreground truncate mt-0.5">{dataset.description}</p>
      </div>
      <div className="hidden md:flex items-center gap-4 shrink-0 text-xs text-muted-foreground">
        {view && <span>{view.columns.length} colunas</span>}
        <span>{dashboardCount} dashboards</span>
      </div>
      {onDelete && (
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 text-destructive hover:text-destructive"
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
