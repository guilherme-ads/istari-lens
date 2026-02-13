import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { motion } from "framer-motion";
import {
  Plus, RefreshCw, Trash2, Power, PowerOff, Database,
  Search, Eye, EyeOff, ServerCog, Layers,
  Activity, AlertCircle, Clock,
} from "lucide-react";

import StatusBadge from "@/components/shared/StatusBadge";
import ConfirmDialog from "@/components/shared/ConfirmDialog";
import LoadingButton from "@/components/shared/LoadingButton";
import EmptyState from "@/components/shared/EmptyState";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { useToast } from "@/hooks/use-toast";
import { useCoreData } from "@/hooks/use-core-data";
import { api, ApiError } from "@/lib/api";
import type { Datasource, View } from "@/types";

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
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <p className="text-2xl font-bold tracking-tight text-foreground leading-tight">{value}</p>
      {detail && <p className="text-xs text-muted-foreground mt-0.5 truncate">{detail}</p>}
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
  const { datasources, views, isLoading, isError, errorMessage } = useCoreData();

  const [deleteTarget, setDeleteTarget] = useState<{ type: "ds" | "view"; id: string; name: string } | null>(null);
  const [syncingId, setSyncingId] = useState<string | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [dsSearch, setDsSearch] = useState("");
  const [viewSearch, setViewSearch] = useState("");

  const [formName, setFormName] = useState("");
  const [formSchema, setFormSchema] = useState("");
  const [formUrl, setFormUrl] = useState("");
  const [formDesc, setFormDesc] = useState("");

  const stats = useMemo(() => ({
    totalDs: datasources.length,
    activeDs: datasources.filter((d) => d.status === "active").length,
    totalViews: views.length,
    activeViews: views.filter((v) => v.status === "active").length,
  }), [datasources, views]);

  const filteredDs = useMemo(() => {
    if (!dsSearch) return datasources;
    const q = dsSearch.toLowerCase();
    return datasources.filter((d) =>
      d.name.toLowerCase().includes(q) || d.schemaPattern.toLowerCase().includes(q),
    );
  }, [datasources, dsSearch]);

  const filteredViews = useMemo(() => {
    if (!viewSearch) return views;
    const q = viewSearch.toLowerCase();
    return views.filter((v) =>
      v.name.toLowerCase().includes(q) || v.schema.toLowerCase().includes(q),
    );
  }, [views, viewSearch]);

  const createDatasource = useMutation({
    mutationFn: () =>
      api.createDatasource({
        name: formName,
        schema_pattern: formSchema || undefined,
        database_url: formUrl,
        description: formDesc || undefined,
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["datasources"] });
      setFormName(""); setFormSchema(""); setFormUrl(""); setFormDesc("");
      setSheetOpen(false);
      toast({ title: "Datasource registrado" });
    },
    onError: (error: unknown) => {
      const message = error instanceof ApiError ? error.detail || error.message : "Falha ao registrar datasource";
      toast({ title: "Erro ao registrar datasource", description: message, variant: "destructive" });
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

  const toggleStatus = async (type: "ds" | "view", id: string) => {
    try {
      if (type === "ds") {
        const datasource = datasources.find((ds) => ds.id === id);
        if (!datasource) return;
        await api.updateDatasource(Number(id), { is_active: datasource.status !== "active" });
        await queryClient.invalidateQueries({ queryKey: ["datasources"] });
      } else {
        const view = views.find((v) => v.id === id);
        if (!view) return;
        await api.updateView(Number(id), { is_active: view.status !== "active" });
        await queryClient.invalidateQueries({ queryKey: ["views"] });
      }
      toast({ title: "Status atualizado" });
    } catch (error) {
      const message = error instanceof ApiError ? error.detail || error.message : "Falha ao atualizar status";
      toast({ title: "Erro ao atualizar", description: message, variant: "destructive" });
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    try {
      if (deleteTarget.type === "ds") {
        await api.deleteDatasource(Number(deleteTarget.id));
        await queryClient.invalidateQueries({ queryKey: ["datasources"] });
      } else {
        await api.deleteView(Number(deleteTarget.id));
        await queryClient.invalidateQueries({ queryKey: ["views"] });
      }
      toast({ title: "Removido com sucesso", description: `"${deleteTarget.name}" foi excluido.` });
      setDeleteTarget(null);
    } catch (error) {
      const message = error instanceof ApiError ? error.detail || error.message : "Falha ao excluir";
      toast({ title: "Erro ao excluir", description: message, variant: "destructive" });
    }
  };

  if (isError) {
    return (
      <div className="bg-background">
        <main className="container py-6">
          <EmptyState icon={<Database className="h-5 w-5" />} title="Erro ao carregar administracao" description={errorMessage} />
        </main>
      </div>
    );
  }

  return (
    <div className="bg-background">
      <main className="container py-6 space-y-6">
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between"
        >
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-foreground">Gerenciamento</h1>
            <p className="text-sm text-muted-foreground mt-0.5">
              Configure datasources e gerencie views disponiveis.
            </p>
          </div>

          <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
            <SheetTrigger asChild>
              <Button className="bg-accent text-accent-foreground hover:bg-accent/90 shrink-0">
                <Plus className="h-4 w-4 mr-2" />
                Novo Datasource
              </Button>
            </SheetTrigger>
            <SheetContent className="sm:max-w-md">
              <SheetHeader>
                <SheetTitle>Registrar Datasource</SheetTitle>
                <SheetDescription>
                  {/* Cliente pediu remover "istari" do texto visivel; para reverter, restaurar "Istari Lens". */}
                  Conecte uma nova fonte de dados ao Lens App.
                </SheetDescription>
              </SheetHeader>
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
                  <Label htmlFor="ds-desc">Descricao</Label>
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
                  <Button type="button" variant="outline" onClick={() => setSheetOpen(false)}>
                    Cancelar
                  </Button>
                </div>
              </form>
            </SheetContent>
          </Sheet>
        </motion.div>

        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatCard icon={ServerCog} label="Datasources" value={stats.totalDs} detail={`${stats.activeDs} ativos`} delay={0} />
          <StatCard icon={Activity} label="Ativos" value={stats.activeDs} detail={`de ${stats.totalDs} total`} delay={0.05} />
          <StatCard icon={Layers} label="Views" value={stats.totalViews} detail={`${stats.activeViews} disponiveis`} delay={0.1} />
          <StatCard icon={AlertCircle} label="Inativos" value={stats.totalDs - stats.activeDs + stats.totalViews - stats.activeViews} detail="requerem atencao" delay={0.15} />
        </div>

        <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.2 }}>
          <Tabs defaultValue="datasources" className="space-y-4">
            <TabsList className="bg-muted/50">
              <TabsTrigger value="datasources" className="gap-1.5 data-[state=active]:bg-card data-[state=active]:shadow-card">
                <ServerCog className="h-3.5 w-3.5" />
                Datasources
                <span className="ml-1 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-semibold text-muted-foreground">
                  {datasources.length}
                </span>
              </TabsTrigger>
              <TabsTrigger value="views" className="gap-1.5 data-[state=active]:bg-card data-[state=active]:shadow-card">
                <Layers className="h-3.5 w-3.5" />
                Views
                <span className="ml-1 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-semibold text-muted-foreground">
                  {views.length}
                </span>
              </TabsTrigger>
            </TabsList>

            <TabsContent value="datasources" className="space-y-4">
              <div className="relative max-w-sm">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Buscar datasources..."
                  value={dsSearch}
                  onChange={(e) => setDsSearch(e.target.value)}
                  className="pl-9 h-9"
                />
              </div>

              {isLoading ? (
                <div className="glass-card p-4 text-sm text-muted-foreground">Carregando...</div>
              ) : filteredDs.length === 0 ? (
                <EmptyState
                  icon={<Database className="h-5 w-5" />}
                  title={dsSearch ? "Nenhum resultado" : "Nenhum datasource registrado"}
                  description={dsSearch ? "Tente outro termo de busca." : "Clique em Novo Datasource para comecar."}
                />
              ) : (
                <div className="glass-card overflow-hidden">
                  <Table>
                    <TableHeader>
                      <TableRow className="bg-muted/30 hover:bg-muted/30">
                        <TableHead className="font-semibold">Nome</TableHead>
                        <TableHead className="font-semibold">Schema</TableHead>
                        <TableHead className="font-semibold hidden lg:table-cell">Ultimo Sync</TableHead>
                        <TableHead className="font-semibold">Status</TableHead>
                        <TableHead className="font-semibold text-right">Acoes</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {filteredDs.map((ds) => (
                        <TableRow key={ds.id}>
                          <TableCell>
                            <div>
                              <span className="font-medium text-foreground">{ds.name}</span>
                              {ds.description && (
                                <p className="text-xs text-muted-foreground mt-0.5 line-clamp-1 max-w-[240px]">
                                  {ds.description}
                                </p>
                              )}
                            </div>
                          </TableCell>
                          <TableCell>
                            <code className="text-xs font-mono bg-muted px-1.5 py-0.5 rounded">{ds.schemaPattern}</code>
                          </TableCell>
                          <TableCell className="hidden lg:table-cell">
                            <span className="text-sm text-muted-foreground flex items-center gap-1.5">
                              <Clock className="h-3 w-3" />
                              {ds.lastSync === "Never" ? "Nunca" : new Date(ds.lastSync).toLocaleDateString("pt-BR")}
                            </span>
                          </TableCell>
                          <TableCell>
                            <StatusBadge status={ds.status === "syncing" ? "syncing" : ds.status} />
                          </TableCell>
                          <TableCell>
                            <div className="flex items-center justify-end gap-0.5">
                              <ActionBtn tooltip="Sincronizar" onClick={() => handleSync(ds.id)} disabled={syncingId === ds.id}>
                                <RefreshCw className={`h-3.5 w-3.5 ${syncingId === ds.id ? "animate-spin" : ""}`} />
                              </ActionBtn>
                              <ActionBtn tooltip={ds.status === "active" ? "Desativar" : "Ativar"} onClick={() => toggleStatus("ds", ds.id)}>
                                {ds.status === "active" ? <PowerOff className="h-3.5 w-3.5" /> : <Power className="h-3.5 w-3.5" />}
                              </ActionBtn>
                              {ds.status === "inactive" && (
                                <ActionBtn tooltip="Excluir" onClick={() => setDeleteTarget({ type: "ds", id: ds.id, name: ds.name })} destructive>
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
                  placeholder="Buscar views..."
                  value={viewSearch}
                  onChange={(e) => setViewSearch(e.target.value)}
                  className="pl-9 h-9"
                />
              </div>

              {isLoading ? (
                <div className="glass-card p-4 text-sm text-muted-foreground">Carregando...</div>
              ) : filteredViews.length === 0 ? (
                <EmptyState
                  icon={<Layers className="h-5 w-5" />}
                  title={viewSearch ? "Nenhum resultado" : "Nenhuma view registrada"}
                  description={viewSearch ? "Tente outro termo de busca." : "Faca sync de um datasource para descobrir views."}
                />
              ) : (
                <div className="glass-card overflow-hidden">
                  <Table>
                    <TableHeader>
                      <TableRow className="bg-muted/30 hover:bg-muted/30">
                        <TableHead className="font-semibold">View</TableHead>
                        <TableHead className="font-semibold">Schema</TableHead>
                        <TableHead className="font-semibold hidden lg:table-cell">Detalhes</TableHead>
                        <TableHead className="font-semibold">Status</TableHead>
                        <TableHead className="font-semibold text-right">Acoes</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {filteredViews.map((view) => (
                        <TableRow key={view.id}>
                          <TableCell>
                            <div>
                              <span className="font-medium text-foreground">{view.name}</span>
                              {view.description && (
                                <p className="text-xs text-muted-foreground mt-0.5 line-clamp-1 max-w-[280px]">
                                  {view.description}
                                </p>
                              )}
                            </div>
                          </TableCell>
                          <TableCell>
                            <code className="text-xs font-mono bg-muted px-1.5 py-0.5 rounded">{view.schema}</code>
                          </TableCell>
                          <TableCell className="hidden lg:table-cell">
                            <span className="text-xs text-muted-foreground">
                              {view.columns.length} colunas . {view.rowCount.toLocaleString()} linhas
                            </span>
                          </TableCell>
                          <TableCell>
                            <StatusBadge status={view.status} />
                          </TableCell>
                          <TableCell>
                            <div className="flex items-center justify-end gap-0.5">
                              <ActionBtn tooltip={view.status === "active" ? "Desativar" : "Ativar"} onClick={() => toggleStatus("view", view.id)}>
                                {view.status === "active" ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                              </ActionBtn>
                              {view.status === "inactive" && (
                                <ActionBtn tooltip="Excluir" onClick={() => setDeleteTarget({ type: "view", id: view.id, name: view.name })} destructive>
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
        onOpenChange={() => setDeleteTarget(null)}
        title="Confirmar exclusao"
        description={`Tem certeza que deseja remover "${deleteTarget?.name}"? Esta acao nao pode ser desfeita.`}
        confirmLabel="Excluir"
        onConfirm={handleDelete}
        destructive
      />
    </div>
  );
};

export default AdminPage;

