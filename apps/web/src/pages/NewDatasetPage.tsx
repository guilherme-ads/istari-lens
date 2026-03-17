import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { motion } from "framer-motion";
import {
  ArrowLeft,
  Calculator,
  CircleHelp,
  Columns3,
  Database,
  Eye,
  GripVertical,
  Hash,
  Link2,
  Layers3,
  Loader2,
  Plus,
  Save,
  Search,
  Sigma,
  Table2,
  Tag,
  Trash2,
  X,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useCoreData } from "@/hooks/use-core-data";
import {
  api,
  ApiCatalogDataPreviewResponse,
  ApiCatalogDataset,
  ApiCatalogDimension,
  ApiCatalogMetric,
  ApiDatasetBaseQuerySpec,
  ApiError,
} from "@/lib/api";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import EmptyState from "@/components/shared/EmptyState";

type ActiveNode = "source" | "base" | "joins" | "columns" | "computed" | "metrics" | "dimensions" | `column:${string}`;

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

type ColumnDraft = {
  id: string;
  resource: "r0" | "r1";
  sourceColumn: string;
  name: string;
  type: "numeric" | "temporal" | "text" | "boolean";
  description: string;
  enabled: boolean;
};

type ComputedDraft = {
  id: string;
  name: string;
  formula: string;
  description: string;
};

type MetricFormState = {
  name: string;
  description: string;
  formula: string;
  unit: string;
  defaultGrain: string;
  synonyms: string;
  examples: string;
};

type DimensionFormState = {
  name: string;
  description: string;
  type: "categorical" | "temporal" | "relational";
  synonyms: string;
};

const normalizeSemanticType = (value: string): ColumnDraft["type"] => {
  const raw = (value || "").toLowerCase();
  if (["numeric", "int", "decimal", "double", "float", "money"].some((token) => raw.includes(token))) return "numeric";
  if (["temporal", "date", "time", "timestamp"].some((token) => raw.includes(token))) return "temporal";
  if (raw.includes("bool")) return "boolean";
  return "text";
};

const parseCsv = (value: string): string[] => value.split(",").map((item) => item.trim()).filter(Boolean);
const toCsv = (value?: string[]) => (value || []).join(", ");

const emptyComputedForm = (): Omit<ComputedDraft, "id"> => ({ name: "", formula: "", description: "" });
const emptyMetricForm = (): MetricFormState => ({ name: "", description: "", formula: "", unit: "", defaultGrain: "all", synonyms: "", examples: "" });
const emptyDimensionForm = (): DimensionFormState => ({ name: "", description: "", type: "categorical", synonyms: "" });

const metricToForm = (metric: ApiCatalogMetric): MetricFormState => ({
  name: metric.name,
  description: metric.description || "",
  formula: metric.formula,
  unit: metric.unit || "",
  defaultGrain: metric.default_grain || "",
  synonyms: toCsv(metric.synonyms),
  examples: toCsv(metric.examples),
});

const dimensionToForm = (dimension: ApiCatalogDimension): DimensionFormState => ({
  name: dimension.name,
  description: dimension.description || "",
  type: dimension.type,
  synonyms: toCsv(dimension.synonyms),
});

const parseFormulaExpr = (formula: string): { op: "add" | "sub" | "mul" | "div"; left: string; right: string } | null => {
  const parts = formula.trim().split(/\s+/);
  if (parts.length !== 3) return null;
  const [left, symbol, right] = parts;
  const map: Record<string, "add" | "sub" | "mul" | "div"> = { "+": "add", "-": "sub", "*": "mul", "/": "div" };
  const op = map[symbol];
  if (!op || !left || !right) return null;
  return { op, left, right };
};

const getFormulaQuery = (formula: string): string => {
  const trimmedRight = formula.replace(/\s+$/, "");
  if (!trimmedRight) return "";
  const lastSpace = trimmedRight.lastIndexOf(" ");
  return trimmedRight.slice(lastSpace + 1);
};

const getFormulaSuggestions = (formula: string, options: string[]): string[] => {
  const query = getFormulaQuery(formula).toLowerCase();
  if (!query) return [];
  return options
    .filter((option) => option.toLowerCase().startsWith(query) && option.toLowerCase() !== query)
    .slice(0, 6);
};

const applyFormulaSuggestion = (formula: string, suggestion: string): string => {
  const hasTrailingSpace = /\s$/.test(formula);
  const trimmedRight = formula.replace(/\s+$/, "");
  if (!trimmedRight || hasTrailingSpace) return `${trimmedRight}${trimmedRight ? " " : ""}${suggestion}`;
  const query = getFormulaQuery(formula);
  if (!query) return `${trimmedRight} ${suggestion}`;
  const idx = trimmedRight.lastIndexOf(query);
  if (idx < 0) return `${trimmedRight} ${suggestion}`;
  return `${trimmedRight.slice(0, idx)}${suggestion}`;
};

