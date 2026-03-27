import { useMemo } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { AnimatePresence, motion } from "framer-motion";
import {
  Plus, ChevronLeft, BarChart3, LayoutDashboard, Clock,
  MoreHorizontal, Trash2, Pencil, FolderOpen, Database,
} from "lucide-react";

import EmptyState from "@/components/shared/EmptyState";
import ContextualBreadcrumb from "@/components/shared/ContextualBreadcrumb";
import SkeletonCard from "@/components/shared/SkeletonCard";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useCoreData } from "@/hooks/use-core-data";
import type { Dashboard } from "@/types/dashboard";
import type { Dataset } from "@/types";
import { parseApiDate } from "@/lib/datetime";

const datasetDataStatusLabel = (status: Dataset["dataStatus"]): string => {
  if (status === "initializing") return "Inicializando";
  if (status === "ready") return "Pronto";
  if (status === "syncing") return "Sincronizando";
  if (status === "error") return "Erro";
  if (status === "drift_blocked") return "Drift bloqueado";
  if (status === "paused") return "Pausado";
  if (status === "draft") return "Rascunho";
  return status;
};

const datasetStatusClassName = (status: Dataset["dataStatus"]): string => {
  if (status === "ready") return "bg-success/10 text-success";
  if (status === "syncing" || status === "initializing") return "bg-warning/10 text-warning";
  if (status === "error" || status === "drift_blocked") return "bg-destructive/10 text-destructive";
  return "bg-muted text-muted-foreground";
};

const formatDateTime = (value?: string | null): string => {
  if (!value) return "-";
  const date = parseApiDate(value);
  if (!date) return "-";
  return date.toLocaleString("pt-BR");
};

