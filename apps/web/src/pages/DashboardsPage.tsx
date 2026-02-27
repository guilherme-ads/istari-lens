import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { motion } from "framer-motion";
import {
  ArrowRight,
  Search,
  LayoutGrid,
  List,
  LayoutDashboard,
  Plus,
  Activity,
  Clock3,
  Eye,
  Pencil,
  Share2,
  Trash2,
} from "lucide-react";

import EmptyState from "@/components/shared/EmptyState";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useCoreData } from "@/hooks/use-core-data";
import { api } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";

type CatalogItem = Awaited<ReturnType<typeof api.listDashboardCatalog>>[number];

const formatDateTimeBR = (value?: string | null) => {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return new Intl.DateTimeFormat("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
};

const loadBadgeClass = (score: number) => {
  if (score >= 75) return "bg-destructive/10 text-destructive border-destructive/30";
  if (score >= 45) return "bg-orange-500/10 text-orange-600 border-orange-300";
  return "bg-emerald-500/10 text-emerald-600 border-emerald-300";
};

const normalizeSearchText = (value: string) =>
  value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

const DashboardsPage = () => {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [search, setSearch] = useState("");
  const [viewMode, setViewMode] = useState<"grid" | "list">("grid");
  const [createOpen, setCreateOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<"mine" | "shared" | "org">("mine");
  const [shareOpen, setShareOpen] = useState(false);
  const [shareTarget, setShareTarget] = useState<CatalogItem | null>(null);

  const { datasets, isLoading, isError, errorMessage } = useCoreData();
  const catalogQuery = useQuery({
    queryKey: ["dashboard-catalog"],
    queryFn: () => api.listDashboardCatalog(),
  });

  const rows = useMemo(
    () => (catalogQuery.data || []).slice().sort((a, b) => new Date(b.last_edited_at).getTime() - new Date(a.last_edited_at).getTime()),
    [catalogQuery.data],
  );

  const filteredRows = useMemo(() => {
    if (!search) return rows;
    const q = normalizeSearchText(search);
    return rows.filter((item) =>
      normalizeSearchText(item.name).includes(q)
      || normalizeSearchText(item.dataset_name).includes(q)
      || normalizeSearchText(item.created_by_name || "").includes(q)
      || normalizeSearchText(item.created_by_email || "").includes(q));
  }, [rows, search]);

  const tabCounts = useMemo(() => ({
    mine: filteredRows.filter((item) => item.is_owner).length,
    shared: filteredRows.filter((item) => !item.is_owner && item.access_source === "direct").length,
    org: filteredRows.length,
  }), [filteredRows]);

  const visibleRows = useMemo(() => {
    if (search.trim()) return filteredRows;
    if (activeTab === "mine") return filteredRows.filter((item) => item.is_owner);
    if (activeTab === "shared") return filteredRows.filter((item) => !item.is_owner && item.access_source === "direct");
    return filteredRows;
  }, [activeTab, filteredRows, search]);

  const totalWidgets = useMemo(() => rows.reduce((acc, row) => acc + row.widget_count, 0), [rows]);
  const avgLatency = useMemo(() => {
    const weighted = rows
      .filter((row) => row.avg_widget_execution_ms != null && row.telemetry_coverage > 0 && row.widget_count > 0)
      .map((row) => ({
        avg: row.avg_widget_execution_ms as number,
        weight: Math.max(1, Math.round(row.widget_count * row.telemetry_coverage)),
      }));
    if (weighted.length === 0) return null;
    const totalWeight = weighted.reduce((acc, item) => acc + item.weight, 0);
    const total = weighted.reduce((acc, item) => acc + (item.avg * item.weight), 0);
    return total / totalWeight;
  }, [rows]);

  const sharingQuery = useQuery({
    queryKey: ["dashboard-sharing", shareTarget?.id],
    queryFn: () => api.getDashboardSharing(shareTarget!.id),
    enabled: shareOpen && !!shareTarget?.id,
  });

  const updateVisibilityMutation = useMutation({
    mutationFn: (visibility: "private" | "workspace_view" | "workspace_edit") =>
      api.updateDashboardVisibility(shareTarget!.id, { visibility }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["dashboard-sharing", shareTarget?.id] });
      await queryClient.invalidateQueries({ queryKey: ["dashboard-catalog"] });
      await queryClient.invalidateQueries({ queryKey: ["dashboards"] });
      toast({ title: "Compartilhamento atualizado" });
    },
  });

  const upsertEmailShareMutation = useMutation({
    mutationFn: (payload: { email: string; permission: "view" | "edit" }) =>
      api.upsertDashboardEmailShare(shareTarget!.id, payload),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["dashboard-sharing", shareTarget?.id] });
      await queryClient.invalidateQueries({ queryKey: ["dashboard-catalog"] });
      await queryClient.invalidateQueries({ queryKey: ["dashboards"] });
      toast({ title: "Convite atualizado" });
    },
  });

  const deleteEmailShareMutation = useMutation({
    mutationFn: (shareId: number) => api.deleteDashboardEmailShare(shareTarget!.id, shareId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["dashboard-sharing", shareTarget?.id] });
      await queryClient.invalidateQueries({ queryKey: ["dashboard-catalog"] });
      await queryClient.invalidateQueries({ queryKey: ["dashboards"] });
      toast({ title: "Acesso removido" });
    },
  });

  const loading = isLoading || catalogQuery.isLoading;
  const hasError = isError || catalogQuery.isError;
  const resolvedError = errorMessage || (catalogQuery.error as Error | undefined)?.message || "Erro ao carregar dashboards";

  return (
    <div className="bg-background">
      <main className="container py-6 space-y-6">
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between"
        >
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-foreground">Dashboards</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Explore dashboards disponíveis e crie novos a partir de datasets.
            </p>
          </div>
          <Button
            className="bg-accent text-accent-foreground hover:bg-accent/90 shrink-0"
            onClick={() => setCreateOpen(true)}
          >
            <Plus className="h-4 w-4 mr-2" />
            Novo Dashboard
          </Button>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.05 }}
          className="flex flex-wrap gap-4 text-sm"
        >
          <div className="flex items-center gap-2 text-muted-foreground">
            <LayoutDashboard className="h-4 w-4 text-accent" />
            <span className="font-semibold text-foreground">{loading ? "..." : rows.length}</span> dashboards
          </div>
          <div className="h-4 w-px bg-border hidden sm:block" />
          <div className="flex items-center gap-2 text-muted-foreground">
            <Activity className="h-4 w-4 text-accent" />
            <span className="font-semibold text-foreground">{loading ? "..." : totalWidgets}</span> widgets
          </div>
          <div className="h-4 w-px bg-border hidden sm:block" />
          <div className="flex items-center gap-2 text-muted-foreground">
            <Clock3 className="h-4 w-4 text-accent" />
            <span className="font-semibold text-foreground">{loading ? "..." : avgLatency != null ? `${avgLatency.toFixed(1)} ms` : "-"}</span> latência média
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
              placeholder="Buscar por nome, dataset ou criador..."
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

        <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as "mine" | "shared" | "org")}> 
          <TabsList>
            <TabsTrigger value="mine">Meus dashboards ({tabCounts.mine})</TabsTrigger>
            <TabsTrigger value="shared">Compartilhados comigo ({tabCounts.shared})</TabsTrigger>
            <TabsTrigger value="org">Todos da organização ({tabCounts.org})</TabsTrigger>
          </TabsList>
        </Tabs>

        {hasError ? (
          <EmptyState
            icon={<LayoutDashboard className="h-5 w-5" />}
            title="Erro ao carregar dashboards"
            description={resolvedError}
          />
        ) : loading ? (
          <EmptyState
            icon={<LayoutDashboard className="h-5 w-5" />}
            title="Carregando dashboards"
            description="Aguarde enquanto buscamos os dados."
          />
        ) : visibleRows.length === 0 ? (
          <EmptyState
            icon={<LayoutDashboard className="h-5 w-5" />}
            title={search ? "Nenhum resultado encontrado" : "Nenhum dashboard disponível"}
            description={search ? "Tente ajustar sua busca." : "Crie seu primeiro dashboard para começar."}
            action={
              !search ? (
                <Button variant="outline" size="sm" onClick={() => setCreateOpen(true)}>
                  <Plus className="h-3.5 w-3.5 mr-1.5" /> Novo dashboard
                </Button>
              ) : undefined
            }
          />
        ) : viewMode === "grid" ? (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {visibleRows.map((item, i) => (
              <DashboardGridCard
                key={item.id}
                item={item}
                delay={i * 0.04}
                onOpen={() => navigate(`/datasets/${item.dataset_id}/dashboard/${item.id}`)}
                onEdit={item.access_level !== "view" ? () => navigate(`/datasets/${item.dataset_id}/builder/${item.id}`) : undefined}
                onShare={item.is_owner ? () => {
                  setShareTarget(item);
                  setShareOpen(true);
                } : undefined}
              />
            ))}
          </div>
        ) : (
          <div className="space-y-2">
            {visibleRows.map((item, i) => (
              <DashboardListItem
                key={item.id}
                item={item}
                delay={i * 0.03}
                onOpen={() => navigate(`/datasets/${item.dataset_id}/dashboard/${item.id}`)}
                onEdit={item.access_level !== "view" ? () => navigate(`/datasets/${item.dataset_id}/builder/${item.id}`) : undefined}
                onShare={item.is_owner ? () => {
                  setShareTarget(item);
                  setShareOpen(true);
                } : undefined}
              />
            ))}
          </div>
        )}
      </main>

      <CreateDashboardDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        datasets={datasets.map((dataset) => ({ id: dataset.id, name: dataset.name }))}
        onContinue={(datasetId) => navigate(`/datasets/${datasetId}/builder`)}
      />

      {shareTarget && (
        <ShareDashboardDialog
          open={shareOpen}
          onOpenChange={setShareOpen}
          dashboard={shareTarget}
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

const CreateDashboardDialog = ({
  open,
  onOpenChange,
  datasets,
  onContinue,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  datasets: Array<{ id: string; name: string }>;
  onContinue: (datasetId: string) => void;
}) => {
  const [datasetId, setDatasetId] = useState("");

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setDatasetId("");
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Novo Dashboard</DialogTitle>
          <DialogDescription>Selecione o dataset para iniciar a criação do dashboard.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4 pt-2">
          <div className="space-y-1.5">
            <Label className="text-xs font-semibold text-muted-foreground">Dataset <span className="text-destructive">*</span></Label>
            <Select value={datasetId} onValueChange={setDatasetId}>
              <SelectTrigger className="h-9 text-sm">
                <SelectValue placeholder="Selecione um dataset..." />
              </SelectTrigger>
              <SelectContent>
                {datasets.length === 0
                  ? <SelectItem value="__none__" disabled>Nenhum dataset disponível</SelectItem>
                  : datasets.map((dataset) => (
                    <SelectItem key={dataset.id} value={dataset.id}>{dataset.name}</SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </div>
          <Button
            className="w-full bg-accent text-accent-foreground hover:bg-accent/90"
            disabled={!datasetId}
            onClick={() => {
              onContinue(datasetId);
              onOpenChange(false);
              setDatasetId("");
            }}
          >
            Continuar para Builder
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
};

const DashboardGridCard = ({
  item,
  delay,
  onOpen,
  onEdit,
  onShare,
}: {
  item: CatalogItem;
  delay: number;
  onOpen: () => void;
  onEdit?: () => void;
  onShare?: () => void;
}) => (
  <motion.div
    initial={{ opacity: 0, y: 14 }}
    animate={{ opacity: 1, y: 0 }}
    transition={{ delay, duration: 0.35 }}
    className="group glass-card p-5 text-left transition-all hover:shadow-card-hover flex flex-col gap-3"
  >
    <div className="flex items-start justify-between">
      <button
        type="button"
        onClick={onOpen}
        className="flex h-9 w-9 items-center justify-center rounded-lg bg-accent/10 text-accent group-hover:bg-accent group-hover:text-accent-foreground transition-colors"
        aria-label={`Abrir dashboard ${item.name}`}
      >
        <LayoutDashboard className="h-4 w-4" />
      </button>
      <span className={`inline-flex rounded-full border px-2 py-0.5 text-[10px] font-semibold ${loadBadgeClass(item.load_score)}`}>
        Carga {item.load_score.toFixed(0)}
      </span>
    </div>

    <div className="space-y-1.5">
      <h3 className="font-semibold text-foreground leading-tight">{item.name}</h3>
      <code className="text-xs font-mono text-muted-foreground">{item.dataset_name}</code>
      <p className="text-sm text-muted-foreground line-clamp-2">
        Criado por {item.created_by_name || item.created_by_email || "Não identificado"}
      </p>
    </div>

    <div className="flex flex-wrap gap-1 mt-auto">
      <span className="inline-flex items-center rounded-md bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
        {item.widget_count} widgets
      </span>
      <span className="inline-flex items-center rounded-md bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
        Lat. {item.avg_widget_execution_ms != null ? `${item.avg_widget_execution_ms.toFixed(1)} ms` : "-"} {item.p95_widget_execution_ms != null ? `· p95 ${item.p95_widget_execution_ms} ms` : ""}
      </span>
    </div>

    <div className="flex items-center justify-between text-xs text-muted-foreground pt-2.5 border-t border-border">
      <span>{formatDateTimeBR(item.last_edited_at)}</span>
      <div className="flex items-center gap-1">
        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onOpen}>
          <Eye className="h-3.5 w-3.5" />
        </Button>
        {onEdit && (
          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onEdit}>
            <Pencil className="h-3.5 w-3.5" />
          </Button>
        )}
        {onShare && (
          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onShare}>
            <Share2 className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>
    </div>
  </motion.div>
);

const DashboardListItem = ({
  item,
  delay,
  onOpen,
  onEdit,
  onShare,
}: {
  item: CatalogItem;
  delay: number;
  onOpen: () => void;
  onEdit?: () => void;
  onShare?: () => void;
}) => (
  <motion.div
    initial={{ opacity: 0, x: -8 }}
    animate={{ opacity: 1, x: 0 }}
    transition={{ delay, duration: 0.3 }}
    className="group glass-card w-full p-4 text-left flex items-center gap-4 transition-all hover:shadow-card-hover"
  >
    <button
      type="button"
      onClick={onOpen}
      className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent group-hover:bg-accent group-hover:text-accent-foreground transition-colors"
      aria-label={`Abrir dashboard ${item.name}`}
    >
      <LayoutDashboard className="h-4 w-4" />
    </button>
    <div className="min-w-0 flex-1">
      <div className="flex items-center gap-2">
        <h3 className="font-semibold text-foreground truncate">{item.name}</h3>
        <code className="text-xs font-mono text-muted-foreground hidden sm:inline">{item.dataset_name}</code>
      </div>
      <p className="text-sm text-muted-foreground truncate mt-0.5">
        {item.created_by_name || item.created_by_email || "Não identificado"} | {formatDateTimeBR(item.last_edited_at)}
      </p>
    </div>
    <div className="hidden md:flex items-center gap-4 shrink-0 text-xs text-muted-foreground">
      <span>{item.widget_count} widgets</span>
      <span className={`inline-flex rounded-full border px-2 py-0.5 font-semibold ${loadBadgeClass(item.load_score)}`}>
        {item.load_score.toFixed(0)}
      </span>
    </div>
    <Button variant="ghost" size="icon" className="h-8 w-8" onClick={onOpen}>
      <Eye className="h-4 w-4" />
    </Button>
    {onEdit && (
      <Button variant="ghost" size="icon" className="h-8 w-8" onClick={onEdit}>
        <Pencil className="h-4 w-4" />
      </Button>
    )}
    {onShare && (
      <Button variant="ghost" size="icon" className="h-8 w-8" onClick={onShare}>
        <Share2 className="h-4 w-4" />
      </Button>
    )}
    <ArrowRight className="h-4 w-4 text-muted-foreground group-hover:text-accent shrink-0 transition-colors" />
  </motion.div>
);

const ShareDashboardDialog = ({
  open,
  onOpenChange,
  dashboard,
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
  dashboard: CatalogItem;
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
  const [email, setEmail] = useState("");
  const [permission, setPermission] = useState<"view" | "edit">("view");
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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Compartilhar dashboard</DialogTitle>
          <DialogDescription>{dashboard.name}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>Escopo global do ambiente</Label>
            <Select
              value={visibility || "private"}
              onValueChange={(value) => onVisibilityChange(value as "private" | "workspace_view" | "workspace_edit")}
              disabled={loading || updatingVisibility}
            >
              <SelectTrigger className="h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="private">Privado (somente dono)</SelectItem>
                <SelectItem value="workspace_view">Todos podem ver</SelectItem>
                <SelectItem value="workspace_edit">Todos podem editar</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label>Convidar por e-mail</Label>
            <div className="grid gap-2 sm:grid-cols-[1fr_160px_auto]">
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
                  placeholder="email@empresa.com"
                  disabled={sharingByEmail}
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="none"
                  spellCheck={false}
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
                <SelectTrigger className="h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="view">Pode ver</SelectItem>
                  <SelectItem value="edit">Pode editar</SelectItem>
                </SelectContent>
              </Select>
              <Button
                onClick={() => {
                  if (!canInvite) return;
                  onShareByEmail({ email: normalizedEmail, permission });
                  setEmail("");
                  setSelectedEmail(null);
                }}
                disabled={sharingByEmail || !canInvite}
              >
                Compartilhar
              </Button>
            </div>
          </div>

          <div className="space-y-2">
            <Label>Acessos por e-mail</Label>
            {shares.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nenhum e-mail convidado.</p>
            ) : (
              <div className="space-y-2">
                {shares.map((share) => (
                  <div key={share.id} className="flex items-center justify-between rounded-md border border-border px-3 py-2">
                    <div className="text-sm">
                      <p className="font-medium">{share.email}</p>
                      <p className="text-muted-foreground">{share.permission === "edit" ? "Pode editar" : "Pode ver"}</p>
                    </div>
                    <Button variant="ghost" size="icon" disabled={removingShare} onClick={() => onRemoveShare(share.id)}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};

export default DashboardsPage;
