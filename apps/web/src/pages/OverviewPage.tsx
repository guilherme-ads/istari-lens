import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { motion } from "framer-motion";
import {
  BarChart3,
  Database,
  FileSpreadsheet,
  FolderOpen,
  LayoutDashboard,
  Link2,
  PencilLine,
  Sparkles,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import EmptyState from "@/components/shared/EmptyState";
import { useCoreData } from "@/hooks/use-core-data";
import { getStoredUser } from "@/lib/auth";
import { normalizeText } from "@/lib/text";

const getGreeting = (date: Date) => {
  const hour = date.getHours();
  if (hour < 12) return "Bom dia";
  if (hour < 18) return "Boa tarde";
  return "Boa noite";
};

const getFirstName = (fullName?: string | null, email?: string | null) => {
  const trimmed = normalizeText(fullName || "").trim();
  if (trimmed.length > 0) return trimmed.split(" ")[0];
  if (email && email.includes("@")) return email.split("@")[0];
  return "usuario";
};

const formatRelativeTime = (value: string) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";

  const now = Date.now();
  const diffMs = date.getTime() - now;
  const abs = Math.abs(diffMs);

  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  const week = 7 * day;
  const month = 30 * day;
  const year = 365 * day;

  const rtf = new Intl.RelativeTimeFormat("pt-BR", { numeric: "auto" });
  if (abs < hour) return rtf.format(Math.round(diffMs / minute), "minute");
  if (abs < day) return rtf.format(Math.round(diffMs / hour), "hour");
  if (abs < week) return rtf.format(Math.round(diffMs / day), "day");
  if (abs < month) return rtf.format(Math.round(diffMs / week), "week");
  if (abs < year) return rtf.format(Math.round(diffMs / month), "month");
  return rtf.format(Math.round(diffMs / year), "year");
};

