import { memo, useEffect, useMemo, useRef, useState, type ElementType, type ReactNode } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Hash, Columns3, Filter, ArrowUpDown, Trash2, ChevronUp, ChevronDown, Plus,
  SlidersHorizontal, Palette, BarChart3, LineChart, PieChart, Table2, Type,
  Square, RectangleVertical, RectangleHorizontal, CalendarIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { Separator } from "@/components/ui/separator";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Calendar } from "@/components/ui/calendar";
import { FilterRuleRow } from "@/components/builder/FilterRuleRow";
import { cn } from "@/lib/utils";
import type { DashboardWidget, SectionColumns, WidgetFilter, WidgetWidth } from "@/types/dashboard";
import type { View } from "@/types";

interface WidgetConfigPanelProps {
  widget: DashboardWidget | null;
  dashboardWidgets?: DashboardWidget[];
  view?: View;
  datasetId?: number;
  categoricalValueHints?: Record<string, { values: string[]; truncated: boolean }>;
  categoricalDropdownThreshold?: number;
  sectionColumns?: SectionColumns;
  open: boolean;
  onClose: () => void;
  onSave: (widget: DashboardWidget) => Promise<void> | void;
  onDelete: () => void;
}

const numOps = ["sum", "avg", "min", "max"];
const countLikeOps = ["count", "distinct_count"];
const relativeDateOptions = [
  { value: "today", label: "Hoje" },
  { value: "yesterday", label: "Ontem" },
  { value: "last_7_days", label: "Ultimos 7 dias" },
  { value: "last_30_days", label: "Ultimos 30 dias" },
  { value: "this_year", label: "Este ano" },
  { value: "this_month", label: "Este mes" },
  { value: "last_month", label: "Mes passado" },
] as const;
const widgetPalettePreview: Record<"default" | "warm" | "cool" | "mono" | "vivid", string[]> = {
  default: ["#8B7AF2", "#F28A5A", "#4DAA6B", "#4B9DEB", "#E16BA8"],
  warm: ["#ef4444", "#f97316", "#eab308", "#f59e0b", "#dc2626"],
  cool: ["#3b82f6", "#06b6d4", "#8b5cf6", "#6366f1", "#0ea5e9"],
  mono: ["#111827", "#374151", "#4b5563", "#6b7280", "#9ca3af"],
  vivid: ["#ec4899", "#8b5cf6", "#06b6d4", "#10b981", "#f59e0b"],
};
const widgetPaletteLabel: Record<"default" | "warm" | "cool" | "mono" | "vivid", string> = {
  default: "Padrão",
  warm: "Quente",
  cool: "Fria",
  mono: "Monocromática",
  vivid: "Vibrante",
};
const exactValueFilterOps = new Set<WidgetFilter["op"]>(["eq", "neq", "gt", "lt", "gte", "lte"]);
const dateToYmd = (date: Date): string => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};
const parseYmdDate = (value: unknown): Date | undefined => {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const parsed = new Date(`${value}T00:00:00`);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
};
const formatDateBR = (date: Date) =>
  new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" }).format(date);
const normalizeSemanticColumnType = (rawType: string): "numeric" | "temporal" | "text" | "boolean" => {
  const value = (rawType || "").toLowerCase();
  if (value === "numeric" || value === "temporal" || value === "text" || value === "boolean") {
    return value;
  }
  if (["int", "numeric", "decimal", "real", "double", "float", "money"].some((token) => value.includes(token))) {
    return "numeric";
  }
  if (["date", "time", "timestamp"].some((token) => value.includes(token))) {
    return "temporal";
  }
  if (value.includes("bool")) {
    return "boolean";
  }
  return "text";
};
const aggLabelMap = {
  count: "CONTAGEM",
  distinct_count: "CONTAGEM ÚNICA",
  sum: "SOMA",
  avg: "MÉDIA",
  max: "MÁXIMO",
  min: "MÍNIMO",
} as const;
const dreRowTypeMeta = {
  result: {
    label: "Total (N1)",
    containerClass: "border-l-4 border-l-foreground/60 bg-background",
    titleClass: "font-semibold",
    indentClass: "",
  },
  deduction: {
    label: "Conta Dedura (N2)",
    containerClass: "border-l-4 border-l-amber-300/70 bg-amber-50/20",
    titleClass: "font-normal",
    indentClass: "",
  },
  detail: {
    label: "Conta Analitica (N3)",
    containerClass: "border-l-4 border-l-muted-foreground/30 bg-muted/20",
    titleClass: "font-normal text-muted-foreground",
    indentClass: "pl-4",
  },
} as const;

const widgetTypeIcon = {
  kpi: Hash,
  line: LineChart,
  bar: BarChart3,
  column: BarChart3,
  donut: PieChart,
  table: Table2,
  text: Type,
  dre: Columns3,
} as const;

const secondaryGhostIconButtonClass = "h-8 w-8 text-muted-foreground hover:bg-muted/70 hover:text-foreground";
const destructiveGhostIconButtonClass = "h-8 w-8 text-muted-foreground hover:bg-destructive/10 hover:text-destructive";
const dashedAddButtonClass = "w-full justify-center gap-2 rounded-xl border border-dashed border-border/60 bg-background/60 text-muted-foreground hover:border-foreground/30 hover:bg-muted/50 hover:text-foreground h-9";

const resolveInheritedDreImpact = (
  rows: Array<{ row_type: "result" | "deduction" | "detail"; impact?: "add" | "subtract" }>,
  index: number,
): "add" | "subtract" => {
  const current = rows[index];
  if (!current) return "add";
  if (current.row_type === "deduction") return current.impact || "subtract";
  if (current.row_type === "result") return "add";
  for (let previous = index - 1; previous >= 0; previous -= 1) {
    if (rows[previous]?.row_type === "deduction") {
      return rows[previous]?.impact || "subtract";
    }
  }
  return "add";
};

const buildTemporalDimensionValue = (column: string, granularity: "month" | "week" | "weekday" | "hour"): string =>
  `__time_${granularity}__:${column}`;

const parseTemporalDimensionValue = (value: string): { granularity: "month" | "week" | "weekday" | "hour"; column: string } | null => {
  if (value.startsWith("__time_month__:")) {
    const column = value.slice("__time_month__:".length).trim();
    return column ? { granularity: "month", column } : null;
  }
  if (value.startsWith("__time_week__:")) {
    const column = value.slice("__time_week__:".length).trim();
    return column ? { granularity: "week", column } : null;
  }
  if (value.startsWith("__time_weekday__:")) {
    const column = value.slice("__time_weekday__:".length).trim();
    return column ? { granularity: "weekday", column } : null;
  }
  if (value.startsWith("__time_hour__:")) {
    const column = value.slice("__time_hour__:".length).trim();
    return column ? { granularity: "hour", column } : null;
  }
  return null;
};

const extractKpiFormulaRefs = (formula: string): string[] => {
  const matches = formula.match(/\b[A-Za-z_][A-Za-z0-9_]*\b/g) || [];
  const fnNames = new Set(["COUNT", "DISTINCT", "SUM", "AVG", "MAX", "MIN"]);
  const refs: string[] = [];
  for (const token of matches) {
    if (!fnNames.has(String(token).toUpperCase())) refs.push(String(token));
  }
  return [...new Set(refs)];
};

const isValidFormulaIdentifier = (value: string): boolean => /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);

const normalizeKpiDependencyWidgetId = (value: unknown): number | string | undefined => {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value;
  }
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (/^\d+$/.test(trimmed)) {
    const numeric = Number(trimmed);
    if (Number.isFinite(numeric) && numeric > 0) return numeric;
  }
  return trimmed;
};

const normalizeKpiDependencies = (
  deps: Array<{ source_type?: "widget" | "column"; widget_id?: number | string; column?: string; alias?: string }> = [],
): Array<{ source_type: "widget" | "column"; widget_id?: number | string; column?: string; alias: string }> =>
  deps
    .map((item, index) => {
      const alias = (item.alias || "").trim() || `kpi_${index}`;
      const column = (item.column || "").trim();
      const widgetId = normalizeKpiDependencyWidgetId(item.widget_id);
      const hasValidWidgetId = widgetId !== undefined;
      const inferredSource: "widget" | "column" = item.source_type === "column"
        ? "column"
        : item.source_type === "widget"
          ? "widget"
          : (column ? "column" : "widget");
      const sourceType: "widget" | "column" = inferredSource === "widget" && !hasValidWidgetId && column
        ? "column"
        : inferredSource;

      return sourceType === "column"
        ? {
            source_type: "column" as const,
            column: column || undefined,
            alias,
          }
        : {
            source_type: "widget" as const,
            widget_id: widgetId,
            alias,
          };
    })
    .filter((item) => (item.source_type === "column" ? !!item.column : normalizeKpiDependencyWidgetId(item.widget_id) !== undefined));

const resolveDrePercentBaseRowIndex = (
  rows: Array<{ row_type: "result" | "deduction" | "detail" }>,
  current?: number,
): number | undefined => {
  if (typeof current === "number" && current >= 0 && current < rows.length && rows[current]?.row_type === "result") {
    return current;
  }
  const firstResultIndex = rows.findIndex((row) => row.row_type === "result");
  return firstResultIndex >= 0 ? firstResultIndex : undefined;
};

const DreTitleInput = memo(({
  value,
  className,
  onCommit,
}: {
  value: string;
  className?: string;
  onCommit: (value: string) => void;
}) => {
  const [localValue, setLocalValue] = useState(value);

  useEffect(() => {
    setLocalValue(value);
  }, [value]);

  return (
    <Input
      className={className}
      value={localValue}
      placeholder="Titulo da conta"
      onChange={(e) => setLocalValue(e.target.value)}
      onBlur={() => {
        if (localValue !== value) onCommit(localValue);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          (e.currentTarget as HTMLInputElement).blur();
        }
      }}
    />
  );
});
DreTitleInput.displayName = "DreTitleInput";

const Section = ({
  title,
  icon: Icon,
  children,
  defaultOpen = true,
  badge,
}: {
  title: string;
  icon: ElementType;
  children: ReactNode;
  defaultOpen?: boolean;
  badge?: string | number;
}) => {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border-b border-border/50 last:border-b-0">
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        className="group flex w-full items-center justify-between px-1 py-3 text-left rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        aria-expanded={open}
      >
        <span className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-foreground">
          <Icon className="h-3.5 w-3.5 text-muted-foreground" />
          {title}
          {badge !== undefined && (
            <span className="ml-1 inline-flex items-center justify-center h-4 min-w-[16px] px-1 rounded-full bg-accent/15 text-accent text-[10px] font-bold">
              {badge}
            </span>
          )}
        </span>
        <ChevronDown className={`h-3.5 w-3.5 text-muted-foreground transition-transform duration-200 ${open ? "rotate-0" : "-rotate-90"}`} />
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: [0.25, 0.1, 0.25, 1] as const }}
            className="overflow-hidden"
          >
            <div className="pb-4 space-y-3">{children}</div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

const DataBlock = ({
  title,
  caption,
  badge,
  children,
}: {
  title: string;
  caption?: string;
  badge?: string | number;
  children: ReactNode;
}) => (
  <div className="rounded-lg border border-border/60 bg-background/70 p-3 space-y-2.5">
    <div className="flex items-start justify-between gap-2">
      <div className="min-w-0">
        <p className="text-heading font-semibold text-foreground truncate">{title}</p>
        {caption && <p className="text-caption text-muted-foreground mt-0.5">{caption}</p>}
      </div>
      {badge !== undefined && (
        <span className="inline-flex h-5 min-w-[20px] items-center justify-center rounded-full bg-muted px-1.5 text-caption font-semibold text-muted-foreground">
          {badge}
        </span>
      )}
    </div>
    {children}
  </div>
);

const LayoutOptionPicker = ({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: Array<{ value: string; label: string; icon: ElementType }>;
  onChange: (value: string) => void;
}) => (
  <div className="space-y-1.5 min-w-0">
    <Label className="text-[11px] text-muted-foreground font-medium">{label}</Label>
    <div className="flex gap-1 min-w-0">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          onClick={() => onChange(option.value)}
          className={`min-w-0 flex-1 flex items-center justify-center gap-1 h-7 rounded-md px-1 text-[10px] font-medium transition-all ${
            value === option.value
              ? "bg-accent text-accent-foreground shadow-sm ring-1 ring-accent/30"
              : "bg-muted/40 text-muted-foreground hover:bg-muted hover:text-foreground"
          }`}
          aria-pressed={value === option.value}
          aria-label={`${label}: ${option.label}`}
        >
          <option.icon className="h-2.5 w-2.5 shrink-0" />
          {option.label}
        </button>
      ))}
    </div>
  </div>
);

