import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Calculator, CalendarIcon, ChevronDown, ChevronUp, CircleHelp, Columns3, Copy, Database, Eye, EyeOff, Filter, FunctionSquare, Hash, Layers3, Loader2, Pencil, Plus, Redo2, RefreshCw, Save, Table2, Trash2, Undo2, X, Zap } from "lucide-react";
import type { DateRange } from "react-day-picker";

import CanvasStatusBar from "@/components/dataset-canvas/CanvasStatusBar";
import DatasetCanvasView from "@/components/dataset-canvas/DatasetCanvasView";
import PreviewPanel from "@/components/dataset-canvas/PreviewPanel";
import { defaultCanvasLayout, isJoinEdgeInvalid, mapCanvasToBaseQuerySpec } from "@/components/dataset-canvas/canvas-mappers";
import type { DatasetCanvasEdge, DatasetCanvasNode, DatasetFieldAggregation, DatasetFieldSemanticType } from "@/components/dataset-canvas/canvas-types";
import EmptyState from "@/components/shared/EmptyState";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Calendar } from "@/components/ui/calendar";
import { useCoreData } from "@/hooks/use-core-data";
import { useToast } from "@/hooks/use-toast";
import { api, ApiCatalogDataPreviewResponse, ApiCatalogDimension, ApiCatalogMetric, ApiDataset, ApiDatasetBaseQuerySpec, ApiDatasetComputedExpressionCatalog, ApiDatasetSyncRun, ApiDatasetSyncSchedule, ApiError } from "@/lib/api";
import { evaluateExpression, exprNodeToFormula, getSuggestions, insertSuggestion, normalizeAlias, ROW_LEVEL_AGGREGATION_ERROR, validateAlias, validateAndParseComputedExpression } from "@/lib/computed-expression";
import { parseApiDate } from "@/lib/datetime";
import { isInternalWorkspaceDatasource } from "@/lib/datasource-visibility";
import { cn } from "@/lib/utils";
import JoinPropertiesPanel from "@/components/dataset-canvas/JoinPropertiesPanel";

const parseResourceId = (resourceId: string): { schema: string; name: string } | null => {
  const [schema, ...rest] = resourceId.split(".");
  if (!schema || rest.length === 0) return null;
  const name = rest.join(".");
  if (!name) return null;
  return { schema, name };
};

const normalizeToken = (value: string): string => value.trim().toLowerCase();
const sanitizePrefix = (value: string): string => value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "tabela";
const buildFieldId = (name: string): string => `${name}__${Math.random().toString(36).slice(2, 8)}`;
const inferFieldSemanticType = (rawType: string): DatasetFieldSemanticType => {
  const value = rawType.toLowerCase();
  if (value === "temporal" || value === "date" || value === "datetime") return "temporal";
  if (value === "numeric" || value === "number") return "numeric";
  if (value === "boolean" || value === "bool") return "boolean";
  if (value === "text" || value === "string") return "text";
  if (value.includes("bool")) return "boolean";
  if (value.includes("date") || value.includes("time")) return "temporal";
  if (["int", "numeric", "decimal", "float", "double", "real", "money"].some((token) => value.includes(token))) return "numeric";
  return "text";
};
const inferDefaultAggregation = (semanticType: DatasetFieldSemanticType): DatasetFieldAggregation => (
  semanticType === "numeric" ? "sum" : semanticType === "temporal" ? "max" : "none"
);
const MAX_HISTORY_STEPS = 120;

type RelativeDatePreset = "today" | "yesterday" | "last_7_days" | "last_30_days" | "this_year" | "this_month" | "last_month";

const DATASET_FILTER_OPERATORS: Array<{ value: string; label: string }> = [
  { value: "eq", label: "Igual" },
  { value: "neq", label: "Diferente" },
  { value: "gt", label: "Maior que" },
  { value: "gte", label: "Maior ou igual" },
  { value: "lt", label: "Menor que" },
  { value: "lte", label: "Menor ou igual" },
  { value: "between", label: "Entre" },
  { value: "in", label: "Em lista" },
  { value: "not_in", label: "Fora da lista" },
  { value: "contains", label: "Contem" },
  { value: "is_null", label: "Nulo" },
  { value: "not_null", label: "Nao nulo" },
];
const DATASET_TEMPORAL_FILTER_OPERATORS: Array<{ value: string; label: string }> = [
  { value: "eq", label: "Igual" },
  { value: "neq", label: "Diferente" },
  { value: "gt", label: "Maior que" },
  { value: "gte", label: "Maior ou igual" },
  { value: "lt", label: "Menor que" },
  { value: "lte", label: "Menor ou igual" },
  { value: "between", label: "Entre datas" },
  { value: "__relative__", label: "Data relativa" },
  { value: "in", label: "Em lista" },
  { value: "not_in", label: "Fora da lista" },
  { value: "is_null", label: "Nulo" },
  { value: "not_null", label: "Nao nulo" },
];
const DATASET_RELATIVE_DATE_OPTIONS: Array<{ value: RelativeDatePreset; label: string }> = [
  { value: "today", label: "Hoje" },
  { value: "yesterday", label: "Ontem" },
  { value: "last_7_days", label: "Ultimos 7 dias" },
  { value: "last_30_days", label: "Ultimos 30 dias" },
  { value: "this_year", label: "Este ano" },
  { value: "this_month", label: "Este mes" },
  { value: "last_month", label: "Mes passado" },
];
const DATASET_FILTER_OPS_WITHOUT_VALUE = new Set(["is_null", "not_null"]);
const DATASET_FILTER_OPS_WITH_LIST_VALUE = new Set(["in", "not_in"]);
const DEFAULT_COMPUTED_EXPRESSION_CATALOG: ApiDatasetComputedExpressionCatalog = {
  mode: "row_level",
  description: "Expressoes calculadas por linha. Agregacoes verticais nao sao permitidas.",
  forbidden_aggregations: ["sum", "avg", "count", "min", "max"],
  allowed_functions: {
    matematica: ["abs", "round", "ceil", "floor"],
    nulos_e_seguranca: ["coalesce", "nullif"],
    texto: ["concat", "lower", "upper", "substring", "trim"],
    data: ["date_trunc", "extract"],
    logica: ["case when"],
  },
  allowed_operators: ["+", "-", "*", "/", "%"],
  examples: [
    "receita - custo",
    "valor * 0.1",
    "coalesce(desconto, 0)",
    "case when status = 'ativo' then 1 else 0 end",
  ],
};

const formatDateBR = (date: Date) =>
  new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" }).format(date);
const dateToApi = (date: Date) => date.toISOString().slice(0, 10);
const parseDateValue = (value: unknown): Date | undefined => {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const raw = value.trim();
  const date = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? new Date(`${raw}T00:00:00`) : new Date(raw);
  if (Number.isNaN(date.getTime())) return undefined;
  return date;
};

const coerceDatasetFilterValue = (
  rawValue: string,
  semanticType: DatasetFieldSemanticType,
): unknown => {
  const normalized = rawValue.trim();
  if (!normalized) return "";
  if (semanticType === "boolean") {
    const lowered = normalized.toLowerCase();
    if (lowered === "true") return true;
    if (lowered === "false") return false;
    return normalized;
  }
  if (semanticType === "numeric") {
    const parsed = Number(normalized.replace(",", "."));
    if (Number.isFinite(parsed)) return parsed;
  }
  return normalized;
};

type CanvasSnapshot = {
  nodes: DatasetCanvasNode[];
  edges: DatasetCanvasEdge[];
};

