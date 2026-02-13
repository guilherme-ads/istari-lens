import { useMemo } from "react";
import { useNavigate, useParams, Link } from "react-router-dom";
import { motion } from "framer-motion";
import {
  Plus, ChevronLeft, BarChart3, LayoutDashboard, Clock,
  MoreHorizontal, Trash2, Pencil, FolderOpen, Database,
} from "lucide-react";

import EmptyState from "@/components/shared/EmptyState";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useCoreData } from "@/hooks/use-core-data";
import type { Dashboard } from "@/types/dashboard";

const DatasetDetailPage = () => {
  const navigate = useNavigate();
  const { datasetId } = useParams<{ datasetId: string }>();
  const { datasets, views, dashboards, isLoading, isError, errorMessage } = useCoreData();

  const dataset = useMemo(() => datasets.find((d) => d.id === datasetId), [datasets, datasetId]);
  const view = useMemo(() => (dataset ? views.find((v) => v.id === dataset.viewId) : undefined), [dataset, views]);
  const datasetDashboards = useMemo(
    () => dashboards.filter((d) => d.datasetId === datasetId),
    [dashboards, datasetId],
  );

  if (isError) {
    return (
      <div className="bg-background">
        <main className="container py-6">
          <EmptyState icon={<Database className="h-5 w-5" />} title="Erro ao carregar dataset" description={errorMessage} />
        </main>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="bg-background">
        <main className="container py-6">
          <EmptyState icon={<FolderOpen className="h-5 w-5" />} title="Carregando dataset" description="Aguarde enquanto buscamos os dados." />
        </main>
      </div>
    );
  }

  if (!dataset) {
    return (
      <div className="bg-background flex flex-col flex-1">
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center space-y-3">
            <h2 className="text-lg font-semibold text-foreground">Dataset nao encontrado</h2>
            <Button variant="outline" onClick={() => navigate("/datasets")}>
              <ChevronLeft className="h-4 w-4 mr-1" /> Voltar
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-background">
      <main className="container py-6 space-y-6">
        <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-3">
            <Link to="/datasets" className="hover:text-foreground transition-colors">Datasets</Link>
            <span>/</span>
            <span className="text-foreground font-medium truncate">{dataset.name}</span>
          </div>
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div className="flex items-start gap-4">
              <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent">
                <FolderOpen className="h-5 w-5" />
              </div>
              <div>
                <h1 className="text-2xl font-bold tracking-tight text-foreground">{dataset.name}</h1>
                <p className="text-sm text-muted-foreground mt-0.5">{dataset.description}</p>
                {view && (
                  <div className="flex items-center gap-3 mt-2 text-xs text-muted-foreground">
                    <span className="flex items-center gap-1">
                      <Database className="h-3 w-3" />
                      {view.schema}.{view.name}
                    </span>
                    <span>{view.columns.length} colunas</span>
                    <span>{view.rowCount.toLocaleString()} linhas</span>
                  </div>
                )}
              </div>
            </div>
            <Button
              className="bg-accent text-accent-foreground hover:bg-accent/90 shrink-0"
              onClick={() => navigate(`/datasets/${datasetId}/builder`)}
            >
              <Plus className="h-4 w-4 mr-2" />
              Novo Dashboard
            </Button>
          </div>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1 }}
          className="space-y-3"
        >
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-2">
            <BarChart3 className="h-3.5 w-3.5" />
            Dashboards ({datasetDashboards.length})
          </h2>

          {datasetDashboards.length === 0 ? (
            <EmptyState
              icon={<LayoutDashboard className="h-5 w-5" />}
              title="Nenhum dashboard ainda"
              description="Crie seu primeiro dashboard para visualizar os dados deste dataset."
              action={
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => navigate(`/datasets/${datasetId}/builder`)}
                >
                  <Plus className="h-3.5 w-3.5 mr-1.5" /> Criar dashboard
                </Button>
              }
            />
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {datasetDashboards.map((dash, i) => (
                <DashboardCard
                  key={dash.id}
                  dashboard={dash}
                  delay={i * 0.04}
                  onClick={() => navigate(`/datasets/${datasetId}/dashboard/${dash.id}`)}
                />
              ))}

              <motion.button
                initial={{ opacity: 0, y: 14 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: datasetDashboards.length * 0.04, duration: 0.35 }}
                onClick={() => navigate(`/datasets/${datasetId}/builder`)}
                className="flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-border/60 text-muted-foreground hover:border-accent/40 hover:text-accent transition-all min-h-[140px] p-6"
              >
                <Plus className="h-6 w-6" />
                <span className="text-xs font-medium">Novo Dashboard</span>
              </motion.button>
            </div>
          )}
        </motion.div>
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
    <motion.button
      initial={{ opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay, duration: 0.35 }}
      onClick={onClick}
      className="group glass-card p-5 text-left transition-all hover:shadow-card-hover flex flex-col gap-3"
    >
      <div className="flex items-start justify-between">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-accent/10 text-accent group-hover:bg-accent group-hover:text-accent-foreground transition-colors">
          <LayoutDashboard className="h-4 w-4" />
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              className="rounded-md p-1 text-muted-foreground opacity-0 group-hover:opacity-100 hover:bg-secondary transition-all"
              onClick={(e) => e.stopPropagation()}
            >
              <MoreHorizontal className="h-4 w-4" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem>
              <Pencil className="h-3.5 w-3.5 mr-2" /> Renomear
            </DropdownMenuItem>
            <DropdownMenuItem className="text-destructive focus:text-destructive">
              <Trash2 className="h-3.5 w-3.5 mr-2" /> Excluir
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div className="space-y-1">
        <h3 className="font-semibold text-foreground leading-tight">{dashboard.title}</h3>
        <p className="text-xs text-muted-foreground">
          {sectionCount} {sectionCount === 1 ? "secao" : "secoes"} . {widgetCount} {widgetCount === 1 ? "widget" : "widgets"}
        </p>
      </div>

      <div className="flex items-center justify-between text-xs text-muted-foreground pt-2.5 border-t border-border mt-auto">
        <span className="flex items-center gap-1">
          <Clock className="h-3 w-3" />
          {new Date(dashboard.updatedAt).toLocaleDateString("pt-BR")}
        </span>
        <span className="flex items-center gap-1 text-accent font-semibold group-hover:gap-2 transition-all">
          Editar <Pencil className="h-3 w-3" />
        </span>
      </div>
    </motion.button>
  );
};

export default DatasetDetailPage;
