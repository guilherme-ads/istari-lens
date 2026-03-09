import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { motion } from "framer-motion";
import { ArrowLeft, ArrowRight, Check, Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useCoreData } from "@/hooks/use-core-data";
import { api, ApiDatasetBaseQuerySpec, ApiError } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";

type Step = 0 | 1 | 2;

type FormState = {
  name: string;
  description: string;
  datasourceId: string;
  primaryViewId: string;
  secondaryViewId: string;
  joinType: "left" | "inner";
  joinLeftColumn: string;
  joinRightColumn: string;
};

type SelectedColumn = {
  resource: "r0" | "r1";
  column: string;
  alias: string;
  semanticType: "numeric" | "temporal" | "text" | "boolean";
  description: string;
  enabled: boolean;
};

type ComputedDraft = {
  id: string;
  alias: string;
  description: string;
  left: string;
  op: "add" | "sub" | "mul" | "div";
  right: string;
};

type HydrationDraft = {
  include: Array<{ resource: "r0" | "r1"; column: string; alias: string; description?: string }>;
  computed: ComputedDraft[];
};

const normalizeSemanticType = (value: string): "numeric" | "temporal" | "text" | "boolean" => {
  if (value === "numeric" || value === "temporal" || value === "text" || value === "boolean") return value;
  const raw = (value || "").toLowerCase();
  if (["int", "numeric", "decimal", "real", "double", "float", "money"].some((token) => raw.includes(token))) return "numeric";
  if (["date", "time", "timestamp"].some((token) => raw.includes(token))) return "temporal";
  if (raw.includes("bool")) return "boolean";
  return "text";
};