export const WidgetConfigPanel = ({
  widget,
  dashboardWidgets = [],
  view,
  datasetId: _datasetId,
  categoricalValueHints = {},
  categoricalDropdownThreshold = 25,
  sectionColumns = 3,
  open,
  onClose,
  onSave,
  onDelete,
}: WidgetConfigPanelProps) => {
  const [draft, setDraft] = useState<DashboardWidget | null>(widget);
  const [errors, setErrors] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [activeConfigTab, setActiveConfigTab] = useState<"dados" | "aparencia">("dados");
  const [filterJoin, setFilterJoin] = useState<"AND" | "OR">("AND");
  const formulaTextareaRef = useRef<HTMLInputElement | null>(null);
  const [formulaCaret, setFormulaCaret] = useState<number>(0);

  useEffect(() => {
    setDraft(widget);
    setErrors([]);
    setActiveConfigTab("dados");
    setFilterJoin("AND");
  }, [widget]);

  const columns = view?.columns || [];
  const numericColumns = useMemo(
    () => columns.filter((column) => normalizeSemanticColumnType(column.type) === "numeric"),
    [columns],
  );
  const temporalColumns = useMemo(
    () => columns.filter((column) => normalizeSemanticColumnType(column.type) === "temporal"),
    [columns],
  );
  const categoricalColumns = useMemo(
    () => columns.filter((column) => {
      const normalized = normalizeSemanticColumnType(column.type);
      return normalized === "text" || normalized === "boolean";
    }),
    [columns],
  );
  const columnTypeByName = useMemo(
    () => Object.fromEntries(columns.map((column) => [column.name, normalizeSemanticColumnType(column.type)])),
    [columns],
  );
  const categoricalDimensionOptions = useMemo(
    () => categoricalColumns.map((column) => ({ value: column.name, label: column.name })),
    [categoricalColumns],
  );
  const temporalDimensionOptions = useMemo(
    () => temporalColumns.flatMap((column) => ([
      {
        value: buildTemporalDimensionValue(column.name, "month"),
        label: `${column.name} (mes)`,
      },
      {
        value: buildTemporalDimensionValue(column.name, "week"),
        label: `${column.name} (semana)`,
      },
      {
        value: buildTemporalDimensionValue(column.name, "weekday"),
        label: `${column.name} (dia da semana)`,
      },
      {
        value: buildTemporalDimensionValue(column.name, "hour"),
        label: `${column.name} (hora do dia)`,
      },
    ])),
    [temporalColumns],
  );
  const selectedTableColumns = draft?.config.columns || [];
  const allTableColumnsSelected = columns.length > 0 && selectedTableColumns.length === columns.length;
  const orderedTableColumns = useMemo(() => {
    const selected = columns
      .filter((column) => selectedTableColumns.includes(column.name))
      .sort((a, b) => selectedTableColumns.indexOf(a.name) - selectedTableColumns.indexOf(b.name));
    const unselected = columns.filter((column) => !selectedTableColumns.includes(column.name));
    return [...selected, ...unselected];
  }, [columns, selectedTableColumns]);

  const update = (patch: Partial<DashboardWidget>) => {
    if (!draft) return;
    setDraft({ ...draft, ...patch });
  };

  const validate = (target: DashboardWidget): string[] => {
    const messages: string[] = [];
    const config = target.config;

    if (config.widget_type === "kpi") {
      const isDerivedKpi = config.kpi_type === "derived";
      const baseMetric = config.metrics[0] || (config.composite_metric
        ? { op: config.composite_metric.inner_agg, column: config.composite_metric.value_column }
        : undefined);

      if (!baseMetric && !isDerivedKpi) {
        messages.push("KPI requer exatamente 1 metrica.");
      } else if (baseMetric && baseMetric.op && numOps.includes(baseMetric.op) && (!baseMetric.column || !numericColumns.some((column) => column.name === baseMetric.column))) {
        messages.push("KPI com sum/avg/min/max requer coluna numérica.");
      }

      if (isDerivedKpi) {
        if (config.composite_metric) messages.push("KPI derivada não suporta métrica composta neste MVP.");
        if (!config.formula?.trim()) messages.push("KPI derivada requer fórmula.");
        const refs = extractKpiFormulaRefs(config.formula || "");
        if (refs.length === 0) messages.push("Fórmula deve referenciar aliases das métricas base.");
        const normalizedDeps = normalizeKpiDependencies(config.kpi_dependencies || []);
        const aliases = normalizedDeps.map((item) => item.alias);
        const validRefs = new Set(aliases);
        if (refs.some((ref) => !validRefs.has(ref))) messages.push("Fórmula referencia métrica base inexistente.");
        if (aliases.some((alias) => !isValidFormulaIdentifier(alias))) messages.push("Alias das métricas base devem usar letras, números e _.");
        if (new Set(aliases).size !== aliases.length) messages.push("Aliases das métricas base não podem se repetir.");
        if (normalizedDeps.length < 1) messages.push("KPI derivada requer ao menos 1 base.");
      }

      if (config.composite_metric) {
        if (!config.composite_metric.time_column) messages.push("Metrica composta requer coluna de tempo.");
        if (
          config.composite_metric.time_column
          && !temporalColumns.some((column) => column.name === config.composite_metric?.time_column)
        ) {
          messages.push("A coluna de periodo deve ser temporal.");
        }
      }
    }

    if (config.widget_type === "line") {
      if (!config.time?.column) messages.push("Grafico de linha requer coluna temporal.");
      if (config.time?.column && !temporalColumns.some((column) => column.name === config.time?.column)) {
        messages.push("A coluna de tempo deve ser temporal.");
      }
      if (config.metrics.length < 1) messages.push("Grafico de linha requer ao menos 1 metrica.");
      if (config.metrics.length > 2) messages.push("Grafico de linha permite no maximo 2 metricas.");
      if (config.dimensions.length > 1) messages.push("Grafico de linha permite no maximo 1 legenda de serie.");
      if (config.dimensions[0] && !categoricalColumns.some((column) => column.name === config.dimensions[0])) {
        messages.push("A legenda de serie do grafico de linha precisa ser categorica.");
      }
      if ((config.line_data_labels_percent || 0) < 25 || (config.line_data_labels_percent || 0) > 100) {
        messages.push("Peso de sensibilidade deve ser entre 25 e 100.");
      }
      if (![3, 5, 7].includes(config.line_label_window || 3)) messages.push("Janela deve ser 3, 5 ou 7.");
      if ((config.line_label_min_gap || 0) < 1) messages.push("Distancia minima entre eventos deve ser >= 1.");
    }

    if (config.widget_type === "bar" || config.widget_type === "column" || config.widget_type === "donut") {
      if (config.dimensions.length !== 1) messages.push("Grafico categorico requer exatamente 1 dimensao.");
      const dimension = config.dimensions[0];
      if (dimension) {
        const temporalDimension = parseTemporalDimensionValue(dimension);
        if (temporalDimension && (config.widget_type === "bar" || config.widget_type === "column")) {
          if (!temporalColumns.some((column) => column.name === temporalDimension.column)) {
            messages.push("A dimensao temporal requer coluna de tempo valida.");
          }
        } else if (!categoricalColumns.some((column) => column.name === dimension)) {
          messages.push("A dimensao precisa ser categorica.");
        }
      }
      if (config.metrics.length !== 1) messages.push("Grafico categorico requer exatamente 1 metrica.");
    }

    if (config.widget_type === "table") {
      if (!config.columns || config.columns.length === 0) messages.push("Tabela requer ao menos 1 coluna.");
      if (config.columns?.some((column) => !columns.some((candidate) => candidate.name === column))) {
        messages.push("Tabela contem coluna invalida.");
      }
    }

    if (config.widget_type === "text") {
      if (!config.text_style?.content?.trim()) messages.push("Widget de texto requer conteudo.");
    }
    if (config.widget_type === "dre") {
      if (!config.dre_rows || config.dre_rows.length === 0) {
        messages.push("Widget DRE requer ao menos 1 linha.");
      } else {
        const baseRowIndex = resolveDrePercentBaseRowIndex(config.dre_rows, config.dre_percent_base_row_index);
        if (typeof baseRowIndex !== "number") messages.push("Widget DRE requer ao menos uma conta N1 para base de percentual.");
        config.dre_rows.forEach((row, index) => {
          if (!row.title.trim()) messages.push(`Linha ${index + 1}: título obrigatorio.`);
          if (!row.metrics || row.metrics.length === 0) {
            messages.push(`Linha ${index + 1}: requer ao menos 1 metrica.`);
            return;
          }
          row.metrics.forEach((metricItem) => {
            if (numOps.includes(metricItem.op) && (!metricItem.column || !numericColumns.some((column) => column.name === metricItem.column))) {
              messages.push(`Linha ${index + 1}: agregação ${metricItem.op} requer coluna numérica.`);
            }
            if (metricItem.op === "distinct_count" && !metricItem.column) {
              messages.push(`Linha ${index + 1}: distinct_count requer coluna.`);
            }
          });
        });
      }
    }

    return messages;
  };

  const handleSave = async () => {
    let normalizedDraft: DashboardWidget = { ...draft };
    if (draft.config.widget_type === "table") {
      normalizedDraft = {
        ...draft,
        config: {
          ...draft.config,
          limit: undefined,
          top_n: undefined,
          time: undefined,
        },
      };
    } else if (draft.config.widget_type === "bar" || draft.config.widget_type === "column" || draft.config.widget_type === "donut") {
      normalizedDraft = {
        ...draft,
        config: {
          ...draft.config,
          time: undefined,
          columns: undefined,
        },
      };
    } else if (draft.config.widget_type === "dre") {
      const baseRowIndex = resolveDrePercentBaseRowIndex(draft.config.dre_rows || [], draft.config.dre_percent_base_row_index);
      normalizedDraft = {
        ...draft,
        config: {
          ...draft.config,
          metrics: [],
          dimensions: [],
          time: undefined,
          columns: undefined,
          top_n: undefined,
          order_by: [],
          dre_percent_base_row_index: baseRowIndex,
        },
      };
    } else {
      normalizedDraft = {
        ...draft,
        config: {
          ...draft.config,
          top_n: undefined,
        },
      };
    }

    if (normalizedDraft.config.widget_type === "kpi") {
      const kpiType = normalizedDraft.config.kpi_type === "derived" ? "derived" : "atomic";
      const draftMetric = normalizedDraft.config.metrics[0]
        || (normalizedDraft.config.composite_metric
          ? {
              op: normalizedDraft.config.composite_metric.inner_agg,
              column: normalizedDraft.config.composite_metric.value_column,
            }
          : { op: "count" as const, column: undefined });

      if (normalizedDraft.config.composite_metric) {
        normalizedDraft = {
          ...normalizedDraft,
          config: {
            ...normalizedDraft.config,
            kpi_type: "atomic",
            formula: undefined,
            dependencies: [],
            metrics: [],
            kpi_show_trend: !!normalizedDraft.config.kpi_show_trend,
            composite_metric: {
              ...normalizedDraft.config.composite_metric,
              inner_agg: draftMetric.op,
              value_column: draftMetric.column,
            },
          },
        };
      } else {
        const normalizedFormula = normalizedDraft.config.formula?.trim();
        const dependencies = kpiType === "derived" && normalizedFormula ? extractKpiFormulaRefs(normalizedFormula) : [];
        normalizedDraft = {
          ...normalizedDraft,
          config: {
            ...normalizedDraft.config,
            kpi_type: kpiType,
            formula: kpiType === "derived" ? normalizedFormula : undefined,
            dependencies,
            kpi_dependencies: kpiType === "derived"
              ? normalizeKpiDependencies(normalizedDraft.config.kpi_dependencies || [])
              : [],
            kpi_show_trend: !!normalizedDraft.config.kpi_show_trend,
            kpi_decimals: Math.max(0, Math.min(8, Math.trunc(Number(normalizedDraft.config.kpi_decimals ?? 2)))),
            composite_metric: undefined,
            metrics: kpiType === "derived"
              ? []
              : [{ op: draftMetric.op, column: draftMetric.column }],
          },
        };
      }
    }

    if (normalizedDraft.config.widget_type === "line") {
      const normalizedMetrics = normalizedDraft.config.metrics.length > 0
        ? normalizedDraft.config.metrics
        : [{ op: "count" as const, column: undefined, line_y_axis: "left" as const }];
      normalizedDraft = {
        ...normalizedDraft,
        config: {
          ...normalizedDraft.config,
          metrics: normalizedMetrics.slice(0, 2).map((item, index) => ({
            ...item,
            line_y_axis: item.line_y_axis === "right" ? "right" : index === 0 ? "left" : "right",
          })),
          dimensions: normalizedDraft.config.dimensions.slice(0, 1),
          line_show_grid: !!normalizedDraft.config.line_show_grid,
          line_data_labels_percent: Math.max(25, Math.min(100, normalizedDraft.config.line_data_labels_percent || 60)),
          line_label_window: 3,
          line_label_min_gap: 2,
          line_label_mode: "both",
        },
      };
    }

    const nextErrors = validate(normalizedDraft);
    setErrors(nextErrors);
    if (nextErrors.length > 0) return;
    try {
      setSaving(true);
      await onSave(normalizedDraft);
      onClose();
    } finally {
      setSaving(false);
    }
  };

  if (!draft) return null;

  const metric = (
    draft.config.metrics[0]
    || (draft.config.widget_type === "kpi" && draft.config.composite_metric
      ? {
          op: draft.config.composite_metric.inner_agg,
          column: draft.config.composite_metric.value_column,
        }
      : undefined)
    || { op: "count" as const }
  );
  const size = draft.config.size || { width: 1 as const, height: 1 as const };
  const maxWidth = sectionColumns;
  const textStyle = draft.config.text_style || { content: "", font_size: 18, align: "left" as const };
  const compositeMetric = draft.config.widget_type === "kpi" ? draft.config.composite_metric : undefined;
  const compositeEnabled = draft.config.widget_type === "kpi" && !!draft.config.composite_metric;
  const derivedKpiEnabled = draft.config.widget_type === "kpi" && draft.config.kpi_type === "derived";
  const kpiMode = derivedKpiEnabled ? "derived" : compositeEnabled ? "composite" : "atomic";
  const kpiShowAsSelectValue = draft.config.kpi_show_as === "integer" ? "integer" : "number_2";
  const availableDashboardKpiWidgets = dashboardWidgets.filter((item) => item.id !== draft.id && item.config.widget_type === "kpi");
  const normalizedDerivedDeps = derivedKpiEnabled ? normalizeKpiDependencies(draft.config.kpi_dependencies || []) : [];
  const derivedMetricAliases = derivedKpiEnabled
    ? normalizedDerivedDeps.map((item) => item.alias)
    : [];
  const formulaText = draft.config.formula || "";
  const formulaCaretSafe = Math.max(0, Math.min(formulaCaret, formulaText.length));
  const formulaPrefixText = formulaText.slice(0, formulaCaretSafe);
  const formulaTokenMatch = formulaPrefixText.match(/([A-Za-z_][A-Za-z0-9_]*)$/);
  const formulaTokenPrefix = formulaTokenMatch?.[1] || "";
  const formulaAutocompleteSuggestions = derivedKpiEnabled && formulaTokenPrefix
    ? derivedMetricAliases.filter((alias, index, arr) => arr.indexOf(alias) === index && alias.startsWith(formulaTokenPrefix)).slice(0, 8)
    : [];
  const formulaBestSuggestion = (
    formulaCaretSafe === formulaText.length
      ? formulaAutocompleteSuggestions.find((alias) => alias !== formulaTokenPrefix)
      : undefined
  );
  const formulaInlineCompletionSuffix = formulaBestSuggestion && formulaTokenPrefix
    ? formulaBestSuggestion.slice(formulaTokenPrefix.length)
    : "";
  const periodLabelMap: Record<"day" | "week" | "month" | "hour" | "timestamp", string> = {
    day: "dia",
    week: "semana",
    month: "mes",
    hour: "hora",
    timestamp: "timestamp",
  };
  const compositeDescription = compositeMetric
    ? `${aggLabelMap[compositeMetric.outer_agg]} da ${aggLabelMap[metric.op]}(${metric.column || "*"}) por ${periodLabelMap[compositeMetric.granularity]}`
    : "";
  const categoricalWidgetDimensionOptions = draft.config.widget_type === "bar" || draft.config.widget_type === "column"
    ? [...categoricalDimensionOptions, ...temporalDimensionOptions]
    : categoricalDimensionOptions;
  const barDim = draft.config.dimensions[0] || "";
  const getColumnType = (name: string) => columnTypeByName[name] || "text";
  const getDefaultTableColumnFormat = (columnName: string): string => {
    const columnType = getColumnType(columnName);
    if (columnType === "numeric") return "number_2";
    if (columnType === "temporal") return "datetime";
    return "text";
  };
  const emptyFilter: WidgetFilter = { column: "", op: "eq", value: "" };
  const filterRows = draft.config.filters.length > 0 ? draft.config.filters : [emptyFilter];
  const metricsCount = draft.config.widget_type === "dre"
    ? (draft.config.dre_rows || []).reduce((acc, row) => acc + (row.metrics?.length || 0), 0)
    : (draft.config.metrics?.length || 0);
  const applyFilterAt = (index: number, nextFilter: WidgetFilter) => {
    if (draft.config.filters.length === 0) {
      update({ config: { ...draft.config, filters: [nextFilter] } });
      return;
    }
    update({
      config: {
        ...draft.config,
        filters: draft.config.filters.map((item, itemIndex) => (itemIndex === index ? nextFilter : item)),
      },
    });
  };
  const addFilterRow = (afterIndex: number) => {
    if (draft.config.filters.length === 0) {
      update({ config: { ...draft.config, filters: [emptyFilter, emptyFilter] } });
      return;
    }
    const nextFilters = [...draft.config.filters];
    nextFilters.splice(afterIndex + 1, 0, emptyFilter);
    update({ config: { ...draft.config, filters: nextFilters } });
  };
  const removeFilterRow = (index: number) => {
    if (draft.config.filters.length === 0) {
      update({ config: { ...draft.config, filters: [] } });
      return;
    }
    const nextFilters = draft.config.filters.filter((_, itemIndex) => itemIndex !== index);
    update({ config: { ...draft.config, filters: nextFilters } });
  };
  const dreRows = draft.config.dre_rows || [];
  const dreResultRowOptions = dreRows
    .map((row, index) => ({ row, index }))
    .filter((item) => item.row.row_type === "result");
  const effectiveDrePercentBaseRowIndex = resolveDrePercentBaseRowIndex(dreRows, draft.config.dre_percent_base_row_index);
  const insertFormulaAliasAtCursor = (alias: string) => {
    if (!derivedKpiEnabled) return;
    const currentFormula = draft.config.formula || "";
    const textarea = formulaTextareaRef.current;
    const start = textarea?.selectionStart ?? formulaCaretSafe;
    const end = textarea?.selectionEnd ?? formulaCaretSafe;
    const before = currentFormula.slice(0, start);
    const after = currentFormula.slice(end);
    const token = before.match(/([A-Za-z_][A-Za-z0-9_]*)$/);
    const replaceStart = token ? start - token[1].length : start;
    const nextFormula = `${currentFormula.slice(0, replaceStart)}${alias}${after}`;
    update({
      config: {
        ...draft.config,
        formula: nextFormula,
        dependencies: extractKpiFormulaRefs(nextFormula),
      },
    });
    const nextCaret = replaceStart + alias.length;
    setFormulaCaret(nextCaret);
    queueMicrotask(() => {
      if (formulaTextareaRef.current) {
        formulaTextareaRef.current.focus();
        formulaTextareaRef.current.setSelectionRange(nextCaret, nextCaret);
      }
    });
  };
  const handleKpiModeChange = (value: string) => {
    if (draft.config.widget_type !== "kpi") return;
    const nextMode = value === "derived" || value === "composite" ? value : "atomic";
    const existingMetrics = (draft.config.metrics || []).length > 0
      ? draft.config.metrics
      : [{ op: "count" as const, column: undefined }];
    const existingKpiDeps = (draft.config.kpi_dependencies || []).length > 0
      ? draft.config.kpi_dependencies
      : [];
    update({
      config: {
        ...draft.config,
        kpi_type: nextMode === "derived" ? "derived" : "atomic",
        composite_metric: nextMode === "composite"
          ? (draft.config.composite_metric || {
              type: "agg_over_time_bucket",
              inner_agg: existingMetrics[0]?.op || "count",
              outer_agg: "avg",
              value_column: existingMetrics[0]?.column,
              time_column: temporalColumns[0]?.name || "",
              granularity: "day",
            })
          : undefined,
        formula: nextMode === "derived" ? (draft.config.formula || "") : undefined,
        dependencies: nextMode === "derived"
          ? extractKpiFormulaRefs(draft.config.formula || "")
          : [],
        kpi_dependencies: nextMode === "derived" ? existingKpiDeps : [],
        metrics: nextMode === "derived" ? [] : [existingMetrics[0]],
      },
    });
  };
  const WidgetTypeIcon = widgetTypeIcon[draft.config.widget_type] || Hash;

  return (
    <Sheet open={open} onOpenChange={(value) => !value && onClose()}>
      <SheetContent className="w-[95vw] sm:w-[600px] sm:max-w-[600px] p-0 gap-0 flex flex-col">
        <div className="px-5 pt-5 pb-4 space-y-3 border-b border-border/50">
          <SheetHeader className="space-y-0.5">
            <div className="flex items-center gap-2">
              <div className="h-7 w-7 rounded-md bg-accent/10 flex items-center justify-center shrink-0">
                <WidgetTypeIcon className="h-3.5 w-3.5 text-accent" />
              </div>
              <div className="min-w-0">
                <SheetTitle className="text-sm font-bold tracking-tight truncate">
                  {draft.title || "Widget sem título"}
                  <span className="ml-1.5 text-[10px] font-normal text-muted-foreground uppercase">
                    {draft.config.widget_type}
                  </span>
                </SheetTitle>
                <SheetDescription className="text-[11px] text-muted-foreground truncate">
                  {view ? `${view.schema}.${view.name}` : "Tabela não encontrada"}
                </SheetDescription>
              </div>
            </div>
          </SheetHeader>
        </div>

        <div className="flex-1 overflow-y-auto px-5 pb-24">
          <div className="space-y-5 py-5">
          <div className="space-y-1.5">
            <Label className="text-xs font-semibold text-muted-foreground">Titulo</Label>
            <Input
              value={draft.title}
              onChange={(e) => update({ title: e.target.value })}
              placeholder="Nome do widget"
              className="h-8 text-sm bg-muted/30 border-border/50 focus:bg-background transition-colors"
            />
          </div>

          {draft.config.widget_type === "kpi" && (
            <div className="space-y-1">
              <Label className="text-xs font-semibold text-muted-foreground">Tipo de KPI</Label>
              <Select value={kpiMode} onValueChange={handleKpiModeChange}>
                <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="atomic">Padrão</SelectItem>
                  <SelectItem value="composite">Métrica composta</SelectItem>
                  <SelectItem value="derived">Fórmula avançada</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}

          <Tabs value={activeConfigTab} onValueChange={(value) => setActiveConfigTab(value as "dados" | "aparencia")}>
            <TabsList className="w-full h-8 bg-muted/30 p-0.5 rounded-lg">
              <TabsTrigger value="dados" className="flex-1 h-7 text-[11px] font-semibold rounded-md data-[state=active]:shadow-sm">
                <SlidersHorizontal className="h-3 w-3 mr-1.5" />
                Dados
              </TabsTrigger>
              <TabsTrigger value="aparencia" className="flex-1 h-7 text-[11px] font-semibold rounded-md data-[state=active]:shadow-sm">
                <Palette className="h-3 w-3 mr-1.5" />
                Aparência
              </TabsTrigger>
            </TabsList>
          </Tabs>

          {activeConfigTab === "dados" && (
            <div className="space-y-4 [&_label]:text-[11px] [&_input]:text-[11px] [&_textarea]:text-[11px] [&_[role=combobox]]:text-[11px] [&_.text-xs]:text-[11px]">
              <Section
                title="Modelagem"
                icon={Hash}
                badge={draft.config.widget_type === "text" ? "TXT" : draft.config.widget_type === "table" ? "TAB" : (draft.config.metrics?.length || 0) || undefined}
              >
                <p className="text-[11px] text-muted-foreground pb-1">Configure metricas, colunas e tempo.</p>
                <div className="space-y-2.5">

          {draft.config.widget_type === "text" && (
            <div className="space-y-2">
              <Label className="text-xs font-semibold text-muted-foreground">Texto</Label>
              <Textarea
                value={textStyle.content}
                onChange={(e) =>
                  update({
                    config: {
                      ...draft.config,
                      text_style: { ...textStyle, content: e.target.value },
                      metrics: [],
                      dimensions: [],
                      filters: [],
                      order_by: [],
                      columns: undefined,
                      time: undefined,
                    },
                  })}
                placeholder="Digite o texto"
                className="text-sm min-h-20"
              />
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1">
                  <Label className="text-[11px] text-muted-foreground">Fonte (px)</Label>
                  <Input
                    type="number"
                    min={12}
                    max={72}
                    className="h-8 text-xs"
                    value={textStyle.font_size}
                    onChange={(e) =>
                      update({
                        config: {
                          ...draft.config,
                          text_style: { ...textStyle, font_size: Math.max(12, Math.min(72, Number(e.target.value) || 18)) },
                        },
                      })}
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-[11px] text-muted-foreground">Alinhamento</Label>
                  <Select
                    value={textStyle.align}
                    onValueChange={(value) =>
                      update({
                        config: {
                          ...draft.config,
                          text_style: { ...textStyle, align: value as "left" | "center" | "right" },
                        },
                      })}
                  >
                    <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="left">Esquerda</SelectItem>
                      <SelectItem value="center">Centro</SelectItem>
                      <SelectItem value="right">Direita</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </div>
          )}

          {draft.config.widget_type !== "table"
            && draft.config.widget_type !== "text"
            && draft.config.widget_type !== "line"
            && draft.config.widget_type !== "dre"
            && !(draft.config.widget_type === "kpi" && draft.config.kpi_type === "derived") && (
            <DataBlock title="Métricas" caption="Escolha agregação e coluna de valor." badge={metricsCount}>
              <div className="flex items-center gap-2">
                <Select
                  value={metric.op}
                  onValueChange={(value) => {
                    const nextOp = value as typeof metric.op;
                    const isCountLikeOp = countLikeOps.includes(nextOp);
                    const nextColumn =
                      isCountLikeOp
                        ? metric.column
                        : metric.column && numericColumns.some((column) => column.name === metric.column)
                          ? metric.column
                          : numericColumns[0]?.name;
                    update({
                      config: {
                        ...draft.config,
                        metrics: [{ ...metric, op: nextOp, column: nextColumn }],
                        composite_metric: draft.config.widget_type === "kpi" && draft.config.composite_metric
                          ? {
                              ...draft.config.composite_metric,
                              inner_agg: nextOp,
                              value_column: nextColumn,
                            }
                          : draft.config.composite_metric,
                      },
                    });
                  }}
                >
                  <SelectTrigger className="w-[130px] h-8 text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="count">CONTAGEM</SelectItem>
                    <SelectItem value="distinct_count">CONTAGEM ÚNICA</SelectItem>
                    <SelectItem value="sum">SOMA</SelectItem>
                    <SelectItem value="avg">MÉDIA</SelectItem>
                    <SelectItem value="min">MÍNIMO</SelectItem>
                    <SelectItem value="max">MÁXIMO</SelectItem>
                  </SelectContent>
                </Select>
                <Select
                  value={metric.column || "__none__"}
                  onValueChange={(value) => {
                    const nextColumn = value === "__none__" ? undefined : value;
                    update({
                      config: {
                        ...draft.config,
                        metrics: [{ ...metric, column: nextColumn }],
                        composite_metric: draft.config.widget_type === "kpi" && draft.config.composite_metric
                          ? {
                              ...draft.config.composite_metric,
                              value_column: nextColumn,
                            }
                          : draft.config.composite_metric,
                      },
                    });
                  }}
                >
                  <SelectTrigger className="flex-1 h-8 text-xs"><SelectValue placeholder="Coluna" /></SelectTrigger>
                  <SelectContent>
                    {metric.op === "count" && <SelectItem value="__none__">count(*)</SelectItem>}
                    {(countLikeOps.includes(metric.op) ? columns : numericColumns).map((column) => (
                      <SelectItem key={column.name} value={column.name}>{column.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {(draft.config.widget_type === "bar" || draft.config.widget_type === "column" || draft.config.widget_type === "donut") && (
                  <Input
                    className="w-[170px] h-8 text-xs"
                    placeholder="Alias da metrica"
                    value={metric.alias || ""}
                    onChange={(e) =>
                      update({
                        config: {
                          ...draft.config,
                          metrics: [{ ...metric, alias: e.target.value || undefined }],
                        },
                      })}
                  />
                )}
                {draft.config.widget_type === "donut" && (
                  <Select
                    value={draft.config.donut_metric_display || "value"}
                    onValueChange={(value) =>
                      update({
                        config: {
                          ...draft.config,
                          donut_metric_display: value === "percent" ? "percent" : "value",
                        },
                      })}
                  >
                    <SelectTrigger className="w-[84px] h-8 text-xs"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="value">Valor</SelectItem>
                      <SelectItem value="percent">%</SelectItem>
                    </SelectContent>
                  </Select>
                )}
              </div>
            </DataBlock>
          )}

          {draft.config.widget_type === "kpi" && (
            <DataBlock title="Métricas" caption="Configure base, fórmula e exibição de KPI." badge={metricsCount}>
              {derivedKpiEnabled && (
                <div className="space-y-2 rounded-md border border-border p-2">
                  <Label className="text-xs font-semibold text-muted-foreground">KPIs base do dashboard</Label>
                  {(draft.config.kpi_dependencies || []).map((item, index) => (
                    <div key={`kpi-derived-base-${index}`} className="grid grid-cols-[280px_120px_minmax(0,1fr)_36px] items-center gap-2">
                      <Input
                        className="h-8 text-xs font-mono"
                        value={item.alias || ""}
                        placeholder={`kpi_${index}`}
                        onChange={(e) => {
                          const nextDeps = [...(draft.config.kpi_dependencies || [])];
                          nextDeps[index] = { ...item, alias: e.target.value };
                          update({ config: { ...draft.config, kpi_dependencies: nextDeps } });
                        }}
                      />
                      <Select
                        value={item.source_type === "column" ? "column" : "widget"}
                        onValueChange={(value) => {
                          const nextDeps = [...(draft.config.kpi_dependencies || [])];
                          nextDeps[index] = value === "column"
                            ? {
                                alias: item.alias,
                                source_type: "column",
                                column: item.column || columns[0]?.name,
                              }
                            : {
                                alias: item.alias,
                                source_type: "widget",
                                widget_id: normalizeKpiDependencyWidgetId(item.widget_id)
                                  ?? normalizeKpiDependencyWidgetId(availableDashboardKpiWidgets[0]?.id),
                              };
                          update({ config: { ...draft.config, kpi_dependencies: nextDeps } });
                        }}
                      >
                        <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="widget">KPI</SelectItem>
                          <SelectItem value="column">Coluna</SelectItem>
                        </SelectContent>
                      </Select>
                      <Select
                        value={item.source_type === "column" ? String(item.column || "") : String(item.widget_id || 0)}
                        onValueChange={(value) => {
                          const nextDeps = [...(draft.config.kpi_dependencies || [])];
                          if (item.source_type === "column") {
                            nextDeps[index] = { ...item, source_type: "column", column: value };
                          } else {
                            nextDeps[index] = {
                              ...item,
                              source_type: "widget",
                              widget_id: normalizeKpiDependencyWidgetId(value),
                            };
                          }
                          update({ config: { ...draft.config, kpi_dependencies: nextDeps } });
                        }}
                      >
                        <SelectTrigger className="h-8 text-xs min-w-0"><SelectValue placeholder="KPI base" /></SelectTrigger>
                        <SelectContent>
                          {item.source_type === "column"
                            ? columns.map((col) => (
                                <SelectItem key={`${col.name}:${index}`} value={col.name}>
                                  {col.name}
                                </SelectItem>
                              ))
                            : availableDashboardKpiWidgets.map((depWidget) => (
                                <SelectItem key={`${depWidget.id}-${index}`} value={String(depWidget.id)}>
                                  #{depWidget.id} · {depWidget.title || "KPI sem título"}
                                </SelectItem>
                              ))}
                        </SelectContent>
                      </Select>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className={destructiveGhostIconButtonClass}
                        aria-label={`Remover base de KPI ${index + 1}`}
                        disabled={(draft.config.kpi_dependencies || []).length <= 1}
                        onClick={() => {
                          const nextDeps = (draft.config.kpi_dependencies || []).filter((_, metricIndex) => metricIndex !== index);
                          update({ config: { ...draft.config, kpi_dependencies: nextDeps } });
                        }}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  ))}
                  <div className="flex items-center justify-between gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-8 border-dashed border-border/60 text-muted-foreground hover:border-foreground/30 hover:bg-muted/50 hover:text-foreground"
                      aria-label="Adicionar base de KPI"
                      onClick={() =>
                        update({
                          config: {
                            ...draft.config,
                            kpi_dependencies: [
                              ...(draft.config.kpi_dependencies || []),
                              (
                                availableDashboardKpiWidgets.length > 0
                                  ? {
                                      widget_id: normalizeKpiDependencyWidgetId(availableDashboardKpiWidgets[0]?.id),
                                      source_type: "widget" as const,
                                      alias: `kpi_${(draft.config.kpi_dependencies || []).length}`,
                                    }
                                  : {
                                      source_type: "column" as const,
                                      column: columns[0]?.name || "",
                                      alias: `col_${(draft.config.kpi_dependencies || []).length}`,
                                    }
                              ),
                            ],
                          },
                        })}
                      disabled={columns.length === 0}
                    >
                      <Plus className="h-3.5 w-3.5 mr-1" /> Adicionar base
                    </Button>
                    <span className="text-[11px] text-muted-foreground">Use aliases e funções na fórmula: `COUNT`, `DISTINCT`, `SUM`, `AVG`, `MAX`, `MIN`.</span>
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs font-semibold text-muted-foreground">Fórmula</Label>
                    <div className="relative">
                      <Input
                      ref={formulaTextareaRef}
                      className="relative z-10 h-8 text-xs font-mono pr-3"
                      placeholder=""
                      value={draft.config.formula || ""}
                      onSelect={(e) => setFormulaCaret((e.target as HTMLInputElement).selectionStart || 0)}
                      onKeyUp={(e) => setFormulaCaret((e.currentTarget as HTMLInputElement).selectionStart || 0)}
                      onClick={(e) => setFormulaCaret((e.currentTarget as HTMLInputElement).selectionStart || 0)}
                      onKeyDown={(e) => {
                        if (e.key === "Tab" && formulaBestSuggestion) {
                          e.preventDefault();
                          insertFormulaAliasAtCursor(formulaBestSuggestion);
                        }
                      }}
                      onChange={(e) =>
                        update({
                          config: {
                            ...draft.config,
                            formula: e.target.value,
                            dependencies: extractKpiFormulaRefs(e.target.value),
                          },
                        })}
                      />
                      {formulaBestSuggestion && formulaTokenPrefix && formulaCaretSafe === formulaText.length && (
                        <div className="pointer-events-none absolute inset-0 z-20 flex items-center px-3 text-xs font-mono">
                          <span className="whitespace-pre text-transparent">
                            {formulaPrefixText}
                          </span>
                          <span className="whitespace-pre text-muted-foreground/50">
                            {formulaInlineCompletionSuffix}
                          </span>
                        </div>
                      )}
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[11px] text-muted-foreground truncate">
                        {derivedMetricAliases.length > 0 ? `Aliases: ${derivedMetricAliases.join(", ")} • Ex.: SUM(receita), COUNT(clientes), DISTINCT(client_id)` : "Selecione bases e defina aliases."}
                      </span>
                      {formulaBestSuggestion && (
                        <span className="text-[10px] text-muted-foreground whitespace-nowrap">TAB completa: {formulaBestSuggestion}</span>
                      )}
                    </div>
                  </div>
                </div>
              )}

              {!derivedKpiEnabled && compositeEnabled && draft.config.composite_metric && (
                <div className="space-y-2 rounded-md border border-border p-2">
                  <div className="grid grid-cols-[1fr_auto_1fr] gap-2 items-center">
                    <Select
                      value={draft.config.composite_metric.outer_agg}
                      onValueChange={(value) =>
                        update({
                          config: {
                            ...draft.config,
                            composite_metric: {
                              ...draft.config.composite_metric!,
                              outer_agg: value as "count" | "sum" | "avg" | "min" | "max" | "distinct_count",
                            },
                          },
                        })}
                    >
                      <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="avg">MÉDIA</SelectItem>
                        <SelectItem value="sum">SOMA</SelectItem>
                        <SelectItem value="count">CONTAGEM</SelectItem>
                        <SelectItem value="distinct_count">CONTAGEM ÚNICA</SelectItem>
                        <SelectItem value="min">MÍNIMO</SelectItem>
                        <SelectItem value="max">MÁXIMO</SelectItem>
                      </SelectContent>
                    </Select>

                    <span className="text-xs text-muted-foreground">por</span>

                    <Select
                      value={draft.config.composite_metric.granularity}
                      onValueChange={(value) =>
                        update({
                          config: {
                            ...draft.config,
                            composite_metric: {
                            ...draft.config.composite_metric!,
                              granularity: value as "day" | "week" | "month" | "hour" | "timestamp",
                            },
                          },
                        })}
                    >
                      <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="day">Dia</SelectItem>
                        <SelectItem value="week">Semana</SelectItem>
                        <SelectItem value="month">Mes</SelectItem>
                        <SelectItem value="hour">Hora</SelectItem>
                        <SelectItem value="timestamp">Timestamp (min/seg)</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <Select
                    value={draft.config.composite_metric.time_column}
                    onValueChange={(value) =>
                      update({
                        config: {
                          ...draft.config,
                          composite_metric: {
                            ...draft.config.composite_metric!,
                            time_column: value,
                          },
                        },
                      })}
                  >
                    <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="Coluna de periodo" /></SelectTrigger>
                    <SelectContent>
                      {temporalColumns.map((column) => (
                        <SelectItem key={column.name} value={column.name}>{column.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>

                  <p className="text-[11px] text-muted-foreground">
                    {compositeDescription}
                  </p>
                </div>
              )}

              <div className="grid grid-cols-[minmax(0,220px)_1fr_1fr] gap-2 items-end">
                <div className="space-y-1">
                  <Label className="text-xs font-semibold text-muted-foreground">Mostrar como</Label>
                  <Select
                    value={kpiShowAsSelectValue}
                    onValueChange={(value) =>
                      update({
                        config: {
                          ...draft.config,
                          kpi_show_as: value as "number_2" | "integer",
                        },
                      })}
                  >
                    <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="number_2">Decimal</SelectItem>
                      <SelectItem value="integer">Inteiro</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label className="text-[11px] text-muted-foreground">Prefixo</Label>
                  <Input
                    className="h-8 text-xs"
                    value={draft.config.kpi_prefix || ""}
                    onChange={(e) => update({ config: { ...draft.config, kpi_prefix: e.target.value || undefined } })}
                    placeholder="Ex: R$"
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-[11px] text-muted-foreground">Sufixo</Label>
                  <Input
                    className="h-8 text-xs"
                    value={draft.config.kpi_suffix || ""}
                    onChange={(e) => update({ config: { ...draft.config, kpi_suffix: e.target.value || undefined } })}
                    placeholder="Ex: %"
                  />
                </div>
              </div>
              <div className="flex items-center justify-between rounded-md border border-border/60 bg-muted/20 px-3 py-2">
                <Label className="text-xs font-semibold text-muted-foreground">Comparar com periodo anterior</Label>
                <Switch
                  checked={!!draft.config.kpi_show_trend}
                  onCheckedChange={(checked) => update({ config: { ...draft.config, kpi_show_trend: checked } })}
                />
              </div>
            </DataBlock>
          )}

          {draft.config.widget_type === "line" && (
            <div className="space-y-2.5">
              <DataBlock title="Métricas" caption="Configure agregações e linhas do eixo Y." badge={draft.config.metrics.length}>
                {(draft.config.metrics.length > 0 ? draft.config.metrics : [{ op: "count" as const, column: undefined, line_y_axis: "left" as const }]).map((item, index) => (
                  <div key={`line-metric-${index}`} className="flex items-center gap-2">
                    <Select
                      value={item.op}
                      onValueChange={(value) => {
                        const nextOp = value as typeof item.op;
                        const isCountLikeOp = countLikeOps.includes(nextOp);
                        const nextColumn =
                          isCountLikeOp
                            ? item.column
                            : item.column && numericColumns.some((column) => column.name === item.column)
                              ? item.column
                              : numericColumns[0]?.name;
                        const nextMetrics = [...draft.config.metrics];
                        nextMetrics[index] = { ...item, op: nextOp, column: nextColumn, line_y_axis: item.line_y_axis || (index === 0 ? "left" : "right") };
                        update({ config: { ...draft.config, metrics: nextMetrics } });
                      }}
                    >
                      <SelectTrigger className="w-[140px] h-8 text-xs"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="count">CONTAGEM</SelectItem>
                        <SelectItem value="distinct_count">CONTAGEM ÚNICA</SelectItem>
                        <SelectItem value="sum">SOMA</SelectItem>
                        <SelectItem value="avg">MÉDIA</SelectItem>
                        <SelectItem value="min">MÍNIMO</SelectItem>
                        <SelectItem value="max">MÁXIMO</SelectItem>
                      </SelectContent>
                    </Select>
                  <Select
                    value={item.column || "__none__"}
                      onValueChange={(value) => {
                        const nextColumn = value === "__none__" ? undefined : value;
                        const nextMetrics = [...draft.config.metrics];
                        nextMetrics[index] = { ...item, column: nextColumn, line_y_axis: item.line_y_axis || (index === 0 ? "left" : "right") };
                        update({ config: { ...draft.config, metrics: nextMetrics } });
                      }}
                    >
                      <SelectTrigger className="flex-1 h-8 text-xs"><SelectValue placeholder="Coluna" /></SelectTrigger>
                      <SelectContent>
                        {item.op === "count" && <SelectItem value="__none__">count(*)</SelectItem>}
                        {(countLikeOps.includes(item.op) ? columns : numericColumns).map((column) => (
                          <SelectItem key={column.name} value={column.name}>{column.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Input
                      className="w-[170px] h-8 text-xs"
                      placeholder="Alias da metrica"
                      value={item.alias || ""}
                      onChange={(e) => {
                        const nextMetrics = [...draft.config.metrics];
                        nextMetrics[index] = { ...item, alias: e.target.value || undefined, line_y_axis: item.line_y_axis || (index === 0 ? "left" : "right") };
                        update({ config: { ...draft.config, metrics: nextMetrics } });
                      }}
                    />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className={destructiveGhostIconButtonClass}
                    aria-label={`Remover métrica ${index + 1}`}
                    disabled={draft.config.metrics.length <= 1}
                    onClick={() => {
                        const nextMetrics = draft.config.metrics.filter((_, metricIndex) => metricIndex !== index);
                        update({ config: { ...draft.config, metrics: nextMetrics } });
                      }}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                ))}
                <div className="flex justify-end">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className={secondaryGhostIconButtonClass}
                    aria-label="Adicionar métrica"
                    disabled={(draft.config.metrics.length || 0) >= 2}
                    onClick={() => {
                      const nextMetrics = [...draft.config.metrics];
                      nextMetrics.push({ op: "count", column: undefined, line_y_axis: nextMetrics.length === 0 ? "left" : "right" });
                      update({ config: { ...draft.config, metrics: nextMetrics } });
                    }}
                  >
                    <Plus className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </DataBlock>

              <DataBlock title="Dimensão temporal" caption="Selecione a coluna temporal e a granularidade.">
                <div className="flex items-center gap-2">
                <Select
                  value={draft.config.time?.column || ""}
                  onValueChange={(value) =>
                    update({
                      config: {
                        ...draft.config,
                        time: {
                          column: value,
                          granularity: draft.config.time?.granularity || "day",
                        },
                      },
                    })}
                >
                  <SelectTrigger className="flex-1 h-8 text-xs"><SelectValue placeholder="Coluna temporal" /></SelectTrigger>
                  <SelectContent>
                    {temporalColumns.map((column) => (
                      <SelectItem key={column.name} value={column.name}>{column.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select
                  value={draft.config.time?.granularity || "day"}
                  onValueChange={(value) =>
                    update({
                      config: {
                        ...draft.config,
                        time: {
                          column: draft.config.time?.column || "",
                          granularity: value as "day" | "week" | "month" | "hour" | "timestamp",
                        },
                      },
                    })}
                >
                  <SelectTrigger className="w-[170px] h-8 text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="day">Dia</SelectItem>
                    <SelectItem value="week">Semana</SelectItem>
                    <SelectItem value="month">Mes</SelectItem>
                    <SelectItem value="hour">Hora</SelectItem>
                    <SelectItem value="timestamp">Timestamp (min/seg)</SelectItem>
                  </SelectContent>
                </Select>
                </div>
              </DataBlock>

            </div>
          )}

          {draft.config.widget_type === "dre" && (
            <div className="space-y-2 rounded-md border border-border p-2">
              <div className="flex items-center justify-between">
                <Label className="text-xs font-semibold text-muted-foreground">Linhas do DRE</Label>
              </div>

              <div className="space-y-2">
                {dreRows.map((row, index) => (
                  <div key={`dre-row-${index}`} className="space-y-2">
                    <div
                      className={`space-y-2 rounded-md border border-border/60 p-2 transition-colors hover:bg-muted/35 hover:border-border ${dreRowTypeMeta[row.row_type || "detail"].containerClass}`}
                    >
                      <div className={`grid ${row.row_type === "deduction" ? "grid-cols-[1fr_188px_132px_32px]" : "grid-cols-[1fr_188px_32px]"} gap-2 items-center`}>
                        <DreTitleInput
                          className={`h-8 text-xs ${dreRowTypeMeta[row.row_type || "detail"].titleClass} ${dreRowTypeMeta[row.row_type || "detail"].indentClass}`}
                          value={row.title}
                          onCommit={(nextTitle) => {
                            const nextRows = [...dreRows];
                            nextRows[index] = { ...row, title: nextTitle };
                            update({ config: { ...draft.config, dre_rows: nextRows } });
                          }}
                        />
                        <Select
                          value={row.row_type}
                          onValueChange={(value) => {
                            const nextType = value as "result" | "deduction" | "detail";
                            const nextRows = [...dreRows];
                            const nextImpact = nextType === "result" ? "add" : (row.impact || (row.row_type === "deduction" ? "subtract" : "add"));
                            nextRows[index] = { ...row, row_type: nextType, impact: nextImpact };
                            update({ config: { ...draft.config, dre_rows: nextRows } });
                          }}
                        >
                          <SelectTrigger className="h-8 text-xs">
                            <SelectValue>
                              {((row.row_type && dreRowTypeMeta[row.row_type]) ? dreRowTypeMeta[row.row_type].label : dreRowTypeMeta.result.label).trim()}
                            </SelectValue>
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="result">{dreRowTypeMeta.result.label.trim()}</SelectItem>
                            <SelectItem value="deduction">{dreRowTypeMeta.deduction.label.trim()}</SelectItem>
                            <SelectItem value="detail">{dreRowTypeMeta.detail.label.trim()}</SelectItem>
                          </SelectContent>
                        </Select>
                        {row.row_type === "deduction" && (
                          <Select
                            value={row.impact || "subtract"}
                            onValueChange={(value) => {
                              const nextRows = [...dreRows];
                              nextRows[index] = { ...row, impact: value as "add" | "subtract" };
                              update({ config: { ...draft.config, dre_rows: nextRows } });
                            }}
                          >
                            <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                            <SelectContent>
                              <SelectItem value="add">Soma (+)</SelectItem>
                              <SelectItem value="subtract">Subtrai (-)</SelectItem>
                            </SelectContent>
                          </Select>
                        )}
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className={destructiveGhostIconButtonClass}
                          aria-label={`Remover conta DRE ${index + 1}`}
                          disabled={dreRows.length <= 1}
                          onClick={() => {
                            const nextRows = dreRows.filter((_, rowIndex) => rowIndex !== index);
                            update({ config: { ...draft.config, dre_rows: nextRows } });
                          }}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                      <div className={`text-[11px] text-muted-foreground ${dreRowTypeMeta[row.row_type || "detail"].indentClass}`}>
                        {row.row_type === "result"
                          ? "N1: conta principal de total."
                          : row.row_type === "deduction"
                            ? "N2: conta dedura do resultado, que pode ser de soma ou subtração."
                            : "N3: subitem da conta dedura."}
                      </div>

                      <div className={`space-y-1.5 ${dreRowTypeMeta[row.row_type || "detail"].indentClass}`}>
                        {(row.metrics || []).map((metricItem, metricIndex) => (
                          <div key={`dre-row-${index}-metric-${metricIndex}`} className="grid grid-cols-[140px_1fr_68px] gap-2">
                            <Select
                              value={metricItem.op}
                              onValueChange={(value) => {
                                const nextOp = value as typeof metricItem.op;
                                const isCountLikeOp = countLikeOps.includes(nextOp);
                                const nextColumn =
                                  isCountLikeOp
                                    ? metricItem.column
                                    : metricItem.column && numericColumns.some((column) => column.name === metricItem.column)
                                      ? metricItem.column
                                      : numericColumns[0]?.name;
                                const nextRows = [...dreRows];
                                const nextMetrics = [...(row.metrics || [])];
                                nextMetrics[metricIndex] = { ...metricItem, op: nextOp, column: nextColumn };
                                nextRows[index] = { ...row, metrics: nextMetrics };
                                update({ config: { ...draft.config, dre_rows: nextRows } });
                              }}
                            >
                              <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                              <SelectContent>
                                <SelectItem value="count">CONTAGEM</SelectItem>
                                <SelectItem value="distinct_count">CONTAGEM UNICA</SelectItem>
                                <SelectItem value="sum">SOMA</SelectItem>
                                <SelectItem value="avg">MEDIA</SelectItem>
                                <SelectItem value="min">MINIMO</SelectItem>
                                <SelectItem value="max">MAXIMO</SelectItem>
                              </SelectContent>
                            </Select>
                            <Select
                              value={metricItem.column || "__none__"}
                              onValueChange={(value) => {
                                const nextRows = [...dreRows];
                                const nextMetrics = [...(row.metrics || [])];
                                nextMetrics[metricIndex] = { ...metricItem, column: value === "__none__" ? undefined : value };
                                nextRows[index] = { ...row, metrics: nextMetrics };
                                update({ config: { ...draft.config, dre_rows: nextRows } });
                              }}
                            >
                              <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="Coluna" /></SelectTrigger>
                              <SelectContent>
                                {metricItem.op === "count" && <SelectItem value="__none__">count(*)</SelectItem>}
                                {(countLikeOps.includes(metricItem.op) ? columns : numericColumns).map((column) => (
                                  <SelectItem key={column.name} value={column.name}>{column.name}</SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                            <div className="flex items-center gap-1">
                              {metricIndex === (row.metrics || []).length - 1 && (
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="icon"
                                  className={secondaryGhostIconButtonClass}
                                  aria-label={`Adicionar métrica na conta ${index + 1}`}
                                  onClick={() => {
                                    const nextRows = [...dreRows];
                                    const nextMetrics = [...(row.metrics || []), { op: "sum" as const, column: numericColumns[0]?.name || columns[0]?.name }];
                                    nextRows[index] = { ...row, metrics: nextMetrics };
                                    update({ config: { ...draft.config, dre_rows: nextRows } });
                                  }}
                                >
                                  <Plus className="h-3.5 w-3.5" />
                                </Button>
                              )}
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                className={destructiveGhostIconButtonClass}
                                aria-label={`Remover métrica ${metricIndex + 1} da conta ${index + 1}`}
                                disabled={(row.metrics || []).length <= 1}
                                onClick={() => {
                                  const nextRows = [...dreRows];
                                  const nextMetrics = (row.metrics || []).filter((_, idx) => idx !== metricIndex);
                                  nextRows[index] = { ...row, metrics: nextMetrics };
                                  update({ config: { ...draft.config, dre_rows: nextRows } });
                                }}
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </Button>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>

                    <Button
                      type="button"
                      variant="outline"
                      className={dashedAddButtonClass}
                      aria-label={`Adicionar conta após linha ${index + 1}`}
                      onClick={() => {
                        const nextRows = [...dreRows];
                        nextRows.splice(index + 1, 0, {
                          title: "",
                          row_type: "detail",
                          impact: "add",
                          metrics: [{ op: "sum", column: numericColumns[0]?.name || columns[0]?.name }],
                        });
                        update({ config: { ...draft.config, dre_rows: nextRows } });
                      }}
                    >
                      <Plus className="h-3.5 w-3.5" />
                      Adicionar conta
                    </Button>
                  </div>
                ))}
              </div>

              <div className="space-y-1.5 rounded-md border border-border/60 p-2">
                <Label className="text-[11px] text-muted-foreground">Base do percentual (100%)</Label>
                <Select
                  value={typeof effectiveDrePercentBaseRowIndex === "number" ? String(effectiveDrePercentBaseRowIndex) : "__none__"}
                  onValueChange={(value) =>
                    update({
                      config: {
                        ...draft.config,
                        dre_percent_base_row_index: value === "__none__" ? undefined : Number(value),
                      },
                    })}
                >
                  <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="Selecione uma conta N1" /></SelectTrigger>
                  <SelectContent>
                    {dreResultRowOptions.length === 0 && <SelectItem value="__none__">Nenhuma conta N1 disponível</SelectItem>}
                    {dreResultRowOptions.map(({ row, index }) => (
                      <SelectItem key={`dre-percent-base-${index}`} value={String(index)}>
                        {row.title.trim() || `Conta N1 ${index + 1}`}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          )}
          {(draft.config.widget_type === "bar" || draft.config.widget_type === "column" || draft.config.widget_type === "donut") && (
            <div className="space-y-2">
              <Label className="text-xs font-semibold text-muted-foreground flex items-center gap-1.5">
                <Columns3 className="h-3 w-3" /> Dimensao
              </Label>
              <Select
                value={draft.config.dimensions[0] || ""}
                onValueChange={(value) => {
                  const currentOrder = draft.config.order_by[0];
                  const syncDimensionOrder = !!currentOrder?.column && !currentOrder.metric_ref;
                  update({
                    config: {
                      ...draft.config,
                      dimensions: [value],
                      order_by: syncDimensionOrder
                        ? [{ column: value, direction: currentOrder.direction || "desc" }]
                        : draft.config.order_by,
                    },
                  });
                }}
              >
                <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="Selecione a dimensao" /></SelectTrigger>
                <SelectContent>
                  {categoricalWidgetDimensionOptions.map((option) => (
                    <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {draft.config.widget_type === "table" && (
            <div className="space-y-2">
              <Label className="text-xs font-semibold text-muted-foreground">Colunas da tabela</Label>
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                <Checkbox
                  checked={allTableColumnsSelected}
                  onCheckedChange={(checked) => {
                    if (checked !== true) {
                      update({
                        config: {
                          ...draft.config,
                          columns: [],
                          table_column_formats: {},
                        },
                      });
                      return;
                    }
                    const current = draft.config.columns || [];
                    const missing = columns.map((column) => column.name).filter((name) => !current.includes(name));
                    const nextColumns = [...current, ...missing];
                    const existingFormats = draft.config.table_column_formats || {};
                    const nextFormats = nextColumns.reduce<Record<string, string>>((acc, columnName) => {
                      acc[columnName] = existingFormats[columnName] || getDefaultTableColumnFormat(columnName);
                      return acc;
                    }, {});
                    update({
                      config: {
                        ...draft.config,
                        columns: nextColumns,
                        table_column_formats: nextFormats,
                      },
                    });
                  }}
                />
                Selecionar todas as colunas
              </label>
              <p className="text-[11px] text-muted-foreground">Selecione, ordene e formate as colunas em uma unica lista.</p>
              <div className="space-y-1.5 max-h-64 overflow-auto border rounded-md p-2">
                {orderedTableColumns.map((column) => {
                  const checked = !!draft.config.columns?.includes(column.name);
                  const selectedIndex = selectedTableColumns.indexOf(column.name);
                  const columnType = getColumnType(column.name);
                  const inferredFormat = getDefaultTableColumnFormat(column.name);
                  const formatValue = draft.config.table_column_formats?.[column.name] || inferredFormat;
                  const formatOptions =
                    columnType === "numeric"
                      ? [
                          { value: "number_2", label: "Numero (2 casas)" },
                          { value: "integer", label: "Inteiro" },
                          { value: "currency_brl", label: "Moeda (R$)" },
                          { value: "native", label: "Nativo" },
                          { value: "text", label: "Texto" },
                        ]
                      : columnType === "temporal"
                        ? [
                            { value: "datetime", label: "Data e hora" },
                            { value: "date", label: "So data" },
                            { value: "time", label: "So hora" },
                            { value: "year", label: "So ano" },
                            { value: "month", label: "So mes" },
                            { value: "day", label: "So dia" },
                            { value: "native", label: "Nativo" },
                            { value: "text", label: "Texto" },
                          ]
                        : [
                            { value: "text", label: "Texto" },
                            { value: "native", label: "Nativo" },
                          ];
                  return (
                    <div key={column.name} className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 rounded border border-border/70 p-1.5">
                      <Checkbox
                        checked={checked}
                        onCheckedChange={(value) => {
                          const current = draft.config.columns || [];
                          const next = value
                            ? [...current, column.name]
                            : current.filter((name) => name !== column.name);
                          const currentFormats = draft.config.table_column_formats || {};
                          const nextFormats = value
                            ? { ...currentFormats, [column.name]: currentFormats[column.name] || inferredFormat }
                            : Object.fromEntries(Object.entries(currentFormats).filter(([key]) => key !== column.name));
                          update({ config: { ...draft.config, columns: next, table_column_formats: nextFormats } });
                        }}
                      />
                      <div className="min-w-0">
                        <p className="text-xs truncate">{column.name}</p>
                        <p className="text-[10px] text-muted-foreground truncate">tipo: {getColumnType(column.name)}</p>
                      </div>
                      {checked ? (
                        <div className="flex items-center gap-1">
                          <span className="text-[10px] text-muted-foreground w-7 text-center">#{selectedIndex + 1}</span>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="h-6 w-6"
                            aria-label={`Mover coluna ${column.name} para cima`}
                            disabled={selectedIndex <= 0}
                            onClick={() => {
                              if (selectedIndex <= 0) return;
                              const next = [...selectedTableColumns];
                              [next[selectedIndex - 1], next[selectedIndex]] = [next[selectedIndex], next[selectedIndex - 1]];
                              update({ config: { ...draft.config, columns: next } });
                            }}
                          >
                            <ChevronUp className="h-3 w-3" />
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="h-6 w-6"
                            aria-label={`Mover coluna ${column.name} para baixo`}
                            disabled={selectedIndex === selectedTableColumns.length - 1}
                            onClick={() => {
                              if (selectedIndex < 0 || selectedIndex === selectedTableColumns.length - 1) return;
                              const next = [...selectedTableColumns];
                              [next[selectedIndex + 1], next[selectedIndex]] = [next[selectedIndex], next[selectedIndex + 1]];
                              update({ config: { ...draft.config, columns: next } });
                            }}
                          >
                            <ChevronDown className="h-3 w-3" />
                          </Button>
                          <Select
                            value={formatValue}
                            onValueChange={(value) =>
                              update({
                                config: {
                                  ...draft.config,
                                  table_column_formats: {
                                    ...(draft.config.table_column_formats || {}),
                                    [column.name]: value,
                                  },
                                },
                              })}
                          >
                            <SelectTrigger className="h-7 w-[130px] text-xs"><SelectValue /></SelectTrigger>
                            <SelectContent>
                              {formatOptions.map((option) => (
                                <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                      ) : (
                        <span className="text-[10px] text-muted-foreground pr-1">Nao selecionada</span>
                      )}
                    </div>
                  );
                })}
              </div>
              <div className="flex gap-2 items-center">
                <Label className="text-xs text-muted-foreground">Itens por pagina</Label>
                <Select
                  value={String(draft.config.table_page_size || 25)}
                  onValueChange={(value) =>
                    update({ config: { ...draft.config, table_page_size: Math.max(1, Number(value) || 25) } })}
                >
                  <SelectTrigger className="w-[140px] h-8 text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="10">10</SelectItem>
                    <SelectItem value="25">25</SelectItem>
                    <SelectItem value="50">50</SelectItem>
                    <SelectItem value="100">100</SelectItem>
                    <SelectItem value="200">200</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          )}

                </div>
              </Section>

              {(draft.config.widget_type === "line" || draft.config.widget_type === "bar" || draft.config.widget_type === "column" || draft.config.widget_type === "donut") && (
                <Section title="Opções do gráfico" icon={SlidersHorizontal} defaultOpen={false}>
                  <p className="text-[11px] text-muted-foreground pb-1">Ajustes visuais e de rótulos por tipo de gráfico.</p>

                  {draft.config.widget_type === "line" && (
                    <div className="space-y-2.5">
                      <div className="flex items-center justify-between">
                        <span className="text-xs text-muted-foreground">Segmentar por legenda (series)</span>
                        <Select
                          value={draft.config.dimensions[0] || "__none__"}
                          onValueChange={(value) =>
                            update({
                              config: {
                                ...draft.config,
                                dimensions: value === "__none__" ? [] : [value],
                              },
                            })}
                        >
                          <SelectTrigger className="h-8 w-[190px] text-xs"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="__none__">Sem legenda</SelectItem>
                            {categoricalColumns.map((column) => (
                              <SelectItem key={column.name} value={column.name}>{column.name}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-xs text-muted-foreground">Mostrar linhas de grade</span>
                        <Switch
                          checked={draft.config.line_show_grid !== false}
                          onCheckedChange={(checked) =>
                            update({
                              config: {
                                ...draft.config,
                                line_show_grid: checked,
                              },
                            })}
                        />
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-xs text-muted-foreground">Mostrar rótulos de dados</span>
                        <Switch
                          checked={!!draft.config.line_data_labels_enabled}
                          onCheckedChange={(checked) =>
                            update({
                              config: {
                                ...draft.config,
                                line_data_labels_enabled: checked,
                                line_data_labels_percent: Math.max(25, Math.min(100, draft.config.line_data_labels_percent || 60)),
                                line_label_window: 3,
                                line_label_min_gap: 2,
                                line_label_mode: "both",
                              },
                            })}
                        />
                      </div>
                      <div className="flex items-center gap-2">
                        <Label className="text-xs text-muted-foreground w-[140px]">Peso sensibilidade</Label>
                        <Select
                          value={String(draft.config.line_data_labels_percent || 60)}
                          onValueChange={(value) =>
                            update({
                              config: {
                                ...draft.config,
                                line_data_labels_percent: Math.max(25, Math.min(100, Number(value) || 60)),
                              },
                            })}
                          disabled={!draft.config.line_data_labels_enabled}
                        >
                          <SelectTrigger className="h-8 w-[130px] text-xs"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="25">25%</SelectItem>
                            <SelectItem value="50">50%</SelectItem>
                            <SelectItem value="75">75%</SelectItem>
                            <SelectItem value="100">100%</SelectItem>
                          </SelectContent>
                        </Select>
                        <span className="text-xs text-muted-foreground">%</span>
                      </div>
                      <p className="text-[11px] text-muted-foreground">
                        Define o quão exigente o detector de picos/vales será para exibir rótulos. Valores maiores mostram menos eventos, focando apenas variações mais relevantes.
                      </p>
                    </div>
                  )}

                  {(draft.config.widget_type === "bar" || draft.config.widget_type === "column") && (
                    <div className="space-y-2.5">
                      <div className="flex items-center justify-between">
                        <span className="text-xs text-muted-foreground">Mostrar linhas de grade</span>
                        <Switch
                          checked={!!draft.config.bar_show_grid}
                          onCheckedChange={(checked) =>
                            update({
                              config: {
                                ...draft.config,
                                bar_show_grid: checked,
                              },
                            })}
                        />
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-xs text-muted-foreground">Mostrar rótulos de dados</span>
                        <Switch
                          checked={draft.config.bar_data_labels_enabled !== false}
                          onCheckedChange={(checked) =>
                            update({
                              config: {
                                ...draft.config,
                                bar_data_labels_enabled: checked,
                              },
                            })}
                        />
                      </div>
                    </div>
                  )}

                  {draft.config.widget_type === "donut" && (
                    <div className="space-y-2.5">
                      <div className="flex items-center justify-between">
                        <span className="text-xs text-muted-foreground">Mostrar legenda</span>
                        <Switch
                          checked={draft.config.donut_show_legend !== false}
                          onCheckedChange={(checked) =>
                            update({
                              config: {
                                ...draft.config,
                                donut_show_legend: checked,
                              },
                            })}
                        />
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-xs text-muted-foreground">Mostrar rótulos de dados</span>
                        <Switch
                          checked={!!draft.config.donut_data_labels_enabled}
                          onCheckedChange={(checked) =>
                            update({
                              config: {
                                ...draft.config,
                                donut_data_labels_enabled: checked,
                              },
                            })}
                        />
                      </div>
                      {draft.config.donut_data_labels_enabled && (
                        <div className="flex items-center gap-2">
                          <Label className="text-xs text-muted-foreground w-[180px]">Percentual mínimo da fatia</Label>
                          <Input
                            type="number"
                            min={1}
                            max={100}
                            className="w-[90px] h-8 text-xs"
                            value={draft.config.donut_data_labels_min_percent ?? 6}
                            onChange={(e) =>
                              update({
                                config: {
                                  ...draft.config,
                                  donut_data_labels_min_percent: Math.max(1, Math.min(100, Number(e.target.value) || 6)),
                                },
                              })}
                          />
                          <span className="text-xs text-muted-foreground">%</span>
                        </div>
                      )}
                    </div>
                  )}
                </Section>
              )}

              {(draft.config.widget_type === "line" || draft.config.widget_type === "bar" || draft.config.widget_type === "column") && (
                <Section title="Formato dos valores" icon={Hash} defaultOpen={false}>
                  <p className="text-[11px] text-muted-foreground pb-1">Prefixo e sufixo aplicados aos valores exibidos.</p>
                  <div className="grid grid-cols-2 gap-2">
                    <div className="space-y-1">
                      <Label className="text-[11px] text-muted-foreground">Prefixo</Label>
                      <Input
                        className="h-8 text-xs"
                        value={draft.config.kpi_prefix || ""}
                        onChange={(e) => update({ config: { ...draft.config, kpi_prefix: e.target.value || undefined } })}
                        placeholder="Ex: R$"
                      />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-[11px] text-muted-foreground">Sufixo</Label>
                      <Input
                        className="h-8 text-xs"
                        value={draft.config.kpi_suffix || ""}
                        onChange={(e) => update({ config: { ...draft.config, kpi_suffix: e.target.value || undefined } })}
                        placeholder="Ex: %"
                      />
                    </div>
                  </div>
                </Section>
              )}

          {draft.config.widget_type !== "text" && <Section title="Filtros" icon={Filter} defaultOpen={false} badge={draft.config.filters.length || undefined}>
            <p className="text-[11px] text-muted-foreground pb-1">Defina as regras de filtro por coluna, operador e valor.</p>
            <div className="space-y-2">
              {filterRows.map((filterItem, index) => {
                const isTemporalFilterColumn = !!filterItem.column && getColumnType(filterItem.column) === "temporal";
                const isCategoricalFilterColumn = !!filterItem.column && (getColumnType(filterItem.column) === "text" || getColumnType(filterItem.column) === "boolean");
                const columnHint = filterItem.column ? categoricalValueHints[filterItem.column] : undefined;
                const showCategoricalDropdown = !!(
                  filterItem.column
                  && isCategoricalFilterColumn
                  && exactValueFilterOps.has(filterItem.op)
                  && columnHint
                  && !columnHint.truncated
                  && columnHint.values.length > 0
                  && columnHint.values.length <= categoricalDropdownThreshold
                );
                const isRelativeTemporalFilter = isTemporalFilterColumn
                  && filterItem.op === "between"
                  && typeof filterItem.value === "object"
                  && !!filterItem.value
                  && !Array.isArray(filterItem.value)
                  && "relative" in (filterItem.value as Record<string, unknown>);
                const temporalOpUiValue = isRelativeTemporalFilter ? "__relative__" : filterItem.op;
                const showOperatorAndValue = !!filterItem.column;
                const scalarValue = Array.isArray(filterItem.value) ? String((filterItem.value as unknown[])[0] || "") : String(filterItem.value || "");
                return (
                  <div key={`filter-row-${index}`} className="space-y-2">
                    {filterRows.length > 1 && index > 0 && (
                      <button
                        type="button"
                        className="inline-flex h-6 items-center rounded-full border border-border/60 bg-muted/40 px-2.5 text-caption font-semibold text-muted-foreground hover:bg-muted/70"
                        aria-label={`Alternar operador lógico entre filtros: ${filterJoin}`}
                        onClick={() => setFilterJoin((prev) => (prev === "AND" ? "OR" : "AND"))}
                      >
                        {filterJoin}
                      </button>
                    )}
                    <FilterRuleRow variant="widget">
                    <Select
                      value={filterItem.column || "__none__"}
                      onValueChange={(value) => {
                        if (value === "__none__") {
                          removeFilterRow(index);
                          return;
                        }
                        applyFilterAt(index, {
                          column: value,
                          op: filterItem.op || "eq",
                          value: filterItem.value || "",
                        });
                      }}
                    >
                      <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="Sem filtro" /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__none__">Sem filtro</SelectItem>
                        {columns.map((column) => (
                          <SelectItem key={column.name} value={column.name}>{column.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {showOperatorAndValue && (
                      <>
                        <Select
                          value={isTemporalFilterColumn ? temporalOpUiValue : filterItem.op}
                          onValueChange={(value) =>
                            applyFilterAt(index, {
                              ...filterItem,
                              op: value === "__relative__" ? "between" : value as WidgetFilter["op"],
                              value:
                                value === "__relative__"
                                  ? { relative: "last_7_days" }
                                  : value === "between"
                                    ? ["", ""]
                                    : value === "is_null" || value === "not_null"
                                      ? undefined
                                      : filterItem.value,
                            })}
                        >
                          <SelectTrigger className="h-8 w-full text-xs"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="eq">=</SelectItem>
                            <SelectItem value="neq">!=</SelectItem>
                            <SelectItem value="gt">&gt;</SelectItem>
                            <SelectItem value="lt">&lt;</SelectItem>
                            <SelectItem value="gte">&gt;=</SelectItem>
                            <SelectItem value="lte">&lt;=</SelectItem>
                            {isTemporalFilterColumn ? (
                              <>
                                <SelectItem value="between">entre</SelectItem>
                                <SelectItem value="__relative__">relativa</SelectItem>
                              </>
                            ) : (
                              <>
                                <SelectItem value="contains">cont</SelectItem>
                                <SelectItem value="between">entre</SelectItem>
                              </>
                            )}
                            <SelectItem value="in">in</SelectItem>
                            <SelectItem value="not_in">not in</SelectItem>
                            <SelectItem value="is_null">nulo</SelectItem>
                            <SelectItem value="not_null">não nulo</SelectItem>
                          </SelectContent>
                        </Select>
                        {filterItem.op === "is_null" || filterItem.op === "not_null" ? (
                          <div className="h-8 w-full" />
                        ) : isTemporalFilterColumn && isRelativeTemporalFilter ? (
                          <Select
                            value={String((filterItem.value as Record<string, unknown>)?.relative || "last_7_days")}
                            onValueChange={(value) =>
                              applyFilterAt(index, { ...filterItem, op: "between", value: { relative: value } })}
                          >
                            <SelectTrigger className="h-8 w-full text-xs"><SelectValue /></SelectTrigger>
                            <SelectContent>
                              {relativeDateOptions.map((option) => (
                                <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        ) : isTemporalFilterColumn && filterItem.op === "between" ? (
                          <Popover>
                            <PopoverTrigger asChild>
                              <Button
                                type="button"
                                variant="outline"
                                className={cn(
                                  "h-8 w-full justify-start text-left text-xs font-normal",
                                  (!Array.isArray(filterItem.value) || !filterItem.value[0] || !filterItem.value[1]) && "text-muted-foreground",
                                )}
                              >
                                <CalendarIcon className="mr-2 h-3.5 w-3.5" />
                                {Array.isArray(filterItem.value) && filterItem.value[0] && filterItem.value[1]
                                  ? `${formatDateBR(parseYmdDate(String(filterItem.value[0])) || new Date(String(filterItem.value[0])))} - ${formatDateBR(parseYmdDate(String(filterItem.value[1])) || new Date(String(filterItem.value[1])))}`
                                  : "Selecionar intervalo"}
                              </Button>
                            </PopoverTrigger>
                            <PopoverContent className="w-auto p-0" align="start">
                              <Calendar
                                mode="range"
                                selected={{
                                  from: parseYmdDate(String((Array.isArray(filterItem.value) ? filterItem.value[0] : "") || "")),
                                  to: parseYmdDate(String((Array.isArray(filterItem.value) ? filterItem.value[1] : "") || "")),
                                }}
                                onSelect={(range) =>
                                  applyFilterAt(index, {
                                    ...filterItem,
                                    value: range?.from && range?.to ? [dateToYmd(range.from), dateToYmd(range.to)] : ["", ""],
                                  })}
                                numberOfMonths={2}
                              />
                            </PopoverContent>
                          </Popover>
                        ) : isTemporalFilterColumn ? (
                          <Popover>
                            <PopoverTrigger asChild>
                              <Button
                                type="button"
                                variant="outline"
                                className={cn(
                                  "h-8 w-full justify-start text-left text-xs font-normal",
                                  !filterItem.value && "text-muted-foreground",
                                )}
                              >
                                <CalendarIcon className="mr-2 h-3.5 w-3.5" />
                                {filterItem.value
                                  ? formatDateBR(parseYmdDate(String(filterItem.value)) || new Date(String(filterItem.value)))
                                  : "Selecionar data"}
                              </Button>
                            </PopoverTrigger>
                            <PopoverContent className="w-auto p-0" align="start">
                              <Calendar
                                mode="single"
                                selected={parseYmdDate(String(filterItem.value || ""))}
                                onSelect={(date) =>
                                  applyFilterAt(index, {
                                    ...filterItem,
                                    value: date ? dateToYmd(date) : "",
                                  })}
                              />
                            </PopoverContent>
                          </Popover>
                        ) : filterItem.op === "between" ? (
                          <div className="flex w-full items-center gap-1">
                            <Input
                              className="h-8 flex-1 text-xs"
                              value={String((Array.isArray(filterItem.value) ? filterItem.value[0] : "") || "")}
                              onChange={(e) =>
                                applyFilterAt(index, {
                                  ...filterItem,
                                  value: [
                                    e.target.value,
                                    String((Array.isArray(filterItem.value) ? filterItem.value[1] : "") || ""),
                                  ],
                                })}
                            />
                            <Input
                              className="h-8 flex-1 text-xs"
                              value={String((Array.isArray(filterItem.value) ? filterItem.value[1] : "") || "")}
                              onChange={(e) =>
                                applyFilterAt(index, {
                                  ...filterItem,
                                  value: [
                                    String((Array.isArray(filterItem.value) ? filterItem.value[0] : "") || ""),
                                    e.target.value,
                                  ],
                                })}
                            />
                          </div>
                        ) : showCategoricalDropdown ? (
                          <Select
                            value={scalarValue || "__none__"}
                            onValueChange={(value) =>
                              applyFilterAt(index, {
                                ...filterItem,
                                value: value === "__none__" ? "" : value,
                              })}
                          >
                            <SelectTrigger className="h-8 w-full text-xs"><SelectValue placeholder="Valor" /></SelectTrigger>
                            <SelectContent>
                              <SelectItem value="__none__">Sem valor</SelectItem>
                              {(columnHint?.values || []).map((value) => (
                                <SelectItem key={`filter-${index}-${value}`} value={value}>{value}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        ) : (
                          <Input
                            className="h-8 w-full text-xs"
                            value={Array.isArray(filterItem.value) ? String((filterItem.value as unknown[]).join(",")) : String(filterItem.value || "")}
                            onChange={(e) =>
                              applyFilterAt(index, {
                                ...filterItem,
                                value: filterItem.op === "in" || filterItem.op === "not_in"
                                  ? e.target.value.split(",").map((v) => v.trim()).filter(Boolean)
                                  : e.target.value,
                              })}
                          />
                        )}
                      </>
                    )}
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      className={`${secondaryGhostIconButtonClass} shrink-0`}
                      aria-label={`Adicionar filtro após linha ${index + 1}`}
                      onClick={() => addFilterRow(index)}
                    >
                      <Plus className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      className={`${destructiveGhostIconButtonClass} shrink-0`}
                      aria-label={`Remover filtro ${index + 1}`}
                      onClick={() => removeFilterRow(index)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </FilterRuleRow>
                  </div>
                );
              })}
            </div>
          </Section>}

          {(draft.config.widget_type === "bar" || draft.config.widget_type === "column" || draft.config.widget_type === "donut") && <Section title="Ordenação" icon={ArrowUpDown} defaultOpen={false} badge={draft.config.order_by.length || undefined}>
            <p className="text-[11px] text-muted-foreground pb-1">Priorize os itens por métrica ou dimensão.</p>
            <div className="flex items-center gap-2">
              <Select
                value={
                  draft.config.order_by[0]?.metric_ref
                    ? "__metric__"
                    : draft.config.order_by[0]?.column || "__none__"
                }
                onValueChange={(value) =>
                  update({
                    config: {
                      ...draft.config,
                      order_by: value === "__none__"
                        ? []
                        : value === "__metric__"
                          ? [{ metric_ref: "m0", direction: draft.config.order_by[0]?.direction || "desc" }]
                          : [{ column: value, direction: draft.config.order_by[0]?.direction || "desc" }],
                    },
                  })}
              >
                <SelectTrigger className="flex-1 h-8 text-xs"><SelectValue placeholder="Sem ordenação" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">Sem ordenação</SelectItem>
                  <SelectItem value="__metric__">Pela metrica</SelectItem>
                  {barDim && <SelectItem value={barDim}>Pela dimensao</SelectItem>}
                </SelectContent>
              </Select>
              {draft.config.order_by[0] && (
                <Select
                  value={draft.config.order_by[0].direction}
                  onValueChange={(value) =>
                    update({
                      config: {
                        ...draft.config,
                        order_by: [{ ...draft.config.order_by[0], direction: value as "asc" | "desc" }],
                      },
                    })}
                >
                  <SelectTrigger className="w-[90px] h-8 text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="asc">ASC</SelectItem>
                    <SelectItem value="desc">DESC</SelectItem>
                  </SelectContent>
                </Select>
              )}
            </div>
            <div className="flex items-center gap-2">
              <Label className="text-xs text-muted-foreground w-[90px]">Top N</Label>
              <Input
                type="number"
                min={1}
                step={1}
                className="w-[120px] h-8 text-xs"
                value={draft.config.top_n ?? ""}
                placeholder="Ex: 5"
                onChange={(e) => {
                  const raw = e.target.value.trim();
                  if (!raw) {
                    update({ config: { ...draft.config, top_n: undefined } });
                    return;
                  }
                  const parsed = Math.max(1, Math.trunc(Number(raw) || 1));
                  update({ config: { ...draft.config, top_n: parsed } });
                }}
              />
              <span className="text-[11px] text-muted-foreground">Deixe vazio para mostrar todas as dimensoes.</span>
            </div>
          </Section>}

          {draft.config.widget_type !== "text" && draft.config.widget_type !== "kpi" && draft.config.widget_type !== "bar" && draft.config.widget_type !== "column" && draft.config.widget_type !== "donut" && draft.config.widget_type !== "dre" && <Section title="Ordenação" icon={ArrowUpDown} defaultOpen={false} badge={draft.config.order_by.length || undefined}>
            <p className="text-[11px] text-muted-foreground pb-1">Defina a coluna e a direção da ordenação.</p>
            <div className="flex items-center gap-2">
              <Select
                value={draft.config.order_by[0]?.column || "__none__"}
                onValueChange={(value) =>
                  update({
                    config: {
                      ...draft.config,
                      order_by: value === "__none__" ? [] : [{
                        column: value,
                        direction: draft.config.order_by[0]?.direction || "desc",
                      }],
                    },
                  })}
              >
                <SelectTrigger className="flex-1 h-8 text-xs"><SelectValue placeholder="Sem ordenação" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">Sem ordenação</SelectItem>
                  {columns.map((column) => (
                    <SelectItem key={column.name} value={column.name}>{column.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {draft.config.order_by[0] && (
                <Select
                  value={draft.config.order_by[0].direction}
                  onValueChange={(value) =>
                    update({
                      config: {
                        ...draft.config,
                        order_by: [{ ...draft.config.order_by[0], direction: value as "asc" | "desc" }],
                      },
                    })}
                >
                  <SelectTrigger className="w-[90px] h-8 text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="asc">ASC</SelectItem>
                    <SelectItem value="desc">DESC</SelectItem>
                  </SelectContent>
                </Select>
              )}
            </div>
          </Section>}

            </div>
          )}

          {activeConfigTab === "aparencia" && (
            <>
              <Separator />
              <div className="space-y-3">
                <Section title="Layout" icon={Columns3}>
                  <div className="space-y-3">
                    <div className="flex items-center justify-between py-0.5">
                      <Label htmlFor="widget-show-title" className="text-xs text-foreground/80 font-normal cursor-pointer">Mostrar título</Label>
                      <Switch
                        id="widget-show-title"
                        checked={draft.config.show_title !== false}
                        onCheckedChange={(checked) =>
                          update({
                            config: {
                              ...draft.config,
                              show_title: checked,
                            },
                          })}
                      />
                    </div>
                    <div className="grid grid-cols-2 gap-2 items-start">
                      <LayoutOptionPicker
                        label="Largura (blocos)"
                        value={String(size.width)}
                        options={[
                          { value: "1", label: "1/6", icon: Square },
                          ...(maxWidth >= 2 ? [{ value: "2", label: "2/6", icon: RectangleVertical } as const] : []),
                          ...(maxWidth >= 3 ? [{ value: "3", label: "3/6", icon: RectangleHorizontal } as const] : []),
                          ...(maxWidth >= 4 ? [{ value: "4", label: "4/6", icon: RectangleHorizontal } as const] : []),
                          ...(maxWidth >= 6 ? [{ value: "6", label: "6/6", icon: RectangleHorizontal } as const] : []),
                        ]}
                        onChange={(value) =>
                          update({
                            config: {
                              ...draft.config,
                              size: {
                                ...size,
                                width: Math.min(maxWidth, Number(value)) as WidgetWidth,
                              },
                            },
                          })}
                      />
                      <LayoutOptionPicker
                        label="Altura"
                        value={String(size.height)}
                        options={[
                          { value: "0.5", label: "0.5x", icon: RectangleHorizontal },
                          { value: "1", label: "1x", icon: Square },
                          { value: "2", label: "2x", icon: RectangleVertical },
                        ]}
                        onChange={(value) =>
                          update({
                            config: {
                              ...draft.config,
                              size: { ...size, height: value === "0.5" ? 0.5 : value === "2" ? 2 : 1 },
                            },
                          })}
                      />
                    </div>
                  </div>
                  <div className="pt-2 space-y-1">
                    <Label className="text-[11px] text-muted-foreground">Espaçamento interno</Label>
                    <Select
                      value={draft.config.visual_padding || "normal"}
                      onValueChange={(value) =>
                        update({
                          config: {
                            ...draft.config,
                            visual_padding: value as "compact" | "normal" | "comfortable",
                          },
                        })}
                    >
                      <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="compact">Compacto</SelectItem>
                        <SelectItem value="normal">Normal</SelectItem>
                        <SelectItem value="comfortable">Confortável</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </Section>

                {draft.config.widget_type !== "table" && draft.config.widget_type !== "dre" && (
                  <Section title="Paleta de cores" icon={Palette} defaultOpen={false}>
                    <div className="space-y-1.5">
                      {(Object.keys(widgetPalettePreview) as Array<keyof typeof widgetPalettePreview>).map((paletteKey) => {
                        const selected = (draft.config.visual_palette || "default") === paletteKey;
                        return (
                          <button
                            key={paletteKey}
                            type="button"
                            className={`h-9 w-full rounded-md border px-2.5 transition-colors ${
                              selected
                                ? "border-primary bg-primary/10 text-foreground"
                                : "border-border text-muted-foreground hover:bg-muted/50"
                            }`}
                            onClick={() =>
                              update({
                                config: {
                                  ...draft.config,
                                  visual_palette: paletteKey,
                                },
                              })}
                            aria-label={`Paleta ${widgetPaletteLabel[paletteKey]}`}
                            title={widgetPaletteLabel[paletteKey]}
                          >
                            <div className="flex items-center justify-between gap-2">
                              <div className="flex items-center gap-1.5">
                                {widgetPalettePreview[paletteKey].map((color) => (
                                  <span
                                    key={`${paletteKey}-${color}`}
                                    className="h-3.5 w-3.5 rounded-full"
                                    style={{ backgroundColor: color }}
                                  />
                                ))}
                              </div>
                              <span className="text-[11px]">
                                {widgetPaletteLabel[paletteKey]}
                              </span>
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  </Section>
                )}
              </div>
            </>
          )}

          {errors.length > 0 && (
            <div className="rounded-md border border-destructive/40 bg-destructive/5 p-2 text-xs text-destructive space-y-1">
              {errors.map((error) => (
                <p key={error}>{error}</p>
              ))}
            </div>
          )}

          </div>
        </div>
        <div className="border-t border-border/50 bg-card/95 backdrop-blur-sm px-5 py-3 flex items-center gap-2">
          <Button className="flex-1 h-9 font-semibold text-xs shadow-sm" onClick={handleSave} disabled={saving}>
            {saving ? "Salvando..." : "Salvar alterações"}
          </Button>
          <Button variant="ghost" size="icon" className="h-9 w-9 shrink-0 destructive-icon-btn" aria-label="Excluir widget" onClick={onDelete}>
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
};








