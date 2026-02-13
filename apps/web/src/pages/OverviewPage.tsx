import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { motion } from "framer-motion";
import { useQueries } from "@tanstack/react-query";
import {
  Layers, BarChart3, Database, Activity, Plus, ArrowRight,
  Clock, TrendingUp, FolderOpen, LayoutDashboard,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import EmptyState from "@/components/shared/EmptyState";
import { useCoreData } from "@/hooks/use-core-data";
import { api } from "@/lib/api";
import { getStoredUser } from "@/lib/auth";

const OverviewPage = () => {
  const navigate = useNavigate();
  const user = getStoredUser();
  const { datasets, dashboards, datasources, views, hasToken, isLoading, isError, errorMessage } = useCoreData();

  const activeDatasources = datasources.filter((d) => d.status === "active");
  const activeViews = views.filter((v) => v.status === "active");

  const datasetIdByViewId = useMemo(() => {
    const map = new Map<string, number>();
    datasets.forEach((dataset) => {
      if (!map.has(dataset.viewId)) {
        map.set(dataset.viewId, Number(dataset.id));
      }
    });
    return map;
  }, [datasets]);

  const volumeQueries = useQueries({
    queries: activeViews.map((view) => {
      const datasetId = datasetIdByViewId.get(view.id);
      return {
        queryKey: ["overview", "data-volume", view.id, datasetId],
        enabled: hasToken && typeof datasetId === "number",
        staleTime: 60_000,
        queryFn: async () => {
          if (typeof datasetId !== "number") return 0;

          const result = await api.previewQuery({
            datasetId,
            metrics: [{ field: "*", agg: "count" }],
            dimensions: [],
            filters: [],
            sort: [],
            limit: 1,
            offset: 0,
          });

          const firstRow = result.rows[0];
          if (!firstRow) return 0;

          const firstMetric = Object.values(firstRow).find((value) => typeof value === "number");
          return typeof firstMetric === "number" && Number.isFinite(firstMetric) ? firstMetric : 0;
        },
      };
    }),
  });

  const rowCountByViewId = useMemo(() => {
    const map = new Map<string, number>();
    activeViews.forEach((view, index) => {
      const queriedCount = volumeQueries[index]?.data;
      map.set(view.id, typeof queriedCount === "number" ? queriedCount : view.rowCount);
    });
    return map;
  }, [activeViews, volumeQueries]);

  const totalRows = useMemo(
    () => Array.from(rowCountByViewId.values()).reduce((sum, count) => sum + count, 0),
    [rowCountByViewId],
  );

  const stats = [
    { label: "Datasources ativos", value: activeDatasources.length, icon: Database, color: "text-accent" },
    { label: "Views disponíveis", value: activeViews.length, icon: Activity, color: "text-accent" },
    { label: "Datasets", value: datasets.length, icon: Layers, color: "text-accent" },
    { label: "Dashboards", value: dashboards.length, icon: BarChart3, color: "text-accent" },
  ];

  const recentDatasets = [...datasets]
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, 5);

  const recentDashboards = [...dashboards]
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    .slice(0, 5);

  if (isError) {
    return (
      <div className="bg-background">
        <main className="container py-6">
          <EmptyState icon={<Database className="h-5 w-5" />} title="Erro ao carregar visão geral" description={errorMessage} />
        </main>
      </div>
    );
  }

  return (
    <div className="bg-background">
      <main className="container py-6 space-y-8">
        {/* Header */}
        <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">Visão Geral</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Acompanhe seus dados, datasets e dashboards em um só lugar.
          </p>
        </motion.div>

        {/* Stats */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {stats.map((stat, i) => (
            <motion.div
              key={stat.label}
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: i * 0.06 }}
              className="glass-card p-5 flex items-start gap-3"
            >
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent/10">
                <stat.icon className={`h-5 w-5 ${stat.color}`} />
              </div>
              <div>
                <p className="text-2xl font-extrabold tracking-tight text-foreground">{stat.value}</p>
                <p className="text-xs text-muted-foreground mt-0.5">{stat.label}</p>
              </div>
            </motion.div>
          ))}
        </div>

        {/* Quick actions */}
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.25 }}
          className="glass-card p-5"
        >
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-4">Ações rápidas</h2>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <button
              onClick={() => navigate("/datasets")}
              className="group flex items-center gap-3 rounded-xl border border-border p-4 text-left hover:border-accent/40 hover:bg-accent/5 transition-all"
            >
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent group-hover:bg-accent group-hover:text-accent-foreground transition-colors">
                <FolderOpen className="h-4 w-4" />
              </div>
              <div>
                <p className="text-sm font-semibold text-foreground">Explorar Datasets</p>
                <p className="text-xs text-muted-foreground">Veja todos os datasets disponíveis</p>
              </div>
            </button>
            {user?.is_admin && (
              <button
                onClick={() => navigate("/admin")}
                className="group flex items-center gap-3 rounded-xl border border-border p-4 text-left hover:border-accent/40 hover:bg-accent/5 transition-all"
              >
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent group-hover:bg-accent group-hover:text-accent-foreground transition-colors">
                  <Database className="h-4 w-4" />
                </div>
                <div>
                  <p className="text-sm font-semibold text-foreground">Gerenciar Fontes</p>
                  <p className="text-xs text-muted-foreground">Configure datasources e views</p>
                </div>
              </button>
            )}
            <button
              onClick={() => navigate("/datasets")}
              className="group flex items-center gap-3 rounded-xl border border-border p-4 text-left hover:border-accent/40 hover:bg-accent/5 transition-all"
            >
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent group-hover:bg-accent group-hover:text-accent-foreground transition-colors">
                <Plus className="h-4 w-4" />
              </div>
              <div>
                <p className="text-sm font-semibold text-foreground">Novo Dataset</p>
                <p className="text-xs text-muted-foreground">Crie um dataset e comece a analisar</p>
              </div>
            </button>
          </div>
        </motion.div>

        {/* Two-column: recent datasets + dashboards */}
        <div className="grid gap-6 lg:grid-cols-2">
          {/* Recent Datasets */}
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.3 }}
            className="glass-card p-5"
          >
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-2">
                <Layers className="h-3.5 w-3.5" /> Datasets recentes
              </h2>
              <Button variant="ghost" size="sm" className="text-xs text-accent h-7" onClick={() => navigate("/datasets")}>
                Ver todos <ArrowRight className="h-3 w-3 ml-1" />
              </Button>
            </div>
            <div className="space-y-2">
              {recentDatasets.map((ds) => {
                const view = views.find((v) => v.id === ds.viewId);
                return (
                  <button
                    key={ds.id}
                    onClick={() => navigate(`/datasets/${ds.id}`)}
                    className="group w-full flex items-center gap-3 rounded-lg p-3 text-left hover:bg-secondary/50 transition-colors"
                  >
                    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent">
                      <FolderOpen className="h-3.5 w-3.5" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-semibold text-foreground truncate">{ds.name}</p>
                      <p className="text-xs text-muted-foreground truncate">
                        {view ? `${view.schema}.${view.name}` : "—"} · {ds.dashboardIds.length} dashboards
                      </p>
                    </div>
                    <div className="text-xs text-muted-foreground hidden sm:flex items-center gap-1">
                      <Clock className="h-3 w-3" />
                      {new Date(ds.createdAt).toLocaleDateString("pt-BR")}
                    </div>
                  </button>
                );
              })}
            </div>
          </motion.div>

          {/* Recent Dashboards */}
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.35 }}
            className="glass-card p-5"
          >
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-2">
                <BarChart3 className="h-3.5 w-3.5" /> Dashboards recentes
              </h2>
            </div>
            {recentDashboards.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-8 text-center">
                <LayoutDashboard className="h-8 w-8 text-muted-foreground/40 mb-2" />
                <p className="text-sm text-muted-foreground">Nenhum dashboard criado ainda.</p>
              </div>
            ) : (
              <div className="space-y-2">
                {recentDashboards.map((dash) => {
                  const dataset = datasets.find((d) => d.id === dash.datasetId);
                  const widgetCount = dash.sections.reduce((t, s) => t + s.widgets.length, 0);
                  return (
                    <button
                      key={dash.id}
                      onClick={() => dataset && navigate(`/datasets/${dataset.id}/dashboard/${dash.id}`)}
                      className="group w-full flex items-center gap-3 rounded-lg p-3 text-left hover:bg-secondary/50 transition-colors"
                    >
                      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent">
                        <LayoutDashboard className="h-3.5 w-3.5" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-semibold text-foreground truncate">{dash.title}</p>
                        <p className="text-xs text-muted-foreground truncate">
                          {dataset?.name || "—"} · {widgetCount} widgets
                        </p>
                      </div>
                      <div className="text-xs text-muted-foreground hidden sm:flex items-center gap-1">
                        <Clock className="h-3 w-3" />
                        {new Date(dash.updatedAt).toLocaleDateString("pt-BR")}
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </motion.div>
        </div>

        {/* Data volume */}
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.4 }}
          className="glass-card p-5"
        >
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-4 flex items-center gap-2">
            <TrendingUp className="h-3.5 w-3.5" /> Volume de dados
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            {activeViews.map((view) => {
              const rowCount = rowCountByViewId.get(view.id) || 0;
              const pct = totalRows > 0 ? Math.round((rowCount / totalRows) * 100) : 0;
              return (
                <div key={view.id} className="space-y-2">
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-medium text-foreground truncate">{view.schema}.{view.name}</span>
                    <span className="text-muted-foreground">{rowCount.toLocaleString()}</span>
                  </div>
                  <div className="h-2 rounded-full bg-muted overflow-hidden">
                    <motion.div
                      initial={{ width: 0 }}
                      animate={{ width: `${pct}%` }}
                      transition={{ delay: 0.5, duration: 0.6, ease: "easeOut" }}
                      className="h-full rounded-full bg-accent"
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </motion.div>
      </main>
    </div>
  );
};

export default OverviewPage;