const OverviewPage = () => {
  const navigate = useNavigate();
  const user = getStoredUser();
  const { datasets, dashboards, datasources, views, isLoading, isError, errorMessage } = useCoreData();

  const now = new Date();
  const firstName = getFirstName(user?.full_name, user?.email);
  const greeting = getGreeting(now);

  const dashboardsSorted = useMemo(
    () => [...dashboards].sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()),
    [dashboards],
  );

  const datasetsSorted = useMemo(
    () => [...datasets].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()),
    [datasets],
  );

  const lastEditedDashboard = dashboardsSorted[0];
  const datasetWithoutDashboard = datasetsSorted.find((dataset) => dataset.dashboardIds.length === 0);

  const totalWidgets = useMemo(
    () => dashboards.reduce((acc, dashboard) => acc + dashboard.sections.reduce((sum, sec) => sum + sec.widgets.length, 0), 0),
    [dashboards],
  );

  const datasetsWithDashboards = useMemo(
    () => datasets.filter((dataset) => dataset.dashboardIds.length > 0).length,
    [datasets],
  );

  const activeDatasources = useMemo(
    () => datasources.filter((datasource) => datasource.status === "active"),
    [datasources],
  );

  const activeSpreadsheetCount = useMemo(
    () => activeDatasources.filter((datasource) => datasource.sourceType === "spreadsheet").length,
    [activeDatasources],
  );

  const activeDatabaseCount = useMemo(
    () => activeDatasources.filter((datasource) => datasource.sourceType === "database").length,
    [activeDatasources],
  );

  const recentDatasets = datasetsSorted.slice(0, 6);
  const recentDashboards = dashboardsSorted.slice(0, 6);
  const suggestions = useMemo(() => {
    const items: Array<{
      key: string;
      icon: typeof PencilLine;
      title: string;
      description: string;
      detail?: string;
      className?: string;
      iconClassName?: string;
      onClick: () => void;
    }> = [];

    if (lastEditedDashboard) {
      items.push({
        key: "continue-editing",
        icon: PencilLine,
        title: "Continuar editando",
        description: lastEditedDashboard.title,
        detail: `Atualizado ${formatRelativeTime(lastEditedDashboard.updatedAt)}`,
        onClick: () => navigate(`/datasets/${lastEditedDashboard.datasetId}/dashboard/${lastEditedDashboard.id}`),
      });
    }

    if (datasetWithoutDashboard) {
      items.push({
        key: "first-dashboard",
        icon: Sparkles,
        title: "Criar primeiro dashboard",
        description: `Dataset ${datasetWithoutDashboard.name}`,
        detail: "Este dataset ainda nao tem dashboard.",
        className: "border-warning/40 bg-warning/10",
        iconClassName: "text-warning",
        onClick: () => navigate(`/datasets/${datasetWithoutDashboard.id}/builder`),
      });
    }

    if (user?.is_admin) {
      items.push({
        key: "new-datasource",
        icon: Database,
        title: "Conectar nova fonte",
        description: "Adicione bancos e planilhas para ampliar analises.",
        className: "border-success/40 bg-success/10",
        iconClassName: "text-success",
        onClick: () => navigate("/admin"),
      });
    }

    return items;
  }, [datasetWithoutDashboard, lastEditedDashboard, navigate, user?.is_admin]);

  if (isError) {
    return (
      <div className="bg-background">
        <main className="app-container py-6">
          <EmptyState icon={<Database className="h-5 w-5" />} title="Erro ao carregar visao geral" description={errorMessage} />
        </main>
      </div>
    );
  }

  return (
    <div className="bg-background">
      <main className="app-container py-6 space-y-8">
        <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="space-y-1.5">
          <h1 className="text-display text-foreground">
            {greeting}, {firstName}
          </h1>
          <p className="text-body text-muted-foreground">
            Voce tem {dashboards.length} {dashboards.length === 1 ? "dashboard ativo" : "dashboards ativos"}.
          </p>
        </motion.div>

        <section className="grid gap-4 md:grid-cols-3">
          <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="glass-card py-5 px-5">
            <div className="flex items-center justify-between">
              <p className="text-heading">Dashboards</p>
              <LayoutDashboard className="h-4 w-4 text-accent" />
            </div>
            {isLoading ? (
              <Skeleton className="mt-2 h-9 w-16" />
            ) : (
              <p className="mt-2 text-kpi-lg text-foreground">{dashboards.length}</p>
            )}
            <p className="mt-1 text-caption">{totalWidgets} widgets criados</p>
          </motion.div>

          <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.05 }} className="glass-card py-5 px-5">
            <div className="flex items-center justify-between">
              <p className="text-heading">Datasets</p>
              <FolderOpen className="h-4 w-4 text-accent" />
            </div>
            {isLoading ? (
              <Skeleton className="mt-2 h-9 w-16" />
            ) : (
              <p className="mt-2 text-kpi-lg text-foreground">{datasets.length}</p>
            )}
            <p className="mt-1 text-caption">{datasetsWithDashboards} com dashboards</p>
          </motion.div>

          <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }} className="glass-card py-5 px-5">
            <div className="flex items-center justify-between">
              <p className="text-heading">Fontes conectadas</p>
              <Link2 className="h-4 w-4 text-accent" />
            </div>
            {isLoading ? (
              <Skeleton className="mt-2 h-9 w-16" />
            ) : (
              <p className="mt-2 text-kpi-lg text-foreground">{activeDatasources.length}</p>
            )}
            <p className="mt-1 text-caption">
              {activeSpreadsheetCount} {activeSpreadsheetCount === 1 ? "planilha" : "planilhas"} · {activeDatabaseCount} {activeDatabaseCount === 1 ? "banco" : "bancos"}
            </p>
          </motion.div>
        </section>

        {suggestions.length > 0 && (
          <motion.section initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }} className="space-y-3">
            <h2 className="text-heading">Sugestoes para voce</h2>
            <div className="grid gap-3 md:grid-cols-3">
              {suggestions.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  onClick={item.onClick}
                  className={`glass-card interactive-card p-4 text-left ${item.className || ""}`}
                >
                  <div className="flex items-center gap-2">
                    <item.icon className={`h-4 w-4 ${item.iconClassName || "text-accent"}`} />
                    <p className="font-bold text-foreground">{item.title}</p>
                  </div>
                  <p className="mt-2 text-body text-muted-foreground line-clamp-1">{item.description}</p>
                  {item.detail && <p className="mt-1 text-caption">{item.detail}</p>}
                </button>
              ))}
            </div>
          </motion.section>
        )}

        <div className="grid gap-6 lg:grid-cols-2 2xl:grid-cols-3">
          <motion.section initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.15 }} className="glass-card p-5 2xl:col-span-2">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-heading">Datasets recentes</h2>
              <Button variant="ghost" size="sm" className="h-7 text-xs text-accent" onClick={() => navigate("/datasets")}>
                Ver todos
              </Button>
            </div>
            {isLoading ? (
              <div className="space-y-2">
                {[0, 1, 2, 3].map((i) => (
                  <div key={i} className="flex items-start gap-3 rounded-lg p-3">
                    <Skeleton className="h-8 w-8 shrink-0 rounded-lg" />
                    <div className="flex-1 space-y-1.5">
                      <Skeleton className="h-4 w-40" />
                      <Skeleton className="h-3 w-24" />
                    </div>
                    <Skeleton className="h-3 w-12" />
                  </div>
                ))}
              </div>
            ) : recentDatasets.length === 0 ? (
              <p className="text-caption">Nenhum dataset encontrado.</p>
            ) : (
              <div className="space-y-2">
                {recentDatasets.map((dataset) => {
                  const view = views.find((item) => item.id === dataset.viewId);
                  const datasource = datasources.find((item) => item.id === (view ? view.datasourceId : dataset.datasourceId));
                  const datasetSourceLabel = view
                    ? `${view.schema}.${view.name}`
                    : String((dataset.baseQuerySpec?.base as { primary_resource?: string } | undefined)?.primary_resource || "dataset semantico");
                  const isSpreadsheet = datasource?.sourceType === "spreadsheet";
                  const Icon = isSpreadsheet ? FileSpreadsheet : Database;
                  const iconClass = isSpreadsheet ? "text-success" : "text-accent";

                  return (
                    <Tooltip key={dataset.id}>
                      <TooltipTrigger asChild>
                        <button
                          onClick={() => navigate(`/datasets/${dataset.id}`)}
                          className="group flex w-full items-start gap-3 rounded-lg p-3 text-left transition-colors hover:bg-secondary/50"
                        >
                          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-secondary">
                            <Icon className={`h-4 w-4 ${iconClass}`} />
                          </div>
                          <div className="min-w-0 flex-1">
                            <p className="truncate font-bold text-foreground">{dataset.name}</p>
                            <p className="text-caption truncate">
                              {datasetSourceLabel} · {dataset.dashboardIds.length} {dataset.dashboardIds.length === 1 ? "dashboard" : "dashboards"}
                            </p>
                          </div>
                          <span className="hidden self-start pt-0.5 text-caption sm:inline">{formatRelativeTime(dataset.createdAt)}</span>
                        </button>
                      </TooltipTrigger>
                      <TooltipContent className="text-caption">
                        Colunas: {(dataset.semanticColumns.length > 0 ? dataset.semanticColumns.length : (view?.columns.length || 0))} - Linhas: {view ? view.rowCount.toLocaleString() : "-"}
                      </TooltipContent>
                    </Tooltip>
                  );
                })}
              </div>
            )}
          </motion.section>

          <motion.section initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.2 }} className="glass-card p-5">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-heading">Dashboards recentes</h2>
              <Button variant="ghost" size="sm" className="h-7 text-xs text-accent" onClick={() => navigate("/dashboards")}>
                Ver todos
              </Button>
            </div>
            {isLoading ? (
              <div className="space-y-2">
                {[0, 1, 2, 3].map((i) => (
                  <div key={i} className="flex items-start gap-3 rounded-lg p-3">
                    <Skeleton className="h-8 w-8 shrink-0 rounded-lg" />
                    <div className="flex-1 space-y-1.5">
                      <Skeleton className="h-4 w-40" />
                      <Skeleton className="h-3 w-24" />
                    </div>
                    <Skeleton className="h-3 w-12" />
                  </div>
                ))}
              </div>
            ) : recentDashboards.length === 0 ? (
              <p className="text-caption">Nenhum dashboard encontrado.</p>
            ) : (
              <div className="space-y-2">
                {recentDashboards.map((dashboard) => {
                  const dataset = datasets.find((item) => item.id === dashboard.datasetId);
                  const widgetCount = dashboard.sections.reduce((acc, section) => acc + section.widgets.length, 0);
                  const sectionCount = dashboard.sections.length;

                  return (
                    <Tooltip key={dashboard.id}>
                      <TooltipTrigger asChild>
                        <button
                          onClick={() => dataset && navigate(`/datasets/${dataset.id}/dashboard/${dashboard.id}`)}
                          className="group flex w-full items-start gap-3 rounded-lg p-3 text-left transition-colors hover:bg-secondary/50"
                        >
                          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent/10">
                            <BarChart3 className="h-4 w-4 text-accent" />
                          </div>
                          <div className="min-w-0 flex-1">
                            <p className="truncate font-bold text-foreground">{dashboard.title}</p>
                            <p className="text-caption truncate">
                              {dataset?.name || "-"} · {widgetCount} {widgetCount === 1 ? "widget" : "widgets"}
                            </p>
                          </div>
                          <span className="hidden self-start pt-0.5 text-caption sm:inline">{formatRelativeTime(dashboard.updatedAt)}</span>
                        </button>
                      </TooltipTrigger>
                      <TooltipContent className="text-caption">
                        {sectionCount} {sectionCount === 1 ? "seção" : "seções"} · {widgetCount} {widgetCount === 1 ? "widget" : "widgets"}
                      </TooltipContent>
                    </Tooltip>
                  );
                })}
              </div>
            )}
          </motion.section>
        </div>
      </main>
    </div>
  );
};

export default OverviewPage;

