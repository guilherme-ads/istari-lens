import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { motion } from "framer-motion";
import { KeyRound, Loader2, Plus, Power, PowerOff, RefreshCw, ShieldCheck } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Label } from "@/components/ui/label";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { useToast } from "@/hooks/use-toast";
import { api, ApiError } from "@/lib/api";
import { getStoredUser } from "@/lib/auth";

const ApiConfigPage = () => {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const user = getStoredUser();
  const isAdmin = !!user?.is_admin;
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("gpt-4o-mini");
  const [createApiSheetOpen, setCreateApiSheetOpen] = useState(false);

  const integrationsQuery = useQuery({ queryKey: ["api-config", "integrations"], queryFn: api.listApiIntegrations });
  const activeIntegration = useMemo(() => integrationsQuery.data?.items.find((item) => item.is_active) || null, [integrationsQuery.data?.items]);
  const inactiveIntegrations = useMemo(() => (integrationsQuery.data?.items || []).filter((item) => !item.is_active), [integrationsQuery.data?.items]);
  const llmConfigured = !!activeIntegration;

  useEffect(() => {
    if (activeIntegration?.model) setModel(activeIntegration.model);
  }, [activeIntegration?.model]);

  const saveIntegrationMutation = useMutation({
    mutationFn: () => api.createOpenAIIntegration({ api_key: apiKey.trim(), model, is_active: true }),
    onSuccess: async () => {
      setApiKey("");
      setCreateApiSheetOpen(false);
      await queryClient.invalidateQueries({ queryKey: ["api-config", "integrations"] });
      toast({ title: "API OpenAI cadastrada e ativada" });
    },
    onError: (error: unknown) => {
      const message = error instanceof ApiError ? error.detail || error.message : "Falha ao cadastrar API";
      toast({ title: "Erro ao cadastrar", description: message, variant: "destructive" });
    },
  });

  const testDraftIntegrationMutation = useMutation({
    mutationFn: () => api.testOpenAIIntegration({ api_key: apiKey.trim() || undefined, model }),
    onSuccess: () => toast({ title: "Conexão validada", description: "OpenAI respondeu com sucesso." }),
    onError: (error: unknown) => {
      const message = error instanceof ApiError ? error.detail || error.message : "Falha ao testar conexão";
      toast({ title: "Falha no teste", description: message, variant: "destructive" });
    },
  });

  const testStoredIntegrationMutation = useMutation({
    mutationFn: (integrationId: number) => api.testApiIntegration(integrationId),
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: ["api-config", "integrations"] });
      toast({ title: "Conexão validada", description: result.message });
    },
    onError: (error: unknown) => {
      const message = error instanceof ApiError ? error.detail || error.message : "Falha ao testar conexão";
      toast({ title: "Falha no teste", description: message, variant: "destructive" });
    },
  });

  const activateIntegrationMutation = useMutation({
    mutationFn: (integrationId: number) => api.activateApiIntegration(integrationId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["api-config", "integrations"] });
      toast({ title: "API ativada" });
    },
    onError: (error: unknown) => {
      const message = error instanceof ApiError ? error.detail || error.message : "Falha ao ativar API";
      toast({ title: "Falha ao ativar", description: message, variant: "destructive" });
    },
  });

  const deactivateIntegrationMutation = useMutation({
    mutationFn: (integrationId: number) => api.deactivateApiIntegration(integrationId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["api-config", "integrations"] });
      toast({ title: "API desativada" });
    },
    onError: (error: unknown) => {
      const message = error instanceof ApiError ? error.detail || error.message : "Falha ao desativar API";
      toast({ title: "Falha ao desativar", description: message, variant: "destructive" });
    },
  });

  return (
    <div className="bg-background">
      <main className="container space-y-6 py-6">
        <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight text-foreground"><KeyRound className="h-5 w-5 text-accent" />Configuração de APIs</h1>
            <p className="mt-1 text-sm text-muted-foreground">Configure e gerencie credenciais de providers LLM.</p>
          </div>
          {isAdmin && (
            <Sheet open={createApiSheetOpen} onOpenChange={setCreateApiSheetOpen}>
              <SheetTrigger asChild>
                <Button className="bg-accent text-accent-foreground hover:bg-accent/90"><Plus className="mr-2 h-4 w-4" />Cadastrar nova API</Button>
              </SheetTrigger>
              <SheetContent className="sm:max-w-md">
                <SheetHeader>
                  <SheetTitle>Cadastrar API OpenAI</SheetTitle>
                  <SheetDescription>Cadastre uma nova chave. Ao ativar, a API ativa atual sera desativada.</SheetDescription>
                </SheetHeader>
                <div className="mt-6 space-y-5">
                  <div className="space-y-2"><Label htmlFor="openai-model-page">Modelo</Label><Input id="openai-model-page" value={model} onChange={(e) => setModel(e.target.value)} placeholder="gpt-4o-mini" /></div>
                  <div className="space-y-2"><Label htmlFor="openai-key-page">OpenAI API Key</Label><Input id="openai-key-page" type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="sk-..." autoComplete="off" /></div>
                  <div className="flex flex-wrap gap-2 pt-1">
                    <Button variant="outline" onClick={() => testDraftIntegrationMutation.mutate()} disabled={testDraftIntegrationMutation.isPending}>{testDraftIntegrationMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />} Testar chave digitada</Button>
                    <Button onClick={() => saveIntegrationMutation.mutate()} disabled={!apiKey.trim() || saveIntegrationMutation.isPending}>{saveIntegrationMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}Cadastrar e ativar</Button>
                  </div>
                </div>
              </SheetContent>
            </Sheet>
          )}
        </motion.div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div className="glass-card p-4"><p className="text-xs font-medium text-muted-foreground">Provider</p><p className="text-lg font-bold tracking-tight text-foreground">{activeIntegration?.provider?.toUpperCase() || "OpenAI"}</p><p className="mt-0.5 text-xs text-muted-foreground">Provider atualmente ativo</p></div>
          <div className="glass-card p-4"><p className="text-xs font-medium text-muted-foreground">Status</p><p className="text-lg font-bold tracking-tight text-foreground">{llmConfigured ? "Configurada" : "Não configurada"}</p><p className="mt-0.5 text-xs text-muted-foreground">{llmConfigured ? "Credenciais validadas" : "Necessita chave de API"}</p></div>
          <div className="glass-card p-4"><p className="text-xs font-medium text-muted-foreground">APIs cadastradas</p><p className="text-lg font-bold tracking-tight text-foreground">{integrationsQuery.data?.items.length || 0}</p><p className="mt-0.5 text-xs text-muted-foreground">{inactiveIntegrations.length} desativada(s)</p></div>
        </div>

        {!isAdmin ? (
          <div className="glass-card max-w-xl p-6"><p className="text-sm font-semibold text-foreground">Acesso restrito</p><p className="mt-1 text-sm text-muted-foreground">Somente administradores podem alterar configurações de APIs.</p></div>
        ) : (
          <div className="glass-card space-y-6 p-6">
            <div><h2 className="text-base font-semibold text-foreground">APIs configuradas</h2><p className="mt-1 text-sm text-muted-foreground">Apenas uma API pode ficar ativa por vez.</p></div>

            <div className="space-y-3">
              <h3 className="text-sm font-semibold text-foreground">API ativa</h3>
              <div className="overflow-hidden rounded-lg border border-border">
                <Table>
                  <TableHeader><TableRow className="bg-muted/30 hover:bg-muted/30"><TableHead className="font-semibold">Provider</TableHead><TableHead className="font-semibold">Modelo</TableHead><TableHead className="font-semibold">Chave</TableHead><TableHead className="font-semibold">Saldo estimado</TableHead><TableHead className="font-semibold">Atualizada</TableHead><TableHead className="font-semibold">Status</TableHead><TableHead className="text-right font-semibold">Acoes</TableHead></TableRow></TableHeader>
                  <TableBody>
                    {activeIntegration ? (
                      <TableRow>
                        <TableCell className="font-medium">{activeIntegration.provider.toUpperCase()}</TableCell>
                        <TableCell>{activeIntegration.model}</TableCell>
                        <TableCell><code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{activeIntegration.masked_api_key}</code></TableCell>
                        <TableCell>{typeof activeIntegration.billing_estimated_remaining_usd === "number" ? `US$ ${activeIntegration.billing_estimated_remaining_usd.toFixed(2)}` : "Não disponível"}</TableCell>
                        <TableCell>{new Date(activeIntegration.updated_at).toLocaleString("pt-BR")}</TableCell>
                        <TableCell><Badge className="border-success/20 bg-success/10 text-success" variant="outline">Ativa</Badge></TableCell>
                        <TableCell>
                          <div className="flex justify-end gap-2">
                            <Tooltip><TooltipTrigger asChild><Button variant="ghost" size="icon" onClick={() => testStoredIntegrationMutation.mutate(activeIntegration.id)} disabled={testStoredIntegrationMutation.isPending}><RefreshCw className={`h-4 w-4 ${testStoredIntegrationMutation.isPending ? "animate-spin" : ""}`} /></Button></TooltipTrigger><TooltipContent className="text-xs">Testar e atualizar saldo</TooltipContent></Tooltip>
                            <Tooltip><TooltipTrigger asChild><Button variant="ghost" size="icon" className="text-destructive hover:bg-destructive/10 hover:text-destructive" onClick={() => deactivateIntegrationMutation.mutate(activeIntegration.id)} disabled={deactivateIntegrationMutation.isPending}><PowerOff className="h-4 w-4" /></Button></TooltipTrigger><TooltipContent className="text-xs">Desativar</TooltipContent></Tooltip>
                          </div>
                        </TableCell>
                      </TableRow>
                    ) : (
                      <TableRow><TableCell colSpan={7} className="text-sm text-muted-foreground">Nenhuma API ativa.</TableCell></TableRow>
                    )}
                  </TableBody>
                </Table>
              </div>
            </div>

            <div className="space-y-3">
              <h3 className="text-sm font-semibold text-foreground">APIs desativadas</h3>
              <div className="overflow-hidden rounded-lg border border-border">
                <Table>
                  <TableHeader><TableRow className="bg-muted/30 hover:bg-muted/30"><TableHead className="font-semibold">Provider</TableHead><TableHead className="font-semibold">Modelo</TableHead><TableHead className="font-semibold">Chave</TableHead><TableHead className="font-semibold">Saldo estimado</TableHead><TableHead className="font-semibold">Atualizada</TableHead><TableHead className="font-semibold">Status</TableHead><TableHead className="text-right font-semibold">Acoes</TableHead></TableRow></TableHeader>
                  <TableBody>
                    {inactiveIntegrations.length > 0 ? (
                      inactiveIntegrations.map((item) => (
                        <TableRow key={item.id}>
                          <TableCell className="font-medium">{item.provider.toUpperCase()}</TableCell>
                          <TableCell>{item.model}</TableCell>
                          <TableCell><code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{item.masked_api_key}</code></TableCell>
                          <TableCell>{typeof item.billing_estimated_remaining_usd === "number" ? `US$ ${item.billing_estimated_remaining_usd.toFixed(2)}` : "Não disponível"}</TableCell>
                          <TableCell>{new Date(item.updated_at).toLocaleString("pt-BR")}</TableCell>
                          <TableCell><Badge variant="outline" className="text-muted-foreground">Desativada</Badge></TableCell>
                          <TableCell>
                            <div className="flex justify-end gap-2">
                              <Tooltip><TooltipTrigger asChild><Button variant="ghost" size="icon" onClick={() => testStoredIntegrationMutation.mutate(item.id)} disabled={testStoredIntegrationMutation.isPending}><RefreshCw className={`h-4 w-4 ${testStoredIntegrationMutation.isPending ? "animate-spin" : ""}`} /></Button></TooltipTrigger><TooltipContent className="text-xs">Testar e atualizar saldo</TooltipContent></Tooltip>
                              <Tooltip><TooltipTrigger asChild><Button variant="ghost" size="icon" onClick={() => activateIntegrationMutation.mutate(item.id)} disabled={activateIntegrationMutation.isPending}><Power className="h-4 w-4" /></Button></TooltipTrigger><TooltipContent className="text-xs">Ativar</TooltipContent></Tooltip>
                            </div>
                          </TableCell>
                        </TableRow>
                      ))
                    ) : (
                      <TableRow><TableCell colSpan={7} className="text-sm text-muted-foreground">Nenhuma API desativada cadastrada.</TableCell></TableRow>
                    )}
                  </TableBody>
                </Table>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
};

export default ApiConfigPage;