const DatasetDetailPage = () => {
  const navigate = useNavigate();
  const { datasetId } = useParams<{ datasetId: string }>();
  const { datasets, views, dashboards, isLoading, isError, errorMessage } = useCoreData();
  const showLoadingSkeleton = isLoading;

  const dataset = useMemo(() => datasets.find((d) => d.id === datasetId), [datasets, datasetId]);
  const view = useMemo(() => (dataset ? views.find((v) => v.id === dataset.viewId) : undefined), [dataset, views]);
  const sourceLabel = useMemo(() => {
    if (!dataset) return "-";
    if (view) return `${view.schema}.${view.name}`;
    return String((dataset.baseQuerySpec?.base as { primary_resource?: string } | undefined)?.primary_resource || "dataset semantico");
  }, [dataset, view]);
  const semanticColumns = dataset?.semanticColumns || [];
  const datasetDashboards = useMemo(() => dashboards.filter((d) => d.datasetId === datasetId), [dashboards, datasetId]);

  if (isError) {
    return <div className="bg-background"><main className="app-container py-6"><EmptyState icon={<Database className="h-5 w-5" />} title="Erro ao carregar dataset" description={errorMessage} /></main></div>;
  }
  if (!dataset && !showLoadingSkeleton) {
    return <div className="bg-background flex flex-col flex-1"><div className="flex-1 flex items-center justify-center"><div className="text-center space-y-3"><h2 className="text-title text-foreground">Dataset nao encontrado</h2><Button variant="outline" onClick={() => navigate("/datasets")}><ChevronLeft className="h-4 w-4 mr-1" /> Voltar</Button></div></div></div>;
  }

  return (
    <div className="bg-background">
      <main className="app-container py-6 space-y-8">
        <AnimatePresence mode="wait">
          {showLoadingSkeleton ? (
            <motion.div key="dataset-detail-skeleton" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="space-y-6">
              <div className="space-y-3"><Skeleton className="h-4 w-56 max-w-full" /><div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between mb-3"><div className="flex items-start gap-4"><Skeleton className="h-12 w-12 rounded-xl" /><div className="space-y-2"><Skeleton className="h-8 w-64 max-w-full" /><Skeleton className="h-4 w-80 max-w-full" /><Skeleton className="h-3 w-72 max-w-full" /></div></div><Skeleton className="h-10 w-40" /></div></div>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{Array.from({ length: 6 }).map((_, i) => <SkeletonCard key={`dashboard-skeleton-${i}`} variant="dashboard" />)}</div>
            </motion.div>
          ) : (
            <motion.div key="dataset-detail-content" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
              <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
                <ContextualBreadcrumb className="mb-3" items={[{ label: "Datasets", href: "/datasets" }, { label: dataset.name }]} />
                <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between mb-3">
                  <div className="flex items-start gap-4">
                    <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent"><FolderOpen className="h-5 w-5" /></div>
                    <div>
                      <h1 className="text-display text-foreground">{dataset.name}</h1>
                      <p className="text-body text-muted-foreground mt-1.5">{dataset.description}</p>
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        <span className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-[10px] font-semibold text-muted-foreground">{dataset.accessMode === "imported" ? "Imported" : "Direct"}</span>
                        <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold ${datasetStatusClassName(dataset.dataStatus)}`}>{datasetDataStatusLabel(dataset.dataStatus)}</span>
                        <span className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-[10px] font-semibold text-muted-foreground">Ultimo sync: {formatDateTime(dataset.lastSuccessfulSyncAt || undefined)}</span>
                      </div>
                      {view && <div className="flex items-center gap-3 mt-2 text-caption"><span className="flex items-center gap-1"><Database className="h-3 w-3" />{sourceLabel}</span><span>{semanticColumns.length > 0 ? semanticColumns.length : (view?.columns.length || 0)} colunas</span>{view && <span>{view.rowCount.toLocaleString()} linhas</span>}</div>}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <Button variant="outline" onClick={() => navigate(`/datasets/${datasetId}/edit`)}><Pencil className="h-4 w-4 mr-2" />Editar Dataset</Button>
                    <Button className="bg-accent text-accent-foreground hover:bg-accent/90" onClick={() => navigate(`/datasets/${datasetId}/builder`)}><Plus className="h-4 w-4 mr-2" />Novo Dashboard</Button>
                  </div>
                </div>
              </motion.div>

              <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }} className="space-y-3">
                <h2 className="text-heading flex items-center gap-2"><BarChart3 className="h-3.5 w-3.5" />Dashboards ({datasetDashboards.length})</h2>
                {datasetDashboards.length === 0 ? (
                  <EmptyState icon={<LayoutDashboard className="h-5 w-5" />} title="Nenhum dashboard ainda" description="Crie seu primeiro dashboard para visualizar os dados deste dataset." action={<Button variant="outline" size="sm" onClick={() => navigate(`/datasets/${datasetId}/builder`)}><Plus className="h-3.5 w-3.5 mr-1.5" /> Criar dashboard</Button>} />
                ) : (
                  <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    {datasetDashboards.map((dash, i) => <DashboardCard key={dash.id} dashboard={dash} delay={i * 0.04} onClick={() => navigate(`/datasets/${datasetId}/dashboard/${dash.id}`)} />)}
                    <motion.button initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: datasetDashboards.length * 0.04, duration: 0.35 }} onClick={() => navigate(`/datasets/${datasetId}/builder`)} className="flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-border/60 text-muted-foreground hover:border-accent/40 hover:text-accent transition-all min-h-[140px] p-6"><Plus className="h-6 w-6" /><span className="text-caption font-medium">Novo Dashboard</span></motion.button>
                  </div>
                )}
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>
      </main>
    </div>
  );
};

const DashboardCard = ({
  dashboard,
  delay,
  onClick,
}: {
  dashboard: Dashboard;
  delay: number;
  onClick: () => void;
}) => {
  const sectionCount = dashboard.sections.length;
  const widgetCount = dashboard.sections.reduce((t, s) => t + s.widgets.length, 0);

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
      className="group glass-card interactive-card p-5 text-left flex flex-col gap-3"
    >
      <div className="flex items-start justify-between">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-accent/10 text-accent group-hover:bg-accent group-hover:text-accent-foreground transition-colors"><LayoutDashboard className="h-4 w-4" /></div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild><button className="rounded-md p-1 text-muted-foreground opacity-0 group-hover:opacity-100 hover:bg-secondary transition-all" onClick={(e) => e.stopPropagation()}><MoreHorizontal className="h-4 w-4" /></button></DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem><Pencil className="h-3.5 w-3.5 mr-2" /> Renomear</DropdownMenuItem>
            <DropdownMenuItem className="text-destructive focus:text-destructive"><Trash2 className="h-3.5 w-3.5 mr-2" /> Excluir</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <div className="space-y-1">
        <h3 className="font-bold text-foreground leading-tight">{dashboard.title}</h3>
        <p className="text-caption">{sectionCount} {sectionCount === 1 ? "secao" : "secoes"} . {widgetCount} {widgetCount === 1 ? "widget" : "widgets"}</p>
      </div>
      <div className="flex items-center justify-between text-caption pt-2.5 border-t border-border mt-auto">
        <span className="flex items-center gap-1"><Clock className="h-3 w-3" />{(parseApiDate(dashboard.updatedAt)?.toLocaleDateString("pt-BR")) || "-"}</span>
        <span className="flex items-center gap-1 text-accent font-semibold group-hover:gap-2 transition-all">Editar <Pencil className="h-3 w-3" /></span>
      </div>
    </motion.div>
  );
};

export default DatasetDetailPage;
