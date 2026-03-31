import type { ElementType } from "react";
import { Clock3, Hash, ToggleRight, Type } from "lucide-react";

import type { MetricOp, WidgetFilter } from "@/types/dashboard";

export const metricOps: MetricOp[] = ["count", "distinct_count", "sum", "avg", "min", "max"];
export const countLikeOps = new Set<MetricOp>(["count", "distinct_count"]);
export const numericOps = new Set<MetricOp>(["sum", "avg", "min", "max"]);
export const kpiFormulaFunctionNames = new Set(["COUNT", "DISTINCT", "SUM", "AVG", "MAX", "MIN"]);
export const metricLabelByOp: Record<MetricOp, string> = {
  count: "CONTAGEM",
  distinct_count: "CONTAGEM ÚNICA",
  sum: "SOMA",
  avg: "MÉDIA",
  min: "MÍNIMO",
  max: "MÁXIMO",
};

export const commonFilterOps: Array<{ value: WidgetFilter["op"]; label: string }> = [
  { value: "eq", label: "=" },
  { value: "neq", label: "!=" },
  { value: "gt", label: ">" },
  { value: "lt", label: "<" },
  { value: "gte", label: ">=" },
  { value: "lte", label: "<=" },
  { value: "in", label: "in" },
  { value: "not_in", label: "not in" },
  { value: "contains", label: "contém" },
  { value: "not_contains", label: "nao contem" },
  { value: "between", label: "entre" },
  { value: "is_null", label: "nulo" },
  { value: "not_null", label: "não nulo" },
];

export type TemporalFilterOpUi = WidgetFilter["op"] | "__relative__";
export const temporalFilterOps: Array<{ value: TemporalFilterOpUi; label: string }> = [
  { value: "eq", label: "=" },
  { value: "neq", label: "!=" },
  { value: "gt", label: ">" },
  { value: "lt", label: "<" },
  { value: "gte", label: ">=" },
  { value: "lte", label: "<=" },
  { value: "in", label: "in" },
  { value: "not_in", label: "not in" },
  { value: "between", label: "entre datas" },
  { value: "__relative__", label: "relativa" },
  { value: "is_null", label: "nulo" },
  { value: "not_null", label: "não nulo" },
];

export const nullOps = new Set<WidgetFilter["op"]>(["is_null", "not_null"]);
export const listOps = new Set<WidgetFilter["op"]>(["in", "not_in"]);
export const relativeDateOptions = [
  { value: "today", label: "Hoje" },
  { value: "yesterday", label: "Ontem" },
  { value: "last_7_days", label: "Últimos 7 dias" },
  { value: "last_30_days", label: "Últimos 30 dias" },
  { value: "this_year", label: "Este ano" },
  { value: "this_month", label: "Este mês" },
  { value: "last_month", label: "Mês passado" },
] as const;

export const dateToApi = (date: Date) => date.toISOString().slice(0, 10);

export const parseDateValue = (value: unknown): Date | undefined => {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const raw = value.trim();
  const date = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? new Date(`${raw}T00:00:00`) : new Date(raw);
  if (Number.isNaN(date.getTime())) return undefined;
  return date;
};

export const formatDateLabel = (date: Date) =>
  new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" }).format(date);

export const paletteByName: Record<"default" | "warm" | "cool" | "mono" | "vivid", string[]> = {
  default: ["bg-chart-1", "bg-chart-2", "bg-chart-3", "bg-chart-4", "bg-chart-5"],
  warm: ["bg-warning", "bg-highlight", "bg-destructive", "bg-chart-3", "bg-chart-5"],
  cool: ["bg-chart-4", "bg-chart-6", "bg-chart-7", "bg-chart-1", "bg-chart-2"],
  mono: ["bg-foreground", "bg-foreground/80", "bg-foreground/60", "bg-foreground/40", "bg-foreground/20"],
  vivid: ["bg-accent", "bg-chart-7", "bg-chart-8", "bg-success", "bg-chart-5"],
};