const NewDatasetPage = () => {
  const { datasetId } = useParams<{ datasetId: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { datasources, datasets, views, isLoading, isError, errorMessage } = useCoreData();

  const isEditing = !!datasetId;
  const editingDataset = useMemo(() => (datasetId ? datasets.find((item) => item.id === datasetId) : undefined), [datasetId, datasets]);
  const backPath = isEditing && datasetId ? `/datasets/${datasetId}` : "/datasets";
  const [savedDatasetId, setSavedDatasetId] = useState<string | null>(datasetId || null);
  const resolvedDatasetRouteId = savedDatasetId || datasetId || null;

  const [activeNode, setActiveNode] = useState<ActiveNode>("source");
  const [rightPanelMode, setRightPanelMode] = useState<"preview" | "semantic" | null>(null);
  const [columnSearch, setColumnSearch] = useState("");
  const [dragColumnId, setDragColumnId] = useState<string | null>(null);
  const [previewLimit, setPreviewLimit] = useState("15");
  const [preview, setPreview] = useState<ApiCatalogDataPreviewResponse | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);

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
  const [columns, setColumns] = useState<ColumnDraft[]>([]);
  const [computedColumns, setComputedColumns] = useState<ComputedDraft[]>([]);
  const [editingComputedId, setEditingComputedId] = useState<string | null>(null);
  const [computedForm, setComputedForm] = useState<Omit<ComputedDraft, "id">>(emptyComputedForm());
  const [pendingInclude, setPendingInclude] = useState<Array<{ resource: "r0" | "r1"; column: string; alias: string; description?: string }> | null>(null);
  const [catalogPreview, setCatalogPreview] = useState<ApiCatalogDataset | null>(null);
  const [editingMetricId, setEditingMetricId] = useState<number | null>(null);
  const [editingDimensionId, setEditingDimensionId] = useState<number | null>(null);
  const [metricForm, setMetricForm] = useState<MetricFormState>(emptyMetricForm());
  const [dimensionForm, setDimensionForm] = useState<DimensionFormState>(emptyDimensionForm());

  const activeDatasources = datasources.filter((item) => item.status === "active");
  const activeViews = views.filter((item) => item.status === "active" && (!form.datasourceId || item.datasourceId === form.datasourceId));
  const primaryView = activeViews.find((item) => item.id === form.primaryViewId);
  const secondaryView = activeViews.find((item) => item.id === form.secondaryViewId);
  const useSecondary = !!secondaryView;

  useEffect(() => {
    if (!primaryView) {
      setColumns([]);
      return;
    }
    const buildForView = (resource: "r0" | "r1", viewId?: string) => {
      if (!viewId) return [] as ColumnDraft[];
      const view = activeViews.find((item) => item.id === viewId);
      if (!view) return [] as ColumnDraft[];
      return view.columns.map((column) => {
        const id = `${resource}.${column.name}`;
        return {
          id,
          resource,
          sourceColumn: column.name,
          name: column.name,
          type: normalizeSemanticType(column.type),
          description: "",
          enabled: resource === "r0",
        } as ColumnDraft;
      });
    };
    const nextColumns = [...buildForView("r0", form.primaryViewId), ...buildForView("r1", form.secondaryViewId)];
    setColumns((prev) => {
      const prevMap = new Map(prev.map((item) => [item.id, item]));
      return nextColumns.map((item) => prevMap.get(item.id) ? { ...item, ...prevMap.get(item.id)! } : item);
    });
  }, [activeViews, form.primaryViewId, form.secondaryViewId, primaryView]);

  useEffect(() => {
    if (!pendingInclude || columns.length === 0) return;
    setColumns((prev) =>
      prev.map((column) => {
        const include = pendingInclude.find((item) => `${item.resource}.${item.column}` === column.id);
        if (!include) return { ...column, enabled: false };
        return { ...column, enabled: true, name: include.alias, description: include.description || "" };
      }),
    );
    setPendingInclude(null);
  }, [columns.length, pendingInclude]);

  useEffect(() => {
    if (!isEditing || !editingDataset || isLoading || !views.length) return;
    if (form.name.trim()) return;
    const baseQuery = editingDataset.baseQuerySpec as ApiDatasetBaseQuerySpec | null;
    let secondaryViewId = "";
    let joinType: "left" | "inner" = "left";
    let joinLeftColumn = "";
    let joinRightColumn = "";
    let includeItems: Array<{ resource: "r0" | "r1"; column: string; alias: string; description?: string }> = [];
    let computedItems: ComputedDraft[] = [];

    const resources = baseQuery?.base?.resources || [];
    const primaryResource = baseQuery?.base?.primary_resource || resources[0]?.resource_id || "";
    const resolveViewIdFromResource = (resourceId: string): string => {
      if (!resourceId || !resourceId.includes(".")) return "";
      const [schema, ...nameParts] = resourceId.split(".");
      const name = nameParts.join(".");
      return activeViews.find((item) => item.schema === schema && item.name === name)?.id || "";
    };

    let primaryViewId = editingDataset.viewId || "";
    const resolvedPrimaryFromResource = resolveViewIdFromResource(primaryResource);
    if (!primaryViewId && resolvedPrimaryFromResource) {
      primaryViewId = resolvedPrimaryFromResource;
    }

    const join = baseQuery?.base?.joins?.[0];
    if (join?.right_resource) {
      const joinResource = resources.find((item) => item.id === join.right_resource);
      secondaryViewId = resolveViewIdFromResource(joinResource?.resource_id || "");
      joinType = join.type;
      joinLeftColumn = join.on?.[0]?.left_column || "";
      joinRightColumn = join.on?.[0]?.right_column || "";
    }

    const resourceIdToNode = new Map<string, "r0" | "r1">();
    resourceIdToNode.set("r0", "r0");
    resourceIdToNode.set("r1", "r1");
    if (join?.right_resource) {
      resourceIdToNode.set(join.right_resource, "r1");
    }
    if (join?.left_resource) {
      resourceIdToNode.set(join.left_resource, "r0");
    }

    includeItems = (baseQuery?.preprocess?.columns?.include || []).map((item) => ({
      resource: resourceIdToNode.get(item.resource) || "r0",
      column: item.column,
      alias: item.alias,
    }));
    computedItems = (baseQuery?.preprocess?.computed_columns || []).map((item, index) => {
      const left = (item.expr as { args?: Array<{ column?: string }> })?.args?.[0]?.column || "";
      const right = (item.expr as { args?: Array<{ column?: string }> })?.args?.[1]?.column || "";
      const op = (item.expr as { op?: string })?.op;
      const symbol = op === "add" ? "+" : op === "sub" ? "-" : op === "mul" ? "*" : "/";
      return { id: `hydrated-${index}`, name: item.alias, formula: `${left} ${symbol} ${right}`, description: "" };
    });

    setForm({
      name: editingDataset.name,
      description: editingDataset.description || "",
      datasourceId: editingDataset.datasourceId,
      primaryViewId,
      secondaryViewId,
      joinType,
      joinLeftColumn,
      joinRightColumn,
    });
    setPendingInclude(includeItems.length > 0 ? includeItems : null);
    setComputedColumns(computedItems);
  }, [activeViews, editingDataset, form.name, isEditing, isLoading, views.length]);

  const enabledColumns = useMemo(() => columns.filter((item) => item.enabled && item.name.trim()), [columns]);
  const filteredColumns = useMemo(() => {
    const term = columnSearch.trim().toLowerCase();
    if (!term) return columns;
    return columns.filter((item) => item.name.toLowerCase().includes(term) || item.sourceColumn.toLowerCase().includes(term));
  }, [columnSearch, columns]);
  const aliasOptions = useMemo(() => enabledColumns.map((item) => item.name).filter(Boolean), [enabledColumns]);
  const computedFormSuggestions = useMemo(() => getFormulaSuggestions(computedForm.formula, aliasOptions), [aliasOptions, computedForm.formula]);

  const buildPayload = () => {
    if (!primaryView) throw new Error("Tabela base obrigatoria");
    const resources = [{ id: "r0", resource_id: `${primaryView.schema}.${primaryView.name}` }];
    if (useSecondary && secondaryView) {
      resources.push({ id: "r1", resource_id: `${secondaryView.schema}.${secondaryView.name}` });
    }
    const joins = useSecondary
      ? [{ type: form.joinType, left_resource: "r0", right_resource: "r1", on: [{ left_column: form.joinLeftColumn, right_column: form.joinRightColumn }] }]
      : [];
    const include = enabledColumns.map((item) => ({ resource: item.resource, column: item.sourceColumn, alias: item.name }));
    const computed = computedColumns
      .map((item) => {
        const expr = parseFormulaExpr(item.formula);
        if (!item.name.trim() || !expr) return null;
        return { alias: item.name.trim(), expr: { op: expr.op, args: [{ column: expr.left }, { column: expr.right }] }, data_type: "numeric" as const };
      })
      .filter((item): item is NonNullable<typeof item> => !!item);
    const semantic = [
      ...enabledColumns.map((item) => ({ name: item.name, type: item.type, source: "projected" as const, description: item.description || undefined })),
      ...computedColumns.filter((item) => item.name.trim()).map((item) => ({ name: item.name.trim(), type: "numeric" as const, source: "computed" as const, description: item.description || undefined })),
    ];
    const baseQuerySpec: ApiDatasetBaseQuerySpec = {
      version: 1,
      source: { datasource_id: Number(form.datasourceId) },
      base: { primary_resource: `${primaryView.schema}.${primaryView.name}`, resources, joins },
      preprocess: { columns: { include, exclude: [] }, computed_columns: computed, filters: [] },
    };
    return { datasource_id: Number(form.datasourceId), view_id: Number(form.primaryViewId), name: form.name.trim(), description: form.description.trim(), base_query_spec: baseQuerySpec, semantic_columns: semantic };
  };

  const canSave = !!form.name.trim() && !!form.datasourceId && !!primaryView && enabledColumns.length > 0 && (!useSecondary || (!!form.joinLeftColumn && !!form.joinRightColumn));

  const saveDataset = useMutation({
    mutationFn: async () => {
      const payload = buildPayload();
      if (isEditing && datasetId) {
        return api.updateDataset(Number(datasetId), {
          view_id: payload.view_id,
          name: payload.name,
          description: payload.description,
          base_query_spec: payload.base_query_spec,
          semantic_columns: payload.semantic_columns,
        });
      }
      return api.createDataset(payload);
    },
    onSuccess: async (dataset) => {
      setSavedDatasetId(String(dataset.id));
      await Promise.all([queryClient.invalidateQueries({ queryKey: ["datasets"] }), queryClient.invalidateQueries({ queryKey: ["dashboards"] })]);
      loadCatalog.mutate(dataset.id);
      toast({ title: isEditing ? "Dataset atualizado" : "Dataset criado" });
    },
    onError: (error: unknown) => {
      const message = error instanceof ApiError ? error.detail || error.message : "Falha ao salvar dataset";
      toast({ title: "Erro ao salvar", description: message, variant: "destructive" });
    },
  });

  const loadCatalog = useMutation({
    mutationFn: async (id: number) => api.getCatalogDataset(id),
    onSuccess: setCatalogPreview,
  });

  const loadPreview = useMutation({
    mutationFn: async () => {
      const payload = buildPayload();
      return api.previewCatalogData({
        datasource_id: Number(form.datasourceId),
        base_query_spec: payload.base_query_spec as unknown as Record<string, unknown>,
        columns: [
          ...enabledColumns.map((item) => item.name),
          ...computedColumns.filter((item) => item.name.trim()).map((item) => item.name.trim()),
        ],
        limit: Number(previewLimit),
      });
    },
    onSuccess: (data) => {
      setPreview(data);
      setPreviewError(null);
    },
    onError: (error: unknown) => {
      const message = error instanceof ApiError ? error.detail || error.message : "Falha ao carregar preview";
      setPreviewError(message);
    },
  });

  useEffect(() => {
    if (!form.datasourceId || !primaryView || enabledColumns.length === 0) {
      setPreview(null);
      setPreviewError(null);
      return;
    }
    if (useSecondary && (!form.joinLeftColumn || !form.joinRightColumn)) return;
    const t = window.setTimeout(() => loadPreview.mutate(), 450);
    return () => window.clearTimeout(t);
  }, [form.datasourceId, form.primaryViewId, form.secondaryViewId, form.joinLeftColumn, form.joinRightColumn, form.joinType, enabledColumns, computedColumns, previewLimit]);

  useEffect(() => {
    if (!resolvedDatasetRouteId) return;
    if (catalogPreview || loadCatalog.isPending) return;
    loadCatalog.mutate(Number(resolvedDatasetRouteId));
  }, [catalogPreview, loadCatalog, resolvedDatasetRouteId]);

  useEffect(() => {
    const semanticNodeActive = activeNode === "computed" || activeNode === "metrics" || activeNode === "dimensions";
    if (rightPanelMode === "semantic" && !semanticNodeActive) {
      setRightPanelMode(null);
    }
  }, [activeNode, rightPanelMode]);

  const createMetric = useMutation({
    mutationFn: async () => {
      if (!resolvedDatasetRouteId) throw new Error("Salve o dataset antes de criar metricas");
      return api.createCatalogMetric({
        dataset_id: Number(resolvedDatasetRouteId),
        name: metricForm.name.trim(),
        description: metricForm.description.trim() || undefined,
        formula: metricForm.formula.trim(),
        unit: metricForm.unit.trim() || undefined,
        default_grain: metricForm.defaultGrain.trim() || undefined,
        synonyms: parseCsv(metricForm.synonyms),
        examples: parseCsv(metricForm.examples),
      });
    },
    onSuccess: () => {
      if (resolvedDatasetRouteId) loadCatalog.mutate(Number(resolvedDatasetRouteId));
      setEditingMetricId(null);
      setMetricForm(emptyMetricForm());
    },
  });

  const updateMetric = useMutation({
    mutationFn: async () => {
      if (!editingMetricId) throw new Error("Selecione uma metrica");
      return api.updateCatalogMetric(editingMetricId, {
        name: metricForm.name.trim(),
        description: metricForm.description.trim(),
        formula: metricForm.formula.trim(),
        unit: metricForm.unit.trim(),
        default_grain: metricForm.defaultGrain.trim(),
        synonyms: parseCsv(metricForm.synonyms),
        examples: parseCsv(metricForm.examples),
      });
    },
    onSuccess: () => {
      if (resolvedDatasetRouteId) loadCatalog.mutate(Number(resolvedDatasetRouteId));
      setEditingMetricId(null);
      setMetricForm(emptyMetricForm());
    },
  });

  const deleteMetric = useMutation({
    mutationFn: async (metricId: number) => api.deleteCatalogMetric(metricId),
    onSuccess: () => {
      if (resolvedDatasetRouteId) loadCatalog.mutate(Number(resolvedDatasetRouteId));
    },
  });

  const createDimension = useMutation({
    mutationFn: async () => {
      if (!resolvedDatasetRouteId) throw new Error("Salve o dataset antes de criar dimensoes");
      return api.createCatalogDimension({
        dataset_id: Number(resolvedDatasetRouteId),
        name: dimensionForm.name.trim(),
        description: dimensionForm.description.trim() || undefined,
        type: dimensionForm.type,
        synonyms: parseCsv(dimensionForm.synonyms),
      });
    },
    onSuccess: () => {
      if (resolvedDatasetRouteId) loadCatalog.mutate(Number(resolvedDatasetRouteId));
      setEditingDimensionId(null);
      setDimensionForm(emptyDimensionForm());
    },
  });

  const updateDimension = useMutation({
    mutationFn: async () => {
      if (!editingDimensionId) throw new Error("Selecione uma dimensao");
      return api.updateCatalogDimension(editingDimensionId, {
        name: dimensionForm.name.trim(),
        description: dimensionForm.description.trim(),
        type: dimensionForm.type,
        synonyms: parseCsv(dimensionForm.synonyms),
      });
    },
    onSuccess: () => {
      if (resolvedDatasetRouteId) loadCatalog.mutate(Number(resolvedDatasetRouteId));
      setEditingDimensionId(null);
      setDimensionForm(emptyDimensionForm());
    },
  });

  const deleteDimension = useMutation({
    mutationFn: async (dimensionId: number) => api.deleteCatalogDimension(dimensionId),
    onSuccess: () => {
      if (resolvedDatasetRouteId) loadCatalog.mutate(Number(resolvedDatasetRouteId));
    },
  });

  const focusedColumn = useMemo(() => {
    if (!activeNode.startsWith("column:")) return null;
    const id = activeNode.slice(7);
    return columns.find((item) => item.id === id) || null;
  }, [activeNode, columns]);

  const counters = useMemo(
    () => ({
      columns: enabledColumns.length + computedColumns.filter((item) => item.name.trim()).length,
      joins: useSecondary ? 1 : 0,
      metrics: catalogPreview?.metrics.length || 0,
      dimensions: catalogPreview?.dimensions.length || 0,
    }),
    [catalogPreview?.dimensions.length, catalogPreview?.metrics.length, computedColumns, enabledColumns.length, useSecondary],
  );
  const isSemanticNode = activeNode === "computed" || activeNode === "metrics" || activeNode === "dimensions";
  const showSemanticConfigPanel = rightPanelMode === "semantic" && isSemanticNode;
  const showPreviewPanel = rightPanelMode === "preview";

  const structureItems: Array<{ id: ActiveNode; label: string; icon: typeof Database; count?: number }> = [
    { id: "source", label: "Fonte", icon: Database },
    { id: "base", label: "Tabela Base", icon: Table2 },
    { id: "joins", label: "Joins", icon: Link2, count: counters.joins },
    { id: "columns", label: "Colunas", icon: Table2, count: counters.columns },
    { id: "computed", label: "Colunas Calculadas", icon: Calculator, count: computedColumns.length },
    { id: "metrics", label: "Metricas", icon: Sigma, count: counters.metrics },
    { id: "dimensions", label: "Dimensoes", icon: Tag, count: counters.dimensions },
  ];

  const reorderColumns = (fromId: string, toId: string) => {
    if (fromId === toId) return;
    setColumns((prev) => {
      const fromIndex = prev.findIndex((item) => item.id === fromId);
      const toIndex = prev.findIndex((item) => item.id === toId);
      if (fromIndex < 0 || toIndex < 0) return prev;
      const next = [...prev];
      const [moved] = next.splice(fromIndex, 1);
      next.splice(toIndex, 0, moved);
      return next;
    });
  };

  const startCreateComputed = () => {
    setRightPanelMode("semantic");
    setEditingComputedId(null);
    setComputedForm(emptyComputedForm());
  };

  const startEditComputed = (item: ComputedDraft) => {
    setRightPanelMode("semantic");
    setEditingComputedId(item.id);
    setComputedForm({ name: item.name, formula: item.formula, description: item.description });
  };

  const saveComputed = () => {
    if (!computedForm.name.trim() || !parseFormulaExpr(computedForm.formula)) return;
    if (editingComputedId) {
      setComputedColumns((prev) =>
        prev.map((item) => item.id === editingComputedId ? { ...item, ...computedForm, name: computedForm.name.trim() } : item),
      );
    } else {
      setComputedColumns((prev) => [...prev, { id: `cc-${Date.now()}`, ...computedForm, name: computedForm.name.trim() }]);
    }
    setEditingComputedId(null);
    setComputedForm(emptyComputedForm());
  };

  const removeComputed = (id: string) => {
    setComputedColumns((prev) => prev.filter((item) => item.id !== id));
    if (editingComputedId === id) {
      setEditingComputedId(null);
      setComputedForm(emptyComputedForm());
    }
  };

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
    <div className="bg-background h-[calc(100vh-56px)] min-h-0 flex flex-col overflow-hidden">
      <header className="h-12 border-b border-border bg-card/90 px-3 backdrop-blur-sm">
        <div className="flex h-full items-center justify-between gap-3">
          <div className="min-w-0 flex items-center gap-3">
            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => navigate(backPath)}>
              <ArrowLeft className="h-4 w-4" />
            </Button>
            <p className="truncate text-sm font-semibold">{form.name || "Dataset sem titulo"}</p>
            <Badge
              variant="outline"
              className={cn(
                "h-5 text-[10px] font-medium",
                saveDataset.isPending
                  ? "bg-accent/10 text-accent border-accent/20"
                  : resolvedDatasetRouteId
                    ? "bg-success/10 text-success border-success/20"
                    : "bg-warning/10 text-warning border-warning/20",
              )}
            >
              {saveDataset.isPending ? "Salvando..." : resolvedDatasetRouteId ? "Salvo" : "Nao salvo"}
            </Badge>
            <div className="hidden lg:flex items-center gap-3 text-[11px] text-muted-foreground">
              <span className="inline-flex items-center gap-1"><Columns3 className="h-3 w-3" />{counters.columns} colunas</span>
              <span className="inline-flex items-center gap-1"><Link2 className="h-3 w-3" />{counters.joins} joins</span>
              <span className="inline-flex items-center gap-1"><Sigma className="h-3 w-3" />{counters.metrics} metricas</span>
              <span className="inline-flex items-center gap-1"><Tag className="h-3 w-3" />{counters.dimensions} dimensoes</span>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              className="h-8 text-xs gap-1.5"
              onClick={() => setRightPanelMode((prev) => prev === "preview" ? null : "preview")}
            >
              {rightPanelMode === "preview" ? <X className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
              {rightPanelMode === "preview" ? "Fechar lateral" : "Abrir preview"}
            </Button>
            <Button onClick={() => saveDataset.mutate()} disabled={!canSave || saveDataset.isPending} className="h-8 text-xs gap-1.5 bg-accent text-accent-foreground hover:bg-accent/90">
              <Save className="h-3 w-3" />
              Salvar
            </Button>
          </div>
        </div>
      </header>

      <ResizablePanelGroup direction="horizontal" className="h-full min-h-0">
        <ResizablePanel defaultSize={18} minSize={14} maxSize={28}>
          <aside className="h-full border-r border-border/50 bg-card/30 overflow-hidden flex flex-col">
            <div className="px-3 pt-3 pb-2 border-b border-border/50">
              <p className="inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                <Layers3 className="h-3.5 w-3.5" />
                Estrutura
              </p>
            </div>
            <ScrollArea className="h-full px-3 pb-3">
              <div className="space-y-1.5 pt-3">
                {structureItems.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => setActiveNode(item.id)}
                    className={cn(
                      "group w-full rounded-lg border border-border/50 bg-card/50 px-3 py-2.5 text-left transition-colors",
                      activeNode === item.id
                        ? "border-accent/35 bg-accent/10 text-foreground"
                        : "text-muted-foreground hover:border-accent/30 hover:bg-muted/50 hover:text-foreground",
                    )}
                  >
                    <span className="flex items-start gap-2.5">
                      <span className={cn(
                        "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md",
                        activeNode === item.id ? "bg-accent/15 text-accent" : "bg-accent/10 text-accent",
                      )}>
                        <item.icon className="h-4 w-4" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-xs font-semibold whitespace-normal break-words leading-4">{item.label}</span>
                        <span className="block text-[10px] text-muted-foreground whitespace-normal break-words leading-4">
                          {item.id === "source" ? "Conexao e metadados do dataset" : null}
                          {item.id === "base" ? "Tabela base principal" : null}
                          {item.id === "joins" ? "Relacionamentos entre tabelas" : null}
                          {item.id === "columns" ? "Selecao, rename e descricao" : null}
                          {item.id === "computed" ? "Formulas e colunas derivadas" : null}
                          {item.id === "metrics" ? "Indicadores agregados do catalogo" : null}
                          {item.id === "dimensions" ? "Eixos de segmentacao" : null}
                        </span>
                      </span>
                      {item.count != null ? <Badge variant="outline" className="h-5 px-1.5 text-[10px] mt-0.5">{item.count}</Badge> : null}
                    </span>
                  </button>
                ))}
              </div>
              <Separator className="my-3" />
              <div className="pb-2">
                <p className="mb-2 text-[11px] uppercase tracking-wide text-muted-foreground">Colunas</p>
                <div className="relative">
                  <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                  <Input value={columnSearch} onChange={(event) => setColumnSearch(event.target.value)} className="h-9 pl-8" placeholder="Buscar..." />
                </div>
              </div>
              <div className="space-y-1">
                {filteredColumns.map((column) => (
                  <button
                    key={`left-${column.id}`}
                    type="button"
                    onClick={() => setActiveNode(`column:${column.id}`)}
                    className={cn(
                      "w-full rounded-lg border border-border/50 bg-card/50 px-2.5 py-2 text-left transition-colors",
                      activeNode === `column:${column.id}` ? "border-accent/30 bg-accent/10" : "hover:border-accent/25 hover:bg-muted/40",
                    )}
                  >
                  <p className="truncate text-xs font-medium">{column.name}</p>
                    <p className="text-[11px] text-muted-foreground">{column.type}</p>
                  </button>
                ))}
              </div>
            </ScrollArea>
          </aside>
        </ResizablePanel>

        <ResizableHandle withHandle />

        <ResizablePanel defaultSize={50} minSize={34}>
          <section className="h-full overflow-auto p-6">
            <motion.div key={activeNode} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="max-w-4xl">
              {activeNode === "source" && (
                <EditorCard icon={Database} title="Fonte de Dados" subtitle="Datasource selector">
                  <Label>Nome *</Label>
                  <Input value={form.name} onChange={(event) => setForm((prev) => ({ ...prev, name: event.target.value }))} />
                  <Label>Descricao</Label>
                  <Textarea value={form.description} onChange={(event) => setForm((prev) => ({ ...prev, description: event.target.value }))} rows={3} />
                  <Label>Datasource *</Label>
                  <Select value={form.datasourceId} onValueChange={(value) => setForm((prev) => ({ ...prev, datasourceId: value }))}>
                    <SelectTrigger><SelectValue placeholder="Selecione..." /></SelectTrigger>
                    <SelectContent>{activeDatasources.map((item) => <SelectItem key={item.id} value={item.id}>{item.name}</SelectItem>)}</SelectContent>
                  </Select>
                </EditorCard>
              )}
              {activeNode === "base" && (
                <EditorCard icon={Table2} title="Tabela Base" subtitle="Table selector">
                  <Label>Tabela principal *</Label>
                  <Select value={form.primaryViewId} onValueChange={(value) => setForm((prev) => ({ ...prev, primaryViewId: value }))} disabled={!form.datasourceId}>
                    <SelectTrigger><SelectValue placeholder="Selecione..." /></SelectTrigger>
                    <SelectContent>{activeViews.map((item) => <SelectItem key={item.id} value={item.id}>{item.schema}.{item.name}</SelectItem>)}</SelectContent>
                  </Select>
                </EditorCard>
              )}
              {activeNode === "joins" && (
                <EditorCard icon={Link2} title="Joins" subtitle="+ Add join / table / condition / type">
                  {!useSecondary ? <Button variant="outline" onClick={() => {
                    const candidate = activeViews.find((item) => item.id !== form.primaryViewId);
                    if (candidate) setForm((prev) => ({ ...prev, secondaryViewId: candidate.id }));
                  }} disabled={!form.primaryViewId}><Plus className="h-4 w-4 mr-1.5" />Add join</Button> : null}
                  {useSecondary && (
                    <div className="grid gap-3 md:grid-cols-2">
                      <Select value={form.secondaryViewId} onValueChange={(value) => setForm((prev) => ({ ...prev, secondaryViewId: value }))}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{activeViews.filter((item) => item.id !== form.primaryViewId).map((item) => <SelectItem key={item.id} value={item.id}>{item.schema}.{item.name}</SelectItem>)}</SelectContent></Select>
                      <Select value={form.joinType} onValueChange={(value) => setForm((prev) => ({ ...prev, joinType: value as FormState["joinType"] }))}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="left">left</SelectItem><SelectItem value="inner">inner</SelectItem></SelectContent></Select>
                      <Select value={form.joinLeftColumn || "__none__"} onValueChange={(value) => setForm((prev) => ({ ...prev, joinLeftColumn: value === "__none__" ? "" : value }))}><SelectTrigger><SelectValue placeholder="left column" /></SelectTrigger><SelectContent><SelectItem value="__none__">Selecione...</SelectItem>{(primaryView?.columns || []).map((item) => <SelectItem key={item.name} value={item.name}>{item.name}</SelectItem>)}</SelectContent></Select>
                      <Select value={form.joinRightColumn || "__none__"} onValueChange={(value) => setForm((prev) => ({ ...prev, joinRightColumn: value === "__none__" ? "" : value }))}><SelectTrigger><SelectValue placeholder="right column" /></SelectTrigger><SelectContent><SelectItem value="__none__">Selecione...</SelectItem>{(secondaryView?.columns || []).map((item) => <SelectItem key={item.name} value={item.name}>{item.name}</SelectItem>)}</SelectContent></Select>
                      <Button variant="outline" className="destructive-icon-btn md:col-span-2" onClick={() => setForm((prev) => ({ ...prev, secondaryViewId: "", joinLeftColumn: "", joinRightColumn: "" }))}><Trash2 className="h-4 w-4 mr-1.5" />Remover join</Button>
                    </div>
                  )}
                </EditorCard>
              )}
              {activeNode === "columns" && (
                <EditorCard icon={Table2} title="Colunas" subtitle="[checkbox] column_name | type | rename | description">
                  <div className="rounded-xl border border-border/60 overflow-hidden">
                    <Table className="text-caption">
                      <TableHeader className="bg-muted/30">
                        <TableRow className="hover:bg-muted/30">
                          <TableHead className="h-9 w-8 px-2" />
                          <TableHead className="h-9 w-8 px-2" />
                          <TableHead className="h-9 px-2 text-[11px] uppercase tracking-wide">column_name</TableHead>
                          <TableHead className="h-9 w-[120px] px-2 text-[11px] uppercase tracking-wide">type</TableHead>
                          <TableHead className="h-9 px-2 text-[11px] uppercase tracking-wide">rename</TableHead>
                          <TableHead className="h-9 px-2 text-[11px] uppercase tracking-wide">description</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {filteredColumns.map((column) => (
                          <TableRow
                            key={`row-${column.id}`}
                            draggable
                            onDragStart={() => setDragColumnId(column.id)}
                            onDragOver={(event) => event.preventDefault()}
                            onDrop={(event) => {
                              event.preventDefault();
                              if (dragColumnId) reorderColumns(dragColumnId, column.id);
                              setDragColumnId(null);
                            }}
                            className="align-middle"
                          >
                            <TableCell className="w-8 p-2">
                              <GripVertical className="h-4 w-4 text-muted-foreground/70" />
                            </TableCell>
                            <TableCell className="w-8 p-2">
                              <Checkbox
                                checked={column.enabled}
                                onCheckedChange={(checked) => {
                                  const isChecked = checked === true;
                                  setColumns((prev) => prev.map((item) => item.id === column.id ? { ...item, enabled: isChecked } : item));
                                }}
                              />
                            </TableCell>
                            <TableCell className="px-2 py-2.5 text-sm">{column.sourceColumn}</TableCell>
                            <TableCell className="px-2 py-2.5">
                              <Badge variant="outline" className="w-fit text-[10px]">{column.type}</Badge>
                            </TableCell>
                            <TableCell className="px-2 py-2.5">
                              <Input
                                className="h-8 text-caption"
                                value={column.name}
                                onChange={(event) => setColumns((prev) => prev.map((item) => item.id === column.id ? { ...item, name: event.target.value } : item))}
                              />
                            </TableCell>
                            <TableCell className="px-2 py-2.5">
                              <Input
                                className="h-8 text-caption"
                                value={column.description}
                                onChange={(event) => setColumns((prev) => prev.map((item) => item.id === column.id ? { ...item, description: event.target.value } : item))}
                              />
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                </EditorCard>
              )}
              {activeNode === "computed" && (
                <EditorCard icon={Calculator} title="Colunas Calculadas" subtitle="name / formula / description">
                  <div className="flex items-center justify-between">
                    <p className="text-caption text-muted-foreground">A configuracao desta lista fica no painel lateral.</p>
                    <Button variant="outline" size="sm" className="h-8 text-caption" onClick={startCreateComputed}>
                      <Plus className="h-3.5 w-3.5 mr-1" />
                      Nova coluna
                    </Button>
                  </div>
                  <div className="space-y-2">
                    {computedColumns.length === 0 ? (
                      <p className="text-sm text-muted-foreground">Nenhuma coluna calculada criada.</p>
                    ) : (
                      computedColumns.map((item) => (
                        <div key={item.id} className={cn("rounded-lg border bg-card/35 p-3", editingComputedId === item.id ? "border-accent/40" : "border-border/60")}>
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0">
                              <p className="truncate text-sm font-medium">{item.name}</p>
                              <p className="text-caption font-mono text-muted-foreground">{item.formula || "-"}</p>
                              {item.description ? <p className="mt-1 text-caption text-muted-foreground">{item.description}</p> : null}
                            </div>
                            <div className="flex gap-1">
                              <Button variant="ghost" size="sm" className="h-7 text-caption" onClick={() => startEditComputed(item)}>
                                Editar
                              </Button>
                              <Button variant="ghost" size="sm" className="h-7 text-caption destructive-icon-btn" onClick={() => removeComputed(item.id)}>
                                Remover
                              </Button>
                            </div>
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                </EditorCard>
              )}
              {activeNode === "metrics" && (
                <EditorCard
                  icon={Sigma}
                  title="Metrics"
                  subtitle="name / aggregation / formula"
                  hint="Metricas representam calculos agregados, como SUM(receita) ou COUNT(id)."
                >
                  {!resolvedDatasetRouteId ? (
                    <p className="text-sm text-muted-foreground">Salve o dataset para editar metricas.</p>
                  ) : (
                    <div className="space-y-3">
                      <div className="flex items-center justify-between">
                        <p className="text-caption text-muted-foreground">A configuracao de novas metricas fica no painel lateral.</p>
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-8 text-caption"
                          onClick={() => {
                            setRightPanelMode("semantic");
                            setEditingMetricId(null);
                            setMetricForm(emptyMetricForm());
                          }}
                        >
                          <Plus className="h-3.5 w-3.5 mr-1" />
                          Nova metrica
                        </Button>
                      </div>
                      {(catalogPreview?.metrics || []).length === 0 ? <p className="text-sm text-muted-foreground">Nenhuma metrica criada.</p> : null}
                      <div className="space-y-2">
                        {(catalogPreview?.metrics || []).map((item) => (
                          <div key={item.id} className={cn("rounded-lg border bg-card/35 p-3", editingMetricId === item.id ? "border-accent/40" : "border-border/60")}>
                            <div className="flex items-start justify-between gap-2">
                              <div>
                                <p className="text-sm font-medium">{item.name}</p>
                                <p className="text-caption font-mono text-muted-foreground">{item.formula}</p>
                              </div>
                              <div className="flex gap-1">
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="h-7 text-caption"
                                  onClick={() => {
                                    setRightPanelMode("semantic");
                                    setEditingMetricId(item.id);
                                    setMetricForm(metricToForm(item));
                                  }}
                                >
                                  Editar
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="h-7 text-caption destructive-icon-btn"
                                  onClick={() => {
                                    if (editingMetricId === item.id) {
                                      setEditingMetricId(null);
                                      setMetricForm(emptyMetricForm());
                                    }
                                    deleteMetric.mutate(item.id);
                                  }}
                                >
                                  Remover
                                </Button>
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </EditorCard>
              )}
              {activeNode === "dimensions" && (
                <EditorCard
                  icon={Tag}
                  title="Dimensions"
                  subtitle="name / type / source column"
                  hint="Dimensoes segmentam as metricas para analise, como data, cidade ou parceiro."
                >
                  {!resolvedDatasetRouteId ? (
                    <p className="text-sm text-muted-foreground">Salve o dataset para editar dimensoes.</p>
                  ) : (
                    <div className="space-y-3">
                      <div className="flex items-center justify-between">
                        <p className="text-caption text-muted-foreground">A configuracao de novas dimensoes fica no painel lateral.</p>
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-8 text-caption"
                          onClick={() => {
                            setRightPanelMode("semantic");
                            setEditingDimensionId(null);
                            setDimensionForm(emptyDimensionForm());
                          }}
                        >
                          <Plus className="h-3.5 w-3.5 mr-1" />
                          Nova dimensao
                        </Button>
                      </div>
                      {(catalogPreview?.dimensions || []).length === 0 ? <p className="text-sm text-muted-foreground">Nenhuma dimensao criada.</p> : null}
                      <div className="space-y-2">
                        {(catalogPreview?.dimensions || []).map((item) => (
                          <div key={item.id} className={cn("rounded-lg border bg-card/35 p-3", editingDimensionId === item.id ? "border-accent/40" : "border-border/60")}>
                            <div className="flex items-start justify-between gap-2">
                              <div>
                                <p className="text-sm font-medium">{item.name}</p>
                                <p className="text-caption text-muted-foreground">{item.type}</p>
                              </div>
                              <div className="flex gap-1">
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="h-7 text-caption"
                                  onClick={() => {
                                    setRightPanelMode("semantic");
                                    setEditingDimensionId(item.id);
                                    setDimensionForm(dimensionToForm(item));
                                  }}
                                >
                                  Editar
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="h-7 text-caption destructive-icon-btn"
                                  onClick={() => {
                                    if (editingDimensionId === item.id) {
                                      setEditingDimensionId(null);
                                      setDimensionForm(emptyDimensionForm());
                                    }
                                    deleteDimension.mutate(item.id);
                                  }}
                                >
                                  Remover
                                </Button>
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </EditorCard>
              )}
              {focusedColumn && (
                <EditorCard icon={Hash} title={`Coluna: ${focusedColumn.name}`} subtitle="Configuracao individual da coluna">
                  <Label>Rename</Label>
                  <Input value={focusedColumn.name} onChange={(event) => setColumns((prev) => prev.map((item) => item.id === focusedColumn.id ? { ...item, name: event.target.value } : item))} />
                  <Label>Description</Label>
                  <Textarea value={focusedColumn.description} onChange={(event) => setColumns((prev) => prev.map((item) => item.id === focusedColumn.id ? { ...item, description: event.target.value } : item))} rows={3} />
                </EditorCard>
              )}
            </motion.div>
          </section>
        </ResizablePanel>

        {rightPanelMode ? (
          <>
            <ResizableHandle withHandle />
            <ResizablePanel defaultSize={32} minSize={24} maxSize={40}>
              {showSemanticConfigPanel ? (
            <aside className="h-full border-l border-border/60 bg-[hsl(var(--card)/0.28)] flex flex-col overflow-hidden">
              <div className="px-4 py-4 border-b border-border/60 flex items-start justify-between gap-2">
                <div>
                  <p className="inline-flex items-center gap-2 text-sm font-semibold">
                    {activeNode === "computed" ? <Calculator className="h-4 w-4 text-accent" /> : null}
                    {activeNode === "metrics" ? <Sigma className="h-4 w-4 text-accent" /> : null}
                    {activeNode === "dimensions" ? <Tag className="h-4 w-4 text-accent" /> : null}
                    CONFIGURACAO
                  </p>
                  <p className="mt-1 text-caption text-muted-foreground">
                    {activeNode === "computed" ? "Criar e editar colunas calculadas." : null}
                    {activeNode === "metrics" ? "Criar e editar metricas do catalogo semantico." : null}
                    {activeNode === "dimensions" ? "Criar e editar dimensoes do catalogo semantico." : null}
                  </p>
                </div>
                <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setRightPanelMode(null)}>
                  <X className="h-4 w-4" />
                </Button>
              </div>
              <ScrollArea className="min-h-0 flex-1">
                <div className="p-4">
                  {activeNode === "computed" ? (
                    <div className="rounded-xl border border-border/60 bg-card/35 p-3 space-y-2">
                      <Input
                        placeholder="name"
                        value={computedForm.name}
                        onChange={(event) => setComputedForm((prev) => ({ ...prev, name: event.target.value }))}
                      />
                      <div className="space-y-1.5">
                        <Input
                          placeholder="formula"
                          value={computedForm.formula}
                          onChange={(event) => setComputedForm((prev) => ({ ...prev, formula: event.target.value }))}
                          className="font-mono"
                        />
                        {computedFormSuggestions.length > 0 ? (
                          <div className="rounded-md border border-border/60 bg-background p-1.5 flex flex-wrap gap-1.5">
                            {computedFormSuggestions.map((suggestion) => (
                              <button
                                key={`computed-suggest-${suggestion}`}
                                type="button"
                                className="rounded bg-muted px-2 py-1 text-[11px] font-mono hover:bg-accent/20"
                                onClick={() => setComputedForm((prev) => ({ ...prev, formula: applyFormulaSuggestion(prev.formula, suggestion) }))}
                              >
                                {suggestion}
                              </button>
                            ))}
                          </div>
                        ) : null}
                      </div>
                      <Input
                        placeholder="description"
                        value={computedForm.description}
                        onChange={(event) => setComputedForm((prev) => ({ ...prev, description: event.target.value }))}
                      />
                      <div className="flex flex-wrap gap-1.5">
                        {aliasOptions.map((alias) => (
                          <button
                            key={`computed-alias-${alias}`}
                            type="button"
                            className="rounded bg-muted px-2 py-1 text-[11px] font-mono"
                            onClick={() => setComputedForm((prev) => ({ ...prev, formula: `${prev.formula}${prev.formula ? " " : ""}${alias}` }))}
                          >
                            {alias}
                          </button>
                        ))}
                      </div>
                      <div className="flex gap-2">
                        <Button
                          onClick={saveComputed}
                          disabled={!computedForm.name.trim() || !parseFormulaExpr(computedForm.formula)}
                        >
                          {editingComputedId ? "Salvar coluna" : "Criar coluna"}
                        </Button>
                        {(editingComputedId || computedForm.name || computedForm.formula || computedForm.description) ? (
                          <Button variant="outline" onClick={startCreateComputed}>
                            Limpar
                          </Button>
                        ) : null}
                      </div>
                    </div>
                  ) : null}

                  {activeNode === "metrics" ? (
                    <div className="rounded-xl border border-border/60 bg-card/35 p-3 space-y-2">
                      {!resolvedDatasetRouteId ? <p className="text-sm text-muted-foreground">Salve o dataset para criar metricas.</p> : (
                        <>
                          <Input
                            placeholder="name"
                            value={metricForm.name}
                            onChange={(event) => setMetricForm((prev) => ({ ...prev, name: event.target.value }))}
                          />
                          <Input
                            placeholder="formula"
                            value={metricForm.formula}
                            onChange={(event) => setMetricForm((prev) => ({ ...prev, formula: event.target.value }))}
                          />
                          <Input
                            placeholder="description"
                            value={metricForm.description}
                            onChange={(event) => setMetricForm((prev) => ({ ...prev, description: event.target.value }))}
                          />
                          <div className="grid grid-cols-2 gap-2">
                            <Input
                              placeholder="unit"
                              value={metricForm.unit}
                              onChange={(event) => setMetricForm((prev) => ({ ...prev, unit: event.target.value }))}
                            />
                            <Input
                              placeholder="default grain"
                              value={metricForm.defaultGrain}
                              onChange={(event) => setMetricForm((prev) => ({ ...prev, defaultGrain: event.target.value }))}
                            />
                          </div>
                          <Input
                            placeholder="synonyms (csv)"
                            value={metricForm.synonyms}
                            onChange={(event) => setMetricForm((prev) => ({ ...prev, synonyms: event.target.value }))}
                          />
                          <Input
                            placeholder="examples (csv)"
                            value={metricForm.examples}
                            onChange={(event) => setMetricForm((prev) => ({ ...prev, examples: event.target.value }))}
                          />
                          <div className="flex gap-2">
                            <Button
                              onClick={() => (editingMetricId ? updateMetric.mutate() : createMetric.mutate())}
                              disabled={!metricForm.name.trim() || !metricForm.formula.trim()}
                            >
                              {editingMetricId ? "Salvar metrica" : "Criar metrica"}
                            </Button>
                            {(editingMetricId || metricForm.name || metricForm.formula || metricForm.description || metricForm.unit || metricForm.synonyms || metricForm.examples) ? (
                              <Button
                                variant="outline"
                                onClick={() => {
                                  setEditingMetricId(null);
                                  setMetricForm(emptyMetricForm());
                                }}
                              >
                                Limpar
                              </Button>
                            ) : null}
                          </div>
                        </>
                      )}
                    </div>
                  ) : null}

                  {activeNode === "dimensions" ? (
                    <div className="rounded-xl border border-border/60 bg-card/35 p-3 space-y-2">
                      {!resolvedDatasetRouteId ? <p className="text-sm text-muted-foreground">Salve o dataset para criar dimensoes.</p> : (
                        <>
                          <Input
                            placeholder="name"
                            value={dimensionForm.name}
                            onChange={(event) => setDimensionForm((prev) => ({ ...prev, name: event.target.value }))}
                          />
                          <Input
                            placeholder="description"
                            value={dimensionForm.description}
                            onChange={(event) => setDimensionForm((prev) => ({ ...prev, description: event.target.value }))}
                          />
                          <Select
                            value={dimensionForm.type}
                            onValueChange={(value) => setDimensionForm((prev) => ({ ...prev, type: value as DimensionFormState["type"] }))}
                          >
                            <SelectTrigger><SelectValue /></SelectTrigger>
                            <SelectContent>
                              <SelectItem value="categorical">categorical</SelectItem>
                              <SelectItem value="temporal">temporal</SelectItem>
                              <SelectItem value="relational">relational</SelectItem>
                            </SelectContent>
                          </Select>
                          <Input
                            placeholder="synonyms (csv)"
                            value={dimensionForm.synonyms}
                            onChange={(event) => setDimensionForm((prev) => ({ ...prev, synonyms: event.target.value }))}
                          />
                          <div className="flex gap-2">
                            <Button
                              onClick={() => (editingDimensionId ? updateDimension.mutate() : createDimension.mutate())}
                              disabled={!dimensionForm.name.trim()}
                            >
                              {editingDimensionId ? "Salvar dimensao" : "Criar dimensao"}
                            </Button>
                            {(editingDimensionId || dimensionForm.name || dimensionForm.description || dimensionForm.synonyms) ? (
                              <Button
                                variant="outline"
                                onClick={() => {
                                  setEditingDimensionId(null);
                                  setDimensionForm(emptyDimensionForm());
                                }}
                              >
                                Limpar
                              </Button>
                            ) : null}
                          </div>
                        </>
                      )}
                    </div>
                  ) : null}
                </div>
              </ScrollArea>
            </aside>
              ) : showPreviewPanel ? (
            <aside className="h-full border-l border-border/60 bg-[hsl(var(--card)/0.28)] flex flex-col overflow-hidden">
              <div className="px-4 py-4 border-b border-border/60 flex items-center justify-between gap-2">
                <p className="inline-flex items-center gap-2 text-sm font-semibold"><Eye className="h-4 w-4 text-accent" />PREVIEW</p>
                <div className="flex items-center gap-2">
                  <Select value={previewLimit} onValueChange={setPreviewLimit}>
                    <SelectTrigger className="h-8 w-[96px] text-xs"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="10">10 linhas</SelectItem>
                      <SelectItem value="15">15 linhas</SelectItem>
                      <SelectItem value="20">20 linhas</SelectItem>
                    </SelectContent>
                  </Select>
                  <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setRightPanelMode(null)}>
                    <X className="h-4 w-4" />
                  </Button>
                </div>
              </div>
              <div className="px-4 py-2 text-caption text-muted-foreground border-b border-border/50">
                {preview?.columns.length || 0} colunas . {preview?.row_count || 0} linhas
              </div>
              <div className="min-h-0 flex-1">
                {loadPreview.isPending && !preview ? (
                  <div className="h-full px-4">
                    <EmptyState
                      icon={<Loader2 className="h-5 w-5 animate-spin" />}
                      title="Gerando preview"
                      description="Executando query de teste com as configuracoes atuais."
                    />
                  </div>
                ) : null}
                {previewError ? (
                  <div className="h-full px-4">
                    <EmptyState
                      icon={<Eye className="h-5 w-5" />}
                      title="Falha no preview"
                      description={previewError}
                    />
                  </div>
                ) : null}
                {preview && preview.columns.length > 0 ? (
                  <ScrollArea className="h-full">
                    <div className="min-w-max">
                      <Table className="text-caption">
                        <TableHeader className="sticky top-0 z-10 bg-card/90">
                          <TableRow className="hover:bg-card/90">
                            {preview.columns.map((column) => (
                              <TableHead key={`head-${column}`} className="h-9 px-3 py-2 whitespace-nowrap">{column}</TableHead>
                            ))}
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {preview.rows.map((row, rowIndex) => (
                            <TableRow key={`row-${rowIndex}`} className="border-b border-border/40">
                              {preview.columns.map((column) => (
                                <TableCell key={`cell-${rowIndex}-${column}`} className="px-3 py-2 whitespace-nowrap">
                                  {String((row as Record<string, unknown>)[column] ?? "-")}
                                </TableCell>
                              ))}
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  </ScrollArea>
                ) : null}
                {!loadPreview.isPending && !preview && !previewError ? (
                  <div className="h-full px-4">
                    <EmptyState
                      icon={<Eye className="h-5 w-5" />}
                      title="Preview indisponivel"
                      description="Selecione fonte, tabela base e colunas para visualizar dados."
                    />
                  </div>
                ) : null}
              </div>
            </aside>
              ) : null}
            </ResizablePanel>
          </>
        ) : null}
      </ResizablePanelGroup>
    </div>
  );
};

const EditorCard = ({
  icon: Icon,
  title,
  subtitle,
  hint,
  children,
}: {
  icon: typeof Database;
  title: string;
  subtitle: string;
  hint?: string;
  children: ReactNode;
}) => (
  <Card className="rounded-2xl border-border/60 bg-[hsl(var(--card)/0.45)]">
    <CardContent className="p-5 space-y-4">
      <div className="flex items-start gap-3">
        <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent"><Icon className="h-5 w-5" /></span>
        <div className="space-y-0.5">
          <div className="inline-flex items-center gap-1.5">
            <h2 className="text-lg font-semibold">{title}</h2>
            {hint ? (
              <TooltipProvider delayDuration={150}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button type="button" className="inline-flex text-muted-foreground hover:text-foreground" aria-label={`Ajuda: ${title}`}>
                      <CircleHelp className="h-3.5 w-3.5" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent className="max-w-[260px] text-caption">{hint}</TooltipContent>
                </Tooltip>
              </TooltipProvider>
            ) : null}
          </div>
          <p className="text-body text-muted-foreground">{subtitle}</p>
        </div>
      </div>
      {children}
    </CardContent>
  </Card>
);

export default NewDatasetPage;