const DatasetCanvas = () => {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { datasetId } = useParams<{ datasetId: string }>();
  const isEditing = !!datasetId;

  const { datasources, datasets, views, isLoading, isError, errorMessage } = useCoreData();
  const activeDatasources = useMemo(() => datasources.filter((item) => item.status === "active"), [datasources]);
  const selectableDatasources = useMemo(
    () => activeDatasources.filter((item) => !isInternalWorkspaceDatasource(item)),
    [activeDatasources],
  );
  const editingDataset = useMemo(() => (datasetId ? datasets.find((item) => item.id === datasetId) : undefined), [datasetId, datasets]);

  const [hydratedDatasetId, setHydratedDatasetId] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [datasourceId, setDatasourceId] = useState("");
  const [accessMode, setAccessMode] = useState<"direct" | "imported" | "">("");
  const [leftPanelTab, setLeftPanelTab] = useState<"estrutura" | "syncs">("estrutura");

  const [nodes, setNodes] = useState<DatasetCanvasNode[]>([]);
  const [edges, setEdges] = useState<DatasetCanvasEdge[]>([]);
  const [computedColumns, setComputedColumns] = useState<ApiDatasetBaseQuerySpec["preprocess"]["computed_columns"]>([]);
  const [filters, setFilters] = useState<ApiDatasetBaseQuerySpec["preprocess"]["filters"]>([]);

  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);

  const [preview, setPreview] = useState<ApiCatalogDataPreviewResponse | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [isDirty, setIsDirty] = useState(false);
  const [lastSavedAt, setLastSavedAt] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState(false);
  const [nodeEditorTab, setNodeEditorTab] = useState<"columns" | "computed" | "filters" | "metrics" | "dimensions">("columns");
  const [nodeDraftFields, setNodeDraftFields] = useState<DatasetCanvasNode["data"]["fields"] | null>(null);
  const [nodeDraftComputedColumns, setNodeDraftComputedColumns] = useState<ApiDatasetBaseQuerySpec["preprocess"]["computed_columns"] | null>(null);
  const [nodeDraftFilters, setNodeDraftFilters] = useState<ApiDatasetBaseQuerySpec["preprocess"]["filters"] | null>(null);
  const [edgeDraftJoinType, setEdgeDraftJoinType] = useState<DatasetCanvasEdge["data"]["joinType"] | null>(null);
  const [edgeDraftConditions, setEdgeDraftConditions] = useState<DatasetCanvasEdge["data"]["conditions"] | null>(null);
  const [isEdgeDraftDirty, setIsEdgeDraftDirty] = useState(false);
  const [expandedDraftFieldIds, setExpandedDraftFieldIds] = useState<string[]>([]);
  const [isNodeDraftDirty, setIsNodeDraftDirty] = useState(false);
  const [isComputedDialogOpen, setIsComputedDialogOpen] = useState(false);
  const [isMetricDialogOpen, setIsMetricDialogOpen] = useState(false);
  const [isDimensionDialogOpen, setIsDimensionDialogOpen] = useState(false);
  const [editingComputedAlias, setEditingComputedAlias] = useState<string | null>(null);
  const [newComputedAlias, setNewComputedAlias] = useState("");
  const [newComputedFormula, setNewComputedFormula] = useState("");
  const [newComputedType, setNewComputedType] = useState<DatasetFieldSemanticType>("numeric");
  const [computedEditorCursor, setComputedEditorCursor] = useState(0);
  const [computedEditorSuggestionIndex, setComputedEditorSuggestionIndex] = useState(0);
  const [computedColumnSearch, setComputedColumnSearch] = useState("");
  const [computedFunctionSearch, setComputedFunctionSearch] = useState("");
  const [isComputedEditorFocused, setIsComputedEditorFocused] = useState(false);
  const computedFormulaRef = useRef<HTMLTextAreaElement | null>(null);
  const [draggingFieldId, setDraggingFieldId] = useState<string | null>(null);
  const [newMetricName, setNewMetricName] = useState("");
  const [newMetricFormula, setNewMetricFormula] = useState("");
  const [newMetricDescription, setNewMetricDescription] = useState("");
  const [newDimensionName, setNewDimensionName] = useState("");
  const [newDimensionColumn, setNewDimensionColumn] = useState("");
  const [newDimensionDescription, setNewDimensionDescription] = useState("");
  const [expandedMetricIds, setExpandedMetricIds] = useState<number[]>([]);
  const [expandedDimensionIds, setExpandedDimensionIds] = useState<number[]>([]);
  const [metricDraftById, setMetricDraftById] = useState<Record<number, { name: string; formula: string; description: string }>>({});
  const [dimensionDraftById, setDimensionDraftById] = useState<Record<number, { name: string; type: "categorical" | "temporal" | "relational"; description: string }>>({});
  const [syncExecutionType, setSyncExecutionType] = useState<"manual" | "scheduled">("manual");
  const [syncFrequencyMinutes, setSyncFrequencyMinutes] = useState("60");
  const [syncTimezone, setSyncTimezone] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
  const [syncMisfirePolicy, setSyncMisfirePolicy] = useState<"run_once" | "skip" | "immediate">("run_once");
  const [undoCount, setUndoCount] = useState(0);
  const [redoCount, setRedoCount] = useState(0);
  const historyRef = useRef<{ current: CanvasSnapshot | null; undo: CanvasSnapshot[]; redo: CanvasSnapshot[] }>({
    current: null,
    undo: [],
    redo: [],
  });
  const isRestoringHistoryRef = useRef(false);
  const computedExpressionCatalogQuery = useQuery({
    queryKey: ["dataset-computed-expression-catalog"],
    queryFn: () => api.getDatasetComputedExpressionCatalog(),
    staleTime: 300_000,
  });

  const cloneSnapshot = useCallback((snapshot: CanvasSnapshot): CanvasSnapshot => ({
    nodes: snapshot.nodes.map((node) => ({
      ...node,
      position: { ...node.position },
      data: {
        ...node.data,
        fields: node.data.fields.map((field) => ({ ...field })),
      },
    })),
    edges: snapshot.edges.map((edge) => ({
      ...edge,
      data: {
        ...edge.data,
        conditions: edge.data.conditions.map((condition) => ({ ...condition })),
      },
    })),
  }), []);

  const snapshotsEqual = useCallback((a: CanvasSnapshot | null, b: CanvasSnapshot | null): boolean => {
    if (!a || !b) return false;
    return JSON.stringify(a) === JSON.stringify(b);
  }, []);

  const resetHistory = useCallback((snapshot: CanvasSnapshot) => {
    historyRef.current = {
      current: cloneSnapshot(snapshot),
      undo: [],
      redo: [],
    };
    setUndoCount(0);
    setRedoCount(0);
  }, [cloneSnapshot]);

  const commitHistory = useCallback((nextSnapshot: CanvasSnapshot) => {
    if (isRestoringHistoryRef.current) return;
    const currentSnapshot = historyRef.current.current;
    const clonedNext = cloneSnapshot(nextSnapshot);

    if (!currentSnapshot) {
      historyRef.current.current = clonedNext;
      setUndoCount(0);
      setRedoCount(0);
      return;
    }

    if (snapshotsEqual(currentSnapshot, clonedNext)) return;
    historyRef.current.undo.push(cloneSnapshot(currentSnapshot));
    if (historyRef.current.undo.length > MAX_HISTORY_STEPS) historyRef.current.undo.shift();
    historyRef.current.current = clonedNext;
    historyRef.current.redo = [];
    setUndoCount(historyRef.current.undo.length);
    setRedoCount(0);
  }, [cloneSnapshot, snapshotsEqual]);

  const undoCanvas = useCallback(() => {
    if (!historyRef.current.undo.length) return;
    const previous = historyRef.current.undo.pop();
    if (!previous) return;
    if (historyRef.current.current) {
      historyRef.current.redo.push(cloneSnapshot(historyRef.current.current));
      if (historyRef.current.redo.length > MAX_HISTORY_STEPS) historyRef.current.redo.shift();
    }
    historyRef.current.current = cloneSnapshot(previous);
    isRestoringHistoryRef.current = true;
    setNodes(previous.nodes);
    setEdges(previous.edges);
    setSelectedNodeId(null);
    setSelectedEdgeId(null);
    setTimeout(() => { isRestoringHistoryRef.current = false; }, 0);
    setUndoCount(historyRef.current.undo.length);
    setRedoCount(historyRef.current.redo.length);
    setIsDirty(true);
  }, [cloneSnapshot]);

  const redoCanvas = useCallback(() => {
    if (!historyRef.current.redo.length) return;
    const next = historyRef.current.redo.pop();
    if (!next) return;
    if (historyRef.current.current) {
      historyRef.current.undo.push(cloneSnapshot(historyRef.current.current));
      if (historyRef.current.undo.length > MAX_HISTORY_STEPS) historyRef.current.undo.shift();
    }
    historyRef.current.current = cloneSnapshot(next);
    isRestoringHistoryRef.current = true;
    setNodes(next.nodes);
    setEdges(next.edges);
    setSelectedNodeId(null);
    setSelectedEdgeId(null);
    setTimeout(() => { isRestoringHistoryRef.current = false; }, 0);
    setUndoCount(historyRef.current.undo.length);
    setRedoCount(historyRef.current.redo.length);
    setIsDirty(true);
  }, [cloneSnapshot]);

  const selectedNode = useMemo(() => nodes.find((item) => item.id === selectedNodeId) || null, [nodes, selectedNodeId]);
  const selectedEdge = useMemo(() => edges.find((item) => item.id === selectedEdgeId) || null, [edges, selectedEdgeId]);
  const selectedEdgeSourceNode = useMemo(() => {
    if (!selectedEdge) return null;
    return nodes.find((node) => node.id === selectedEdge.source) || null;
  }, [nodes, selectedEdge]);
  const selectedEdgeTargetNode = useMemo(() => {
    if (!selectedEdge) return null;
    return nodes.find((node) => node.id === selectedEdge.target) || null;
  }, [nodes, selectedEdge]);

  const projectedColumns = useMemo(() => {
    const usedAliases = new Set<string>();
    const columns: Array<{
      fieldId: string;
      nodeId: string;
      column: string;
      alias: string;
      semanticType: "text" | "numeric" | "temporal" | "boolean";
      sqlType: string;
      prefix?: string;
      suffix?: string;
      aggregation?: DatasetFieldAggregation;
      description?: string;
      hidden?: boolean;
    }> = [];

    nodes.forEach((node) => {
      const prefix = sanitizePrefix(node.data.label);
      node.data.fields
        .filter((field) => field.selected && (field.alias || field.name).trim())
        .forEach((field) => {
          const baseAlias = (field.alias || field.name).trim();
          let nextAlias = baseAlias;
          let aliasKey = normalizeToken(nextAlias);

          if (usedAliases.has(aliasKey)) {
            nextAlias = `${prefix}_${baseAlias}`;
            aliasKey = normalizeToken(nextAlias);
          }

          let suffix = 2;
          while (usedAliases.has(aliasKey)) {
            nextAlias = `${prefix}_${baseAlias}_${suffix}`;
            aliasKey = normalizeToken(nextAlias);
            suffix += 1;
          }

          usedAliases.add(aliasKey);
          columns.push({
            fieldId: field.id,
            nodeId: node.id,
            column: field.name,
            alias: nextAlias,
            semanticType: field.semanticType || inferFieldSemanticType(field.type),
            sqlType: field.type,
            prefix: field.prefix,
            suffix: field.suffix,
            aggregation: field.aggregation,
            description: field.description,
            hidden: !field.selected,
          });
        });
    });

    return columns;
  }, [nodes]);

  const semanticColumns = useMemo(() => projectedColumns.map((item) => ({
    name: item.alias,
    type: item.semanticType,
    source: "projected" as const,
    description: item.description,
  })), [projectedColumns]);

  const filterEditorColumns = useMemo(() => {
    const usedAliases = new Set<string>();
    const columns: Array<{ field: string; semanticType: DatasetFieldSemanticType }> = [];

    nodes.forEach((node) => {
      const prefix = sanitizePrefix(node.data.label);
      const sourceFields = selectedNode && nodeDraftFields && node.id === selectedNode.id
        ? nodeDraftFields
        : node.data.fields;
      sourceFields
        .filter((field) => field.selected && (field.alias || field.name).trim())
        .forEach((field) => {
          const baseAlias = (field.alias || field.name).trim();
          let nextAlias = baseAlias;
          let aliasKey = normalizeToken(nextAlias);

          if (usedAliases.has(aliasKey)) {
            nextAlias = `${prefix}_${baseAlias}`;
            aliasKey = normalizeToken(nextAlias);
          }

          let suffix = 2;
          while (usedAliases.has(aliasKey)) {
            nextAlias = `${prefix}_${baseAlias}_${suffix}`;
            aliasKey = normalizeToken(nextAlias);
            suffix += 1;
          }
          usedAliases.add(aliasKey);
          const semanticTypeRaw = field.semanticType || inferFieldSemanticType(field.type);
          const semanticType = semanticTypeRaw === "text" ? inferFieldSemanticType(field.type) : semanticTypeRaw;
          columns.push({
            field: nextAlias,
            semanticType,
          });
        });
    });

    return columns;
  }, [nodeDraftFields, nodes, selectedNode]);

  const datasetFilterableColumns = useMemo(() => {
    const seen = new Set<string>();
    const items: Array<{ field: string; semanticType: DatasetFieldSemanticType }> = [];
    filterEditorColumns.forEach((column) => {
      const fieldName = (column.field || "").trim();
      if (!fieldName || seen.has(fieldName)) return;
      seen.add(fieldName);
      items.push({ field: fieldName, semanticType: column.semanticType });
    });
    return items;
  }, [filterEditorColumns]);

  const datasetFilterTypeByField = useMemo(() => {
    const index = new Map<string, DatasetFieldSemanticType>();
    datasetFilterableColumns.forEach((item) => index.set(item.field, item.semanticType));
    return index;
  }, [datasetFilterableColumns]);

  const computedExpressionCatalog = computedExpressionCatalogQuery.data || DEFAULT_COMPUTED_EXPRESSION_CATALOG;
  const computedAllowedFunctions = useMemo(
    () => Object.values(computedExpressionCatalog.allowed_functions || {}).flat().filter((item) => item.toLowerCase() !== "case when"),
    [computedExpressionCatalog.allowed_functions],
  );
  const computedColumnsSource = nodeDraftComputedColumns || computedColumns;
  const computedAvailableColumns = useMemo(() => {
    const seen = new Set<string>();
    const items: Array<{ name: string; type: DatasetFieldSemanticType }> = [];
    filterEditorColumns.forEach((item) => {
      const name = item.field.trim();
      if (!name || seen.has(name)) return;
      seen.add(name);
      items.push({ name, type: item.semanticType });
    });
    computedColumnsSource.forEach((item) => {
      const name = String(item.alias || "").trim();
      if (!name || seen.has(name)) return;
      seen.add(name);
      items.push({ name, type: item.data_type || "text" });
    });
    return items;
  }, [computedColumnsSource, filterEditorColumns]);
  const computedUnavailableAliasNames = useMemo(() => {
    const taken = new Set<string>();
    computedAvailableColumns.forEach((item) => taken.add(item.name.toLowerCase()));
    computedColumnsSource.forEach((item) => taken.add(String(item.alias || "").trim().toLowerCase()));
    if (editingComputedAlias) {
      taken.delete(editingComputedAlias.toLowerCase());
    }
    return taken;
  }, [computedAvailableColumns, computedColumnsSource, editingComputedAlias]);
  const newComputedAliasNormalized = useMemo(() => normalizeAlias(newComputedAlias), [newComputedAlias]);
  const newComputedAliasError = useMemo(
    () => validateAlias(newComputedAlias, computedUnavailableAliasNames),
    [computedUnavailableAliasNames, newComputedAlias],
  );
  const computedExpressionValidation = useMemo(
    () => validateAndParseComputedExpression({
      formula: newComputedFormula,
      columns: computedAvailableColumns.map((item) => ({ name: item.name, type: item.type })),
      allowedFunctions: computedAllowedFunctions,
      forbiddenAggregations: computedExpressionCatalog.forbidden_aggregations,
    }),
    [computedAllowedFunctions, computedAvailableColumns, computedExpressionCatalog.forbidden_aggregations, newComputedFormula],
  );
  const computedInferredType = computedExpressionValidation.inferredType;
  const computedTypeConflict = computedInferredType !== "desconhecido" && computedInferredType !== newComputedType;
  const computedCanSubmit = !newComputedAliasError && computedExpressionValidation.errors.length === 0 && !!computedExpressionValidation.ast;
  const computedExpressionSuggestions = useMemo(
    () => getSuggestions({
      input: newComputedFormula,
      cursor: computedEditorCursor,
      columns: computedAvailableColumns.map((item) => ({ name: item.name, type: item.type })),
      functions: computedAllowedFunctions,
    }),
    [computedAllowedFunctions, computedAvailableColumns, computedEditorCursor, newComputedFormula],
  );
  const computedSelectedSuggestion = computedExpressionSuggestions.suggestions[
    Math.max(0, Math.min(computedEditorSuggestionIndex, computedExpressionSuggestions.suggestions.length - 1))
  ];
  const computedPreviewRows = useMemo(() => {
    if (!computedExpressionValidation.ast || !preview?.rows?.length) return [];
    return preview.rows.slice(0, 5).map((row, index) => {
      let result: unknown = null;
      let error: string | null = null;
      try {
        result = evaluateExpression(computedExpressionValidation.ast as Parameters<typeof evaluateExpression>[0], row);
      } catch (err) {
        error = err instanceof Error ? err.message : "Falha ao calcular preview";
      }
      return { id: `computed-preview-${index}`, row, result, error };
    });
  }, [computedExpressionValidation.ast, preview?.rows]);

  const resolveDefaultDatasetFilterValue = useCallback((opUi: string, field: string): unknown => {
    const semanticType = datasetFilterTypeByField.get(field) || "text";
    if (opUi === "__relative__" && semanticType === "temporal") return { relative: "last_7_days" as RelativeDatePreset };
    const op = opUi === "__relative__" ? "between" : opUi;
    if (DATASET_FILTER_OPS_WITHOUT_VALUE.has(op)) return undefined;
    if (op === "between") return ["", ""];
    if (DATASET_FILTER_OPS_WITH_LIST_VALUE.has(op)) return [];
    if (semanticType === "boolean") return true;
    return "";
  }, [datasetFilterTypeByField]);

  const resolveDatasetFilterPayload = useCallback((opUi: string, field: string) => {
    const semanticType = datasetFilterTypeByField.get(field) || "text";
    if (opUi === "__relative__" && semanticType === "temporal") {
      return {
        op: "between",
        value: { relative: "last_7_days" as RelativeDatePreset },
      };
    }
    return {
      op: opUi,
      value: resolveDefaultDatasetFilterValue(opUi, field),
    };
  }, [datasetFilterTypeByField, resolveDefaultDatasetFilterValue]);

  const resolveDatasetFilterUiOperator = useCallback((
    filter: ApiDatasetBaseQuerySpec["preprocess"]["filters"][number],
    _semanticType: DatasetFieldSemanticType,
  ): string => {
    if (
      filter.op === "between"
      && typeof filter.value === "object"
      && filter.value !== null
      && !Array.isArray(filter.value)
      && "relative" in (filter.value as Record<string, unknown>)
    ) {
      return "__relative__";
    }
    return filter.op || "eq";
  }, []);

  const addDatasetFilter = useCallback(() => {
    if (datasetFilterableColumns.length === 0) {
      toast({
        title: "Adicione colunas primeiro",
        description: "Selecione ao menos uma coluna no dataset para criar filtros nativos.",
      });
      return;
    }
    const defaultField = datasetFilterableColumns[0].field;
    const payload = resolveDatasetFilterPayload("eq", defaultField);
    setNodeDraftFilters((prev) => [
      ...(prev || []),
      {
        field: defaultField,
        op: payload.op,
        value: payload.value,
      },
    ]);
    setIsNodeDraftDirty(true);
  }, [datasetFilterableColumns, resolveDatasetFilterPayload, toast]);

  const updateDatasetFilter = useCallback((
    index: number,
    updater: (current: ApiDatasetBaseQuerySpec["preprocess"]["filters"][number]) => ApiDatasetBaseQuerySpec["preprocess"]["filters"][number],
  ) => {
    setNodeDraftFilters((prev) => {
      const current = prev || [];
      return current.map((item, itemIndex) => (itemIndex === index ? updater(item) : item));
    });
    setIsNodeDraftDirty(true);
  }, []);

  const removeDatasetFilter = useCallback((index: number) => {
    setNodeDraftFilters((prev) => (prev || []).filter((_, itemIndex) => itemIndex !== index));
    setIsNodeDraftDirty(true);
  }, []);

  const joinTypeMismatchIssue = useMemo(() => {
    for (const edge of edges) {
      const sourceNode = nodes.find((node) => node.id === edge.source);
      const targetNode = nodes.find((node) => node.id === edge.target);
      if (!sourceNode || !targetNode) continue;
      for (const condition of edge.data.conditions) {
        const leftName = (condition.leftColumn || "").trim();
        const rightName = (condition.rightColumn || "").trim();
        if (!leftName || !rightName) continue;
        const leftField = sourceNode.data.fields.find((field) => field.name === leftName);
        const rightField = targetNode.data.fields.find((field) => field.name === rightName);
        if (!leftField || !rightField) continue;
        const leftType = inferFieldSemanticType(leftField.type);
        const rightType = inferFieldSemanticType(rightField.type);
        if (leftType !== rightType) {
          return {
            edgeId: edge.id,
            message: `Join invalido: ${sourceNode.data.label}.${leftName} (${leftType}) x ${targetNode.data.label}.${rightName} (${rightType}).`,
          };
        }
      }
    }
    return null;
  }, [edges, nodes]);

  const hasValidationError = useMemo(() => {
    if (!name.trim()) return true;
    if (!accessMode) return true;
    if (!datasourceId) return true;
    if (nodes.length === 0) return true;
    if (edges.some((edge) => isJoinEdgeInvalid(edge))) return true;
    if (joinTypeMismatchIssue) return true;
    return false;
  }, [accessMode, datasourceId, edges, joinTypeMismatchIssue, name, nodes]);

  const saveValidationIssue = useMemo(() => {
    if (!name.trim()) {
      return {
        title: "Adicione um nome no dataset antes de salvar",
        description: "O nome fica no topo esquerdo da tela, em 'Dataset sem titulo'.",
        focus: () => setEditingTitle(true),
      };
    }
    if (!accessMode) {
      return {
        title: "Selecione o tipo do dataset antes de salvar",
        description: "Use o seletor 'Tipo do dataset' no painel esquerdo.",
      };
    }
    if (!datasourceId) {
      return {
        title: "Selecione uma fonte antes de salvar",
        description: "Arraste uma tabela para o canvas para definir a fonte automaticamente.",
      };
    }
    if (nodes.length === 0) {
      return {
        title: "Adicione pelo menos uma tabela antes de salvar",
        description: "Use o painel esquerdo em 'Recursos' e arraste uma tabela para o canvas.",
      };
    }
    const firstInvalidEdge = edges.find((edge) => isJoinEdgeInvalid(edge));
    if (firstInvalidEdge) {
      return {
        title: "Revise os joins antes de salvar",
        description: "Existe um join com condicao incompleta. Abra o join no canvas e conclua a configuracao.",
        focus: () => {
          setSelectedEdgeId(firstInvalidEdge.id);
          setSelectedNodeId(null);
        },
      };
    }
    if (joinTypeMismatchIssue) {
      return {
        title: "Revise os tipos das chaves do join",
        description: joinTypeMismatchIssue.message,
        focus: () => {
          setSelectedEdgeId(joinTypeMismatchIssue.edgeId);
          setSelectedNodeId(null);
        },
      };
    }
    return null;
  }, [accessMode, datasourceId, edges, joinTypeMismatchIssue, name, nodes.length]);

  const resolveViewIdByResourceId = useCallback((resourceId: string, dsId: string): string | undefined => {
    const parsed = parseResourceId(resourceId);
    if (!parsed) return undefined;
    return views.find((view) => (
      view.datasourceId === dsId
      && view.schema.toLowerCase() === parsed.schema.toLowerCase()
      && view.name.toLowerCase() === parsed.name.toLowerCase()
    ))?.id;
  }, [views]);
  const resolveDatasourceIdForResource = useCallback((resourceId: string, fallbackDatasourceId: number): number => {
    const parsed = parseResourceId(resourceId);
    if (!parsed) return fallbackDatasourceId;
    const schemaNorm = parsed.schema.toLowerCase();
    const nameNorm = parsed.name.toLowerCase();

    const preferred = views.find((item) => (
      item.datasourceId === String(fallbackDatasourceId)
      && item.schema.toLowerCase() === schemaNorm
      && item.name.toLowerCase() === nameNorm
    ));
    if (preferred) return fallbackDatasourceId;

    const matches = views.filter((item) => (
      item.schema.toLowerCase() === schemaNorm
      && item.name.toLowerCase() === nameNorm
    ));
    if (matches.length === 0) return fallbackDatasourceId;
    const resolved = Number(matches[0].datasourceId);
    return Number.isFinite(resolved) ? resolved : fallbackDatasourceId;
  }, [views]);
  const hydrateResourceFields = useCallback(async (
    resourceId: string,
    fallbackDatasourceId: number,
  ): Promise<Array<{ name: string; type: string }>> => {
    const dsId = resolveDatasourceIdForResource(resourceId, fallbackDatasourceId);
    const parsed = parseResourceId(resourceId);
    const schemaNorm = parsed?.schema.toLowerCase() || "";
    const nameNorm = parsed?.name.toLowerCase() || "";
    const byResource = parsed
      ? views.find((item) => (
        item.datasourceId === String(dsId)
        && item.schema.toLowerCase() === schemaNorm
        && item.name.toLowerCase() === nameNorm
      ))
      : undefined;
    if (byResource?.columns?.length) {
      return byResource.columns.map((column) => ({ name: column.name, type: column.type }));
    }

    try {
      const schema = await api.getCatalogResourceSchema(resourceId, dsId);
      if (schema.fields.length > 0) {
        return schema.fields.map((field) => ({ name: field.name, type: field.data_type }));
      }
    } catch {
      // fallback below
    }

    if (parsed) {
      try {
        const cols = await api.getViewColumns(parsed.name, parsed.schema, dsId);
        if (cols.length > 0) {
          return cols.map((col) => ({ name: col.column_name, type: col.column_type || col.normalized_type || "text" }));
        }
      } catch {
        // fallback below
      }
    }

    return [];
  }, [resolveDatasourceIdForResource, views]);

  useEffect(() => {
    if (!isEditing || !editingDataset) return;
    if (hydratedDatasetId === editingDataset.id) return;

    let cancelled = false;

    const run = async () => {
      const nextDatasourceId = editingDataset.datasourceId;
      const nextAccessMode = editingDataset.accessMode === "imported" ? "imported" : "direct";
      const baseSpec = editingDataset.baseQuerySpec as ApiDatasetBaseQuerySpec | null;

      setName(editingDataset.name || "");
      setDescription(editingDataset.description || "");
      setDatasourceId(nextDatasourceId);
      setAccessMode(nextAccessMode);
      setPreview(null);
      setPreviewError(null);

      if (!baseSpec || !baseSpec.base?.resources?.length) {
        setNodes([]);
        setEdges([]);
        setComputedColumns([]);
        setFilters([]);
        setSelectedNodeId(null);
        setSelectedEdgeId(null);
        setPreview(null);
        setIsDirty(false);
        resetHistory({ nodes: [], edges: [] });
        setHydratedDatasetId(editingDataset.id);
        return;
      }

      const rawInclude = Array.isArray(baseSpec.preprocess?.columns?.include)
        ? baseSpec.preprocess?.columns?.include
        : [];
      const knownResourceIds = new Set(
        Array.isArray(baseSpec.base.resources) ? baseSpec.base.resources.map((item) => item.id) : [],
      );
      const hasIncludeForKnownResource = rawInclude.some((item) => {
        if (!item || typeof item !== "object") return false;
        const resource = (item as Record<string, unknown>).resource;
        return typeof resource === "string" && knownResourceIds.has(resource);
      });
      // Some migrated datasets keep include rows bound to legacy resource ids.
      // In this case, treat include as empty to avoid rendering a blank canvas.
      const effectiveInclude = hasIncludeForKnownResource ? rawInclude : [];
      const includeByResource = new Map<string, Array<Record<string, unknown>>>();
      effectiveInclude.forEach((item, index) => {
        if (!item || typeof item !== "object") return;
        const rawResource = (item as Record<string, unknown>).resource;
        if (typeof rawResource !== "string" || !rawResource.trim()) return;
        const bucket = includeByResource.get(rawResource) || [];
        bucket.push({ ...(item as Record<string, unknown>), __order_index: index });
        includeByResource.set(rawResource, bucket);
      });

      const loadedNodes = await Promise.all(baseSpec.base.resources.map(async (resource, index) => {
        let fields = await hydrateResourceFields(resource.resource_id, Number(nextDatasourceId));
        const isPrimary = baseSpec.base.primary_resource === resource.resource_id;
        const includeRows = includeByResource.get(resource.id) || [];
        if (fields.length === 0 && includeRows.length > 0) {
          const inferredByName = new Map<string, string>();
          includeRows.forEach((row) => {
            const columnName = String(row.column || "").trim();
            if (!columnName || inferredByName.has(columnName)) return;
            inferredByName.set(columnName, String(row.sql_type || "text"));
          });
          fields = Array.from(inferredByName.entries()).map(([name, type]) => ({ name, type }));
        }

        return {
          id: resource.id,
          type: "resource" as const,
          position: { x: 0, y: 0 },
          data: {
            resourceId: resource.resource_id,
            label: resource.resource_id.split(".").slice(-1)[0] || `resource_${index + 1}`,
            isPrimary,
            fields: (() => {
              const byColumn = new Map<string, Array<Record<string, unknown>>>();
              includeRows.forEach((row) => {
                const column = String(row.column || "").trim();
                if (!column) return;
                const bucket = byColumn.get(column) || [];
                bucket.push(row);
                byColumn.set(column, bucket);
              });

              const hydratedFields: DatasetCanvasNode["data"]["fields"] = [];
              fields.forEach((field) => {
                const semanticTypeDefault = inferFieldSemanticType(field.type);
                const includeItems = byColumn.get(field.name) || [];
                if (includeItems.length === 0) {
                  const selected = effectiveInclude.length === 0 ? isPrimary : false;
                  hydratedFields.push({
                    id: buildFieldId(field.name),
                    name: field.name,
                    type: field.type,
                    selected,
                    alias: field.name,
                    semanticType: semanticTypeDefault,
                    aggregation: inferDefaultAggregation(semanticTypeDefault),
                  });
                  return;
                }

                includeItems.forEach((includeItem) => {
                  const semanticTypeRaw = String(includeItem.semantic_type || "").trim().toLowerCase();
                  const semanticType = (["text", "numeric", "temporal", "boolean"].includes(semanticTypeRaw)
                    ? semanticTypeRaw
                    : semanticTypeDefault) as DatasetFieldSemanticType;
                  const aggregationRaw = String(includeItem.aggregation || "").trim().toLowerCase();
                  const aggregation = ([
                    "none",
                    "count",
                    "sum",
                    "avg",
                    "min",
                    "max",
                    "distinct_count",
                  ].includes(aggregationRaw) ? aggregationRaw : inferDefaultAggregation(semanticType)) as DatasetFieldAggregation;
                  hydratedFields.push({
                    id: String(includeItem.field_id || "").trim() || buildFieldId(field.name),
                    name: field.name,
                    type: String(includeItem.sql_type || field.type),
                    selected: !(includeItem.hidden === true),
                    alias: String(includeItem.alias || field.name),
                    semanticType,
                    prefix: typeof includeItem.prefix === "string" ? includeItem.prefix : undefined,
                    suffix: typeof includeItem.suffix === "string" ? includeItem.suffix : undefined,
                    aggregation,
                    description: typeof includeItem.description === "string" ? includeItem.description : undefined,
                  });
                });
              });

              if (effectiveInclude.length === 0) return hydratedFields;
              return hydratedFields.sort((a, b) => {
                const includeA = includeRows.find((row) => String(row.field_id || "").trim() === a.id || (row.column === a.name && row.alias === a.alias));
                const includeB = includeRows.find((row) => String(row.field_id || "").trim() === b.id || (row.column === b.name && row.alias === b.alias));
                const orderA = typeof includeA?.order === "number" ? includeA.order : Number(includeA?.__order_index ?? 0);
                const orderB = typeof includeB?.order === "number" ? includeB.order : Number(includeB?.__order_index ?? 0);
                return orderA - orderB;
              });
            })(),
          },
        };
      }));

      if (cancelled) return;

      const loadedEdges: DatasetCanvasEdge[] = (baseSpec.base.joins || []).map((join, index) => ({
        id: `j${index + 1}`,
        type: "join",
        source: join.left_resource,
        target: join.right_resource,
        data: {
          joinType: join.type,
          cardinality: (
            join.cardinality
            && typeof join.cardinality === "object"
            && !Array.isArray(join.cardinality)
          )
            ? {
                estimated: (
                  (join.cardinality as Record<string, unknown>).estimated
                  && typeof (join.cardinality as Record<string, unknown>).estimated === "object"
                  && !Array.isArray((join.cardinality as Record<string, unknown>).estimated)
                )
                  ? ((join.cardinality as Record<string, unknown>).estimated as DatasetCanvasEdge["data"]["cardinality"]["estimated"])
                  : undefined,
                actual: (
                  (join.cardinality as Record<string, unknown>).actual
                  && typeof (join.cardinality as Record<string, unknown>).actual === "object"
                  && !Array.isArray((join.cardinality as Record<string, unknown>).actual)
                )
                  ? ((join.cardinality as Record<string, unknown>).actual as DatasetCanvasEdge["data"]["cardinality"]["actual"])
                  : undefined,
              }
            : undefined,
          conditions: join.on.map((item) => ({ leftColumn: item.left_column, rightColumn: item.right_column })),
        },
      }));

      const layoutedNodes = defaultCanvasLayout(loadedNodes);
      setNodes(layoutedNodes);
      setEdges(loadedEdges);
      setComputedColumns(baseSpec.preprocess?.computed_columns || []);
      setFilters(baseSpec.preprocess?.filters || []);
      setSelectedNodeId(null);
      setSelectedEdgeId(null);
      setIsDirty(false);
      resetHistory({ nodes: layoutedNodes, edges: loadedEdges });
      setHydratedDatasetId(editingDataset.id);
    };

    void run();

    return () => {
      cancelled = true;
    };
  }, [editingDataset, hydrateResourceFields, hydratedDatasetId, isEditing, resetHistory]);

  useEffect(() => {
    commitHistory({ nodes, edges });
  }, [commitHistory, edges, nodes]);

  const buildPayload = useCallback(() => {
    if (!datasourceId) throw new Error("Datasource e obrigatorio.");

    if (!accessMode) throw new Error("Modo de acesso e obrigatorio.");

    const resources = nodes.map((node) => ({
      id: node.id,
      resourceId: node.data.resourceId,
    }));

    const joins = edges.map((edge) => ({
      type: edge.data.joinType,
      leftResource: edge.source,
      rightResource: edge.target,
      conditions: edge.data.conditions,
      cardinality: edge.data.cardinality,
    }));

    const include = projectedColumns.map((item, index) => ({
      resource: item.nodeId,
      column: item.column,
      alias: item.alias,
      field_id: item.fieldId,
      semantic_type: item.semanticType,
      sql_type: item.sqlType,
      prefix: item.prefix,
      suffix: item.suffix,
      aggregation: item.aggregation || "none",
      description: item.description,
      hidden: item.hidden || false,
      order: index,
    }));

    const baseQuerySpec = mapCanvasToBaseQuerySpec({
      datasourceId: Number(datasourceId),
      resources,
      joins,
      include,
      computedColumns,
      filters,
    });

    const primaryNode = nodes[0];
    const viewId = primaryNode ? resolveViewIdByResourceId(primaryNode.data.resourceId, datasourceId) : undefined;

    return {
      datasource_id: Number(datasourceId),
      name: name.trim(),
      description: description.trim() || undefined,
      access_mode: accessMode,
      view_id: viewId ? Number(viewId) : undefined,
      base_query_spec: baseQuerySpec,
      semantic_columns: semanticColumns,
    };
  }, [accessMode, computedColumns, datasourceId, description, edges, filters, name, nodes, projectedColumns, resolveViewIdByResourceId, semanticColumns]);

  const formatSaveDatasetError = useCallback((error: unknown): { title: string; description?: string } => {
    const parsePayload = (raw: unknown): Record<string, unknown> | null => {
      if (!raw) return null;
      if (typeof raw === "string") {
        try {
          const parsed = JSON.parse(raw) as unknown;
          return typeof parsed === "object" && parsed !== null ? parsed as Record<string, unknown> : null;
        } catch {
          return null;
        }
      }
      return (typeof raw === "object" && raw !== null) ? raw as Record<string, unknown> : null;
    };

    if (error instanceof ApiError) {
      const payload = parsePayload(error.detail);
      const fallbackDescription = error.detail || error.message || "Falha ao salvar dataset";
      if (!payload) {
        return { title: "Erro ao salvar dataset", description: fallbackDescription };
      }

      const baseMessage = typeof payload.message === "string" && payload.message.trim()
        ? payload.message.trim()
        : "Erro ao salvar dataset";

      const fieldErrorsRaw = payload.field_errors;
      if (!fieldErrorsRaw || typeof fieldErrorsRaw !== "object" || Array.isArray(fieldErrorsRaw)) {
        return { title: baseMessage, description: fallbackDescription === baseMessage ? undefined : fallbackDescription };
      }

      const fieldMessages = Object.entries(fieldErrorsRaw as Record<string, unknown>)
        .map(([field, rawValue]) => {
          if (Array.isArray(rawValue)) {
            const joined = rawValue.map((item) => String(item)).join(", ").trim();
            return joined ? `${field}: ${joined}` : "";
          }
          const text = String(rawValue || "").trim();
          return text ? `${field}: ${text}` : "";
        })
        .filter(Boolean);

      if (fieldMessages.length === 0) {
        return { title: baseMessage, description: fallbackDescription === baseMessage ? undefined : fallbackDescription };
      }
      return {
        title: baseMessage,
        description: fieldMessages.slice(0, 5).join(" | "),
      };
    }

    if (error instanceof Error) {
      return { title: "Erro ao salvar dataset", description: error.message };
    }

    return { title: "Erro ao salvar dataset", description: "Falha ao salvar dataset" };
  }, []);

  const saveDataset = useMutation({
    mutationFn: async (closeAfterSave: boolean = false): Promise<{ dataset: ApiDataset; closeAfterSave: boolean }> => {
      const payload = buildPayload();
      if (isEditing && datasetId) {
        const dataset = await api.updateDataset(Number(datasetId), {
          name: payload.name,
          description: payload.description,
          access_mode: payload.access_mode,
          view_id: payload.view_id,
          base_query_spec: payload.base_query_spec,
          semantic_columns: payload.semantic_columns,
        });
        return { dataset, closeAfterSave };
      }
      const dataset = await api.createDataset(payload);
      return { dataset, closeAfterSave };
    },
    onSuccess: async ({ dataset, closeAfterSave }) => {
      const id = String(dataset.id);
      setIsDirty(false);
      setLastSavedAt(new Date().toISOString());

      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["datasets"] }),
        queryClient.invalidateQueries({ queryKey: ["dashboards"] }),
      ]);

      if (closeAfterSave) {
        navigate(`/datasets/${id}`);
      } else if (!isEditing) {
        navigate(`/datasets/${id}/edit`, { replace: true });
      }
      toast({ title: isEditing ? "Dataset atualizado" : "Dataset criado" });
    },
    onError: (error: unknown) => {
      const parsed = formatSaveDatasetError(error);
      toast({ title: parsed.title, description: parsed.description, variant: "destructive" });
    },
  });

  const handleSaveDataset = useCallback((closeAfterSave = false) => {
    if (saveDataset.isPending) return;
    if (saveValidationIssue) {
      toast({
        title: saveValidationIssue.title,
        description: saveValidationIssue.description,
        variant: "destructive",
      });
      saveValidationIssue.focus?.();
      return;
    }
    saveDataset.mutate(closeAfterSave);
  }, [saveDataset, saveValidationIssue, toast]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      const tagName = target?.tagName?.toLowerCase();
      const isTyping = target?.isContentEditable || tagName === "input" || tagName === "textarea" || tagName === "select";
      if (isTyping) return;

      const withCtrlOrMeta = event.ctrlKey || event.metaKey;
      if (!withCtrlOrMeta) return;

      if (event.key.toLowerCase() === "s") {
        event.preventDefault();
        handleSaveDataset(event.shiftKey);
        return;
      }

      if (event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) {
          redoCanvas();
          return;
        }
        undoCanvas();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [handleSaveDataset, redoCanvas, undoCanvas]);

  const loadPreview = useMutation({
    mutationFn: async () => {
      const payload = buildPayload();
      const columns = payload.semantic_columns.map((item) => item.name);
      return api.previewCatalogData({
        datasource_id: payload.datasource_id,
        base_query_spec: payload.base_query_spec,
        columns,
        limit: 15,
      });
    },
    onMutate: () => setPreviewError(null),
    onSuccess: (result) => setPreview(result),
    onError: (error: unknown) => {
      const formatPreviewError = (value: unknown): string => {
        if (!value) return "Falha ao gerar preview";
        const payload = typeof value === "string"
          ? (() => {
            try {
              return JSON.parse(value) as unknown;
            } catch {
              return value;
            }
          })()
          : value;
        if (typeof payload === "string") return payload;
        if (typeof payload !== "object") return "Falha ao gerar preview";
        const root = payload as Record<string, unknown>;
        const nested = (root.error && typeof root.error === "object") ? root.error as Record<string, unknown> : root;
        const message = typeof nested.message === "string"
          ? nested.message
          : typeof root.message === "string"
            ? root.message
            : "Falha ao gerar preview";
        const errorId = typeof nested.error_id === "string"
          ? nested.error_id
          : typeof root.error_id === "string"
            ? root.error_id
            : null;
        return errorId ? `${message} (error_id: ${errorId})` : message;
      };

      const message = error instanceof ApiError
        ? formatPreviewError(error.detail || error.message)
        : error instanceof Error
          ? error.message
          : "Falha ao gerar preview";
      setPreviewError(message);
      setPreview(null);
    },
  });

  const datasetCatalogQuery = useQuery({
    queryKey: ["catalog-dataset", datasetId],
    queryFn: () => api.getCatalogDataset(Number(datasetId)),
    enabled: isEditing && !!datasetId,
    staleTime: 30_000,
  });

  const createMetricMutation = useMutation({
    mutationFn: (payload: { datasetId: number; name: string; formula: string; description?: string }) =>
      api.createCatalogMetric({
        dataset_id: payload.datasetId,
        name: payload.name,
        formula: payload.formula,
        description: payload.description,
      }),
    onSuccess: () => {
      setNewMetricName("");
      setNewMetricFormula("");
      setNewMetricDescription("");
      void datasetCatalogQuery.refetch();
      toast({ title: "Metrica criada" });
    },
    onError: (error: unknown) => {
      const message = error instanceof ApiError ? error.detail || error.message : "Falha ao criar metrica";
      toast({ title: "Erro ao criar metrica", description: String(message), variant: "destructive" });
    },
  });

  const createDimensionMutation = useMutation({
    mutationFn: (payload: { datasetId: number; name: string; column: string; description?: string }) =>
      api.createCatalogDimension({
        dataset_id: payload.datasetId,
        name: payload.name,
        type: "categorical",
        description: [payload.description, payload.column ? `Coluna origem: ${payload.column}` : ""].filter(Boolean).join(" . "),
      }),
    onSuccess: () => {
      setNewDimensionName("");
      setNewDimensionColumn("");
      setNewDimensionDescription("");
      void datasetCatalogQuery.refetch();
      toast({ title: "Dimensao criada" });
    },
    onError: (error: unknown) => {
      const message = error instanceof ApiError ? error.detail || error.message : "Falha ao criar dimensao";
      toast({ title: "Erro ao criar dimensao", description: String(message), variant: "destructive" });
    },
  });

  const updateMetricMutation = useMutation({
    mutationFn: (payload: { metricId: number; name: string; formula: string; description?: string }) =>
      api.updateCatalogMetric(payload.metricId, {
        name: payload.name,
        formula: payload.formula,
        description: payload.description,
      }),
    onSuccess: () => {
      void datasetCatalogQuery.refetch();
      toast({ title: "Metrica atualizada" });
    },
    onError: (error: unknown) => {
      const message = error instanceof ApiError ? error.detail || error.message : "Falha ao atualizar metrica";
      toast({ title: "Erro ao atualizar metrica", description: String(message), variant: "destructive" });
    },
  });

  const deleteMetricMutation = useMutation({
    mutationFn: (metricId: number) => api.deleteCatalogMetric(metricId),
    onSuccess: () => {
      void datasetCatalogQuery.refetch();
      toast({ title: "Metrica removida" });
    },
    onError: (error: unknown) => {
      const message = error instanceof ApiError ? error.detail || error.message : "Falha ao remover metrica";
      toast({ title: "Erro ao remover metrica", description: String(message), variant: "destructive" });
    },
  });

  const updateDimensionMutation = useMutation({
    mutationFn: (payload: { dimensionId: number; name: string; type: "categorical" | "temporal" | "relational"; description?: string }) =>
      api.updateCatalogDimension(payload.dimensionId, {
        name: payload.name,
        type: payload.type,
        description: payload.description,
      }),
    onSuccess: () => {
      void datasetCatalogQuery.refetch();
      toast({ title: "Dimensao atualizada" });
    },
    onError: (error: unknown) => {
      const message = error instanceof ApiError ? error.detail || error.message : "Falha ao atualizar dimensao";
      toast({ title: "Erro ao atualizar dimensao", description: String(message), variant: "destructive" });
    },
  });

  const deleteDimensionMutation = useMutation({
    mutationFn: (dimensionId: number) => api.deleteCatalogDimension(dimensionId),
    onSuccess: () => {
      void datasetCatalogQuery.refetch();
      toast({ title: "Dimensao removida" });
    },
    onError: (error: unknown) => {
      const message = error instanceof ApiError ? error.detail || error.message : "Falha ao remover dimensao";
      toast({ title: "Erro ao remover dimensao", description: String(message), variant: "destructive" });
    },
  });

  const syncRunsQuery = useQuery({
    queryKey: ["dataset-sync-runs", datasetId],
    queryFn: () => api.listDatasetSyncRuns(Number(datasetId), 25),
    enabled: isEditing && !!datasetId,
    staleTime: 30_000,
    refetchInterval: isEditing && !!datasetId ? 30_000 : false,
  });

  const importConfigQuery = useQuery({
    queryKey: ["dataset-import-config", datasetId],
    queryFn: () => api.getDatasetImportConfig(Number(datasetId)),
    enabled: isEditing && !!datasetId && accessMode === "imported",
    staleTime: 30_000,
  });

  const syncScheduleQuery = useQuery({
    queryKey: ["dataset-sync-schedule", datasetId],
    queryFn: async () => {
      try {
        return await api.getDatasetSyncSchedule(Number(datasetId));
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return null;
        throw error;
      }
    },
    enabled: isEditing && !!datasetId && accessMode === "imported",
    staleTime: 30_000,
    refetchInterval: isEditing && !!datasetId && accessMode === "imported" ? 30_000 : false,
  });

  const triggerSyncMutation = useMutation({
    mutationFn: async () => api.triggerDatasetSync(Number(datasetId)),
    onSuccess: () => {
      void syncRunsQuery.refetch();
      toast({ title: "Sync enfileirado" });
    },
    onError: (error: unknown) => {
      const message = error instanceof ApiError ? error.detail || error.message : "Falha ao iniciar sync";
      toast({ title: "Erro ao iniciar sync", description: String(message), variant: "destructive" });
    },
  });

  const retrySyncMutation = useMutation({
    mutationFn: async (runId: number) => api.retryDatasetSyncRun(Number(datasetId), runId),
    onSuccess: () => {
      void syncRunsQuery.refetch();
      toast({ title: "Retry enfileirado" });
    },
    onError: (error: unknown) => {
      const message = error instanceof ApiError ? error.detail || error.message : "Falha ao reenfileirar sync";
      toast({ title: "Erro ao reenfileirar sync", description: String(message), variant: "destructive" });
    },
  });

  const upsertImportConfigMutation = useMutation({
    mutationFn: async (enabled: boolean) => api.upsertDatasetImportConfig(Number(datasetId), { enabled }),
    onSuccess: async (config) => {
      await queryClient.invalidateQueries({ queryKey: ["dataset-import-config", datasetId] });
      toast({ title: config.enabled ? "Sync habilitado" : "Sync pausado" });
    },
    onError: (error: unknown) => {
      const message = error instanceof ApiError ? error.detail || error.message : "Falha ao atualizar import config";
      toast({ title: "Erro ao atualizar sync", description: String(message), variant: "destructive" });
    },
  });

  const saveSyncScheduleMutation = useMutation({
    mutationFn: async () => {
      if (syncExecutionType === "manual") {
        await api.deleteDatasetSyncSchedule(Number(datasetId));
        return null;
      }
      const payload = {
        enabled: syncExecutionType === "scheduled",
        schedule_kind: "interval" as const,
        interval_minutes: Math.max(1, Number.parseInt(syncFrequencyMinutes, 10) || 60),
        cron_expr: undefined,
        timezone: syncTimezone.trim() || "UTC",
        misfire_policy: syncMisfirePolicy === "immediate" ? "run_once" : syncMisfirePolicy,
      };
      return api.upsertDatasetSyncSchedule(Number(datasetId), payload);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["dataset-sync-schedule", datasetId] });
      toast({ title: "Agenda de sync atualizada" });
    },
    onError: (error: unknown) => {
      const message = error instanceof ApiError ? error.detail || error.message : "Falha ao salvar agenda de sync";
      toast({ title: "Erro ao salvar agenda", description: String(message), variant: "destructive" });
    },
  });

  const selectedColumnsCount = useMemo(() => nodes.reduce((sum, node) => sum + node.data.fields.filter((field) => field.selected).length, 0), [nodes]);
  const activeDatasource = useMemo(() => activeDatasources.find((item) => item.id === datasourceId), [activeDatasources, datasourceId]);
  const availableDatasourceIds = useMemo(() => selectableDatasources
    .filter((item) => accessMode !== "imported" || item.copyPolicy === "allowed")
    .map((item) => item.id), [accessMode, selectableDatasources]);
  const refreshResourcesMutation = useMutation({
    mutationFn: async () => {
      const candidates = selectableDatasources.filter((item) => {
        if (item.sourceType !== "database") return false;
        if (accessMode === "imported" && item.copyPolicy !== "allowed") return false;
        if (accessMode !== "imported" && datasourceId && item.id !== datasourceId) return false;
        return true;
      });
      if (!candidates.length) return { total: 0, success: 0, failed: 0 };

      const results = await Promise.allSettled(
        candidates.map(async (item) => api.syncDatasource(Number(item.id))),
      );
      const success = results.filter((item) => item.status === "fulfilled").length;
      return {
        total: candidates.length,
        success,
        failed: candidates.length - success,
      };
    },
    onSuccess: async (result) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["views"] }),
        queryClient.invalidateQueries({ queryKey: ["datasources"] }),
      ]);
      if (result.total === 0) {
        toast({ title: "Nenhuma fonte elegivel para atualizar" });
        return;
      }
      if (result.failed > 0) {
        toast({
          title: "Atualizacao parcial das fontes",
          description: `${result.success}/${result.total} fontes sincronizadas.`,
          variant: "destructive",
        });
        return;
      }
      toast({
        title: "Fontes atualizadas",
        description: `${result.success} fonte${result.success > 1 ? "s" : ""} sincronizada${result.success > 1 ? "s" : ""}.`,
      });
    },
    onError: (error: unknown) => {
      const message = error instanceof ApiError ? error.detail || error.message : "Falha ao atualizar fontes";
      toast({ title: "Erro ao atualizar fontes", description: String(message), variant: "destructive" });
    },
  });

  const resourcesByDatasource = useMemo(() => {
    if (!accessMode) return [];
    const datasourceNameById = new Map(selectableDatasources.map((item) => [item.id, item.name]));
    const grouped = new Map<string, {
      datasourceId: string;
      datasourceName: string;
      resources: Array<{
        resourceId: string;
        label: string;
        schema: string;
        name: string;
        fields: Array<{ name: string; type: string }>;
      }>;
    }>();

    views.forEach((view) => {
      if (!availableDatasourceIds.includes(view.datasourceId)) return;
      if (accessMode !== "imported" && datasourceId && view.datasourceId !== datasourceId) return;
      const next = grouped.get(view.datasourceId) || {
        datasourceId: view.datasourceId,
        datasourceName: datasourceNameById.get(view.datasourceId) || `Fonte ${view.datasourceId}`,
        resources: [],
      };
      next.resources.push({
        resourceId: `${view.schema}.${view.name}`,
        label: view.name,
        schema: view.schema,
        name: view.name,
        fields: view.columns.map((column) => ({ name: column.name, type: column.type })),
      });
      grouped.set(view.datasourceId, next);
    });

    return Array.from(grouped.values())
      .map((group) => ({
        ...group,
        resources: group.resources.sort((a, b) => a.resourceId.localeCompare(b.resourceId)),
      }))
      .sort((a, b) => a.datasourceName.localeCompare(b.datasourceName));
  }, [accessMode, selectableDatasources, availableDatasourceIds, datasourceId, views]);

  const handleAccessModeChange = useCallback((nextValue: "direct" | "imported" | "") => {
    if (nextValue === accessMode) return;
    setAccessMode(nextValue);
    setDatasourceId("");
    setNodes([]);
    setEdges([]);
    setSelectedNodeId(null);
    setSelectedEdgeId(null);
    setPreview(null);
    setPreviewError(null);
    resetHistory({ nodes: [], edges: [] });
    setIsDirty(true);
  }, [accessMode, resetHistory]);

  const addResourceToCanvas = useCallback((
    resource: {
      resourceId: string;
      label: string;
      datasourceId: string;
      fields: Array<{ name: string; type: string }>;
    },
    position?: { x: number; y: number },
  ) => {
    if (!accessMode) {
      toast({ title: "Selecione o tipo do dataset", description: "Escolha Direct ou Imported para liberar o catalogo de recursos." });
      return;
    }

    if (accessMode !== "imported" && datasourceId && datasourceId !== resource.datasourceId) {
      toast({ title: "Datasource invalido", description: "Todos os recursos do dataset devem ser da mesma fonte.", variant: "destructive" });
      return;
    }

    const duplicate = nodes.some((node) => node.data.resourceId.toLowerCase() === resource.resourceId.toLowerCase());
    if (duplicate) {
      toast({ title: "Recurso ja adicionado", description: "Esse recurso ja esta no canvas." });
      return;
    }

    if (!datasourceId) {
      setDatasourceId(resource.datasourceId);
    } else if (accessMode === "imported" && datasourceId !== resource.datasourceId) {
      const currentDatasource = selectableDatasources.find((item) => item.id === datasourceId);
      const nextDatasource = selectableDatasources.find((item) => item.id === resource.datasourceId);
      if (currentDatasource?.sourceType === "spreadsheet" && nextDatasource?.sourceType === "database") {
        // Keep logical datasource anchored on the DB source when mixing spreadsheet + DB resources.
        setDatasourceId(resource.datasourceId);
      }
    }

    const nextOrdinal = nodes.reduce((max, node) => {
      const numeric = Number(node.id.replace(/^r/, ""));
      if (Number.isNaN(numeric)) return max;
      return Math.max(max, numeric);
    }, -1) + 1;

    const nextNode: DatasetCanvasNode = {
      id: `r${nextOrdinal}`,
      type: "resource",
      position: position || { x: 0, y: 0 },
      data: {
        resourceId: resource.resourceId,
        label: resource.label,
        fields: resource.fields.map((field) => {
          const semanticType = inferFieldSemanticType(field.type);
          return {
            id: buildFieldId(field.name),
            name: field.name,
            type: field.type,
            selected: true,
            alias: field.name,
            semanticType,
            aggregation: inferDefaultAggregation(semanticType),
          };
        }),
      },
    };

    const inferCondition = (leftFields: Array<{ name: string; type: string }>, rightFields: Array<{ name: string; type: string }>) => {
      let best: { leftColumn: string; rightColumn: string; score: number } | null = null;
      leftFields.forEach((leftField) => {
        rightFields.forEach((rightField) => {
          const left = normalizeToken(leftField.name);
          const right = normalizeToken(rightField.name);
          let score = 0;
          if (left === right) score = 4;
          else if (left.endsWith("_id") && (left.replace(/_id$/, "") === right || right === "id")) score = 3;
          else if (right.endsWith("_id") && (right.replace(/_id$/, "") === left || left === "id")) score = 3;
          else if (left === "id" && right.endsWith("_id")) score = 2.5;
          else if (right === "id" && left.endsWith("_id")) score = 2.5;
          if (!best || score > best.score) {
            best = { leftColumn: leftField.name, rightColumn: rightField.name, score };
          }
        });
      });
      return best && best.score > 0 ? { leftColumn: best.leftColumn, rightColumn: best.rightColumn } : null;
    };

    const inferBestAnchorNode = (candidateNodes: DatasetCanvasNode[]) => {
      if (candidateNodes.length === 0) return null;
      let best: { node: DatasetCanvasNode; condition: { leftColumn: string; rightColumn: string }; score: number } | null = null;
      candidateNodes.forEach((candidate) => {
        const condition = inferCondition(candidate.data.fields, nextNode.data.fields);
        if (!condition) return;
        const score = condition.leftColumn === condition.rightColumn ? 4 : 3;
        if (!best || score > best.score) {
          best = { node: candidate, condition, score };
        }
      });
      if (best) return best;
      const fallbackNode = candidateNodes[0];
      const fallbackLeft = fallbackNode.data.fields[0]?.name || "";
      const fallbackRight = nextNode.data.fields[0]?.name || "";
      if (!fallbackLeft || !fallbackRight) return null;
      return { node: fallbackNode, condition: { leftColumn: fallbackLeft, rightColumn: fallbackRight }, score: 1 };
    };

    const anchor = inferBestAnchorNode(nodes);

    setNodes((prev) => {
      if (position) return [...prev, nextNode];
      return defaultCanvasLayout([...prev, nextNode]);
    });
    if (anchor) {
      setEdges((prev) => {
        const duplicate = prev.some((edge) => edge.source === anchor.node.id && edge.target === nextNode.id);
        if (duplicate) return prev;
        return [
          ...prev,
          {
            id: `j${Date.now()}`,
            type: "join",
            source: anchor.node.id,
            target: nextNode.id,
            data: {
              joinType: "left",
              conditions: [anchor.condition],
            },
          },
        ];
      });
      setSelectedNodeId(null);
      setSelectedEdgeId(null);
    } else if (!position) {
      setSelectedNodeId(nextNode.id);
      setSelectedEdgeId(null);
    } else {
      setSelectedNodeId(null);
      setSelectedEdgeId(null);
    }
    setIsDirty(true);
  }, [accessMode, datasourceId, nodes, selectableDatasources, toast]);

  const onCreateJoinFromCanvas = useCallback((sourceNodeId: string, targetNodeId: string) => {
    if (sourceNodeId === targetNodeId) return;
    const sourceNode = nodes.find((node) => node.id === sourceNodeId);
    const targetNode = nodes.find((node) => node.id === targetNodeId);
    if (!sourceNode || !targetNode) return;

    const alreadyExists = edges.find((edge) => edge.source === sourceNodeId && edge.target === targetNodeId);
    if (alreadyExists) {
      setSelectedEdgeId(alreadyExists.id);
      setSelectedNodeId(null);
      return;
    }

    const sourceDefault = sourceNode.data.fields.find((field) => field.name.endsWith("_id"))?.name
      || sourceNode.data.fields[0]?.name
      || "";
    const targetDefault = targetNode.data.fields.find((field) => field.name === "id")?.name
      || targetNode.data.fields[0]?.name
      || "";

    const edgeId = `j${Date.now()}`;
    const nextEdge: DatasetCanvasEdge = {
      id: edgeId,
      type: "join",
      source: sourceNodeId,
      target: targetNodeId,
      data: {
        joinType: "left",
        conditions: [{ leftColumn: sourceDefault, rightColumn: targetDefault }],
      },
    };
    setEdges((prev) => [...prev, nextEdge]);
    setSelectedEdgeId(edgeId);
    setSelectedNodeId(null);
    setIsDirty(true);
  }, [edges, nodes]);

  const previewConfigSignature = useMemo(() => JSON.stringify({
    accessMode,
    datasourceId,
    columns: projectedColumns.map((item) => ({
      nodeId: item.nodeId,
      column: item.column,
      alias: item.alias,
      semanticType: item.semanticType,
    })),
    joins: edges.map((edge) => ({
      source: edge.source,
      target: edge.target,
      joinType: edge.data.joinType,
      conditions: edge.data.conditions,
    })),
    computedColumns,
    filters,
  }), [accessMode, computedColumns, datasourceId, edges, filters, projectedColumns]);

  const joinDiagnostics = useMemo(() => {
    if (!selectedEdge || !selectedEdgeSourceNode || !selectedEdgeTargetNode) {
      return {
        cardinality: "indefinida" as const,
        warnings: [] as string[],
      };
    }

    const conditions = edgeDraftConditions || selectedEdge.data.conditions;
    if (!isEdgeDraftDirty) {
      const actualCardinality = selectedEdge.data.cardinality?.actual?.value;
      if (actualCardinality) {
        return {
          cardinality: actualCardinality,
          warnings: [] as string[],
        };
      }
      const estimatedCardinality = selectedEdge.data.cardinality?.estimated?.value;
      if (estimatedCardinality) {
        const warnings: string[] = [];
        if (estimatedCardinality === "1-N" || estimatedCardinality === "N-N") warnings.push("Aviso: potencial duplicacao de linhas");
        if (estimatedCardinality === "N-N") warnings.push("Aviso: join sem chave unica");
        return {
          cardinality: estimatedCardinality,
          warnings,
        };
      }
    }
    const normalizedConditions = conditions
      .filter((item) => item.leftColumn && item.rightColumn)
      .map((item) => ({ left: item.leftColumn.trim().toLowerCase(), right: item.rightColumn.trim().toLowerCase() }));
    if (normalizedConditions.length === 0) {
      return { cardinality: "indefinida" as const, warnings: [] as string[] };
    }

    const isUniqueCandidate = (column: string, sideFields: Array<{ name: string }>) => {
      const normalized = column.trim().toLowerCase();
      if (normalized === "id") return true;
      if (normalized.endsWith("_pk")) return true;
      if (normalized.endsWith("_uuid")) return true;
      const field = sideFields.find((item) => item.name.toLowerCase() === normalized);
      if (!field) return false;
      return field.name.toLowerCase() === "id";
    };

    const leftIsUnique = normalizedConditions.every((condition) => isUniqueCandidate(condition.left, selectedEdgeSourceNode.data.fields));
    const rightIsUnique = normalizedConditions.every((condition) => isUniqueCandidate(condition.right, selectedEdgeTargetNode.data.fields));

    let cardinality: "1-1" | "1-N" | "N-1" | "N-N" | "indefinida" = "indefinida";
    if (leftIsUnique && rightIsUnique) cardinality = "1-1";
    else if (leftIsUnique && !rightIsUnique) cardinality = "1-N";
    else if (!leftIsUnique && rightIsUnique) cardinality = "N-1";
    else cardinality = "N-N";

    const warnings: string[] = [];
    if (cardinality === "1-N" || cardinality === "N-N") warnings.push("Aviso: potencial duplicacao de linhas");
    if (cardinality === "N-N") warnings.push("Aviso: join sem chave unica");

    return { cardinality, warnings };
  }, [edgeDraftConditions, isEdgeDraftDirty, selectedEdge, selectedEdgeSourceNode, selectedEdgeTargetNode]);

  const formatSyncDateTime = useCallback((value?: string | null) => {
    if (!value) return "-";
    const date = parseApiDate(value);
    if (!date) return "-";
    return date.toLocaleString("pt-BR");
  }, []);

  const toSyncTimestamp = useCallback((value?: string | null): number | null => {
    if (!value) return null;
    const parsed = parseApiDate(value);
    if (!parsed) return null;
    return parsed.getTime();
  }, []);

  const isImportedMode = accessMode === "imported";
  const syncRuns = useMemo<ApiDatasetSyncRun[]>(() => syncRunsQuery.data?.items || [], [syncRunsQuery.data?.items]);
  const syncSchedule = useMemo<ApiDatasetSyncSchedule | null>(() => syncScheduleQuery.data || null, [syncScheduleQuery.data]);
  const latestSyncRun = useMemo(() => syncRuns[0] || null, [syncRuns]);
  const syncDurationsMs = useMemo(() => syncRuns
    .map((run) => {
      const started = toSyncTimestamp(run.started_at);
      const finished = toSyncTimestamp(run.finished_at);
      if (started === null || finished === null || finished < started) return null;
      return finished - started;
    })
    .filter((value): value is number => typeof value === "number"), [syncRuns, toSyncTimestamp]);
  const averageSyncDurationMs = useMemo(() => {
    if (syncDurationsMs.length === 0) return null;
    return Math.round(syncDurationsMs.reduce((sum, value) => sum + value, 0) / syncDurationsMs.length);
  }, [syncDurationsMs]);
  const latestSyncRowsProcessed = useMemo(() => {
    if (!latestSyncRun?.stats) return null;
    const rowCandidates = [
      Number((latestSyncRun.stats as Record<string, unknown>).rows_written),
      Number((latestSyncRun.stats as Record<string, unknown>).rows_read),
      Number((latestSyncRun.stats as Record<string, unknown>).rows_processed),
    ].filter((value) => Number.isFinite(value) && value >= 0);
    return rowCandidates.length > 0 ? rowCandidates[0] : null;
  }, [latestSyncRun]);
  const latestSyncBytesProcessed = useMemo(() => {
    if (!latestSyncRun?.stats) return null;
    const raw = Number((latestSyncRun.stats as Record<string, unknown>).bytes_processed);
    return Number.isFinite(raw) && raw >= 0 ? raw : null;
  }, [latestSyncRun]);
  const currentSyncStatus = useMemo(() => {
    if (!importConfigQuery.data?.enabled) return "paused" as const;
    if (latestSyncRun?.status === "failed") return "error" as const;
    return "active" as const;
  }, [importConfigQuery.data?.enabled, latestSyncRun?.status]);
  const catalogMetrics = useMemo<ApiCatalogMetric[]>(() => datasetCatalogQuery.data?.metrics || [], [datasetCatalogQuery.data?.metrics]);
  const catalogDimensions = useMemo<ApiCatalogDimension[]>(() => datasetCatalogQuery.data?.dimensions || [], [datasetCatalogQuery.data?.dimensions]);

  const formatDurationMs = useCallback((value?: number | null) => {
    if (!value || value <= 0) return "-";
    if (value < 1000) return `${value}ms`;
    const seconds = value / 1000;
    if (seconds < 60) return `${seconds.toFixed(1)}s`;
    const minutes = Math.floor(seconds / 60);
    const remainder = Math.round(seconds % 60);
    return `${minutes}m ${remainder}s`;
  }, []);

  const formatBytes = useCallback((value?: number | null) => {
    if (!value || value <= 0) return "-";
    if (value < 1024) return `${value} B`;
    const units = ["KB", "MB", "GB", "TB"];
    let current = value / 1024;
    let unitIndex = 0;
    while (current >= 1024 && unitIndex < units.length - 1) {
      current /= 1024;
      unitIndex += 1;
    }
    return `${current.toFixed(1)} ${units[unitIndex]}`;
  }, []);

  const describeInterval = useCallback((minutesRaw: string) => {
    const minutes = Math.max(1, Number.parseInt(minutesRaw, 10) || 60);
    if (minutes < 60) return `Executa a cada ${minutes} minutos`;
    if (minutes % 60 === 0) {
      const hours = minutes / 60;
      if (hours === 24) return "Executa a cada 1 dia";
      return `Executa a cada ${hours} hora${hours > 1 ? "s" : ""}`;
    }
    return `Executa a cada ${minutes} minutos`;
  }, []);

  useEffect(() => {
    if (leftPanelTab === "syncs" && !isImportedMode) {
      setLeftPanelTab("estrutura");
    }
  }, [isImportedMode, leftPanelTab]);

  useEffect(() => {
    if (!syncSchedule) {
      setSyncExecutionType("manual");
      return;
    }
    setSyncExecutionType(syncSchedule.enabled ? "scheduled" : "manual");
    setSyncFrequencyMinutes(String(syncSchedule.interval_minutes || 60));
    setSyncTimezone(syncSchedule.timezone || "UTC");
    setSyncMisfirePolicy(syncSchedule.misfire_policy || "run_once");
  }, [syncSchedule]);

  useEffect(() => {
    setMetricDraftById(
      Object.fromEntries(
        catalogMetrics.map((metric) => [
          metric.id,
          {
            name: metric.name,
            formula: metric.formula,
            description: metric.description || "",
          },
        ]),
      ),
    );
    setExpandedMetricIds((prev) => prev.filter((id) => catalogMetrics.some((metric) => metric.id === id)));
  }, [catalogMetrics]);

  useEffect(() => {
    setDimensionDraftById(
      Object.fromEntries(
        catalogDimensions.map((dimension) => [
          dimension.id,
          {
            name: dimension.name,
            type: dimension.type,
            description: dimension.description || "",
          },
        ]),
      ),
    );
    setExpandedDimensionIds((prev) => prev.filter((id) => catalogDimensions.some((dimension) => dimension.id === id)));
  }, [catalogDimensions]);
  const connectedNodeIds = useMemo(() => {
    if (!selectedNode) return new Set<string>();
    const result = new Set<string>([selectedNode.id]);
    edges.forEach((edge) => {
      if (edge.source === selectedNode.id) result.add(edge.target);
      if (edge.target === selectedNode.id) result.add(edge.source);
    });
    return result;
  }, [edges, selectedNode]);

  useEffect(() => {
    if (!selectedNode) {
      setNodeDraftFields(null);
      setNodeDraftComputedColumns(null);
      setNodeDraftFilters(null);
      setExpandedDraftFieldIds([]);
      setIsNodeDraftDirty(false);
      return;
    }
    setNodeDraftFields(selectedNode.data.fields.map((field) => ({ ...field })));
    setNodeDraftComputedColumns(computedColumns.map((column) => ({ ...column })));
    setNodeDraftFilters(filters.map((filter) => ({ ...filter })));
    setExpandedDraftFieldIds([]);
    setIsNodeDraftDirty(false);
  }, [computedColumns, filters, selectedNode]);

  useEffect(() => {
    if (!selectedEdge) {
      setEdgeDraftJoinType(null);
      setEdgeDraftConditions(null);
      setIsEdgeDraftDirty(false);
      return;
    }
    setEdgeDraftJoinType(selectedEdge.data.joinType);
    setEdgeDraftConditions(selectedEdge.data.conditions.map((condition) => ({ ...condition })));
    setIsEdgeDraftDirty(false);
  }, [selectedEdgeId]); // eslint-disable-line react-hooks/exhaustive-deps

  const updateNodeDraftDirty = useCallback(() => {
    setIsNodeDraftDirty(true);
  }, []);

  const toggleExpandedField = useCallback((fieldId: string) => {
    setExpandedDraftFieldIds((prev) => (
      prev.includes(fieldId) ? prev.filter((id) => id !== fieldId) : [...prev, fieldId]
    ));
  }, []);

  const reorderFieldInDraft = useCallback((fromIndex: number, toIndex: number) => {
    if (fromIndex === toIndex) return;
    setNodeDraftFields((prev) => {
      if (!prev) return prev;
      const next = [...prev];
      if (fromIndex < 0 || fromIndex >= next.length || toIndex < 0 || toIndex >= next.length) return prev;
      const [moved] = next.splice(fromIndex, 1);
      next.splice(toIndex, 0, moved);
      return next;
    });
    updateNodeDraftDirty();
  }, [updateNodeDraftDirty]);

  const updateDraftField = useCallback((fieldId: string, patch: Partial<DatasetCanvasNode["data"]["fields"][number]>) => {
    setNodeDraftFields((prev) => {
      if (!prev) return prev;
      return prev.map((field) => (field.id === fieldId ? { ...field, ...patch } : field));
    });
    updateNodeDraftDirty();
  }, [updateNodeDraftDirty]);

  const duplicateDraftField = useCallback((fieldId: string) => {
    setNodeDraftFields((prev) => {
      if (!prev) return prev;
      const index = prev.findIndex((field) => field.id === fieldId);
      if (index < 0) return prev;
      const source = prev[index];
      const duplicate = {
        ...source,
        id: buildFieldId(source.name),
        alias: `${source.alias || source.name}_copy`,
      };
      const next = [...prev];
      next.splice(index + 1, 0, duplicate);
      return next;
    });
    updateNodeDraftDirty();
  }, [updateNodeDraftDirty]);

  const removeDraftField = useCallback((fieldId: string) => {
    setNodeDraftFields((prev) => {
      if (!prev) return prev;
      return prev.filter((field) => field.id !== fieldId);
    });
    updateNodeDraftDirty();
  }, [updateNodeDraftDirty]);

  const openAddComputedDialog = useCallback(() => {
    setEditingComputedAlias(null);
    setNewComputedAlias("");
    setNewComputedFormula("");
    setNewComputedType("numeric");
    setComputedEditorCursor(0);
    setComputedEditorSuggestionIndex(0);
    setComputedColumnSearch("");
    setComputedFunctionSearch("");
    setIsComputedDialogOpen(true);
  }, []);

  const openEditComputedDialog = useCallback((column: ApiDatasetBaseQuerySpec["preprocess"]["computed_columns"][number]) => {
    setEditingComputedAlias(String(column.alias || ""));
    setNewComputedAlias(String(column.alias || ""));
    setNewComputedFormula(exprNodeToFormula((column.expr || null) as any));
    setNewComputedType((column.data_type || "numeric") as DatasetFieldSemanticType);
    setComputedEditorSuggestionIndex(0);
    setComputedColumnSearch("");
    setComputedFunctionSearch("");
    setIsComputedDialogOpen(true);
  }, []);

  const addComputedColumnFromEditor = useCallback(() => {
    if (!selectedNode) return;
    if (!computedCanSubmit || !computedExpressionValidation.ast) {
      const fallbackMessage = computedExpressionValidation.errors[0]
        || newComputedAliasError
        || "Revise alias e expressao por linha antes de adicionar.";
      toast({
        title: "Nao foi possivel adicionar coluna calculada",
        description: fallbackMessage,
        variant: "destructive",
      });
      return;
    }
    setNodeDraftComputedColumns((prev) => {
      const next = prev ? [...prev] : [];
      let replaced = false;
      if (editingComputedAlias) {
        for (let index = 0; index < next.length; index += 1) {
          if (String(next[index].alias || "") !== editingComputedAlias) continue;
          next[index] = {
            ...next[index],
            alias: newComputedAliasNormalized,
            data_type: newComputedType,
            expr: computedExpressionValidation.ast,
          };
          replaced = true;
          break;
        }
      }
      if (!replaced) {
        next.push({
          alias: newComputedAliasNormalized,
          data_type: newComputedType,
          expr: computedExpressionValidation.ast,
        });
      }
      return next;
    });
    setEditingComputedAlias(null);
    setNewComputedAlias("");
    setNewComputedFormula("");
    setNewComputedType("numeric");
    setComputedEditorCursor(0);
    setComputedEditorSuggestionIndex(0);
    setComputedColumnSearch("");
    setComputedFunctionSearch("");
    setIsComputedDialogOpen(false);
    updateNodeDraftDirty();
  }, [
    computedCanSubmit,
    computedExpressionValidation.ast,
    computedExpressionValidation.errors,
    editingComputedAlias,
    newComputedAliasError,
    newComputedAliasNormalized,
    newComputedType,
    selectedNode,
    toast,
    updateNodeDraftDirty,
  ]);

  const insertComputedSuggestion = useCallback((label: string, kind: "column" | "function") => {
    const target = computedExpressionSuggestions.suggestions.find((item) => item.label === label && item.kind === kind) || {
      kind,
      label,
      detail: kind === "column" ? "column" : "funcao",
      insertText: kind === "function" ? `${label}(` : label,
      score: 0,
    };
    const applied = insertSuggestion({
      input: newComputedFormula,
      cursor: computedEditorCursor,
      prefix: computedExpressionSuggestions.prefix,
      suggestion: target,
    });
    setNewComputedFormula(applied.value);
    setComputedEditorCursor(applied.cursor);
    setComputedEditorSuggestionIndex(0);
    requestAnimationFrame(() => {
      if (!computedFormulaRef.current) return;
      computedFormulaRef.current.focus();
      computedFormulaRef.current.setSelectionRange(applied.cursor, applied.cursor);
    });
  }, [computedEditorCursor, computedExpressionSuggestions.prefix, computedExpressionSuggestions.suggestions, newComputedFormula]);

  useEffect(() => {
    if (!isComputedDialogOpen) return;
    if (!computedFormulaRef.current) return;
    const el = computedFormulaRef.current;
    el.style.height = "auto";
    el.style.height = `${Math.min(260, Math.max(120, el.scrollHeight))}px`;
  }, [isComputedDialogOpen, newComputedFormula]);

  useEffect(() => {
    setComputedEditorSuggestionIndex(0);
  }, [computedExpressionSuggestions.prefix]);

  useEffect(() => {
    if (!isComputedDialogOpen) {
      setIsComputedEditorFocused(false);
      setComputedEditorSuggestionIndex(0);
      return;
    }
    setComputedEditorCursor(newComputedFormula.length);
  }, [isComputedDialogOpen, newComputedFormula.length]);

  const selectedNodeComputedColumns = useMemo(() => {
    if (!selectedNode || !nodeDraftComputedColumns) return [];
    return nodeDraftComputedColumns.filter((item) => {
      const resources = (item.expr as Record<string, unknown> | undefined)?.resources;
      if (!Array.isArray(resources)) return true;
      return resources.some((resource) => typeof resource === "string" && connectedNodeIds.has(resource));
    });
  }, [connectedNodeIds, nodeDraftComputedColumns, selectedNode]);

  const closeNodeEditorWithoutSave = useCallback(() => {
    setSelectedNodeId(null);
    setSelectedEdgeId(null);
    setNodeDraftFields(null);
    setNodeDraftComputedColumns(null);
    setNodeDraftFilters(null);
    setEdgeDraftJoinType(null);
    setEdgeDraftConditions(null);
    setIsEdgeDraftDirty(false);
    setExpandedDraftFieldIds([]);
    setIsNodeDraftDirty(false);
  }, []);

  const applyNodeEditorDraft = useCallback(() => {
    if (!selectedNode || !nodeDraftFields) return;
    setNodes((prev) => prev.map((node) => (
      node.id === selectedNode.id
        ? { ...node, data: { ...node.data, fields: nodeDraftFields.map((field) => ({ ...field })) } }
        : node
    )));
    if (nodeDraftComputedColumns) {
      setComputedColumns(nodeDraftComputedColumns.map((column) => ({ ...column })));
    }
    if (nodeDraftFilters) {
      setFilters(nodeDraftFilters.map((filter) => ({ ...filter })));
    }
    setSelectedNodeId(null);
    setSelectedEdgeId(null);
    setNodeDraftFields(null);
    setNodeDraftComputedColumns(null);
    setNodeDraftFilters(null);
    setEdgeDraftJoinType(null);
    setEdgeDraftConditions(null);
    setIsEdgeDraftDirty(false);
    setExpandedDraftFieldIds([]);
    setIsNodeDraftDirty(false);
    setIsDirty(true);
  }, [nodeDraftComputedColumns, nodeDraftFields, nodeDraftFilters, selectedNode]);

  const closeEdgeEditorWithoutSave = useCallback(() => {
    setSelectedEdgeId(null);
    setSelectedNodeId(null);
    setEdgeDraftJoinType(null);
    setEdgeDraftConditions(null);
    setIsEdgeDraftDirty(false);
  }, []);

  const applyEdgeEditorDraft = useCallback(() => {
    if (!selectedEdge || !edgeDraftJoinType || !edgeDraftConditions) return;
    setEdges((prev) => prev.map((edge) => (
      edge.id === selectedEdge.id
        ? {
            ...edge,
            data: {
              ...edge.data,
              joinType: edgeDraftJoinType,
              conditions: edgeDraftConditions.map((condition) => ({ ...condition })),
              cardinality: isEdgeDraftDirty ? undefined : edge.data.cardinality,
            },
          }
        : edge
    )));
    setSelectedEdgeId(null);
    setSelectedNodeId(null);
    setEdgeDraftJoinType(null);
    setEdgeDraftConditions(null);
    setIsEdgeDraftDirty(false);
    setIsDirty(true);
  }, [edgeDraftConditions, edgeDraftJoinType, selectedEdge]);

  const dimensionColumnOptions = useMemo(() => {
    const options: Array<{ value: string; label: string }> = [];
    nodes.forEach((node) => {
      if (!connectedNodeIds.has(node.id)) return;
      node.data.fields.forEach((field) => {
        options.push({ value: `${node.id}.${field.name}`, label: `${node.data.label}.${field.name}` });
      });
    });
    return options;
  }, [connectedNodeIds, nodes]);

  const removableDuplicateFieldIds = useMemo(() => {
    if (!nodeDraftFields) return new Set<string>();
    const byName = new Map<string, number>();
    nodeDraftFields.forEach((field) => {
      byName.set(field.name, (byName.get(field.name) || 0) + 1);
    });
    const result = new Set<string>();
    nodeDraftFields.forEach((field) => {
      if ((byName.get(field.name) || 0) > 1) result.add(field.id);
    });
    return result;
  }, [nodeDraftFields]);

  useEffect(() => {
    if (!accessMode || !datasourceId || nodes.length === 0 || projectedColumns.length === 0) {
      setPreview(null);
      setPreviewError(null);
      return;
    }

    if (edges.some((edge) => isJoinEdgeInvalid(edge))) {
      setPreview(null);
      setPreviewError(null);
      return;
    }
    if (joinTypeMismatchIssue) {
      setPreview(null);
      setPreviewError(joinTypeMismatchIssue.message);
      return;
    }

    const timer = window.setTimeout(() => {
      loadPreview.mutate();
    }, 350);

    return () => window.clearTimeout(timer);
  }, [accessMode, datasourceId, edges, joinTypeMismatchIssue, nodes.length, previewConfigSignature, projectedColumns.length]);

  if (isLoading && isEditing && !editingDataset) {
    return <div className="app-container py-6"><EmptyState icon={<Loader2 className="h-5 w-5 animate-spin" />} title="Carregando dataset" description="Recuperando configuracao atual..." /></div>;
  }

  if (isError) {
    return <div className="app-container py-6"><EmptyState icon={<Table2 className="h-5 w-5" />} title="Falha ao abrir editor" description={errorMessage} /></div>;
  }

  if (isEditing && !editingDataset) {
    return <div className="app-container py-6"><EmptyState icon={<Table2 className="h-5 w-5" />} title="Dataset nao encontrado" description="Verifique o id da rota e tente novamente." /></div>;
  }

  return (
    <div className="bg-background h-[calc(100vh-56px)] min-h-0 flex flex-col overflow-hidden">
      <header className="h-12 border-b border-border bg-card/90 px-3 backdrop-blur-sm">
        <div className="flex h-full items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={() => navigate(isEditing && datasetId ? `/datasets/${datasetId}` : "/datasets")}
          >
            <ArrowLeft className="h-4 w-4" />
          </Button>

          {editingTitle ? (
            <Input
              autoFocus
              value={name}
              onChange={(event) => {
                setName(event.target.value);
                setIsDirty(true);
              }}
              onBlur={() => setEditingTitle(false)}
              onKeyDown={(event) => {
                if (event.key === "Enter") setEditingTitle(false);
              }}
              className="h-7 max-w-[240px] bg-muted/30 text-sm font-semibold"
              placeholder="Dataset sem titulo"
            />
          ) : (
            <button type="button" className="max-w-[240px] truncate text-sm font-semibold" onClick={() => setEditingTitle(true)}>
              {name.trim() || "Dataset sem titulo"}
            </button>
          )}

          <Badge
            variant="outline"
            className={cn(
              "h-5 text-[10px] font-medium",
              isDirty
                ? "border-warning/20 bg-warning/10 text-warning"
                : "border-success/20 bg-success/10 text-success",
            )}
          >
            {isDirty ? "Rascunho" : "Salvo"}
          </Badge>

          <Separator orientation="vertical" className="mx-1 h-5" />

          <div className="hidden items-center gap-1 text-[11px] text-muted-foreground md:flex">
            <Database className="h-3 w-3" />
            <span>{activeDatasource?.name || "Datasource"}</span>
            <span>.</span>
            <Columns3 className="h-3 w-3" />
            <span>{selectedColumnsCount} colunas</span>
            <span>.</span>
            <span>{nodes.length} tabelas</span>
          </div>

          <div className="flex-1" />

          <div className="hidden text-[11px] text-muted-foreground lg:block">
            {edges.length} joins . {computedColumns.length} computadas
          </div>

          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-8 w-8 px-0"
            onClick={undoCanvas}
            disabled={undoCount === 0}
            title="Desfazer (Ctrl+Z)"
          >
            <Undo2 className="h-3.5 w-3.5" />
          </Button>

          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-8 w-8 px-0"
            onClick={redoCanvas}
            disabled={redoCount === 0}
            title="Refazer (Ctrl+Shift+Z)"
          >
            <Redo2 className="h-3.5 w-3.5" />
          </Button>

          <Button
            type="button"
            size="sm"
            variant="secondary"
            className="h-8 gap-1.5 text-xs"
            onClick={() => handleSaveDataset(false)}
            disabled={saveDataset.isPending}
          >
            {saveDataset.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />}
            <span className="hidden sm:inline">Salvar</span>
          </Button>

          <Button
            type="button"
            size="sm"
            className="h-8 gap-1.5 bg-accent text-xs text-accent-foreground hover:bg-accent/90"
            onClick={() => handleSaveDataset(true)}
            disabled={saveDataset.isPending}
          >
            {saveDataset.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />}
            <span className="hidden sm:inline">Salvar e fechar</span>
          </Button>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-hidden">
        <ResizablePanelGroup direction="horizontal" className="h-full min-h-0">
          <ResizablePanel id="dataset-left" order={1} defaultSize={18} minSize={14} maxSize={28} className="overflow-hidden">
            <aside className="glass-panel h-full overflow-hidden flex flex-col rounded-none border-r border-border/50">
              <div className="px-3 pt-3 pb-2 border-b border-border/45 space-y-1.5">
                <div className="flex items-center gap-1.5">
                  <Label className="text-heading">Tipo do dataset</Label>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        className="text-muted-foreground/80 transition-colors hover:text-foreground"
                        aria-label="Ajuda sobre tipo do dataset"
                      >
                        <CircleHelp className="h-3.5 w-3.5" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="right" className="max-w-[280px] text-caption">
                      {"\"Conex\u00e3o direta\" conecta diretamente na fonte de dados. \"Importado\" copia os dados para o Lens, permitindo acesso r\u00e1pido aos dados sem precisar se conectar \u00e0 fonte original."}
                    </TooltipContent>
                  </Tooltip>
                </div>
                <Select
                  value={accessMode || "__none__"}
                  onValueChange={(value) => handleAccessModeChange(value === "__none__" ? "" : value as "direct" | "imported")}
                >
                  <SelectTrigger className="h-8 text-body">
                    <SelectValue placeholder="Selecione o tipo" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">Selecione...</SelectItem>
                    <SelectItem value="direct">{"Conex\u00e3o direta"}</SelectItem>
                    <SelectItem value="imported">Importado</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <Tabs value={leftPanelTab} onValueChange={(value) => setLeftPanelTab(value as "estrutura" | "syncs")} className="h-full flex flex-col overflow-hidden">
                <div className="px-3 pt-3 pb-2 space-y-2">
                  <div className="flex items-center gap-2">
                    <TabsList className="grid h-8 flex-1 grid-cols-2 rounded-lg bg-muted/30 p-0.5">
                      <TabsTrigger value="estrutura" className="h-7 rounded-md text-caption font-medium">Recursos</TabsTrigger>
                      <TabsTrigger value="syncs" disabled={!isImportedMode} className="h-7 rounded-md text-caption font-medium">Syncs</TabsTrigger>
                    </TabsList>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          type="button"
                          variant="outline"
                          size="icon"
                          className="h-8 w-8 shrink-0"
                          disabled={refreshResourcesMutation.isPending || !accessMode}
                          onClick={() => refreshResourcesMutation.mutate()}
                          aria-label="Atualizar fontes"
                        >
                          <RefreshCw className={cn("h-3.5 w-3.5", refreshResourcesMutation.isPending ? "animate-spin" : "")} />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent side="bottom" className="text-caption">
                        Atualizar fontes
                      </TooltipContent>
                    </Tooltip>
                  </div>
                </div>

                <TabsContent value="estrutura" className="m-0 min-h-0 flex-1">
                  <div className="h-full overflow-y-auto overflow-x-hidden px-3 pb-3">
                    <div className="space-y-3">
                      {!accessMode ? (
                        <p className="rounded-lg border border-border/60 bg-card/45 px-3 py-2 text-caption text-muted-foreground">
                          Selecione o tipo do dataset para liberar os recursos.
                        </p>
                      ) : null}
                      {resourcesByDatasource.map((group) => (
                        <div key={`catalog-group-${group.datasourceId}`} className="space-y-1.5">
                          <div className="flex items-center justify-between">
                            <p className="truncate text-heading">{group.datasourceName}</p>
                            <Badge variant="secondary" className="text-caption">{group.resources.length}</Badge>
                          </div>
                          {group.resources.map((resource) => (
                            <button
                              key={`catalog-item-${group.datasourceId}-${resource.resourceId}`}
                              type="button"
                              draggable
                              onDragStartCapture={(event) => {
                                event.dataTransfer.effectAllowed = "copy";
                                event.dataTransfer.setData("application/x-istari-resource", JSON.stringify({
                                  resourceId: resource.resourceId,
                                  label: resource.label,
                                  datasourceId: group.datasourceId,
                                  fields: resource.fields,
                                }));
                                event.dataTransfer.setData("text/plain", resource.resourceId);
                              }}
                              onDoubleClick={() => addResourceToCanvas({
                                resourceId: resource.resourceId,
                                label: resource.label,
                                datasourceId: group.datasourceId,
                                fields: resource.fields,
                              })}
                              className="w-full cursor-grab active:cursor-grabbing rounded-md border border-border/50 bg-card/40 px-2.5 py-1.5 text-left transition-colors hover:bg-muted/30"
                              title={resource.resourceId}
                            >
                              <div className="flex items-center gap-1.5">
                                <p className="min-w-0 flex-1 truncate text-label text-foreground/95">{resource.name || resource.label}</p>
                                <Badge
                                  variant="outline"
                                  className="h-4 shrink-0 border-border/65 bg-background/30 px-1 text-caption font-medium text-muted-foreground"
                                >
                                  {resource.schema || "schema"}
                                </Badge>
                              </div>
                            </button>
                          ))}
                        </div>
                      ))}

                      {accessMode && resourcesByDatasource.length === 0 ? (
                        <p className="text-caption text-muted-foreground">Nenhum recurso disponivel para o tipo selecionado.</p>
                      ) : null}
                    </div>
                  </div>
                </TabsContent>

                <TabsContent value="syncs" className="m-0 min-h-0 flex-1">
                  <div className="h-full overflow-y-auto overflow-x-hidden px-3 pb-3">
                    {!isEditing || !datasetId ? (
                      <p className="rounded-lg border border-border/60 bg-card/45 px-3 py-2 text-xs text-muted-foreground">
                        Salve o dataset para acompanhar o historico de syncs.
                      </p>
                    ) : !isImportedMode ? (
                      <p className="rounded-lg border border-border/60 bg-card/45 px-3 py-2 text-xs text-muted-foreground">
                        Sync de dataset disponivel apenas para modo imported.
                      </p>
                    ) : (
                      <div className="space-y-3">
                        <div className="rounded-lg border border-border/60 bg-card/45 p-2.5 space-y-2">
                          <div className="flex items-center justify-between gap-2">
                            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Status</p>
                            <Badge
                              variant="outline"
                              className={cn(
                                "text-[10px] uppercase",
                                currentSyncStatus === "active" && "border-success/30 bg-success/10 text-success",
                                currentSyncStatus === "paused" && "border-warning/30 bg-warning/10 text-warning",
                                currentSyncStatus === "error" && "border-destructive/30 bg-destructive/10 text-destructive",
                              )}
                            >
                              {currentSyncStatus === "active" ? "Ativo" : currentSyncStatus === "paused" ? "Pausado" : "Erro"}
                            </Badge>
                          </div>
                          <div className="grid grid-cols-2 gap-2 text-[11px]">
                            <div className="rounded-md border border-border/60 bg-background/45 px-2 py-1.5">
                              <p className="text-muted-foreground">Ultima sincronizacao</p>
                              <p className="font-medium text-foreground">{formatSyncDateTime(latestSyncRun?.finished_at || latestSyncRun?.queued_at)}</p>
                            </div>
                            <div className="rounded-md border border-border/60 bg-background/45 px-2 py-1.5">
                              <p className="text-muted-foreground">Proxima execucao</p>
                              <p className="font-medium text-foreground">{formatSyncDateTime(syncSchedule?.next_run_at)}</p>
                            </div>
                            <div className="rounded-md border border-border/60 bg-background/45 px-2 py-1.5">
                              <p className="text-muted-foreground">Duracao media</p>
                              <p className="font-medium text-foreground">{formatDurationMs(averageSyncDurationMs)}</p>
                            </div>
                            <div className="rounded-md border border-border/60 bg-background/45 px-2 py-1.5">
                              <p className="text-muted-foreground">Volume processado</p>
                              <p className="font-medium text-foreground">
                                {latestSyncRowsProcessed !== null ? `${latestSyncRowsProcessed.toLocaleString("pt-BR")} linhas` : formatBytes(latestSyncBytesProcessed)}
                              </p>
                            </div>
                          </div>
                        </div>

                        <div className="rounded-lg border border-border/60 bg-card/45 p-2.5 space-y-2">
                          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Acoes</p>
                          <div className="flex flex-col items-stretch gap-2">
                            <div className="flex items-center justify-between gap-3 rounded-md border border-border/60 bg-background/45 px-2 py-1.5">
                              <div className="min-w-0">
                                <p className="truncate text-[11px] font-medium text-foreground">Sync automatica</p>
                                <p className="truncate text-[10px] text-muted-foreground">Ativa agendamento e sincronizacao manual</p>
                              </div>
                              <Switch
                                checked={Boolean(importConfigQuery.data?.enabled)}
                                disabled={upsertImportConfigMutation.isPending || importConfigQuery.isLoading}
                                onCheckedChange={(checked) => upsertImportConfigMutation.mutate(checked)}
                              />
                            </div>
                            <Button
                              type="button"
                              size="sm"
                              className="h-8 w-full gap-1.5 bg-primary text-xs font-medium text-primary-foreground hover:bg-primary/90"
                              disabled={!importConfigQuery.data?.enabled || triggerSyncMutation.isPending}
                              onClick={() => triggerSyncMutation.mutate()}
                            >
                              {triggerSyncMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Zap className="h-3.5 w-3.5" />}
                              Sincronizar agora
                            </Button>
                          </div>
                        </div>

                        {importConfigQuery.data?.enabled ? (
                          <div className="rounded-lg border border-border/60 bg-card/45 p-2.5 space-y-2">
                            <div className="flex items-center justify-between gap-2">
                              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Agenda</p>
                            </div>
                            <div className="grid grid-cols-2 gap-2">
                              <div className="space-y-1 col-span-2">
                                <Label className="text-[10px] text-muted-foreground">Tipo de execucao</Label>
                                <Select value={syncExecutionType} onValueChange={(value) => setSyncExecutionType(value as "manual" | "scheduled")}>
                                  <SelectTrigger className="h-7 text-[11px]"><SelectValue /></SelectTrigger>
                                  <SelectContent>
                                    <SelectItem value="manual">Manual</SelectItem>
                                    <SelectItem value="scheduled">Agendado</SelectItem>
                                  </SelectContent>
                                </Select>
                              </div>
                              {syncExecutionType === "scheduled" ? (
                                <>
                                  <div className="space-y-1 col-span-2">
                                    <Label className="text-[10px] text-muted-foreground">Frequencia</Label>
                                    <Select value={syncFrequencyMinutes} onValueChange={setSyncFrequencyMinutes}>
                                      <SelectTrigger className="h-7 text-[11px]"><SelectValue /></SelectTrigger>
                                      <SelectContent>
                                        <SelectItem value="5">5 min</SelectItem>
                                        <SelectItem value="15">15 min</SelectItem>
                                        <SelectItem value="30">30 min</SelectItem>
                                        <SelectItem value="60">1 hora</SelectItem>
                                        <SelectItem value="360">6 horas</SelectItem>
                                        <SelectItem value="1440">1 dia</SelectItem>
                                      </SelectContent>
                                    </Select>
                                  </div>
                                  <div className="space-y-1 col-span-2">
                                    <div className="flex items-center justify-between gap-2">
                                      <Label className="text-[10px] text-muted-foreground">Timezone</Label>
                                      <span className="text-[10px] text-muted-foreground" title="Timezone usada para calcular as proximas execucoes automaticas.">?</span>
                                    </div>
                                    <Input
                                      value={syncTimezone}
                                      onChange={(event) => setSyncTimezone(event.target.value)}
                                      className="h-7 text-[11px]"
                                      placeholder="America/Sao_Paulo"
                                    />
                                  </div>
                                  <div className="space-y-1 col-span-2">
                                    <Label className="text-[10px] text-muted-foreground">Quando falhar</Label>
                                    <Select value={syncMisfirePolicy} onValueChange={(value) => setSyncMisfirePolicy(value as "run_once" | "skip" | "immediate")}>
                                      <SelectTrigger className="h-7 text-[11px]"><SelectValue /></SelectTrigger>
                                      <SelectContent>
                                        <SelectItem value="immediate">Executar imediatamente</SelectItem>
                                        <SelectItem value="skip">Pular execucao</SelectItem>
                                        <SelectItem value="run_once">Executar apenas uma vez</SelectItem>
                                      </SelectContent>
                                    </Select>
                                  </div>
                                  <div className="rounded-md border border-border/60 bg-background/45 px-2 py-1.5 text-[11px] text-muted-foreground col-span-2">
                                    {describeInterval(syncFrequencyMinutes)}
                                  </div>
                                </>
                              ) : null}
                            </div>
                            <div className="pt-1">
                              <Button
                                type="button"
                                size="sm"
                                className="h-7 w-full bg-primary text-[10px] font-medium text-primary-foreground hover:bg-primary/90"
                                onClick={() => saveSyncScheduleMutation.mutate()}
                                disabled={saveSyncScheduleMutation.isPending}
                              >
                                {saveSyncScheduleMutation.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
                                Salvar configuracoes
                              </Button>
                            </div>
                          </div>
                        ) : null}

                        <div className="rounded-lg border border-border/60 bg-card/45 p-2.5 space-y-2">
                          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Historico</p>
                          {syncRuns.map((run) => {
                            const startedAt = run.started_at || run.queued_at;
                            const finishedAt = run.finished_at;
                            const startedTs = toSyncTimestamp(startedAt);
                            const finishedTs = toSyncTimestamp(finishedAt);
                            const duration = startedTs !== null && finishedTs !== null
                              ? Math.max(0, finishedTs - startedTs)
                              : null;
                            const rows = (() => {
                              if (!run.stats || typeof run.stats !== "object") return null;
                              const raw = Number((run.stats as Record<string, unknown>).rows_written ?? (run.stats as Record<string, unknown>).rows_read);
                              return Number.isFinite(raw) ? raw : null;
                            })();
                            return (
                              <div key={`sync-run-${run.id}`} className="rounded-md border border-border/60 bg-background/45 px-2.5 py-2">
                                <div className="flex items-center justify-between gap-2">
                                  <div className="min-w-0">
                                    <p className="truncate text-[11px] text-foreground">
                                      {formatSyncDateTime(startedAt)}{" "}
                                      <span className="text-muted-foreground">- {run.status === "success" ? "Sucesso" : run.status === "failed" ? "Erro" : run.status}</span>
                                    </p>
                                    {run.error_message ? (
                                      <p className="truncate text-[11px] text-destructive">{run.error_message}</p>
                                    ) : null}
                                  </div>
                                  <div className="flex items-center gap-1">
                                    <Badge
                                      variant="outline"
                                      className={cn(
                                        "text-[10px] uppercase",
                                        run.status === "success" && "border-success/30 bg-success/10 text-success",
                                        run.status === "failed" && "border-destructive/30 bg-destructive/10 text-destructive",
                                        !["success", "failed"].includes(run.status) && "border-border/70 bg-background/45 text-muted-foreground",
                                      )}
                                    >
                                      {run.status}
                                    </Badge>
                                    {["failed", "skipped", "canceled"].includes(run.status) ? (
                                      <Button
                                        type="button"
                                        variant="outline"
                                        size="sm"
                                        className="h-6 px-1.5 text-[10px]"
                                        onClick={() => retrySyncMutation.mutate(run.id)}
                                        disabled={retrySyncMutation.isPending}
                                      >
                                        {retrySyncMutation.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Redo2 className="h-3 w-3" />}
                                      </Button>
                                    ) : null}
                                  </div>
                                </div>
                              </div>
                            );
                          })}
                          {syncRunsQuery.isLoading ? <p className="text-xs text-muted-foreground">Carregando syncs...</p> : null}
                          {!syncRunsQuery.isLoading && syncRuns.length === 0 ? (
                            <div className="rounded-md border border-dashed border-border/70 bg-background/30 p-3 text-center">
                              <p className="text-xs text-muted-foreground">Nenhuma sincronizacao ainda</p>
                              <Button
                                type="button"
                                size="sm"
                                className="mt-2 h-7 gap-1.5 bg-accent text-xs text-accent-foreground hover:bg-accent/90"
                                disabled={!importConfigQuery.data?.enabled || triggerSyncMutation.isPending}
                                onClick={() => triggerSyncMutation.mutate()}
                              >
                                {triggerSyncMutation.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Zap className="h-3 w-3" />}
                                Sincronizar agora
                              </Button>
                            </div>
                          ) : null}
                        </div>
                      </div>
                    )}
                  </div>
                </TabsContent>
              </Tabs>
            </aside>
          </ResizablePanel>

          <ResizableHandle withHandle />

          <ResizablePanel id="dataset-main" order={2} defaultSize={selectedNode || selectedEdge ? 54 : 82} minSize={36} className="min-w-0 overflow-hidden">
            <ResizablePanelGroup direction="vertical" className="h-full min-h-0">
              <ResizablePanel id="dataset-main-canvas" order={1} defaultSize={70} minSize={50} maxSize={85} className="min-h-0 overflow-hidden">
                <section className="glass-panel h-full min-h-0 overflow-hidden rounded-none border-x-0 border-y-0 flex flex-col">
                  <div className="h-10 border-b border-border/45 px-3 flex items-center gap-2 text-caption text-muted-foreground">
                    <Badge variant="outline" className="h-5 rounded-md border-border/65 bg-background/35 px-1.5 text-caption font-medium">{nodes.length} tabelas</Badge>
                    <Badge variant="outline" className="h-5 rounded-md border-border/65 bg-background/35 px-1.5 text-caption font-medium">{edges.length} joins</Badge>
                    <Badge variant="outline" className="h-5 rounded-md border-border/65 bg-background/35 px-1.5 text-caption font-medium">{selectedColumnsCount} colunas</Badge>
                    <div className="flex-1" />
                    <span className="text-heading">Arraste recursos para o canvas</span>
                  </div>

                  <div className="min-h-0 flex-1 p-3">
                    <DatasetCanvasView
                      nodes={nodes}
                      edges={edges}
                      selectedNodeId={selectedNodeId}
                      selectedEdgeId={selectedEdgeId}
                      onSelectNode={(nodeId) => {
                        setSelectedNodeId(nodeId);
                        setSelectedEdgeId(null);
                        setNodeEditorTab("columns");
                      }}
                      onSelectEdge={(edgeId) => {
                        setSelectedEdgeId(edgeId);
                        setSelectedNodeId(null);
                      }}
                      onMoveNode={(nodeId, position) => {
                        setNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, position } : node)));
                        setIsDirty(true);
                      }}
                      onToggleField={(nodeId, fieldId, selected) => {
                        setNodes((prev) => prev.map((node) => {
                          if (node.id !== nodeId) return node;
                          return { ...node, data: { ...node.data, fields: node.data.fields.map((field) => (field.id === fieldId ? { ...field, selected } : field)) } };
                        }));
                        setIsDirty(true);
                      }}
                      onDropResource={(resource, position) => addResourceToCanvas(resource, position)}
                      onCreateJoin={onCreateJoinFromCanvas}
                      onBackgroundClick={() => {
                        setSelectedNodeId(null);
                        setSelectedEdgeId(null);
                      }}
                    />
                  </div>

                  <div className="px-3 pb-3">
                    <CanvasStatusBar
                      resources={nodes.length}
                      joins={edges.length}
                      columns={selectedColumnsCount}
                      computedColumns={computedColumns.length}
                      metrics={0}
                      dimensions={0}
                      dirty={isDirty}
                      hasValidationError={hasValidationError}
                      lastSavedAt={lastSavedAt}
                    />
                  </div>
                </section>
              </ResizablePanel>

              <ResizableHandle withHandle />

              <ResizablePanel id="dataset-main-preview" order={2} defaultSize={30} minSize={15} maxSize={50} className="min-h-0">
                <PreviewPanel
                  nodes={nodes}
                  edges={edges}
                  preview={preview}
                  isLoading={loadPreview.isPending}
                  errorMessage={previewError}
                />
              </ResizablePanel>
            </ResizablePanelGroup>
          </ResizablePanel>

          {selectedNode || selectedEdge ? (
            <>
              <ResizableHandle withHandle />
              <ResizablePanel id="dataset-right" order={3} defaultSize={28} minSize={22} maxSize={38} className="overflow-hidden">
                <aside className="glass-panel flex h-full min-h-0 flex-col rounded-none border-l border-border/60 overflow-hidden">
                  <div className="h-14 border-b border-border/50 px-3 flex items-center justify-between gap-2 shrink-0 bg-gradient-to-b from-[hsl(var(--card)/0.55)] to-[hsl(var(--card)/0.35)]">
                    <div className="min-w-0 flex items-center gap-2">
                      <span className="inline-flex h-7 w-7 items-center justify-center rounded-lg border border-accent/20 bg-accent/10 text-accent">
                        {selectedEdge ? <FunctionSquare className="h-4 w-4" /> : <Table2 className="h-4 w-4" />}
                      </span>
                      <div className="min-w-0">
                        <p className="text-heading">
                          {selectedEdge ? "Join selecionado" : "Tabela selecionada"}
                        </p>
                        {selectedNode ? (
                          <p className="text-caption truncate text-foreground">{selectedNode.data.label}</p>
                        ) : selectedEdge && selectedEdgeSourceNode && selectedEdgeTargetNode ? (
                          <p className="text-caption truncate text-foreground">{selectedEdgeSourceNode.data.label}{" -> "}{selectedEdgeTargetNode.data.label}</p>
                        ) : null}
                      </div>
                    </div>
                    {selectedNode ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        onClick={closeNodeEditorWithoutSave}
                      >
                        <X className="h-3.5 w-3.5" />
                      </Button>
                    ) : selectedEdge ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        onClick={closeEdgeEditorWithoutSave}
                      >
                        <X className="h-3.5 w-3.5" />
                      </Button>
                    ) : null}
                  </div>

                  <ScrollArea className="min-h-0 flex-1 px-3 py-3">
                    <div className="space-y-3">
                      {selectedNode ? (
                        <div className="space-y-2 rounded-xl border border-border/55 bg-background/35 p-3">
                          <p className="text-body font-medium text-foreground">{selectedNode.data.label}</p>
                          <p className="text-caption font-mono text-muted-foreground">{selectedNode.data.resourceId}</p>
                        </div>
                      ) : null}

                      {selectedEdge && selectedEdgeSourceNode && selectedEdgeTargetNode ? (
                        <div className="space-y-2">
                          <div className="space-y-1.5 rounded-xl border border-border/55 bg-background/35 p-3">
                            <p className="text-heading">Join atual</p>
                            <p className="text-[11px] font-mono text-foreground">{selectedEdgeSourceNode.data.label}</p>
                            <p className="text-[11px] font-mono text-muted-foreground">{"-> "}{selectedEdgeTargetNode.data.label}</p>
                          </div>
                          <JoinPropertiesPanel
                            joinType={edgeDraftJoinType || selectedEdge.data.joinType}
                            conditions={edgeDraftConditions || selectedEdge.data.conditions}
                            leftColumns={selectedEdgeSourceNode.data.fields.map((field) => field.name)}
                            rightColumns={selectedEdgeTargetNode.data.fields.map((field) => field.name)}
                            cardinality={joinDiagnostics.cardinality}
                            warnings={joinDiagnostics.warnings}
                            onChangeJoinType={(value) => {
                              setEdgeDraftJoinType(value);
                              setIsEdgeDraftDirty(true);
                            }}
                            onChangeCondition={(index, field, value) => {
                              setEdgeDraftConditions((prev) => {
                                const current = prev || selectedEdge.data.conditions.map((condition) => ({ ...condition }));
                                return current.map((condition, conditionIndex) => (conditionIndex === index ? { ...condition, [field]: value } : condition));
                              });
                              setIsEdgeDraftDirty(true);
                            }}
                            onAddCondition={() => {
                              setEdgeDraftConditions((prev) => [
                                ...(prev || selectedEdge.data.conditions.map((condition) => ({ ...condition }))),
                                { leftColumn: "", rightColumn: "" },
                              ]);
                              setIsEdgeDraftDirty(true);
                            }}
                            onRemoveCondition={(index) => {
                              setEdgeDraftConditions((prev) => {
                                const current = prev || selectedEdge.data.conditions.map((condition) => ({ ...condition }));
                                return current.filter((_, conditionIndex) => conditionIndex !== index);
                              });
                              setIsEdgeDraftDirty(true);
                            }}
                          />
                        </div>
                      ) : null}

                      {selectedNode ? (
                        <div className="space-y-2 rounded-xl border border-border/70 bg-card/45 p-3">
                          <Tabs value={nodeEditorTab} onValueChange={(value) => setNodeEditorTab(value as "columns" | "computed" | "filters" | "metrics" | "dimensions")}>
                            <TabsList className="w-full h-9 grid grid-cols-5 rounded-xl bg-background/40 p-1">
                              <TabsTrigger value="columns" className="text-caption rounded-lg"><Columns3 className="mr-1 h-3.5 w-3.5" />Colunas</TabsTrigger>
                              <TabsTrigger value="computed" className="text-caption rounded-lg"><Calculator className="mr-1 h-3.5 w-3.5" />Calc.</TabsTrigger>
                              <TabsTrigger value="filters" className="text-caption rounded-lg"><Filter className="mr-1 h-3.5 w-3.5" />Filtros</TabsTrigger>
                              <TabsTrigger value="metrics" className="text-caption rounded-lg"><Hash className="mr-1 h-3.5 w-3.5" />Metricas</TabsTrigger>
                              <TabsTrigger value="dimensions" className="text-caption rounded-lg"><Layers3 className="mr-1 h-3.5 w-3.5" />Dimensoes</TabsTrigger>
                            </TabsList>
                            <Separator className="my-2 bg-border/60" />

                            <TabsContent value="columns" className="mt-0 space-y-2">
                              {(nodeDraftFields || []).map((field, index) => (
                                <div
                                  key={`field-edit-${selectedNode.id}-${field.id}`}
                                  draggable
                                  onDragStart={() => setDraggingFieldId(field.id)}
                                  onDragOver={(event) => event.preventDefault()}
                                  onDrop={() => {
                                    if (!draggingFieldId || draggingFieldId === field.id) return;
                                    const from = (nodeDraftFields || []).findIndex((item) => item.id === draggingFieldId);
                                    const to = index;
                                    reorderFieldInDraft(from, to);
                                    setDraggingFieldId(null);
                                  }}
                                  onDragEnd={() => setDraggingFieldId(null)}
                                  className="rounded-md border border-border bg-background/40 p-2"
                                >
                                  <div className="flex items-center justify-between gap-2">
                                    <div className="min-w-0">
                                      <p className="truncate text-xs font-mono">{field.alias || field.name}</p>
                                      <p className="text-[10px] text-muted-foreground">{field.name}</p>
                                    </div>
                                    <div className="flex items-center gap-1">
                                      <Button type="button" variant="ghost" size="icon" className="h-6 w-6" onClick={() => updateDraftField(field.id, { selected: !field.selected })}>
                                        {field.selected ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
                                      </Button>
                                      <Button type="button" variant="ghost" size="icon" className="h-6 w-6" onClick={() => duplicateDraftField(field.id)}>
                                        <Copy className="h-3.5 w-3.5" />
                                      </Button>
                                      {removableDuplicateFieldIds.has(field.id) ? (
                                        <Button type="button" variant="ghost" size="icon" className="h-6 w-6 destructive-icon-btn" onClick={() => removeDraftField(field.id)}>
                                          <Trash2 className="h-3.5 w-3.5" />
                                        </Button>
                                      ) : null}
                                      <Button type="button" variant="ghost" size="icon" className="h-6 w-6" onClick={() => toggleExpandedField(field.id)}>
                                        {expandedDraftFieldIds.includes(field.id) ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                                      </Button>
                                    </div>
                                  </div>
                                  {expandedDraftFieldIds.includes(field.id) ? (
                                    <>
                                      <div className="mt-2 space-y-1">
                                        <Label className="text-[10px] text-muted-foreground">Alias de exibicao</Label>
                                        <Input
                                          value={field.alias || ""}
                                          onChange={(event) => updateDraftField(field.id, { alias: event.target.value })}
                                          className="h-7 text-[11px]"
                                          placeholder={`Ex: ${field.name}`}
                                        />
                                      </div>
                                      <div className="mt-2 grid grid-cols-2 gap-1.5">
                                        <div className="space-y-1">
                                          <Label className="text-[10px] text-muted-foreground">Tipo semantico</Label>
                                          <Select value={field.semanticType || inferFieldSemanticType(field.type)} onValueChange={(value) => updateDraftField(field.id, { semanticType: value as DatasetFieldSemanticType })}>
                                            <SelectTrigger className="h-7 text-[11px]"><SelectValue placeholder="Selecione o tipo" /></SelectTrigger>
                                            <SelectContent>
                                              <SelectItem value="text">text</SelectItem>
                                              <SelectItem value="numeric">numeric</SelectItem>
                                              <SelectItem value="temporal">temporal</SelectItem>
                                              <SelectItem value="boolean">boolean</SelectItem>
                                            </SelectContent>
                                          </Select>
                                        </div>
                                        <div className="space-y-1">
                                          <Label className="text-[10px] text-muted-foreground">Tipo SQL</Label>
                                          <Input value={field.type} onChange={(event) => updateDraftField(field.id, { type: event.target.value })} className="h-7 text-[11px]" placeholder="Ex: integer, varchar(255)" />
                                        </div>
                                        <div className="space-y-1">
                                          <Label className="text-[10px] text-muted-foreground">Prefixo padrao</Label>
                                          <Input value={field.prefix || ""} onChange={(event) => updateDraftField(field.id, { prefix: event.target.value || undefined })} className="h-7 text-[11px]" placeholder="Ex: R$" />
                                        </div>
                                        <div className="space-y-1">
                                          <Label className="text-[10px] text-muted-foreground">Sufixo padrao</Label>
                                          <Input value={field.suffix || ""} onChange={(event) => updateDraftField(field.id, { suffix: event.target.value || undefined })} className="h-7 text-[11px]" placeholder="Ex: %" />
                                        </div>
                                        <div className="col-span-2 space-y-1">
                                          <Label className="text-[10px] text-muted-foreground">Agregacao padrao</Label>
                                          <Select value={field.aggregation || "none"} onValueChange={(value) => updateDraftField(field.id, { aggregation: value as DatasetFieldAggregation })}>
                                            <SelectTrigger className="h-7 text-[11px]"><SelectValue placeholder="Selecione a agregacao" /></SelectTrigger>
                                            <SelectContent>
                                              <SelectItem value="none">None</SelectItem>
                                              <SelectItem value="sum">SUM</SelectItem>
                                              <SelectItem value="avg">AVG</SelectItem>
                                              <SelectItem value="count">COUNT</SelectItem>
                                              <SelectItem value="min">MIN</SelectItem>
                                              <SelectItem value="max">MAX</SelectItem>
                                              <SelectItem value="distinct_count">DISTINCT_COUNT</SelectItem>
                                            </SelectContent>
                                          </Select>
                                        </div>
                                      </div>
                                      <div className="mt-2 space-y-1">
                                        <Label className="text-[10px] text-muted-foreground">Descricao do campo</Label>
                                        <Textarea
                                          value={field.description || ""}
                                          onChange={(event) => updateDraftField(field.id, { description: event.target.value || undefined })}
                                          rows={2}
                                          className="text-[11px]"
                                          placeholder="Descreva o significado e uso deste campo."
                                        />
                                      </div>
                                    </>
                                  ) : null}
                                </div>
                              ))}
                            </TabsContent>

                            <TabsContent value="computed" className="mt-0 space-y-2">
                              {selectedNodeComputedColumns.length === 0 ? (
                                <button
                                  type="button"
                                  className="w-full rounded-lg border border-dashed border-border/70 bg-background/35 px-3 py-5 text-left transition hover:bg-muted/40"
                                  onClick={openAddComputedDialog}
                                >
                                  <p className="text-xs font-semibold">Adicionar coluna calculada</p>
                                  <p className="mt-1 text-[11px] text-muted-foreground">Defina uma expressao calculada por linha (row-level).</p>
                                </button>
                              ) : (
                                <Button type="button" size="sm" variant="outline" className="h-9 w-full justify-start text-caption rounded-xl" onClick={openAddComputedDialog}>
                                  <Plus className="mr-1.5 h-3.5 w-3.5" />
                                  Adicionar coluna calculada
                                </Button>
                              )}
                              {selectedNodeComputedColumns.map((column) => (
                                <div key={`computed-${column.alias}`} className="rounded-md border border-border/70 bg-background/40 p-2">
                                  <div className="flex items-center justify-between gap-2">
                                    <p className="text-xs font-semibold">{column.alias}</p>
                                    <div className="flex items-center gap-1">
                                      <Button
                                        type="button"
                                        size="icon"
                                        variant="ghost"
                                        className="h-6 w-6"
                                        onClick={() => openEditComputedDialog(column)}
                                        aria-label={`Editar coluna calculada ${column.alias}`}
                                        title="Editar coluna calculada"
                                      >
                                        <Pencil className="h-3.5 w-3.5" />
                                      </Button>
                                      <Button
                                        type="button"
                                        size="icon"
                                        variant="ghost"
                                        className="h-6 w-6 destructive-icon-btn"
                                        onClick={() => {
                                          setNodeDraftComputedColumns((prev) => (prev || []).filter((item) => item.alias !== column.alias));
                                          updateNodeDraftDirty();
                                        }}
                                      >
                                        <Trash2 className="h-3.5 w-3.5" />
                                      </Button>
                                    </div>
                                  </div>
                                  <p className="mt-1 text-[11px] font-mono text-muted-foreground">{JSON.stringify(column.expr)}</p>
                                </div>
                              ))}
                            </TabsContent>

                            <TabsContent value="filters" className="mt-0 space-y-2">
                              <div className="flex items-center justify-between gap-2">
                                <p className="text-[11px] text-muted-foreground">Filtros nativos aplicados direto no dataset.</p>
                                <Button
                                  type="button"
                                  size="sm"
                                  variant="outline"
                                  className="h-8 rounded-xl text-caption"
                                  onClick={addDatasetFilter}
                                  disabled={datasetFilterableColumns.length === 0}
                                >
                                  <Plus className="mr-1.5 h-3.5 w-3.5" />
                                  Filtro
                                </Button>
                              </div>
                              {datasetFilterableColumns.length === 0 ? (
                                <p className="rounded-md border border-border/60 bg-background/45 px-2 py-1.5 text-[11px] text-muted-foreground">
                                  Selecione colunas na aba Colunas para habilitar filtros nativos.
                                </p>
                              ) : null}
                              {(nodeDraftFilters || []).length === 0 ? (
                                <div className="rounded-md border border-dashed border-border/70 bg-background/30 px-3 py-4 text-center">
                                  <p className="text-xs text-muted-foreground">Nenhum filtro nativo configurado.</p>
                                </div>
                              ) : (
                                (nodeDraftFilters || []).map((filter, index) => {
                                  const semanticTypeByField = datasetFilterTypeByField.get(filter.field) || "text";
                                  const opUi = resolveDatasetFilterUiOperator(filter, semanticTypeByField);
                                  const isTemporalFilter = (
                                    semanticTypeByField === "temporal"
                                    || opUi === "__relative__"
                                  );
                                  const semanticType: DatasetFieldSemanticType = isTemporalFilter ? "temporal" : semanticTypeByField;
                                  const operatorOptions = semanticType === "temporal" ? DATASET_TEMPORAL_FILTER_OPERATORS : DATASET_FILTER_OPERATORS;
                                  const isNullOp = DATASET_FILTER_OPS_WITHOUT_VALUE.has(filter.op);
                                  const isListOp = DATASET_FILTER_OPS_WITH_LIST_VALUE.has(filter.op);
                                  const betweenValues = Array.isArray(filter.value) ? filter.value : ["", ""];
                                  const scalarValue = (
                                    Array.isArray(filter.value) || (typeof filter.value === "object" && filter.value !== null)
                                      ? ""
                                      : String(filter.value ?? "")
                                  );
                                  const listValue = Array.isArray(filter.value) ? filter.value.map((item) => String(item ?? "")).join(", ") : "";
                                  const relativePreset = (
                                    typeof filter.value === "object"
                                    && filter.value !== null
                                    && !Array.isArray(filter.value)
                                    && "relative" in (filter.value as Record<string, unknown>)
                                      ? String((filter.value as Record<string, unknown>).relative || "last_7_days")
                                      : "last_7_days"
                                  ) as RelativeDatePreset;
                                  const betweenRange: DateRange = {
                                    from: parseDateValue(betweenValues[0]),
                                    to: parseDateValue(betweenValues[1]),
                                  };
                                  const singleDate = parseDateValue(filter.value);

                                  return (
                                    <div key={`dataset-filter-${index}`} className="rounded-md border border-border/70 bg-background/40 p-2 space-y-2">
                                      <div className="flex items-center justify-between gap-2">
                                        <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Filtro {index + 1}</p>
                                        <div className="flex items-center gap-1">
                                          <Button
                                            type="button"
                                            variant="ghost"
                                            size="icon"
                                            className="h-6 w-6"
                                            onClick={addDatasetFilter}
                                          >
                                            <Plus className="h-3.5 w-3.5" />
                                          </Button>
                                          <Button
                                            type="button"
                                            variant="ghost"
                                            size="icon"
                                            className="h-6 w-6 destructive-icon-btn"
                                            onClick={() => removeDatasetFilter(index)}
                                          >
                                            <Trash2 className="h-3.5 w-3.5" />
                                          </Button>
                                        </div>
                                      </div>
                                      <div className="grid gap-1.5 md:grid-cols-2">
                                        <div className="space-y-1">
                                          <Label className="text-[10px] text-muted-foreground">Campo</Label>
                                          <Select
                                            value={filter.field || "__none__"}
                                            onValueChange={(value) => {
                                              if (value === "__none__") return;
                                              const currentOpUi = resolveDatasetFilterUiOperator(filter, semanticType);
                                              const nextSemanticType = datasetFilterTypeByField.get(value) || "text";
                                              const allowedOps = nextSemanticType === "temporal" ? DATASET_TEMPORAL_FILTER_OPERATORS : DATASET_FILTER_OPERATORS;
                                              const nextOpUi = allowedOps.some((item) => item.value === currentOpUi) ? currentOpUi : "eq";
                                              const payload = resolveDatasetFilterPayload(nextOpUi, value);
                                              updateDatasetFilter(index, (current) => ({
                                                ...current,
                                                field: value,
                                                op: payload.op,
                                                value: payload.value,
                                              }));
                                            }}
                                          >
                                            <SelectTrigger className="h-8 rounded-lg text-caption"><SelectValue placeholder="Selecione..." /></SelectTrigger>
                                            <SelectContent>
                                              <SelectItem value="__none__">Selecione...</SelectItem>
                                              {datasetFilterableColumns.map((column) => (
                                                <SelectItem key={`dataset-filter-col-${column.field}`} value={column.field}>
                                                  {column.field}
                                                </SelectItem>
                                              ))}
                                            </SelectContent>
                                          </Select>
                                        </div>
                                        <div className="space-y-1">
                                          <Label className="text-[10px] text-muted-foreground">Operador</Label>
                                          <Select
                                            value={opUi}
                                            onValueChange={(value) => {
                                              const payload = resolveDatasetFilterPayload(value, filter.field);
                                              updateDatasetFilter(index, (current) => ({
                                                ...current,
                                                op: payload.op,
                                                value: payload.value,
                                              }));
                                            }}
                                          >
                                            <SelectTrigger className="h-8 rounded-lg text-caption"><SelectValue /></SelectTrigger>
                                            <SelectContent>
                                              {operatorOptions.map((option) => (
                                                <SelectItem key={`dataset-filter-op-${option.value}`} value={option.value}>
                                                  {option.label}
                                                </SelectItem>
                                              ))}
                                            </SelectContent>
                                          </Select>
                                        </div>
                                      </div>
                                      {!isNullOp ? (
                                        <div className="space-y-1">
                                          <Label className="text-[10px] text-muted-foreground">Valor</Label>
                                          {semanticType === "temporal" && opUi === "__relative__" ? (
                                            <Select
                                              value={relativePreset}
                                              onValueChange={(value) => {
                                                updateDatasetFilter(index, (current) => ({
                                                  ...current,
                                                  op: "between",
                                                  value: { relative: value as RelativeDatePreset },
                                                }));
                                              }}
                                            >
                                              <SelectTrigger className="h-8 rounded-lg text-caption"><SelectValue /></SelectTrigger>
                                              <SelectContent>
                                                {DATASET_RELATIVE_DATE_OPTIONS.map((option) => (
                                                  <SelectItem key={`dataset-filter-relative-${option.value}`} value={option.value}>
                                                    {option.label}
                                                  </SelectItem>
                                                ))}
                                              </SelectContent>
                                            </Select>
                                          ) : semanticType === "temporal" && opUi === "between" ? (
                                            <Popover>
                                              <PopoverTrigger asChild>
                                                <Button
                                                  type="button"
                                                  variant="outline"
                                                  className={cn(
                                                    "h-8 w-full justify-start text-left text-caption font-normal rounded-lg",
                                                    (!betweenRange.from || !betweenRange.to) && "text-muted-foreground",
                                                  )}
                                                >
                                                  <CalendarIcon className="mr-2 h-3.5 w-3.5" />
                                                  {betweenRange.from && betweenRange.to
                                                    ? `${formatDateBR(betweenRange.from)} - ${formatDateBR(betweenRange.to)}`
                                                    : "Selecionar intervalo"}
                                                </Button>
                                              </PopoverTrigger>
                                              <PopoverContent className="w-auto p-0" align="start">
                                                <Calendar
                                                  mode="range"
                                                  selected={betweenRange}
                                                  onSelect={(range) => {
                                                    updateDatasetFilter(index, (current) => ({
                                                      ...current,
                                                      value: range?.from && range?.to ? [dateToApi(range.from), dateToApi(range.to)] : ["", ""],
                                                    }));
                                                  }}
                                                  numberOfMonths={2}
                                                />
                                              </PopoverContent>
                                            </Popover>
                                          ) : semanticType === "temporal" ? (
                                            <Popover>
                                              <PopoverTrigger asChild>
                                                <Button
                                                  type="button"
                                                  variant="outline"
                                                  className={cn(
                                                    "h-8 w-full justify-start text-left text-caption font-normal rounded-lg",
                                                    !singleDate && "text-muted-foreground",
                                                  )}
                                                >
                                                  <CalendarIcon className="mr-2 h-3.5 w-3.5" />
                                                  {singleDate ? formatDateBR(singleDate) : "Selecionar data"}
                                                </Button>
                                              </PopoverTrigger>
                                              <PopoverContent className="w-auto p-0" align="start">
                                                <Calendar
                                                  mode="single"
                                                  selected={singleDate}
                                                  onSelect={(value) => {
                                                    updateDatasetFilter(index, (current) => ({
                                                      ...current,
                                                      value: value ? dateToApi(value) : "",
                                                    }));
                                                  }}
                                                />
                                              </PopoverContent>
                                            </Popover>
                                          ) : isListOp ? (
                                            <Input
                                              value={listValue}
                                              onChange={(event) => {
                                                const values = event.target.value
                                                  .split(",")
                                                  .map((item) => coerceDatasetFilterValue(item, semanticType))
                                                  .filter((item) => !(typeof item === "string" && item.trim() === ""));
                                                updateDatasetFilter(index, (current) => ({ ...current, value: values }));
                                              }}
                                              className="h-8 rounded-lg text-caption font-mono"
                                              placeholder="valor_1, valor_2, valor_3"
                                            />
                                          ) : opUi === "between" ? (
                                            <div className="grid grid-cols-2 gap-1.5">
                                              <Input
                                                value={String(betweenValues[0] ?? "")}
                                                onChange={(event) => {
                                                  const start = coerceDatasetFilterValue(event.target.value, semanticType);
                                                  updateDatasetFilter(index, (current) => ({
                                                    ...current,
                                                    value: [start, Array.isArray(current.value) ? current.value[1] : ""],
                                                  }));
                                                }}
                                                className="h-8 rounded-lg text-caption font-mono"
                                                placeholder="Inicio"
                                              />
                                              <Input
                                                value={String(betweenValues[1] ?? "")}
                                                onChange={(event) => {
                                                  const end = coerceDatasetFilterValue(event.target.value, semanticType);
                                                  updateDatasetFilter(index, (current) => ({
                                                    ...current,
                                                    value: [Array.isArray(current.value) ? current.value[0] : "", end],
                                                  }));
                                                }}
                                                className="h-8 rounded-lg text-caption font-mono"
                                                placeholder="Fim"
                                              />
                                            </div>
                                          ) : semanticType === "boolean" ? (
                                            <Select
                                              value={String(Boolean(filter.value))}
                                              onValueChange={(value) => {
                                                updateDatasetFilter(index, (current) => ({
                                                  ...current,
                                                  value: value === "true",
                                                }));
                                              }}
                                            >
                                              <SelectTrigger className="h-8 rounded-lg text-caption"><SelectValue /></SelectTrigger>
                                              <SelectContent>
                                                <SelectItem value="true">true</SelectItem>
                                                <SelectItem value="false">false</SelectItem>
                                              </SelectContent>
                                            </Select>
                                          ) : (
                                            <Input
                                              value={scalarValue}
                                              onChange={(event) => {
                                                const nextValue = coerceDatasetFilterValue(event.target.value, semanticType);
                                                updateDatasetFilter(index, (current) => ({ ...current, value: nextValue }));
                                              }}
                                              className="h-8 rounded-lg text-caption font-mono"
                                              placeholder="Valor"
                                            />
                                          )}
                                        </div>
                                      ) : null}
                                    </div>
                                  );
                                })
                              )}
                            </TabsContent>

                            <TabsContent value="metrics" className="mt-0 space-y-2">
                              <Button type="button" size="sm" variant="outline" className="h-9 w-full justify-start text-caption rounded-xl" onClick={() => setIsMetricDialogOpen(true)} disabled={!datasetId}>
                                <Plus className="mr-1.5 h-3.5 w-3.5" />
                                Adicionar metrica
                              </Button>
                              {!datasetId ? (
                                <p className="text-xs text-muted-foreground">Salve o dataset para gerenciar metricas.</p>
                              ) : catalogMetrics.length === 0 ? (
                                <p className="text-xs text-muted-foreground">Nenhuma metrica cadastrada.</p>
                              ) : (
                                catalogMetrics.map((metric) => (
                                  <div key={`metric-${metric.id}`} className="rounded-md border border-border/70 bg-background/40 p-2">
                                    <div className="flex items-start justify-between gap-2">
                                      <div className="min-w-0 space-y-0.5">
                                        <p className="truncate text-xs font-semibold">{metricDraftById[metric.id]?.name || metric.name}</p>
                                        <p className="truncate text-[11px] font-mono text-muted-foreground">{metricDraftById[metric.id]?.formula || metric.formula}</p>
                                      </div>
                                      <div className="flex items-center gap-1">
                                        <Button
                                          type="button"
                                          variant="ghost"
                                          size="icon"
                                          className="h-6 w-6"
                                          disabled={!datasetId || createMetricMutation.isPending}
                                          onClick={() => {
                                            if (!datasetId) return;
                                            const draft = metricDraftById[metric.id] || { name: metric.name, formula: metric.formula, description: metric.description || "" };
                                            createMetricMutation.mutate({
                                              datasetId: Number(datasetId),
                                              name: `${draft.name}_copy`,
                                              formula: draft.formula,
                                              description: draft.description || undefined,
                                            });
                                          }}
                                        >
                                          <Copy className="h-3.5 w-3.5" />
                                        </Button>
                                        <Button
                                          type="button"
                                          variant="ghost"
                                          size="icon"
                                          className="h-6 w-6 destructive-icon-btn"
                                          disabled={deleteMetricMutation.isPending}
                                          onClick={() => deleteMetricMutation.mutate(metric.id)}
                                        >
                                          <Trash2 className="h-3.5 w-3.5" />
                                        </Button>
                                        <Button
                                          type="button"
                                          variant="ghost"
                                          size="icon"
                                          className="h-6 w-6"
                                          onClick={() => setExpandedMetricIds((prev) => (
                                            prev.includes(metric.id) ? prev.filter((id) => id !== metric.id) : [...prev, metric.id]
                                          ))}
                                        >
                                          {expandedMetricIds.includes(metric.id) ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                                        </Button>
                                      </div>
                                    </div>
                                    {expandedMetricIds.includes(metric.id) ? (
                                      <div className="mt-2 space-y-2 border-t border-border/60 pt-2">
                                        <div className="space-y-1">
                                          <Label className="text-[10px] text-muted-foreground">Nome da metrica</Label>
                                          <Input
                                            value={metricDraftById[metric.id]?.name || ""}
                                            onChange={(event) => setMetricDraftById((prev) => ({
                                              ...prev,
                                              [metric.id]: {
                                                name: event.target.value,
                                                formula: prev[metric.id]?.formula || metric.formula,
                                                description: prev[metric.id]?.description || metric.description || "",
                                              },
                                            }))}
                                            className="h-7 text-[11px]"
                                          />
                                        </div>
                                        <div className="space-y-1">
                                          <Label className="text-[10px] text-muted-foreground">Formula</Label>
                                          <Textarea
                                            value={metricDraftById[metric.id]?.formula || ""}
                                            onChange={(event) => setMetricDraftById((prev) => ({
                                              ...prev,
                                              [metric.id]: {
                                                name: prev[metric.id]?.name || metric.name,
                                                formula: event.target.value,
                                                description: prev[metric.id]?.description || metric.description || "",
                                              },
                                            }))}
                                            rows={3}
                                            className="text-[11px] font-mono"
                                          />
                                        </div>
                                        <div className="space-y-1">
                                          <Label className="text-[10px] text-muted-foreground">Descricao</Label>
                                          <Input
                                            value={metricDraftById[metric.id]?.description || ""}
                                            onChange={(event) => setMetricDraftById((prev) => ({
                                              ...prev,
                                              [metric.id]: {
                                                name: prev[metric.id]?.name || metric.name,
                                                formula: prev[metric.id]?.formula || metric.formula,
                                                description: event.target.value,
                                              },
                                            }))}
                                            className="h-7 text-[11px]"
                                            placeholder="Descricao da metrica"
                                          />
                                        </div>
                                        <Button
                                          type="button"
                                          size="sm"
                                          className="h-7 text-[11px]"
                                          disabled={updateMetricMutation.isPending}
                                          onClick={() => {
                                            const draft = metricDraftById[metric.id] || { name: metric.name, formula: metric.formula, description: metric.description || "" };
                                            updateMetricMutation.mutate({
                                              metricId: metric.id,
                                              name: draft.name.trim(),
                                              formula: draft.formula.trim(),
                                              description: draft.description.trim() || undefined,
                                            });
                                          }}
                                        >
                                          Salvar alteracoes
                                        </Button>
                                      </div>
                                    ) : null}
                                  </div>
                                ))
                              )}
                            </TabsContent>

                            <TabsContent value="dimensions" className="mt-0 space-y-2">
                              <Button type="button" size="sm" variant="outline" className="h-9 w-full justify-start text-caption rounded-xl" onClick={() => setIsDimensionDialogOpen(true)} disabled={!datasetId}>
                                <Plus className="mr-1.5 h-3.5 w-3.5" />
                                Adicionar dimensao
                              </Button>
                              {!datasetId ? (
                                <p className="text-xs text-muted-foreground">Salve o dataset para gerenciar dimensoes.</p>
                              ) : catalogDimensions.length === 0 ? (
                                <p className="text-xs text-muted-foreground">Nenhuma dimensao cadastrada.</p>
                              ) : (
                                catalogDimensions.map((dimension) => (
                                  <div key={`dimension-${dimension.id}`} className="rounded-md border border-border/70 bg-background/40 p-2">
                                    <div className="flex items-start justify-between gap-2">
                                      <div className="min-w-0 space-y-0.5">
                                        <p className="truncate text-xs font-semibold">{dimensionDraftById[dimension.id]?.name || dimension.name}</p>
                                        <p className="truncate text-[11px] text-muted-foreground">{dimensionDraftById[dimension.id]?.description || dimension.description || dimension.type}</p>
                                      </div>
                                      <div className="flex items-center gap-1">
                                        <Button
                                          type="button"
                                          variant="ghost"
                                          size="icon"
                                          className="h-6 w-6"
                                          disabled={!datasetId || createDimensionMutation.isPending}
                                          onClick={() => {
                                            if (!datasetId) return;
                                            const draft = dimensionDraftById[dimension.id] || { name: dimension.name, type: dimension.type, description: dimension.description || "" };
                                            createDimensionMutation.mutate({
                                              datasetId: Number(datasetId),
                                              name: `${draft.name}_copy`,
                                              column: "",
                                              description: draft.description || undefined,
                                            });
                                          }}
                                        >
                                          <Copy className="h-3.5 w-3.5" />
                                        </Button>
                                        <Button
                                          type="button"
                                          variant="ghost"
                                          size="icon"
                                          className="h-6 w-6 destructive-icon-btn"
                                          disabled={deleteDimensionMutation.isPending}
                                          onClick={() => deleteDimensionMutation.mutate(dimension.id)}
                                        >
                                          <Trash2 className="h-3.5 w-3.5" />
                                        </Button>
                                        <Button
                                          type="button"
                                          variant="ghost"
                                          size="icon"
                                          className="h-6 w-6"
                                          onClick={() => setExpandedDimensionIds((prev) => (
                                            prev.includes(dimension.id) ? prev.filter((id) => id !== dimension.id) : [...prev, dimension.id]
                                          ))}
                                        >
                                          {expandedDimensionIds.includes(dimension.id) ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                                        </Button>
                                      </div>
                                    </div>
                                    {expandedDimensionIds.includes(dimension.id) ? (
                                      <div className="mt-2 space-y-2 border-t border-border/60 pt-2">
                                        <div className="space-y-1">
                                          <Label className="text-[10px] text-muted-foreground">Nome da dimensao</Label>
                                          <Input
                                            value={dimensionDraftById[dimension.id]?.name || ""}
                                            onChange={(event) => setDimensionDraftById((prev) => ({
                                              ...prev,
                                              [dimension.id]: {
                                                name: event.target.value,
                                                type: prev[dimension.id]?.type || dimension.type,
                                                description: prev[dimension.id]?.description || dimension.description || "",
                                              },
                                            }))}
                                            className="h-7 text-[11px]"
                                          />
                                        </div>
                                        <div className="space-y-1">
                                          <Label className="text-[10px] text-muted-foreground">Tipo</Label>
                                          <Select
                                            value={dimensionDraftById[dimension.id]?.type || dimension.type}
                                            onValueChange={(value) => setDimensionDraftById((prev) => ({
                                              ...prev,
                                              [dimension.id]: {
                                                name: prev[dimension.id]?.name || dimension.name,
                                                type: value as "categorical" | "temporal" | "relational",
                                                description: prev[dimension.id]?.description || dimension.description || "",
                                              },
                                            }))}
                                          >
                                            <SelectTrigger className="h-7 text-[11px]"><SelectValue /></SelectTrigger>
                                            <SelectContent>
                                              <SelectItem value="categorical">categorical</SelectItem>
                                              <SelectItem value="temporal">temporal</SelectItem>
                                              <SelectItem value="relational">relational</SelectItem>
                                            </SelectContent>
                                          </Select>
                                        </div>
                                        <div className="space-y-1">
                                          <Label className="text-[10px] text-muted-foreground">Descricao</Label>
                                          <Input
                                            value={dimensionDraftById[dimension.id]?.description || ""}
                                            onChange={(event) => setDimensionDraftById((prev) => ({
                                              ...prev,
                                              [dimension.id]: {
                                                name: prev[dimension.id]?.name || dimension.name,
                                                type: prev[dimension.id]?.type || dimension.type,
                                                description: event.target.value,
                                              },
                                            }))}
                                            className="h-7 text-[11px]"
                                          />
                                        </div>
                                        <Button
                                          type="button"
                                          size="sm"
                                          className="h-7 text-[11px]"
                                          disabled={updateDimensionMutation.isPending}
                                          onClick={() => {
                                            const draft = dimensionDraftById[dimension.id] || { name: dimension.name, type: dimension.type, description: dimension.description || "" };
                                            updateDimensionMutation.mutate({
                                              dimensionId: dimension.id,
                                              name: draft.name.trim(),
                                              type: draft.type,
                                              description: draft.description.trim() || undefined,
                                            });
                                          }}
                                        >
                                          Salvar alteracoes
                                        </Button>
                                      </div>
                                    ) : null}
                                  </div>
                                ))
                              )}
                            </TabsContent>
                          </Tabs>
                        </div>
                      ) : null}

                    </div>
                  </ScrollArea>
                  {selectedNode ? (
                    <div className="border-t border-border/60 bg-card/70 px-3 py-2">
                      <div className="flex items-center gap-2">
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-9 w-9 shrink-0 destructive-icon-btn"
                          onClick={() => {
                            setNodes((prev) => prev.filter((item) => item.id !== selectedNode.id));
                            setEdges((prev) => prev.filter((edge) => edge.source !== selectedNode.id && edge.target !== selectedNode.id));
                            setSelectedNodeId(null);
                            setSelectedEdgeId(null);
                            setNodeDraftFields(null);
                            setNodeDraftComputedColumns(null);
                            setNodeDraftFilters(null);
                            setEdgeDraftJoinType(null);
                            setEdgeDraftConditions(null);
                            setIsEdgeDraftDirty(false);
                            setExpandedDraftFieldIds([]);
                            setIsNodeDraftDirty(false);
                            setIsDirty(true);
                          }}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                        <Button type="button" className="flex-1 h-9 text-caption rounded-xl bg-accent text-accent-foreground hover:bg-accent/90" onClick={applyNodeEditorDraft} disabled={!nodeDraftFields || !isNodeDraftDirty}>
                          Concluir
                        </Button>
                      </div>
                    </div>
                  ) : selectedEdge ? (
                    <div className="border-t border-border/60 bg-card/70 px-3 py-2">
                      <div className="flex items-center gap-2">
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-9 w-9 shrink-0 destructive-icon-btn"
                          onClick={() => {
                            setEdges((prev) => prev.filter((edge) => edge.id !== selectedEdge.id));
                            setSelectedEdgeId(null);
                            setSelectedNodeId(null);
                            setEdgeDraftJoinType(null);
                            setEdgeDraftConditions(null);
                            setIsEdgeDraftDirty(false);
                            setIsDirty(true);
                          }}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                        <Button
                          type="button"
                          className="flex-1 h-9 text-caption rounded-xl bg-accent text-accent-foreground hover:bg-accent/90"
                          onClick={applyEdgeEditorDraft}
                          disabled={!edgeDraftJoinType || !edgeDraftConditions || edgeDraftConditions.length === 0 || !isEdgeDraftDirty}
                        >
                          Concluir
                        </Button>
                      </div>
                    </div>
                  ) : null}
                </aside>
              </ResizablePanel>
            </>
          ) : null}
        </ResizablePanelGroup>
      </div>

      <Dialog
        open={isComputedDialogOpen}
        onOpenChange={(open) => {
          setIsComputedDialogOpen(open);
          if (!open) setEditingComputedAlias(null);
        }}
      >
        <DialogContent className="flex max-h-[92vh] w-[96vw] max-w-[72rem] flex-col gap-0 overflow-hidden p-0">
          <DialogHeader className="shrink-0 border-b border-border/60 px-4 py-3 sm:px-6">
            <DialogTitle>{editingComputedAlias ? "Editar coluna calculada" : "Nova coluna calculada"}</DialogTitle>
            <DialogDescription>Crie uma expressao por linha (row-level), sem agregacoes verticais.</DialogDescription>
          </DialogHeader>
          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3 sm:px-6">
            <div className="grid min-h-0 gap-3 md:grid-cols-[1.4fr_0.9fr]">
              <div className="min-h-0 min-w-0 space-y-3 pr-1">
              <div className="space-y-1">
                <Label className="text-xs">Alias da coluna</Label>
                <Input
                  value={newComputedAlias}
                  onChange={(event) => setNewComputedAlias(event.target.value)}
                  placeholder="Ex: ticket_medio"
                />
                {!newComputedAliasError && newComputedAlias.trim() && newComputedAliasNormalized !== newComputedAlias.trim() ? (
                  <p className="text-[11px] text-muted-foreground">Sugestao: <span className="font-mono">{newComputedAliasNormalized}</span></p>
                ) : null}
                {newComputedAliasError ? <p className="text-[11px] text-destructive">{newComputedAliasError}</p> : null}
              </div>

              <div className="space-y-1">
                <Label className="text-xs">Expressao por linha</Label>
                <p className="text-[11px] text-muted-foreground">
                  Use colunas da linha atual, operadores e funcoes compativeis. Agregacoes nao sao permitidas.
                </p>
                <Textarea
                  ref={computedFormulaRef}
                  value={newComputedFormula}
                  onFocus={() => setIsComputedEditorFocused(true)}
                  onBlur={() => setTimeout(() => setIsComputedEditorFocused(false), 120)}
                  onClick={(event) => setComputedEditorCursor((event.target as HTMLTextAreaElement).selectionStart || 0)}
                  onKeyUp={(event) => setComputedEditorCursor((event.target as HTMLTextAreaElement).selectionStart || 0)}
                  onKeyDown={(event) => {
                    const hasSuggestions = computedExpressionSuggestions.suggestions.length > 0;
                    if (hasSuggestions && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
                      event.preventDefault();
                      setComputedEditorSuggestionIndex((prev) => {
                        const max = computedExpressionSuggestions.suggestions.length - 1;
                        if (event.key === "ArrowDown") return prev >= max ? 0 : prev + 1;
                        return prev <= 0 ? max : prev - 1;
                      });
                      return;
                    }
                    if (hasSuggestions && (event.key === "Enter" || event.key === "Tab") && computedSelectedSuggestion) {
                      event.preventDefault();
                      insertComputedSuggestion(computedSelectedSuggestion.label, computedSelectedSuggestion.kind);
                    }
                  }}
                  onChange={(event) => {
                    setNewComputedFormula(event.target.value);
                    setComputedEditorCursor(event.target.selectionStart || 0);
                  }}
                  rows={6}
                  className="min-h-[120px] max-h-[260px] font-mono text-xs leading-5"
                  placeholder={"Ex: receita - custo\nEx: valor * 0.15\nEx: case when status = 'ativo' then 1 else 0 end"}
                />
                {isComputedEditorFocused && computedExpressionSuggestions.suggestions.length > 0 ? (
                  <div className="rounded-md border border-border/60 bg-background/70 p-1">
                    <div className="max-h-40 overflow-auto">
                      {computedExpressionSuggestions.suggestions.map((item, index) => (
                        <button
                          key={`computed-suggestion-${item.kind}-${item.label}-${index}`}
                          type="button"
                          className={cn(
                            "flex w-full items-center justify-between rounded-sm px-2 py-1 text-left text-[11px] transition-colors",
                            index === computedEditorSuggestionIndex ? "bg-accent text-accent-foreground" : "hover:bg-muted/40",
                          )}
                          onMouseDown={(event) => {
                            event.preventDefault();
                            insertComputedSuggestion(item.label, item.kind);
                          }}
                        >
                          <span className="min-w-0 truncate pr-2 font-mono">{item.label}</span>
                          <span className="shrink-0 text-muted-foreground">{item.detail}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                ) : null}
                {computedExpressionValidation.errors.length > 0 ? (
                  <div className="space-y-1">
                    {computedExpressionValidation.errors.map((error, index) => (
                      <p key={`computed-expression-error-${index}`} className="text-[11px] text-destructive">{error}</p>
                    ))}
                  </div>
                ) : (
                  <p className="text-[11px] text-success">Expressao valida.</p>
                )}
                <div className="rounded-md border border-border/60 bg-background/45 px-2 py-1.5 text-[11px] text-muted-foreground">
                  <p>Tipo inferido: <span className="font-medium">{computedInferredType}</span></p>
                  {computedTypeConflict ? (
                    <p className="mt-1 text-warning">O tipo inferido difere do tipo semantico selecionado.</p>
                  ) : null}
                </div>
              </div>

              <div className="space-y-1">
                <Label className="text-xs">Tipo semantico (opcional)</Label>
                <Select value={newComputedType} onValueChange={(value) => setNewComputedType(value as DatasetFieldSemanticType)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="numeric">numeric</SelectItem>
                    <SelectItem value="text">text</SelectItem>
                    <SelectItem value="temporal">temporal</SelectItem>
                    <SelectItem value="boolean">boolean</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1 rounded-md border border-border/60 bg-background/45 p-2">
                <p className="text-[11px] font-medium">Colunas usadas</p>
                {computedExpressionValidation.references.length > 0 ? (
                  <p className="text-[11px] text-muted-foreground">{computedExpressionValidation.references.join(", ")}</p>
                ) : (
                  <p className="text-[11px] text-muted-foreground">Nenhuma coluna detectada ainda.</p>
                )}
              </div>

              <div className="space-y-1 rounded-md border border-border/60 bg-background/45 p-2">
                <p className="text-[11px] font-medium">Preview da coluna calculada</p>
                {computedPreviewRows.length > 0 ? (
                  <div className="space-y-1">
                    {computedPreviewRows.map((item) => (
                      <div key={item.id} className="rounded border border-border/50 bg-background/40 px-2 py-1 text-[11px]">
                        {item.error ? (
                          <span className="text-destructive">{item.error}</span>
                        ) : (
                          <div className="flex items-center justify-between gap-2">
                            <span className="truncate text-muted-foreground">
                              {computedExpressionValidation.references.slice(0, 2).map((ref) => `${ref}: ${String(item.row[ref] ?? "null")}`).join(" . ")}
                            </span>
                            <span className="max-w-[48%] break-all text-right font-mono text-foreground">{String(item.result ?? "null")}</span>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-[11px] text-muted-foreground">Salve ou atualize o preview para visualizar linhas de exemplo.</p>
                )}
              </div>
            </div>

              <div className="min-h-0 min-w-0 space-y-3 pr-1">
              <div className="rounded-md border border-border/60 bg-background/45 p-2">
                <p className="text-[11px] font-medium">Colunas disponiveis</p>
                <Input
                  className="mt-2 h-7 text-[11px]"
                  placeholder="Buscar coluna"
                  value={computedColumnSearch}
                  onChange={(event) => setComputedColumnSearch(event.target.value)}
                />
                <ScrollArea className="mt-2 h-40 pr-2">
                  <div className="space-y-1">
                    {computedAvailableColumns
                      .filter((item) => item.name.toLowerCase().includes(computedColumnSearch.trim().toLowerCase()))
                      .map((item) => (
                        <button
                          key={`computed-column-option-${item.name}`}
                          type="button"
                          className="flex w-full items-center justify-between rounded-sm border border-border/50 bg-background/30 px-2 py-1 text-left text-[11px] hover:bg-muted/40"
                          onClick={() => insertComputedSuggestion(item.name, "column")}
                        >
                          <span className="min-w-0 truncate pr-2 font-mono">{item.name}</span>
                          <span className="shrink-0 text-muted-foreground">{item.type}</span>
                        </button>
                      ))}
                  </div>
                </ScrollArea>
              </div>

              <div className="rounded-md border border-border/60 bg-background/45 p-2">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-[11px] font-medium">Funcoes suportadas</p>
                  <Badge variant="outline" className="text-[10px]">row-level</Badge>
                </div>
                <Input
                  className="mt-2 h-7 text-[11px]"
                  placeholder="Buscar funcao"
                  value={computedFunctionSearch}
                  onChange={(event) => setComputedFunctionSearch(event.target.value)}
                />
                <ScrollArea className="mt-2 h-40 pr-2">
                  <div className="space-y-2">
                    {Object.entries(computedExpressionCatalog.allowed_functions || {}).map(([category, names]) => (
                      <div key={`computed-function-group-${category}`} className="space-y-1">
                        <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{category.replace(/_/g, " ")}</p>
                        {(names || [])
                          .filter((name) => name.toLowerCase().includes(computedFunctionSearch.trim().toLowerCase()))
                          .map((name) => (
                            <button
                              key={`computed-function-item-${category}-${name}`}
                              type="button"
                              className="flex w-full items-center justify-between rounded-sm border border-border/50 bg-background/30 px-2 py-1 text-left text-[11px] hover:bg-muted/40"
                              onClick={() => {
                                if (name.toLowerCase() === "case when") {
                                  const snippet = "case when  then  else  end";
                                  const next = `${newComputedFormula}${newComputedFormula.trim() ? " " : ""}${snippet}`;
                                  setNewComputedFormula(next);
                                  setComputedEditorCursor(next.length);
                                  return;
                                }
                                insertComputedSuggestion(name, "function");
                              }}
                            >
                              <span className="min-w-0 truncate pr-2 font-mono">{name}</span>
                              <span className="shrink-0 text-muted-foreground">funcao</span>
                            </button>
                          ))}
                      </div>
                    ))}
                  </div>
                </ScrollArea>
              </div>

              <div className="rounded-md border border-border/60 bg-background/45 p-2">
                <p className="text-[11px] font-medium">Ajuda rapida</p>
                <div className="mt-2 space-y-1">
                  {computedExpressionCatalog.examples.map((example, index) => (
                    <button
                      key={`computed-example-${index}`}
                      type="button"
                      className="block w-full break-all rounded-sm border border-border/50 bg-background/30 px-2 py-1 text-left font-mono text-[11px] hover:bg-muted/40"
                      onClick={() => {
                        setNewComputedFormula(example);
                        setComputedEditorCursor(example.length);
                        requestAnimationFrame(() => {
                          if (!computedFormulaRef.current) return;
                          computedFormulaRef.current.focus();
                          computedFormulaRef.current.setSelectionRange(example.length, example.length);
                        });
                      }}
                    >
                      {example}
                    </button>
                  ))}
                </div>
                <p className="mt-2 text-[11px] text-muted-foreground">
                  Funcoes bloqueadas: {computedExpressionCatalog.forbidden_aggregations.join(", ")}.
                </p>
                <p className="mt-1 text-[11px] text-muted-foreground">
                  {ROW_LEVEL_AGGREGATION_ERROR}
                </p>
              </div>
              </div>
            </div>
          </div>
          <DialogFooter className="shrink-0 border-t border-border/60 px-4 py-3 sm:px-6">
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setIsComputedDialogOpen(false);
                setEditingComputedAlias(null);
              }}
            >
              Cancelar
            </Button>
            <Button type="button" onClick={addComputedColumnFromEditor} disabled={!computedCanSubmit}>
              {editingComputedAlias ? "Salvar alteracoes" : "Adicionar"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={isMetricDialogOpen} onOpenChange={setIsMetricDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Nova metrica</DialogTitle>
            <DialogDescription>Cadastre uma metrica no catalogo do dataset.</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label className="text-xs">Nome</Label>
            <Input value={newMetricName} onChange={(event) => setNewMetricName(event.target.value)} placeholder="Ex: Receita Total" />
            <Label className="text-xs">Formula</Label>
            <Textarea value={newMetricFormula} onChange={(event) => setNewMetricFormula(event.target.value)} rows={4} className="font-mono text-xs" placeholder="sum(valor_pago)" />
            <Label className="text-xs">Descricao</Label>
            <Input value={newMetricDescription} onChange={(event) => setNewMetricDescription(event.target.value)} placeholder="Descricao da metrica" />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setIsMetricDialogOpen(false)}>Cancelar</Button>
            <Button
              type="button"
              disabled={!datasetId || !newMetricName.trim() || !newMetricFormula.trim() || createMetricMutation.isPending}
              onClick={() => {
                if (!datasetId || !newMetricName.trim() || !newMetricFormula.trim()) return;
                createMetricMutation.mutate({
                  datasetId: Number(datasetId),
                  name: newMetricName.trim(),
                  formula: newMetricFormula.trim(),
                  description: newMetricDescription.trim() || undefined,
                }, {
                  onSuccess: () => {
                    setIsMetricDialogOpen(false);
                    setNewMetricName("");
                    setNewMetricFormula("");
                    setNewMetricDescription("");
                  },
                });
              }}
            >
              Adicionar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={isDimensionDialogOpen} onOpenChange={setIsDimensionDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Nova dimensao</DialogTitle>
            <DialogDescription>Cadastre uma dimensao no catalogo do dataset.</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label className="text-xs">Nome</Label>
            <Input value={newDimensionName} onChange={(event) => setNewDimensionName(event.target.value)} placeholder="Ex: Cliente" />
            <Label className="text-xs">Coluna base</Label>
            <Select value={newDimensionColumn || "__none__"} onValueChange={(value) => setNewDimensionColumn(value === "__none__" ? "" : value)}>
              <SelectTrigger><SelectValue placeholder="Selecione a coluna" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">Selecione...</SelectItem>
                {dimensionColumnOptions.map((option) => (
                  <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Label className="text-xs">Descricao</Label>
            <Input value={newDimensionDescription} onChange={(event) => setNewDimensionDescription(event.target.value)} placeholder="Descricao da dimensao" />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setIsDimensionDialogOpen(false)}>Cancelar</Button>
            <Button
              type="button"
              disabled={!datasetId || !newDimensionName.trim() || !newDimensionColumn.trim() || createDimensionMutation.isPending}
              onClick={() => {
                if (!datasetId || !newDimensionName.trim() || !newDimensionColumn.trim()) return;
                createDimensionMutation.mutate({
                  datasetId: Number(datasetId),
                  name: newDimensionName.trim(),
                  column: newDimensionColumn.trim(),
                  description: newDimensionDescription.trim() || undefined,
                }, {
                  onSuccess: () => {
                    setIsDimensionDialogOpen(false);
                    setNewDimensionName("");
                    setNewDimensionColumn("");
                    setNewDimensionDescription("");
                  },
                });
              }}
            >
              Adicionar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default DatasetCanvas;