export const kpiShowAsOptions: Array<{ value: "number_2" | "integer"; label: string }> = [
  { value: "number_2", label: "Decimal" },
  { value: "integer", label: "Inteiro" },
];
export const kpiAbbreviationModeOptions: Array<{ value: "auto" | "always"; label: string }> = [
  { value: "auto", label: "Automático" },
  { value: "always", label: "Sempre abreviar" },
];
export const kpiBaseAggOptions: Array<{ value: MetricOp; label: string }> = [
  { value: "sum", label: "SOMA" },
  { value: "count", label: "CONTAGEM" },
  { value: "distinct_count", label: "CONTAGEM ÚNICA" },
  { value: "avg", label: "MÉDIA" },
];
export const kpiFinalAggOptions: Array<{ value: MetricOp; label: string }> = [
  { value: "avg", label: "MÉDIA" },
  { value: "sum", label: "SOMA" },
  { value: "max", label: "MÁXIMO" },
  { value: "min", label: "MÍNIMO" },
];
export const kpiGranularityTokenOptions: Array<{ value: "day" | "month" | "timestamp"; label: string }> = [
  { value: "day", label: "dia" },
  { value: "month", label: "mês" },
  { value: "timestamp", label: "ano" },
];
export const kpiGranularityLabelByValue: Record<"day" | "month" | "timestamp", string> = {
  day: "dia",
  month: "mês",
  timestamp: "ano",
};
export const kpiModeOptions: Array<{ value: "atomic" | "composite" | "derived"; title: string; description: string }> = [
  { value: "atomic", title: "Valor único", description: "Mostra um único total, média ou contagem." },
  { value: "composite", title: "Média por período", description: "Calcula por dia/mês/ano e depois resume." },
  { value: "derived", title: "Fórmula personalizada", description: "Combina bases com uma fórmula avançada." },
];
export const kpiModeLabel: Record<"atomic" | "composite" | "derived", string> = {
  atomic: "VALOR",
  composite: "PERÍODO",
  derived: "FÓRMULA",
};

export const dreRowTypeMeta: Record<"result" | "deduction" | "detail", {
  label: string;
  containerClass: string;
  titleClass: string;
  indentClass: string;
}> = {
  result: {
    label: "Total (N1)",
    containerClass: "border-l-4 border-l-foreground/60 bg-background/65",
    titleClass: "font-semibold",
    indentClass: "",
  },
  deduction: {
    label: "Conta Dedutora (N2)",
    containerClass: "border-l-4 border-l-amber-300/70 bg-amber-50/10",
    titleClass: "font-normal",
    indentClass: "",
  },
  detail: {
    label: "Conta Analítica (N3)",
    containerClass: "border-l-4 border-l-muted-foreground/30 bg-muted/20",
    titleClass: "font-normal text-muted-foreground",
    indentClass: "pl-4",
  },
};

export const resolveInheritedDreImpact = (
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

export const resolveDrePercentBaseRowIndex = (
  rows: Array<{ row_type: "result" | "deduction" | "detail" }>,
  current?: number,
): number | undefined => {
  if (typeof current === "number" && current >= 0 && current < rows.length && rows[current]?.row_type === "result") {
    return current;
  }
  const firstResultIndex = rows.findIndex((row) => row.row_type === "result");
  return firstResultIndex >= 0 ? firstResultIndex : undefined;
};

export const normalizeColumnType = (rawType: string): "numeric" | "temporal" | "text" | "boolean" => {
  const value = (rawType || "").toLowerCase();
  if (value === "numeric" || value === "temporal" || value === "text" || value === "boolean") return value;
  if (["int", "numeric", "decimal", "real", "double", "float", "money"].some((token) => value.includes(token))) return "numeric";
  if (["date", "time", "timestamp"].some((token) => value.includes(token))) return "temporal";
  if (value.includes("bool")) return "boolean";
  return "text";
};

export const columnTypeBadgeMeta: Record<ReturnType<typeof normalizeColumnType>, {
  label: string;
  icon: ElementType;
  className: string;
}> = {
  numeric: { label: "123", icon: Hash, className: "border-emerald-500/35 bg-emerald-500/10 text-emerald-200" },
  temporal: { label: "Tempo", icon: Clock3, className: "border-sky-500/35 bg-sky-500/10 text-sky-200" },
  text: { label: "Texto", icon: Type, className: "border-violet-500/35 bg-violet-500/10 text-violet-200" },
  boolean: { label: "Bool", icon: ToggleRight, className: "border-amber-500/35 bg-amber-500/10 text-amber-200" },
};

export const parseTemporalDimensionToken = (
  value: string,
): { column: string; granularity: "day" | "month" | "week" | "weekday" | "hour" } | null => {
  if (value.startsWith("__time_day__:")) return { column: value.slice("__time_day__:".length), granularity: "day" };
  if (value.startsWith("__time_month__:")) return { column: value.slice("__time_month__:".length), granularity: "month" };
  if (value.startsWith("__time_week__:")) return { column: value.slice("__time_week__:".length), granularity: "week" };
  if (value.startsWith("__time_weekday__:")) return { column: value.slice("__time_weekday__:".length), granularity: "weekday" };
  if (value.startsWith("__time_hour__:")) return { column: value.slice("__time_hour__:".length), granularity: "hour" };
  return null;
};

export const buildTemporalDimensionToken = (column: string, granularity: "day" | "month" | "week" | "weekday" | "hour"): string =>
  `__time_${granularity}__:${column}`;

export const temporalDimensionGranularityOptions: Array<{ value: "day" | "month" | "week" | "weekday" | "hour"; label: string }> = [
  { value: "day", label: "Dia" },
  { value: "month", label: "Mês" },
  { value: "week", label: "Semana" },
  { value: "weekday", label: "Dia da semana" },
  { value: "hour", label: "Hora" },
];