const NewDatasetPage = () => {
  const { datasetId } = useParams<{ datasetId: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { datasources, datasets, views, isLoading, isError, errorMessage } = useCoreData();
  const isEditing = !!datasetId;
  const editingDataset = useMemo(
    () => (datasetId ? datasets.find((dataset) => dataset.id === datasetId) : undefined),
    [datasets, datasetId],
  );
  const backPath = isEditing && datasetId ? `/datasets/${datasetId}` : "/datasets";

  const [step, setStep] = useState<Step>(0);
  const [form, setForm] = useState<FormState>({
    name: "",
    description: "",
    datasourceId: "",
    primaryViewId: "",
    secondaryViewId: "",
    joinType: "left",
    joinLeftColumn: "",
    joinRightColumn: "",
  });
  const [selectedColumns, setSelectedColumns] = useState<Record<string, SelectedColumn>>({});
  const [computedColumns, setComputedColumns] = useState<ComputedDraft[]>([]);
  const [pendingHydration, setPendingHydration] = useState<HydrationDraft | null>(null);
  const [hydratedEditState, setHydratedEditState] = useState(false);
  const resetSkipCounterRef = useRef(0);

  const activeDatasources = datasources.filter((ds) => ds.status === "active");
  const activeViews = views.filter((v) => v.status === "active" && (!form.datasourceId || v.datasourceId === form.datasourceId));
  const primaryView = activeViews.find((v) => v.id === form.primaryViewId);
  const secondaryView = activeViews.find((v) => v.id === form.secondaryViewId);
  const useSecondary = !!secondaryView;
  const primaryAlias = primaryView?.name || "tabela_base";
  const secondaryAlias = secondaryView?.name || "tabela_join";
  const leftJoinOptions = primaryView?.columns || [];
  const rightJoinOptions = secondaryView?.columns || [];
  const resourceLabels = useMemo(
    () => ({
      r0: primaryAlias,
      r1: secondaryAlias,
    }),
    [primaryAlias, secondaryAlias],
  );

  const resourceViews = useMemo(
    () => [
      ...(primaryView ? [{ resource: "r0" as const, view: primaryView }] : []),
      ...(secondaryView && secondaryView.id !== primaryView?.id ? [{ resource: "r1" as const, view: secondaryView }] : []),
    ],
    [primaryView, secondaryView],
  );

  useEffect(() => {
    if (resetSkipCounterRef.current > 0) {
      resetSkipCounterRef.current -= 1;
      return;
    }
    setForm((prev) => ({
      ...prev,
      primaryViewId: "",
      secondaryViewId: "",
      joinLeftColumn: "",
      joinRightColumn: "",
    }));
    setSelectedColumns({});
    setComputedColumns([]);
  }, [form.datasourceId]);

  useEffect(() => {
    if (resetSkipCounterRef.current > 0) {
      resetSkipCounterRef.current -= 1;
      return;
    }
    setForm((prev) => ({
      ...prev,
      secondaryViewId: "",
      joinLeftColumn: "",
      joinRightColumn: "",
    }));
    setSelectedColumns({});
    setComputedColumns([]);
  }, [form.primaryViewId]);

  useEffect(() => {
    if (!resourceViews.length) {
      setSelectedColumns({});
      return;
    }
    setSelectedColumns((prev) => {
      const next: Record<string, SelectedColumn> = {};
      resourceViews.forEach(({ resource, view }) => {
        view.columns.forEach((column) => {
          const key = `${resource}.${column.name}`;
          const duplicateName = resourceViews.some(
            ({ resource: otherResource, view: otherView }) =>
              otherResource !== resource && otherView.columns.some((col) => col.name === column.name),
          );
          const sourceAlias = resource === "r0" ? primaryAlias : secondaryAlias;
          const normalizedSourceAlias = sourceAlias.replace(/[^a-zA-Z0-9_]/g, "_");
          const defaultAlias = duplicateName ? `${normalizedSourceAlias}_${column.name}` : column.name;
          const current = prev[key];
          next[key] = current || {
            resource,
            column: column.name,
            alias: defaultAlias,
            semanticType: normalizeSemanticType(column.type),
            description: "",
            enabled: resource === "r0",
          };
        });
      });
      return next;
    });
  }, [primaryAlias, resourceViews, secondaryAlias]);

  useEffect(() => {
    if (!isEditing || !editingDataset || hydratedEditState || views.length === 0) return;

    const baseQuerySpec = editingDataset.baseQuerySpec as ApiDatasetBaseQuerySpec | null;
    const datasourceId = editingDataset.datasourceId;
    const availableViews = views.filter((view) => view.datasourceId === datasourceId);

    let primaryResourceId = "";
    let secondaryResourceId = "";
    let joinType: "left" | "inner" = "left";
    let joinLeftColumn = "";
    let joinRightColumn = "";
    const includeItems: Array<{ resource: "r0" | "r1"; column: string; alias: string; description?: string }> = [];
    const computedItems: ComputedDraft[] = [];
    const semanticDescriptionByName = new Map(
      (editingDataset.semanticColumns || [])
        .filter((item) => !!item.name)
        .map((item) => [item.name, item.description || ""]),
    );

    if (baseQuerySpec?.base?.resources?.length) {
      const resources = baseQuerySpec.base.resources;
      primaryResourceId = baseQuerySpec.base.primary_resource || resources[0]?.resource_id || "";

      const firstJoin = baseQuerySpec.base.joins?.[0];
      if (firstJoin?.right_resource) {
        const joinResource = resources.find((item) => item.id === firstJoin.right_resource);
        secondaryResourceId = joinResource?.resource_id || "";
        joinType = firstJoin.type;
        joinLeftColumn = firstJoin.on?.[0]?.left_column || "";
        joinRightColumn = firstJoin.on?.[0]?.right_column || "";
      } else {
        secondaryResourceId = resources.find((item) => item.resource_id !== primaryResourceId)?.resource_id || "";
      }

      const primaryResourceKey = resources.find((item) => item.resource_id === primaryResourceId)?.id || "";
      const secondaryResourceKey = resources.find((item) => item.resource_id === secondaryResourceId)?.id || "";
      const resourceKeyMap = new Map<string, "r0" | "r1">();
      if (primaryResourceKey) resourceKeyMap.set(primaryResourceKey, "r0");
      if (secondaryResourceKey) resourceKeyMap.set(secondaryResourceKey, "r1");

      const preprocessInclude = baseQuerySpec.preprocess?.columns?.include || [];
      preprocessInclude.forEach((item) => {
        const mappedResource = resourceKeyMap.get(item.resource);
        if (!mappedResource) return;
        includeItems.push({
          resource: mappedResource,
          column: item.column,
          alias: item.alias,
          description: semanticDescriptionByName.get(item.alias) || "",
        });
      });

      const preprocessComputed = baseQuerySpec.preprocess?.computed_columns || [];
      preprocessComputed.forEach((item, index) => {
        const left = (item.expr as { args?: Array<{ column?: string }> })?.args?.[0]?.column || "";
        const right = (item.expr as { args?: Array<{ column?: string }> })?.args?.[1]?.column || "";
        const op = (item.expr as { op?: string })?.op;
        if (!item.alias || !left || !right) return;
        if (!["add", "sub", "mul", "div"].includes(String(op))) return;
        computedItems.push({
          id: `cc-hydrated-${index}-${item.alias}`,
          alias: item.alias,
          description: semanticDescriptionByName.get(item.alias) || "",
          left,
          op: op as ComputedDraft["op"],
          right,
        });
      });
    }

    const resolveViewIdFromResource = (resourceId: string): string => {
      if (!resourceId || !resourceId.includes(".")) return "";
      const [schema, ...nameParts] = resourceId.split(".");
      const name = nameParts.join(".");
      const matched = availableViews.find((view) => view.schema === schema && view.name === name);
      return matched?.id || "";
    };

    const primaryViewId = resolveViewIdFromResource(primaryResourceId) || editingDataset.viewId || "";
    const secondaryViewId = resolveViewIdFromResource(secondaryResourceId);

    resetSkipCounterRef.current = 2;
    setForm({
      name: editingDataset.name,
      description: editingDataset.description || "",
      datasourceId,
      primaryViewId,
      secondaryViewId,
      joinType,
      joinLeftColumn,
      joinRightColumn,
    });
    setPendingHydration({
      include: includeItems,
      computed: computedItems,
    });
    setHydratedEditState(true);
  }, [editingDataset, hydratedEditState, isEditing, views]);

  useEffect(() => {
    if (!pendingHydration) return;
    if (Object.keys(selectedColumns).length === 0) return;

    setSelectedColumns((prev) => {
      const next: Record<string, SelectedColumn> = {};
      Object.entries(prev).forEach(([key, item]) => {
        next[key] = { ...item, enabled: false };
      });

      pendingHydration.include.forEach((item) => {
        const key = `${item.resource}.${item.column}`;
        if (!next[key]) return;
        next[key] = {
          ...next[key],
          enabled: true,
          alias: item.alias,
          description: item.description || "",
        };
      });
      return next;
    });
    setComputedColumns(pendingHydration.computed);
    setPendingHydration(null);
  }, [pendingHydration, selectedColumns]);

  const enabledColumns = useMemo(
    () => Object.values(selectedColumns).filter((item) => item.enabled),
    [selectedColumns],
  );
  const columnEntries = useMemo(() => Object.entries(selectedColumns), [selectedColumns]);
  const allColumnsSelected = columnEntries.length > 0 && columnEntries.every(([, item]) => item.enabled);

  const aliasOptions = useMemo(
    () => enabledColumns.map((item) => item.alias.trim()).filter((value) => value.length > 0),
    [enabledColumns],
  );

  const canNextStep = useMemo(() => {
    if (step === 0) return form.name.trim().length > 0;
    if (!form.datasourceId || !primaryView) return false;
    if (useSecondary && (!form.joinLeftColumn.trim() || !form.joinRightColumn.trim())) return false;
    if (enabledColumns.length === 0) return false;
    const aliases = enabledColumns.map((item) => item.alias.trim()).filter((item) => item.length > 0);
    if (aliases.length !== enabledColumns.length) return false;
    if (new Set(aliases).size !== aliases.length) return false;
    return true;
  }, [step, form, primaryView, useSecondary, enabledColumns]);

  const saveDataset = useMutation({
    mutationFn: async () => {
      if (!primaryView) throw new Error("Primary view is required");
      const resources = resourceViews.map(({ resource, view }) => ({
        id: resource,
        resource_id: `${view.schema}.${view.name}`,
      }));
      const joins = useSecondary
        ? [{
            type: form.joinType,
            left_resource: "r0",
            right_resource: "r1",
            on: [{ left_column: form.joinLeftColumn.trim(), right_column: form.joinRightColumn.trim() }],
          }]
        : [];
      const computed = computedColumns
        .filter((item) => item.alias.trim() && item.left.trim() && item.right.trim())
        .map((item) => ({
          alias: item.alias.trim(),
          expr: { op: item.op, args: [{ column: item.left.trim() }, { column: item.right.trim() }] },
          data_type: "numeric" as const,
        }));
      const semanticColumns = [
        ...enabledColumns.map((item) => ({
          name: item.alias.trim(),
          type: normalizeSemanticType(item.semanticType),
          source: "projected" as const,
          description: item.description.trim() || undefined,
        })),
        ...computedColumns
          .filter((item) => item.alias.trim())
          .map((item) => ({
            name: item.alias.trim(),
            type: "numeric" as const,
            source: "computed" as const,
            description: item.description.trim() || undefined,
          })),
      ];

      const baseQuerySpec: ApiDatasetBaseQuerySpec = {
        version: 1,
        source: { datasource_id: Number(form.datasourceId) },
        base: {
          primary_resource: `${primaryView.schema}.${primaryView.name}`,
          resources,
          joins,
        },
        preprocess: {
          columns: {
            include: enabledColumns.map((item) => ({
              resource: item.resource,
              column: item.column,
              alias: item.alias.trim(),
            })),
            exclude: [],
          },
          computed_columns: computed,
          filters: [],
        },
      };

      if (isEditing && datasetId) {
        return api.updateDataset(Number(datasetId), {
          view_id: Number(form.primaryViewId),
          name: form.name.trim(),
          description: form.description.trim(),
          base_query_spec: baseQuerySpec,
          semantic_columns: semanticColumns,
        });
      }
      return api.createDataset({
        datasource_id: Number(form.datasourceId),
        view_id: Number(form.primaryViewId),
        name: form.name.trim(),
        description: form.description.trim(),
        base_query_spec: baseQuerySpec,
        semantic_columns: semanticColumns,
      });
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["datasets"] }),
        queryClient.invalidateQueries({ queryKey: ["dashboards"] }),
      ]);
      toast({ title: isEditing ? "Dataset atualizado com sucesso" : "Dataset criado com sucesso" });
      navigate(backPath);
    },
    onError: (error: unknown) => {
      const message = error instanceof ApiError ? error.detail || error.message : (isEditing ? "Falha ao atualizar dataset" : "Falha ao criar dataset");
      toast({ title: isEditing ? "Erro ao atualizar dataset" : "Erro ao criar dataset", description: message, variant: "destructive" });
    },
  });

  if (isError) {
    return (
      <div className="bg-background min-h-screen">
        <main className="container max-w-4xl py-6">
          <p className="text-body text-destructive">{errorMessage}</p>
        </main>
      </div>
    );
  }

  if (isEditing && !isLoading && !editingDataset) {
    return (
      <div className="bg-background min-h-screen">
        <main className="container max-w-4xl py-6">
          <p className="text-body text-destructive">Dataset nao encontrado.</p>
        </main>
      </div>
    );
  }

  return (
    <div className="bg-background min-h-screen">
      <main className="container max-w-4xl py-6 space-y-6">
        <div className="flex items-center justify-between">
          <Button variant="ghost" size="sm" onClick={() => navigate(backPath)} className="-ml-2">
            <ArrowLeft className="h-4 w-4 mr-1.5" /> Datasets
          </Button>
        </div>

        <div>
          <h1 className="text-display text-foreground">{isEditing ? "Editar Dataset" : "Novo Dataset"}</h1>
          <p className="text-body mt-1.5 text-muted-foreground">
            {isEditing
              ? "Atualize joins, preprocessamento e colunas calculadas do dataset."
              : "Fluxo semantico para criar datasets com joins e preprocessamento."}
          </p>
        </div>

        <div className="glass-card p-5">
          <div className="flex items-center gap-3 text-sm">
            <StepBadge index={0} current={step} label="Identificacao" />
            <StepBadge index={1} current={step} label="Tabelas e preprocessamento" />
            <StepBadge index={2} current={step} label="Revisao" />
          </div>
        </div>

        {step === 0 && (
          <motion.div initial={{ opacity: 0, x: -12 }} animate={{ opacity: 1, x: 0 }} className="glass-card p-6 space-y-4">
            <div className="space-y-1.5">
              <Label className="text-heading">Nome *</Label>
              <Input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} placeholder="Ex: Sales Pipeline" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-heading">Descricao</Label>
              <Textarea value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} rows={3} />
            </div>
          </motion.div>
        )}

        {step === 1 && (
          <motion.div initial={{ opacity: 0, x: -12 }} animate={{ opacity: 1, x: 0 }} className="space-y-4">
            <div className="glass-card p-6 space-y-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label className="text-heading">Datasource *</Label>
                  <Select value={form.datasourceId} onValueChange={(value) => setForm((f) => ({ ...f, datasourceId: value }))}>
                    <SelectTrigger className="h-9 text-sm"><SelectValue placeholder="Selecione..." /></SelectTrigger>
                    <SelectContent>
                      {activeDatasources.map((ds) => (
                        <SelectItem key={ds.id} value={ds.id}>{ds.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-heading">Tabela base *</Label>
                  <Select value={form.primaryViewId} onValueChange={(value) => setForm((f) => ({ ...f, primaryViewId: value }))} disabled={!form.datasourceId || isLoading}>
                    <SelectTrigger className="h-9 text-sm"><SelectValue placeholder="Selecione..." /></SelectTrigger>
                    <SelectContent>
                      {activeViews.map((v) => (
                        <SelectItem key={v.id} value={v.id}>{v.schema}.{v.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label className="text-heading">Tabela para join (opcional)</Label>
                  <Select
                    value={form.secondaryViewId || "__none__"}
                    onValueChange={(value) => setForm((f) => ({ ...f, secondaryViewId: value === "__none__" ? "" : value }))}
                    disabled={!form.primaryViewId}
                  >
                    <SelectTrigger className="h-9 text-sm"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none__">Sem join adicional</SelectItem>
                      {activeViews.filter((v) => v.id !== form.primaryViewId).map((v) => (
                        <SelectItem key={v.id} value={v.id}>{v.schema}.{v.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              {useSecondary && (
                <div className="space-y-1.5">
                  <Label className="text-heading">Tipo de join</Label>
                    <Select value={form.joinType} onValueChange={(value) => setForm((f) => ({ ...f, joinType: value as "left" | "inner" }))}>
                    <SelectTrigger className="h-9 text-sm"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="left">Left</SelectItem>
                      <SelectItem value="inner">Inner</SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    {form.joinType === "left"
                      ? "LEFT JOIN: mantem todas as linhas da tabela base e completa com dados da tabela de join quando houver correspondencia."
                      : "INNER JOIN: retorna apenas linhas que existem nas duas tabelas com base nas colunas selecionadas."}
                  </p>
                </div>
              )}
            </div>

              {useSecondary && (
                <div className="grid grid-cols-2 gap-2">
                  <div className="space-y-1.5">
                    <Label className="text-heading">Coluna de join ({primaryAlias})</Label>
                    <Select value={form.joinLeftColumn || "__none__"} onValueChange={(value) => setForm((f) => ({ ...f, joinLeftColumn: value === "__none__" ? "" : value }))}>
                      <SelectTrigger className="h-9 text-sm"><SelectValue placeholder="Selecione uma coluna" /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__none__">Selecione...</SelectItem>
                        {leftJoinOptions.map((column) => (
                          <SelectItem key={`left-${column.name}`} value={column.name}>{column.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-heading">Coluna de join ({secondaryAlias})</Label>
                    <Select value={form.joinRightColumn || "__none__"} onValueChange={(value) => setForm((f) => ({ ...f, joinRightColumn: value === "__none__" ? "" : value }))}>
                      <SelectTrigger className="h-9 text-sm"><SelectValue placeholder="Selecione uma coluna" /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__none__">Selecione...</SelectItem>
                        {rightJoinOptions.map((column) => (
                          <SelectItem key={`right-${column.name}`} value={column.name}>{column.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              )}
            </div>

            <div className="glass-card p-6 space-y-3">
              <Label className="text-heading">Preprocessamento: colunas (selecao + rename + descricao opcional)</Label>
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                <input
                  type="checkbox"
                  checked={allColumnsSelected}
                  onChange={(e) => {
                    const checked = e.target.checked;
                    setSelectedColumns((prev) => {
                      const next: Record<string, SelectedColumn> = {};
                      Object.entries(prev).forEach(([key, item]) => {
                        next[key] = { ...item, enabled: checked };
                      });
                      return next;
                    });
                  }}
                />
                Selecionar todas as colunas
              </label>
              <div className="rounded-md border border-border p-2 space-y-2 max-h-52 overflow-y-auto">
                {columnEntries.map(([key, item]) => (
                  <div key={key} className="grid grid-cols-[auto_1fr_1fr_1.3fr] gap-2 items-center">
                    <input
                      type="checkbox"
                      checked={item.enabled}
                      onChange={(e) =>
                        setSelectedColumns((prev) => ({
                          ...prev,
                          [key]: { ...prev[key], enabled: e.target.checked },
                        }))}
                    />
                    <span className="text-xs font-mono text-muted-foreground">{resourceLabels[item.resource]}.{item.column}</span>
                    <Input
                      className="h-8 text-xs"
                      value={item.alias}
                      onChange={(e) =>
                        setSelectedColumns((prev) => ({
                          ...prev,
                          [key]: { ...prev[key], alias: e.target.value },
                        }))}
                      placeholder="alias"
                    />
                    <Input
                      className="h-8 text-xs"
                      value={item.description}
                      onChange={(e) =>
                        setSelectedColumns((prev) => ({
                          ...prev,
                          [key]: { ...prev[key], description: e.target.value },
                        }))}
                      placeholder="descricao da coluna (opcional)"
                      disabled={!item.enabled}
                    />
                  </div>
                ))}
              </div>
            </div>

            <div className="glass-card p-6 space-y-3">
              <div className="flex items-center justify-between">
                <Label className="text-heading">Colunas calculadas</Label>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 text-xs"
                  onClick={() =>
                    setComputedColumns((prev) => [
                      ...prev,
                      { id: `cc-${Date.now()}-${Math.random()}`, alias: "", description: "", left: "", op: "sub", right: "" },
                    ])}
                >
                  <Plus className="h-3.5 w-3.5 mr-1" /> Adicionar
                </Button>
              </div>
              <div className="space-y-2">
                {computedColumns.map((item) => (
                  <div key={item.id} className="grid grid-cols-[1fr_1fr_100px_1fr_1fr_auto] gap-2 items-center">
                    <Input
                      className="h-8 text-xs"
                      value={item.alias}
                      onChange={(e) => setComputedColumns((prev) => prev.map((row) => (row.id === item.id ? { ...row, alias: e.target.value } : row)))}
                      placeholder="alias"
                    />
                    <Select value={item.left || "__none__"} onValueChange={(value) => setComputedColumns((prev) => prev.map((row) => (row.id === item.id ? { ...row, left: value === "__none__" ? "" : value } : row)))}>
                      <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="Coluna A" /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__none__">Coluna A</SelectItem>
                        {aliasOptions.map((alias) => <SelectItem key={`l-${item.id}-${alias}`} value={alias}>{alias}</SelectItem>)}
                      </SelectContent>
                    </Select>
                    <Select value={item.op} onValueChange={(value) => setComputedColumns((prev) => prev.map((row) => (row.id === item.id ? { ...row, op: value as ComputedDraft["op"] } : row)))}>
                      <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="add">+</SelectItem>
                        <SelectItem value="sub">-</SelectItem>
                        <SelectItem value="mul">*</SelectItem>
                        <SelectItem value="div">/</SelectItem>
                      </SelectContent>
                    </Select>
                    <Select value={item.right || "__none__"} onValueChange={(value) => setComputedColumns((prev) => prev.map((row) => (row.id === item.id ? { ...row, right: value === "__none__" ? "" : value } : row)))}>
                      <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="Coluna B" /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__none__">Coluna B</SelectItem>
                        {aliasOptions.map((alias) => <SelectItem key={`r-${item.id}-${alias}`} value={alias}>{alias}</SelectItem>)}
                      </SelectContent>
                    </Select>
                    <Input
                      className="h-8 text-xs"
                      value={item.description}
                      onChange={(e) => setComputedColumns((prev) => prev.map((row) => (row.id === item.id ? { ...row, description: e.target.value } : row)))}
                      placeholder="descricao (opcional)"
                    />
                    <Button size="icon" variant="ghost" className="h-8 w-8 destructive-icon-btn" onClick={() => setComputedColumns((prev) => prev.filter((row) => row.id !== item.id))}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                ))}
              </div>
            </div>
          </motion.div>
        )}

        {step === 2 && (
          <motion.div initial={{ opacity: 0, x: -12 }} animate={{ opacity: 1, x: 0 }} className="glass-card p-6 space-y-3">
            <h2 className="text-title">Revisao</h2>
            <p className="text-body text-muted-foreground">
              {isEditing ? "Confirme os dados antes de salvar as alteracoes." : "Confirme os dados antes de criar o dataset."}
            </p>
            <div className="text-sm space-y-2">
              <p><strong>Nome:</strong> {form.name || "-"}</p>
              <p><strong>Descricao:</strong> {form.description || "-"}</p>
              <p><strong>Datasource:</strong> {activeDatasources.find((d) => d.id === form.datasourceId)?.name || "-"}</p>
              <p><strong>Tabela base:</strong> {primaryView ? `${primaryView.schema}.${primaryView.name}` : "-"}</p>
              <p><strong>Tabela join:</strong> {secondaryView ? `${secondaryView.schema}.${secondaryView.name}` : "Sem join"}</p>
              <p><strong>Colunas habilitadas:</strong> {enabledColumns.length}</p>
              <p><strong>Colunas calculadas:</strong> {computedColumns.filter((c) => c.alias.trim()).length}</p>
            </div>
          </motion.div>
        )}

        <div className="flex items-center justify-between pt-2">
          <Button
            variant="ghost"
            onClick={() => {
              if (step === 0) navigate(backPath);
              else setStep((prev) => (prev - 1) as Step);
            }}
          >
            <ArrowLeft className="h-4 w-4 mr-1.5" />
            {step === 0 ? "Cancelar" : "Voltar"}
          </Button>

          {step < 2 ? (
            <Button className="bg-accent text-accent-foreground hover:bg-accent/90" disabled={!canNextStep} onClick={() => setStep((prev) => (prev + 1) as Step)}>
              Proximo <ArrowRight className="h-4 w-4 ml-1.5" />
            </Button>
          ) : (
            <Button className="bg-accent text-accent-foreground hover:bg-accent/90" disabled={saveDataset.isPending || !canNextStep} onClick={() => saveDataset.mutate()}>
              <Check className="h-4 w-4 mr-1.5" />
              {saveDataset.isPending ? (isEditing ? "Salvando..." : "Criando...") : (isEditing ? "Salvar Dataset" : "Criar Dataset")}
            </Button>
          )}
        </div>
      </main>
    </div>
  );
};

const StepBadge = ({ index, current, label }: { index: number; current: number; label: string }) => {
  const active = current === index;
  const done = current > index;
  return (
    <span
      className={`inline-flex items-center gap-2 rounded-lg border px-3 py-2 ${
        active ? "border-accent/30 bg-accent/10 text-accent" : done ? "border-success/30 bg-success/10 text-success" : "border-border text-muted-foreground"
      }`}
    >
      <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-muted text-xs font-bold">
        {done ? <Check className="h-3 w-3" /> : index + 1}
      </span>
      <span className="text-xs sm:text-sm font-medium">{label}</span>
    </span>
  );
};

export default NewDatasetPage;
