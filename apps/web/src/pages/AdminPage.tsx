import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { motion } from "framer-motion";
import {
  Plus, RefreshCw, Trash2, Power, PowerOff, Database,
  Search, Eye, EyeOff, ServerCog, Layers,
  Activity, AlertCircle, Clock, FileSpreadsheet, ArrowLeft, ArrowRightLeft,
} from "lucide-react";

import StatusBadge from "@/components/shared/StatusBadge";
import ConfirmDialog from "@/components/shared/ConfirmDialog";
import LoadingButton from "@/components/shared/LoadingButton";
import EmptyState from "@/components/shared/EmptyState";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { useToast } from "@/hooks/use-toast";
import { useCoreData } from "@/hooks/use-core-data";
import { api, ApiDatasourceDeletionImpact, ApiError } from "@/lib/api";
import { isInternalWorkspaceDatasource } from "@/lib/datasource-visibility";
import SpreadsheetImportFlow from "@/components/shared/SpreadsheetImportFlow";

const SourceTypePill = ({ type }: { type: "database" | "spreadsheet" }) => (
  <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold ${
    type === "spreadsheet"
      ? "bg-emerald-500/10 text-emerald-600"
      : "bg-accent/10 text-accent"
  }`}>
    {type === "spreadsheet" ? <FileSpreadsheet className="h-3 w-3" /> : <Database className="h-3 w-3" />}
    {type === "spreadsheet" ? "Planilha" : "Banco"}
  </span>
);

const StatCard = ({
  icon: Icon,
  label,
  value,
  detail,
  delay = 0,
}: {
  icon: typeof Database;
  label: string;
  value: string | number;
  detail?: string;
  delay?: number;
}) => (
  <motion.div
    initial={{ opacity: 0, y: 8 }}
    animate={{ opacity: 1, y: 0 }}
    transition={{ delay, duration: 0.35 }}
    className="glass-card p-4 flex items-start gap-3"
  >
    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent">
      <Icon className="h-4 w-4" />
    </div>
    <div className="min-w-0">
      <p className="text-caption font-medium">{label}</p>
      <p className="text-title text-foreground">{value}</p>
      {detail && <p className="text-caption mt-0.5 truncate">{detail}</p>}
    </div>
  </motion.div>
);

const ActionBtn = ({
  tooltip,
  onClick,
  disabled,
  destructive,
  children,
}: {
  tooltip: string;
  onClick: () => void;
  disabled?: boolean;
  destructive?: boolean;
  children: React.ReactNode;
}) => (
  <Tooltip>
    <TooltipTrigger asChild>
      <Button
        variant="ghost"
        size="icon"
        className={`h-8 w-8 ${destructive ? "text-destructive hover:text-destructive hover:bg-destructive/10" : "text-muted-foreground hover:text-foreground"}`}
        onClick={onClick}
        disabled={disabled}
      >
        {children}
      </Button>
    </TooltipTrigger>
    <TooltipContent side="top" className="text-xs">{tooltip}</TooltipContent>
  </Tooltip>
);

const AdminPage = () => {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { datasources, views: tables, isLoading, isError, errorMessage } = useCoreData();

  const [deleteTarget, setDeleteTarget] = useState<{ type: "ds" | "table"; id: string; name: string } | null>(null);
  const [syncingId, setSyncingId] = useState<string | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [sourceType, setSourceType] = useState<"database" | "spreadsheet" | null>(null);
  const [dsSearch, setDsSearch] = useState("");
  const [dsTypeFilter, setDsTypeFilter] = useState<"all" | "database" | "spreadsheet">("all");
  const [tableSearch, setTableSearch] = useState("");
  const [deleteImpact, setDeleteImpact] = useState<ApiDatasourceDeletionImpact | null>(null);
  const [loadingDeleteImpactId, setLoadingDeleteImpactId] = useState<string | null>(null);
  const [enablingImportedDatasourceId, setEnablingImportedDatasourceId] = useState<string | null>(null);

  const [formName, setFormName] = useState("");
  const [formSchema, setFormSchema] = useState("");
  const [formUrl, setFormUrl] = useState("");
  const [formDesc, setFormDesc] = useState("");
  const [formCopyPolicy, setFormCopyPolicy] = useState<"allowed" | "forbidden">("allowed");
  const [formDefaultDatasetAccessMode, setFormDefaultDatasetAccessMode] = useState<"direct" | "imported">("direct");

  const resetSheetForm = () => {
    setSourceType(null);
    setFormName("");
    setFormSchema("");
    setFormUrl("");
    setFormDesc("");
    setFormCopyPolicy("allowed");
    setFormDefaultDatasetAccessMode("direct");
  };

  const visibleDatasources = useMemo(
    () => datasources.filter((datasource) => !isInternalWorkspaceDatasource(datasource)),
    [datasources],
  );

  const visibleDatasourceIds = useMemo(
    () => new Set(visibleDatasources.map((datasource) => datasource.id)),
    [visibleDatasources],
  );

  const visibleTables = useMemo(
    () => tables.filter((view) => visibleDatasourceIds.has(view.datasourceId)),
    [tables, visibleDatasourceIds],
  );

  const stats = useMemo(() => ({
    totalDs: visibleDatasources.length,
    activeDs: visibleDatasources.filter((d) => d.status === "active").length,
    totalTables: visibleTables.length,
    activeTables: visibleTables.filter((v) => v.status === "active").length,
  }), [visibleDatasources, visibleTables]);

  const filteredDs = useMemo(() => {
    const byType = dsTypeFilter === "all"
      ? visibleDatasources
      : visibleDatasources.filter((d) => d.sourceType === dsTypeFilter);
    if (!dsSearch) return byType;
    const q = dsSearch.toLowerCase();
    return byType.filter((d) =>
      d.name.toLowerCase().includes(q) || d.schemaPattern.toLowerCase().includes(q),
    );
  }, [visibleDatasources, dsSearch, dsTypeFilter]);

  const filteredTables = useMemo(() => {
    if (!tableSearch) return visibleTables;
    const q = tableSearch.toLowerCase();
    return visibleTables.filter((v) =>
      v.name.toLowerCase().includes(q) || v.schema.toLowerCase().includes(q),
    );
  }, [visibleTables, tableSearch]);

  const createDatasource = useMutation({
    mutationFn: () =>
      api.createDatasource({
        name: formName,
        schema_pattern: formSchema || undefined,
        database_url: formUrl,
        description: formDesc || undefined,
        copy_policy: formCopyPolicy,
        default_dataset_access_mode: formDefaultDatasetAccessMode,
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["datasources"] });
      setSheetOpen(false);
      resetSheetForm();
      toast({ title: "Datasource registrado" });
    },
    onError: (error: unknown) => {
      const message = error instanceof ApiError ? error.detail || error.message : "Falha ao registrar datasource";
      toast({ title: "Erro ao registrar datasource", description: message, variant: "destructive" });
    },
  });

  const enableImportedDatasets = useMutation({
    mutationFn: async (datasourceId: string) => {
      setEnablingImportedDatasourceId(datasourceId);
      return api.enableImportedDatasetsForDatasource(Number(datasourceId), {});
    },
    onSuccess: async (payload) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["datasets"] }),
        queryClient.invalidateQueries({ queryKey: ["datasources"] }),
      ]);
      toast({
        title: "Modo imported habilitado",
        description: `${payload.updated_count} datasets atualizados, ${payload.run_enqueued_count} syncs enfileirados.`,
      });
    },
    onError: (error: unknown) => {
      const message = error instanceof ApiError ? error.detail || error.message : "Falha ao habilitar imported";
      toast({ title: "Erro ao habilitar imported", description: message, variant: "destructive" });
    },
    onSettled: () => {
      setEnablingImportedDatasourceId(null);
    },
  });

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formName || !formUrl) return;
    createDatasource.mutate();
  };

  const handleSync = async (id: string) => {
    setSyncingId(id);
    try {
      await api.syncDatasource(Number(id));
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["datasources"] }),
        queryClient.invalidateQueries({ queryKey: ["views"] }),
        queryClient.invalidateQueries({ queryKey: ["datasets"] }),
      ]);
      toast({ title: "Sync concluido", description: "Dados sincronizados com sucesso." });
    } catch (error) {
      const message = error instanceof ApiError ? error.detail || error.message : "Falha ao sincronizar";
      toast({ title: "Erro de sync", description: message, variant: "destructive" });
    } finally {
      setSyncingId(null);
    }
  };

  const toggleStatus = async (type: "ds" | "table", id: string) => {
    try {
      if (type === "ds") {
        const datasource = datasources.find((ds) => ds.id === id);
        if (!datasource) return;
        await api.updateDatasource(Number(id), { is_active: datasource.status !== "active" });
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ["datasources"] }),
          queryClient.invalidateQueries({ queryKey: ["datasets"] }),
          queryClient.invalidateQueries({ queryKey: ["dashboards"] }),
          queryClient.invalidateQueries({ queryKey: ["views"] }),
        ]);
      } else {
        const table = tables.find((v) => v.id === id);
        if (!table) return;
        await api.updateView(Number(id), { is_active: table.status !== "active" });
        await queryClient.invalidateQueries({ queryKey: ["views"] });
      }
      toast({ title: "Status atualizado" });
    } catch (error) {
      const message = error instanceof ApiError ? error.detail || error.message : "Falha ao atualizar status";
      toast({ title: "Erro ao atualizar", description: message, variant: "destructive" });
    }
  };

  const handleDatasourceDeleteRequest = async (id: string, name: string) => {
    setLoadingDeleteImpactId(id);
    try {
      const impact = await api.getDatasourceDeletionImpact(Number(id));
      setDeleteImpact(impact);
      setDeleteTarget({ type: "ds", id, name });
    } catch (error) {
      const message = error instanceof ApiError ? error.detail || error.message : "Falha ao carregar impacto da exclusao";
      toast({ title: "Erro ao preparar exclusao", description: message, variant: "destructive" });
    } finally {
      setLoadingDeleteImpactId(null);
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    try {
      if (deleteTarget.type === "ds") {
        await api.deleteDatasource(Number(deleteTarget.id));
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ["datasources"] }),
          queryClient.invalidateQueries({ queryKey: ["datasets"] }),
          queryClient.invalidateQueries({ queryKey: ["dashboards"] }),
          queryClient.invalidateQueries({ queryKey: ["views"] }),
        ]);
      } else {
        await api.deleteView(Number(deleteTarget.id));
        await queryClient.invalidateQueries({ queryKey: ["views"] });
      }
      toast({ title: "Removido com sucesso", description: `"${deleteTarget.name}" foi excluido.` });
      setDeleteTarget(null);
      setDeleteImpact(null);
    } catch (error) {
      const message = error instanceof ApiError ? error.detail || error.message : "Falha ao excluir";
      toast({ title: "Erro ao excluir", description: message, variant: "destructive" });
    }
  };

  if (isError) {
    return (
      <div className="bg-background">
        <main className="app-container py-6">
          <EmptyState icon={<Database className="h-5 w-5" />} title="Erro ao carregar administração" description={errorMessage} />
        </main>
      </div>
    );
  }

  return (
    <div className="bg-background">
      <main className="app-container py-6 space-y-8">
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between"
        >
          <div>
            <h1 className="text-display text-foreground">Fontes de Dados</h1>
            <p className="mt-1.5 text-body text-muted-foreground">
              Configure fontes de dados e gerencie tabelas disponíveis.
            </p>
          </div>

          <Sheet
            open={sheetOpen}
            onOpenChange={(open) => {
              setSheetOpen(open);
              if (!open) resetSheetForm();
            }}
          >
            <SheetTrigger asChild>
              <Button className="bg-accent text-accent-foreground hover:bg-accent/90 shrink-0">
                <Plus className="h-4 w-4 mr-2" />
                Nova Fonte
              </Button>
            </SheetTrigger>
            <SheetContent
              className={
                sourceType === "spreadsheet"
                  ? "flex h-full w-full max-w-full flex-col overflow-hidden sm:max-w-[96vw] lg:max-w-[1200px]"
                  : "sm:max-w-md overflow-y-auto"
              }
            >
              <SheetHeader>
                <SheetTitle>Adicionar Nova Fonte</SheetTitle>
              </SheetHeader>

              {!sourceType && (
                <div className="mt-6 grid grid-cols-1 gap-3">
                  <button
                    type="button"
                    onClick={() => setSourceType("database")}
                    className="glass-card p-4 text-left hover:border-accent/50 transition-colors"
                  >
                    <div className="flex items-start gap-3">
                      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent">
                        <Database className="h-5 w-5" />
                      </div>
                      <div>
                        <p className="font-bold text-foreground">Banco de Dados</p>
                        <p className="text-caption mt-0.5">
                          Conexão por URL para sincronizar tabelas existentes.
                        </p>
                      </div>
                    </div>
                  </button>
                  <button
                    type="button"
                    onClick={() => setSourceType("spreadsheet")}
                    className="glass-card p-4 text-left hover:border-emerald-500/50 transition-colors"
                  >
                    <div className="flex items-start gap-3">
                      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-600">
                        <FileSpreadsheet className="h-5 w-5" />
                      </div>
                      <div>
                        <p className="font-bold text-foreground">Planilha</p>
                        <p className="text-caption mt-0.5">
                          Upload de arquivo .csv ou .xlsx como nova fonte.
                        </p>
                      </div>
                    </div>
                  </button>
                </div>
              )}

              {sourceType === "database" && (
                <form onSubmit={handleRegister} className="mt-6 space-y-5">
                  <div className="space-y-2">
                    <Label htmlFor="ds-name">
                      Nome <span className="text-destructive">*</span>
                    </Label>
                    <Input
                      id="ds-name"
                      value={formName}
                      onChange={(e) => setFormName(e.target.value)}
                      placeholder="Ex: Production Analytics"
                      required
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="ds-schema">Schema Pattern</Label>
                    <Input
                      id="ds-schema"
                      value={formSchema}
                      onChange={(e) => setFormSchema(e.target.value)}
                      placeholder="Ex: analytics_*"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Copy Policy</Label>
                    <Select
                      value={formCopyPolicy}
                      onValueChange={(value) => {
                        const nextPolicy = value as "allowed" | "forbidden";
                        setFormCopyPolicy(nextPolicy);
                        if (nextPolicy === "forbidden" && formDefaultDatasetAccessMode === "imported") {
                          setFormDefaultDatasetAccessMode("direct");
                        }
                      }}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="allowed">allowed</SelectItem>
                        <SelectItem value="forbidden">forbidden</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label>Default Dataset Access Mode</Label>
                    <Select
                      value={formDefaultDatasetAccessMode}
                      onValueChange={(value) => setFormDefaultDatasetAccessMode(value as "direct" | "imported")}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="direct">direct</SelectItem>
                        <SelectItem value="imported" disabled={formCopyPolicy === "forbidden"}>imported</SelectItem>
                      </SelectContent>
                    </Select>
                    {formCopyPolicy === "forbidden" && (
                      <p className="text-caption text-muted-foreground">
                        Imported nao pode ser modo padrao quando copy policy for forbidden.
                      </p>
                    )}
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="ds-url">Database URL <span className="text-destructive">*</span></Label>
                    <Input
                      id="ds-url"
                      type="password"
                      value={formUrl}
                      onChange={(e) => setFormUrl(e.target.value)}
                      placeholder="postgresql://user:pass@host:5432/db"
                      required
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="ds-desc">Descrição</Label>
                    <Textarea
                      id="ds-desc"
                      value={formDesc}
                      onChange={(e) => setFormDesc(e.target.value)}
                      placeholder="Descreva o proposito deste datasource..."
                      rows={3}
                    />
                  </div>

                  <div className="flex gap-3 pt-2">
                    <LoadingButton
                      type="submit"
                      loading={createDatasource.isPending}
                      loadingText="Registrando..."
                      className="flex-1 bg-accent text-accent-foreground hover:bg-accent/90"
                    >
                      Registrar
                    </LoadingButton>
                    <Button type="button" variant="outline" onClick={() => setSourceType(null)}>
                      <ArrowLeft className="h-4 w-4 mr-1" />
                      Voltar
                    </Button>
                  </div>
                </form>
              )}

              {sourceType === "spreadsheet" && (
                <div className="mt-0 min-h-0 min-w-0 flex-1 overflow-hidden">
                  <SpreadsheetImportFlow
                    onBack={() => setSourceType(null)}
                    onCompleted={() => {
                      setSheetOpen(false);
                      resetSheetForm();
                    }}
                  />
                </div>
              )}
            </SheetContent>
          </Sheet>
        </motion.div>

        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatCard icon={ServerCog} label="Datasources" value={stats.totalDs} detail={`${stats.activeDs} ativos`} delay={0} />
          <StatCard icon={Activity} label="Ativos" value={stats.activeDs} detail={`de ${stats.totalDs} total`} delay={0.05} />
          <StatCard icon={Layers} label="Tabelas" value={stats.totalTables} detail={`${stats.activeTables} disponíveis`} delay={0.1} />
          <StatCard icon={AlertCircle} label="Inativos" value={stats.totalDs - stats.activeDs + stats.totalTables - stats.activeTables} detail="requerem atenção" delay={0.15} />
        </div>

        <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.2 }}>
          <Tabs defaultValue="datasources" className="space-y-4">
            <TabsList className="bg-muted/50">
              <TabsTrigger value="datasources" className="gap-1.5 data-[state=active]:bg-card data-[state=active]:shadow-card">
                <ServerCog className="h-3.5 w-3.5" />
                Datasources
                <span className="ml-1 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-semibold text-muted-foreground">
                  {visibleDatasources.length}
                </span>
              </TabsTrigger>
              <TabsTrigger value="views" className="gap-1.5 data-[state=active]:bg-card data-[state=active]:shadow-card">
                <Layers className="h-3.5 w-3.5" />
                Tabelas
                <span className="ml-1 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-semibold text-muted-foreground">
                  {visibleTables.length}
                </span>
              </TabsTrigger>
            </TabsList>

            <TabsContent value="datasources" className="space-y-4">
              <div className="flex flex-wrap items-center gap-3">
                <div className="relative max-w-sm flex-1 min-w-[220px]">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <Input
                    placeholder="Buscar datasources..."
                    value={dsSearch}
                    onChange={(e) => setDsSearch(e.target.value)}
                    className="pl-9 h-9"
                  />
                </div>
                <div className="flex items-center rounded-lg border border-border bg-card p-0.5">
                  <button
                    type="button"
                    onClick={() => setDsTypeFilter("all")}
                    className={`px-2.5 py-1.5 text-xs rounded-md ${dsTypeFilter === "all" ? "bg-secondary text-foreground" : "text-muted-foreground hover:text-foreground"}`}
                  >
                    Todos
                  </button>
                  <button
                    type="button"
                    onClick={() => setDsTypeFilter("database")}
                    className={`px-2.5 py-1.5 text-xs rounded-md ${dsTypeFilter === "database" ? "bg-secondary text-foreground" : "text-muted-foreground hover:text-foreground"}`}
                  >
                    Banco
                  </button>
                  <button
                    type="button"
                    onClick={() => setDsTypeFilter("spreadsheet")}
                    className={`px-2.5 py-1.5 text-xs rounded-md ${dsTypeFilter === "spreadsheet" ? "bg-secondary text-foreground" : "text-muted-foreground hover:text-foreground"}`}
                  >
                    Planilha
                  </button>
                </div>
              </div>

              {isLoading ? (
                <div className="glass-card p-4 text-body text-muted-foreground">Carregando...</div>
              ) : filteredDs.length === 0 ? (
                <EmptyState
                  icon={<Database className="h-5 w-5" />}
                  title={dsSearch ? "Nenhum resultado" : "Nenhum datasource registrado"}
                  description={dsSearch ? "Tente outro termo de busca." : "Clique em Nova Fonte para começar."}
                />
              ) : (
                <div className="glass-card overflow-hidden">
                  <Table>
                    <TableHeader>
                      <TableRow className="bg-muted/30 hover:bg-muted/30">
                        <TableHead className="text-heading">Nome</TableHead>
                        <TableHead className="text-heading">Tipo</TableHead>
                        <TableHead className="text-heading hidden xl:table-cell">Copy Policy</TableHead>
                        <TableHead className="text-heading hidden xl:table-cell">Default Mode</TableHead>
                        <TableHead className="text-heading hidden lg:table-cell">Ultimo Sync</TableHead>
                        <TableHead className="text-heading">Status</TableHead>
                        <TableHead className="text-heading text-right">Acoes</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {filteredDs.map((ds) => (
                        <TableRow key={ds.id}>
                          <TableCell>
                            <div>
                              <span className="font-medium text-foreground">{ds.name}</span>
                              {ds.description && (
                                <p className="text-caption mt-0.5 line-clamp-1 max-w-[240px]">
                                  {ds.description}
                                </p>
                              )}
                            </div>
                          </TableCell>
                          <TableCell>
                            <SourceTypePill type={ds.sourceType} />
                          </TableCell>
                          <TableCell className="hidden xl:table-cell">
                            <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                              ds.copyPolicy === "allowed"
                                ? "bg-success/10 text-success"
                                : "bg-destructive/10 text-destructive"
                            }`}>
                              {ds.copyPolicy}
                            </span>
                          </TableCell>
                          <TableCell className="hidden xl:table-cell">
                            <span className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-[10px] font-semibold text-muted-foreground">
                              {ds.defaultDatasetAccessMode}
                            </span>
                          </TableCell>
                          <TableCell className="hidden lg:table-cell">
                            <span className="text-caption flex items-center gap-1.5">
                              <Clock className="h-3 w-3" />
                              {ds.lastSync === "Never" ? "Nunca" : new Date(ds.lastSync).toLocaleDateString("pt-BR")}
                            </span>
                          </TableCell>
                          <TableCell>
                            <StatusBadge status={ds.status === "syncing" ? "syncing" : ds.status} />
                          </TableCell>
                          <TableCell>
                            <div className="flex items-center justify-end gap-0.5">
                              <ActionBtn
                                tooltip={ds.sourceType === "spreadsheet" ? "Não se aplica para planilha" : "Sincronizar"}
                                onClick={() => handleSync(ds.id)}
                                disabled={syncingId === ds.id || ds.sourceType === "spreadsheet"}
                              >
                                <RefreshCw className={`h-3.5 w-3.5 ${syncingId === ds.id ? "animate-spin" : ""}`} />
                              </ActionBtn>
                              <ActionBtn tooltip={ds.status === "active" ? "Desativar" : "Ativar"} onClick={() => toggleStatus("ds", ds.id)}>
                                {ds.status === "active" ? <PowerOff className="h-3.5 w-3.5" /> : <Power className="h-3.5 w-3.5" />}
                              </ActionBtn>
                              <ActionBtn
                                tooltip={
                                  ds.sourceType === "spreadsheet"
                                    ? "So para datasource de banco"
                                    : ds.copyPolicy === "forbidden"
                                      ? "Copy policy bloqueia imported"
                                      : "Migrar datasets para imported"
                                }
                                onClick={() => enableImportedDatasets.mutate(ds.id)}
                                disabled={
                                  ds.sourceType === "spreadsheet"
                                  || ds.copyPolicy === "forbidden"
                                  || enablingImportedDatasourceId === ds.id
                                }
                              >
                                <ArrowRightLeft className={`h-3.5 w-3.5 ${enablingImportedDatasourceId === ds.id ? "animate-pulse" : ""}`} />
                              </ActionBtn>
                              {ds.status === "inactive" && (
                                <ActionBtn
                                  tooltip={loadingDeleteImpactId === ds.id ? "Carregando impacto..." : "Excluir"}
                                  onClick={() => handleDatasourceDeleteRequest(ds.id, ds.name)}
                                  disabled={loadingDeleteImpactId === ds.id}
                                  destructive
                                >
                                  <Trash2 className="h-3.5 w-3.5" />
                                </ActionBtn>
                              )}
                            </div>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </TabsContent>

            <TabsContent value="views" className="space-y-4">
              <div className="relative max-w-sm">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Buscar tabelas..."
                  value={tableSearch}
                  onChange={(e) => setTableSearch(e.target.value)}
                  className="pl-9 h-9"
                />
              </div>

              {isLoading ? (
                <div className="glass-card p-4 text-body text-muted-foreground">Carregando...</div>
              ) : filteredTables.length === 0 ? (
                <EmptyState
                  icon={<Layers className="h-5 w-5" />}
                  title={tableSearch ? "Nenhum resultado" : "Nenhuma tabela registrada"}
                  description={tableSearch ? "Tente outro termo de busca." : "Faca sync de um datasource para descobrir tabelas."}
                />
              ) : (
                <div className="glass-card overflow-hidden">
                  <Table>
                    <TableHeader>
                      <TableRow className="bg-muted/30 hover:bg-muted/30">
                        <TableHead className="text-heading">Tabela</TableHead>
                        <TableHead className="text-heading">Schema</TableHead>
                        <TableHead className="text-heading hidden lg:table-cell">Detalhes</TableHead>
                        <TableHead className="text-heading">Status</TableHead>
                        <TableHead className="text-heading text-right">Acoes</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {filteredTables.map((table) => (
                        <TableRow key={table.id}>
                          <TableCell>
                            <div>
                              <span className="font-medium text-foreground">{table.name}</span>
                              {table.description && (
                                <p className="text-caption mt-0.5 line-clamp-1 max-w-[280px]">
                                  {table.description}
                                </p>
                              )}
                            </div>
                          </TableCell>
                          <TableCell>
                            <code className="text-caption font-mono bg-muted px-1.5 py-0.5 rounded">{table.schema}</code>
                          </TableCell>
                          <TableCell className="hidden lg:table-cell">
                            <span className="text-caption">
                              {table.columns.length} colunas . {table.rowCount.toLocaleString()} linhas
                            </span>
                          </TableCell>
                          <TableCell>
                            <StatusBadge status={table.status} />
                          </TableCell>
                          <TableCell>
                            <div className="flex items-center justify-end gap-0.5">
                              <ActionBtn tooltip={table.status === "active" ? "Desativar" : "Ativar"} onClick={() => toggleStatus("table", table.id)}>
                                {table.status === "active" ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                              </ActionBtn>
                              {table.status === "inactive" && (
                                <ActionBtn tooltip="Excluir" onClick={() => setDeleteTarget({ type: "table", id: table.id, name: table.name })} destructive>
                                  <Trash2 className="h-3.5 w-3.5" />
                                </ActionBtn>
                              )}
                            </div>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </TabsContent>
          </Tabs>
        </motion.div>
      </main>

      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={() => {
          setDeleteTarget(null);
          setDeleteImpact(null);
        }}
        title="Confirmar exclusao"
        description={
          deleteTarget?.type === "ds"
            ? `Tem certeza que deseja remover "${deleteTarget?.name}"? Esta ação removera tambem datasets e dashboards vinculados.`
            : `Tem certeza que deseja remover "${deleteTarget?.name}"? Esta ação não pode ser desfeita.`
        }
        details={
          deleteTarget?.type === "ds" && deleteImpact ? (
            <div className="mt-2 rounded-md border border-border bg-muted/30 p-3 space-y-2">
              <p className="text-caption text-foreground">
                Impacto: {deleteImpact.datasets_count} datasets e {deleteImpact.dashboards_count} dashboards serao excluidos.
              </p>
              {deleteImpact.dashboards_count > 0 && (
                <div className="max-h-40 overflow-auto rounded border border-border bg-background p-2">
                  <ul className="space-y-1">
                    {deleteImpact.dashboards.map((item) => (
                      <li key={item.dashboard_id} className="text-caption">
                        #{item.dashboard_id} . {item.dashboard_name} . {item.dataset_name}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          ) : undefined
        }
        confirmLabel="Excluir"
        onConfirm={handleDelete}
        destructive
      />
    </div>
  );
};

export default AdminPage;




