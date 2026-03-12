import { useEffect, useMemo, useState } from "react";
import { ArrowUpDown, BarChart3, Columns3, Filter, Hash, LineChart, MousePointer, Palette, PieChart, Sparkles, Table2, Type, Wand2, X, Trash2, Plus } from "lucide-react";

import type { DashboardWidget, MetricOp, WidgetFilter, WidgetWidth } from "@/types/dashboard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";

export interface BuilderRightPanelProps {
  widget: DashboardWidget | null;
  onUpdate: (widget: DashboardWidget) => void;
  onDelete: () => void;
  onClose: () => void;
  columns?: Array<{ name: string; type: string }>;
}

type TabKey = "dados" | "visual" | "filtros" | "interacoes";

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

const metricOps: MetricOp[] = ["count", "distinct_count", "sum", "avg", "min", "max"];
const filterOps: Array<{ value: WidgetFilter["op"]; label: string }> = [
  { value: "eq", label: "=" },
  { value: "neq", label: "!=" },
  { value: "gt", label: ">" },
  { value: "lt", label: "<" },
  { value: "gte", label: ">=" },
  { value: "lte", label: "<=" },
  { value: "contains", label: "contem" },
  { value: "between", label: "entre" },
  { value: "in", label: "in" },
  { value: "not_in", label: "not in" },
  { value: "is_null", label: "nulo" },
  { value: "not_null", label: "nao nulo" },
];

const paletteByName: Record<"default" | "warm" | "cool" | "mono" | "vivid", string[]> = {
  default: ["bg-chart-1", "bg-chart-2", "bg-chart-3", "bg-chart-4", "bg-chart-5"],
  warm: ["bg-warning", "bg-highlight", "bg-destructive", "bg-chart-3", "bg-chart-5"],
  cool: ["bg-chart-4", "bg-chart-6", "bg-chart-7", "bg-chart-1", "bg-chart-2"],
  mono: ["bg-foreground", "bg-foreground/80", "bg-foreground/60", "bg-foreground/40", "bg-foreground/20"],
  vivid: ["bg-accent", "bg-chart-7", "bg-chart-8", "bg-success", "bg-chart-5"],
};

const kpiShowAsOptions: Array<{ value: "number_2" | "integer" | "currency_brl" | "percent"; label: string }> = [
  { value: "number_2", label: "Decimal (2 casas)" },
  { value: "integer", label: "Inteiro" },
  { value: "currency_brl", label: "Moeda (BRL)" },
  { value: "percent", label: "Percentual" },
];

const normalizeColumnType = (rawType: string): "numeric" | "temporal" | "text" | "boolean" => {
  const value = (rawType || "").toLowerCase();
  if (value === "numeric" || value === "temporal" || value === "text" || value === "boolean") return value;
  if (["int", "numeric", "decimal", "real", "double", "float", "money"].some((token) => value.includes(token))) return "numeric";
  if (["date", "time", "timestamp"].some((token) => value.includes(token))) return "temporal";
  if (value.includes("bool")) return "boolean";
  return "text";
};

const inferColumns = (widget: DashboardWidget): Array<{ name: string; type: string }> => {
  const names = new Set<string>();
  widget.config.metrics.forEach((metric) => metric.column && names.add(metric.column));
  widget.config.dimensions.forEach((dimension) => !dimension.startsWith("__time_") && names.add(dimension));
  widget.config.filters.forEach((filter) => filter.column && names.add(filter.column));
  widget.config.columns?.forEach((column) => names.add(column));
  if (widget.config.time?.column) names.add(widget.config.time.column);
  return Array.from(names).map((name) => ({ name, type: "text" }));
};

export const BuilderRightPanel = ({ widget, onUpdate, onDelete, onClose, columns }: BuilderRightPanelProps) => {
  const [draft, setDraft] = useState<DashboardWidget | null>(widget);
  const [activeTab, setActiveTab] = useState<TabKey>("dados");
  const [filterJoin, setFilterJoin] = useState<"AND" | "OR">("AND");

  useEffect(() => {
    setDraft(widget);
    setActiveTab("dados");
  }, [widget]);

  const resolvedColumns = useMemo(() => {
    if (columns && columns.length > 0) return columns;
    if (!draft) return [];
    return inferColumns(draft);
  }, [columns, draft]);

  const numericColumns = useMemo(() => resolvedColumns.filter((column) => normalizeColumnType(column.type) === "numeric"), [resolvedColumns]);
  const temporalColumns = useMemo(() => resolvedColumns.filter((column) => normalizeColumnType(column.type) === "temporal"), [resolvedColumns]);
  const categoricalColumns = useMemo(() => resolvedColumns.filter((column) => {
    const type = normalizeColumnType(column.type);
    return type === "text" || type === "boolean";
  }), [resolvedColumns]);

  if (!draft) {
    return (
      <aside className="h-full border-l border-border/60 bg-[hsl(var(--card)/0.28)]">
        <div className="h-full flex items-center justify-center p-6">
          <div className="text-center space-y-2 max-w-[240px]">
            <div className="mx-auto h-10 w-10 rounded-xl border border-accent/25 bg-accent/10 text-accent flex items-center justify-center">
              <MousePointer className="h-5 w-5" />
            </div>
            <p className="text-body font-semibold text-foreground">Nenhum widget selecionado</p>
            <p className="text-caption text-muted-foreground">Clique em um widget no canvas para configura-lo aqui.</p>
          </div>
        </div>
      </aside>
    );
  }

  const Icon = widgetTypeIcon[draft.config.widget_type];
  const metric = draft.config.metrics[0] || { op: "count" as const, column: resolvedColumns[0]?.name };
  const size = draft.config.size || { width: 1, height: 1 };
  const isLineWidget = draft.config.widget_type === "line";
  const isBarLikeWidget = draft.config.widget_type === "bar" || draft.config.widget_type === "column";
  const isDonutWidget = draft.config.widget_type === "donut";
  const isCategoricalChart = isBarLikeWidget || isDonutWidget;
  const hasChartOptions = isLineWidget || isBarLikeWidget || isDonutWidget;
  const currentOrder = draft.config.order_by[0];
  const orderTargetValue = currentOrder?.metric_ref ? "__metric__" : currentOrder?.column || "__none__";

  const setConfig = (patch: Partial<DashboardWidget["config"]>) => {
    setDraft((current) => {
      if (!current) return current;
      const nextConfig = { ...current.config, ...patch };
      return {
        ...current,
        type: nextConfig.widget_type,
        props: nextConfig,
        config: nextConfig,
      };
    });
  };

  const setMetric = (patch: Partial<(typeof metric)>) => {
    const nextMetrics = [...(draft.config.metrics || [{ op: "count", column: resolvedColumns[0]?.name }])];
    nextMetrics[0] = { ...nextMetrics[0], ...patch };
    setConfig({ metrics: nextMetrics });
  };

  const updateFilter = (index: number, patch: Partial<WidgetFilter>) => {
    const next = [...(draft.config.filters || [])];
    next[index] = { ...next[index], ...patch };
    setConfig({ filters: next });
  };

  const addFilter = () => setConfig({ filters: [...(draft.config.filters || []), { column: "", op: "eq", value: "" }] });
  const removeFilter = (index: number) => setConfig({ filters: (draft.config.filters || []).filter((_, idx) => idx !== index) });

  const save = () => {
    onUpdate(draft);
    onClose();
  };

  return (
    <aside className="h-full border-l border-border/60 bg-[hsl(var(--card)/0.28)] flex flex-col">
      <div className="h-14 border-b border-border/60 px-3 flex items-center justify-between gap-2 shrink-0 bg-gradient-to-b from-[hsl(var(--card)/0.65)] to-[hsl(var(--card)/0.4)]">
        <div className="min-w-0 flex items-center gap-2">
          <span className="inline-flex h-7 w-7 items-center justify-center rounded-lg border border-accent/20 bg-accent/10 text-accent">
            <Icon className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <p className="text-label font-semibold text-foreground truncate">{draft.title || "Sem titulo"}</p>
            <p className="text-caption text-muted-foreground truncate">{draft.config.view_name}</p>
          </div>
        </div>
        <Button type="button" variant="ghost" size="icon" className="h-7 w-7" onClick={onClose}>
          <X className="h-4 w-4" />
        </Button>
      </div>

      <div className="px-3 pt-2.5 shrink-0">
        <Input className="h-9 text-caption rounded-xl border-border/70 bg-background/45" value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} placeholder="Renomear widget" />
        <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as TabKey)} className="mt-2">
          <TabsList className="w-full h-9 grid grid-cols-4 rounded-xl bg-background/40 p-1">
            <TabsTrigger value="dados" className="text-caption rounded-lg"><Hash className="h-3.5 w-3.5 mr-1" />Dados</TabsTrigger>
            <TabsTrigger value="visual" className="text-caption rounded-lg"><Palette className="h-3.5 w-3.5 mr-1" />Visual</TabsTrigger>
            <TabsTrigger value="filtros" className="text-caption rounded-lg"><Filter className="h-3.5 w-3.5 mr-1" />Filtros</TabsTrigger>
            <TabsTrigger value="interacoes" className="text-caption rounded-lg"><Wand2 className="h-3.5 w-3.5 mr-1" />Inter.</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      <Separator className="my-2 bg-border/60" />

      <ScrollArea className="flex-1 px-3 pb-20">
        <div className="space-y-3">
          {activeTab === "dados" && (
            <div className="space-y-3">
              <div className="rounded-xl border border-border/60 bg-background/45 p-3 space-y-2">
                <p className="text-label font-semibold text-foreground">Metricas</p>
                <div className="grid grid-cols-[120px_minmax(0,1fr)] gap-2">
                  <Select value={metric.op} onValueChange={(value) => setMetric({ op: value as MetricOp })}>
                    <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                    <SelectContent>{metricOps.map((op) => <SelectItem key={op} value={op}>{op}</SelectItem>)}</SelectContent>
                  </Select>
                  <Select value={metric.column || "__none__"} onValueChange={(value) => setMetric({ column: value === "__none__" ? undefined : value })}>
                    <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="Coluna" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none__">Sem coluna</SelectItem>
                      {(metric.op === "count" || metric.op === "distinct_count" ? resolvedColumns : numericColumns).map((column) => (
                        <SelectItem key={column.name} value={column.name}>{column.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              {(isCategoricalChart || isLineWidget) && (
                <div className="rounded-xl border border-border/60 bg-background/45 p-3 space-y-2">
                  <p className="text-label font-semibold text-foreground">Dimensao</p>
                  {isLineWidget ? (
                    <>
                      <div className="grid grid-cols-2 gap-2">
                        <Select value={draft.config.time?.column || "__none__"} onValueChange={(value) => setConfig({ time: { column: value === "__none__" ? "" : value, granularity: draft.config.time?.granularity || "day" } })}>
                          <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="Tempo" /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="__none__">Sem tempo</SelectItem>
                            {temporalColumns.map((column) => <SelectItem key={column.name} value={column.name}>{column.name}</SelectItem>)}
                          </SelectContent>
                        </Select>
                        <Select value={draft.config.time?.granularity || "day"} onValueChange={(value) => setConfig({ time: { column: draft.config.time?.column || "", granularity: value as "day" | "week" | "month" | "hour" | "timestamp" } })}>
                          <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="day">Dia</SelectItem>
                            <SelectItem value="week">Semana</SelectItem>
                            <SelectItem value="month">Mes</SelectItem>
                            <SelectItem value="hour">Hora</SelectItem>
                            <SelectItem value="timestamp">Timestamp</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      <Select value={draft.config.dimensions[0] || "__none__"} onValueChange={(value) => setConfig({ dimensions: value === "__none__" ? [] : [value] })}>
                        <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="Legenda (series)" /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="__none__">Sem legenda</SelectItem>
                          {categoricalColumns.map((column) => <SelectItem key={column.name} value={column.name}>{column.name}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    </>
                  ) : (
                    <Select value={draft.config.dimensions[0] || "__none__"} onValueChange={(value) => setConfig({ dimensions: value === "__none__" ? [] : [value] })}>
                      <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="Dimensao" /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__none__">Sem dimensao</SelectItem>
                        {categoricalColumns.map((column) => <SelectItem key={column.name} value={column.name}>{column.name}</SelectItem>)}
                        {temporalColumns.map((column) => <SelectItem key={`temporal-${column.name}`} value={column.name}>{column.name}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  )}
                </div>
              )}

              {(isCategoricalChart || isLineWidget || draft.config.widget_type === "table") && (
                <div className="rounded-xl border border-border/60 bg-background/45 p-3 space-y-2">
                  <p className="flex items-center gap-1.5 text-label font-semibold text-foreground">
                    <ArrowUpDown className="h-3.5 w-3.5 text-muted-foreground" />
                    Ordenacao
                  </p>
                  {isCategoricalChart ? (
                    <div className="space-y-2">
                      <div className="grid grid-cols-[minmax(0,1fr)_88px] gap-2">
                        <Select
                          value={orderTargetValue}
                          onValueChange={(value) => {
                            if (value === "__none__") {
                              setConfig({ order_by: [] });
                              return;
                            }
                            if (value === "__metric__") {
                              setConfig({ order_by: [{ metric_ref: "m0", direction: currentOrder?.direction || "desc" }] });
                              return;
                            }
                            setConfig({ order_by: [{ column: value, direction: currentOrder?.direction || "desc" }] });
                          }}
                        >
                          <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="Sem ordenacao" /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="__none__">Sem ordenacao</SelectItem>
                            <SelectItem value="__metric__">Pela metrica</SelectItem>
                            {draft.config.dimensions[0] && <SelectItem value={draft.config.dimensions[0]}>Pela dimensao</SelectItem>}
                          </SelectContent>
                        </Select>
                        <Select
                          value={currentOrder?.direction || "desc"}
                          onValueChange={(value) => {
                            if (!currentOrder) return;
                            setConfig({
                              order_by: [{ ...currentOrder, direction: value as "asc" | "desc" }],
                            });
                          }}
                          disabled={!currentOrder}
                        >
                          <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="asc">ASC</SelectItem>
                            <SelectItem value="desc">DESC</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      {(isBarLikeWidget || isDonutWidget) && (
                        <div className="grid grid-cols-[96px_minmax(0,1fr)] items-center gap-2">
                          <Label className="text-caption text-muted-foreground">Top N</Label>
                          <Input
                            type="number"
                            min={1}
                            className="h-8 text-xs"
                            value={draft.config.top_n ?? ""}
                            placeholder="Vazio = sem limite"
                            onChange={(event) => {
                              const raw = event.target.value.trim();
                              if (!raw) {
                                setConfig({ top_n: undefined });
                                return;
                              }
                              setConfig({ top_n: Math.max(1, Math.trunc(Number(raw) || 1)) });
                            }}
                          />
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="grid grid-cols-[minmax(0,1fr)_88px] gap-2">
                      <Select
                        value={currentOrder?.column || "__none__"}
                        onValueChange={(value) => {
                          if (value === "__none__") {
                            setConfig({ order_by: [] });
                            return;
                          }
                          setConfig({ order_by: [{ column: value, direction: currentOrder?.direction || "desc" }] });
                        }}
                      >
                        <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="Sem ordenacao" /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="__none__">Sem ordenacao</SelectItem>
                          {resolvedColumns.map((column) => <SelectItem key={`order-${column.name}`} value={column.name}>{column.name}</SelectItem>)}
                        </SelectContent>
                      </Select>
                      <Select
                        value={currentOrder?.direction || "desc"}
                        onValueChange={(value) => {
                          if (!currentOrder) return;
                          setConfig({ order_by: [{ ...currentOrder, direction: value as "asc" | "desc" }] });
                        }}
                        disabled={!currentOrder}
                      >
                        <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="asc">ASC</SelectItem>
                          <SelectItem value="desc">DESC</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  )}
                </div>
              )}

              {draft.config.widget_type === "kpi" && (
                <div className="rounded-xl border border-border/60 bg-background/45 p-3 space-y-2">
                  <p className="text-label font-semibold text-foreground">Formato KPI</p>
                  <Select
                    value={draft.config.kpi_show_as || "number_2"}
                    onValueChange={(value) => setConfig({ kpi_show_as: value as "number_2" | "integer" | "currency_brl" | "percent" })}
                  >
                    <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {kpiShowAsOptions.map((option) => (
                        <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <div className="grid grid-cols-[120px_minmax(0,1fr)] items-center gap-2">
                    <Label className="text-caption text-muted-foreground">Casas decimais</Label>
                    <Input
                      type="number"
                      min={0}
                      max={8}
                      className="h-8 text-xs"
                      value={draft.config.kpi_decimals ?? 2}
                      onChange={(event) => setConfig({ kpi_decimals: Math.max(0, Math.min(8, Math.trunc(Number(event.target.value) || 0)) ) })}
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <Input className="h-8 text-xs" value={draft.config.kpi_prefix || ""} placeholder="Prefixo (ex: R$)" onChange={(event) => setConfig({ kpi_prefix: event.target.value || undefined })} />
                    <Input className="h-8 text-xs" value={draft.config.kpi_suffix || ""} placeholder="Sufixo (ex: %)" onChange={(event) => setConfig({ kpi_suffix: event.target.value || undefined })} />
                  </div>
                </div>
              )}

              {draft.config.widget_type === "table" && (
                <div className="rounded-xl border border-border/60 bg-background/45 p-3 space-y-2">
                  <p className="text-label font-semibold text-foreground">Tabela</p>
                  <div className="grid grid-cols-[120px_minmax(0,1fr)] items-center gap-2">
                    <Label className="text-caption text-muted-foreground">Itens por pagina</Label>
                    <Select
                      value={String(draft.config.table_page_size || 25)}
                      onValueChange={(value) => setConfig({ table_page_size: Math.max(1, Number(value) || 25) })}
                    >
                      <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
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
          )}

          {activeTab === "visual" && (
            <div className="space-y-3">
              <div className="rounded-xl border border-border/60 bg-background/45 p-3 space-y-2">
                <p className="text-label font-semibold text-foreground">Layout</p>
                <div className="flex items-center justify-between"><Label className="text-caption text-muted-foreground">Mostrar titulo</Label><Switch checked={draft.config.show_title !== false} onCheckedChange={(checked) => setConfig({ show_title: checked })} /></div>
                <div className="grid grid-cols-2 gap-2">
                  <Select value={String(size.width)} onValueChange={(value) => setConfig({ size: { ...size, width: Number(value) as WidgetWidth } })}><SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="1">1/6</SelectItem><SelectItem value="2">2/6</SelectItem><SelectItem value="3">3/6</SelectItem><SelectItem value="4">4/6</SelectItem><SelectItem value="6">6/6</SelectItem></SelectContent></Select>
                  <Select value={String(size.height)} onValueChange={(value) => setConfig({ size: { ...size, height: value === "0.5" ? 0.5 : value === "2" ? 2 : 1 } })}><SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="0.5">0.5x</SelectItem><SelectItem value="1">1x</SelectItem><SelectItem value="2">2x</SelectItem></SelectContent></Select>
                </div>
              </div>

              {hasChartOptions && (
                <div className="rounded-xl border border-border/60 bg-background/45 p-3 space-y-2.5">
                  <p className="text-label font-semibold text-foreground">Opcoes do grafico</p>

                  {isLineWidget && (
                    <>
                      <div className="flex items-center justify-between">
                        <Label className="text-caption text-muted-foreground">Mostrar linhas de grade</Label>
                        <Switch checked={draft.config.line_show_grid !== false} onCheckedChange={(checked) => setConfig({ line_show_grid: checked })} />
                      </div>
                      <div className="flex items-center justify-between">
                        <Label className="text-caption text-muted-foreground">Mostrar rotulos de dados</Label>
                        <Switch checked={!!draft.config.line_data_labels_enabled} onCheckedChange={(checked) => setConfig({ line_data_labels_enabled: checked })} />
                      </div>
                      <div className="grid grid-cols-[140px_minmax(0,1fr)] items-center gap-2">
                        <Label className="text-caption text-muted-foreground">Sensibilidade (%)</Label>
                        <Input
                          type="number"
                          min={25}
                          max={100}
                          className="h-8 text-xs"
                          value={draft.config.line_data_labels_percent ?? 60}
                          onChange={(event) => {
                            const nextValue = Math.max(25, Math.min(100, Number(event.target.value) || 60));
                            setConfig({ line_data_labels_percent: nextValue });
                          }}
                          disabled={!draft.config.line_data_labels_enabled}
                        />
                      </div>
                      <div className="grid grid-cols-[140px_minmax(0,1fr)] items-center gap-2">
                        <Label className="text-caption text-muted-foreground">Janela (pontos)</Label>
                        <Input
                          type="number"
                          min={1}
                          max={12}
                          className="h-8 text-xs"
                          value={draft.config.line_label_window ?? 3}
                          onChange={(event) => setConfig({ line_label_window: Math.max(1, Math.min(12, Math.trunc(Number(event.target.value) || 1))) })}
                          disabled={!draft.config.line_data_labels_enabled}
                        />
                      </div>
                      <div className="grid grid-cols-[140px_minmax(0,1fr)] items-center gap-2">
                        <Label className="text-caption text-muted-foreground">Gap minimo</Label>
                        <Input
                          type="number"
                          min={1}
                          max={12}
                          className="h-8 text-xs"
                          value={draft.config.line_label_min_gap ?? 2}
                          onChange={(event) => setConfig({ line_label_min_gap: Math.max(1, Math.min(12, Math.trunc(Number(event.target.value) || 1))) })}
                          disabled={!draft.config.line_data_labels_enabled}
                        />
                      </div>
                      <div className="grid grid-cols-[140px_minmax(0,1fr)] items-center gap-2">
                        <Label className="text-caption text-muted-foreground">Modo de evento</Label>
                        <Select
                          value={draft.config.line_label_mode || "both"}
                          onValueChange={(value) => setConfig({ line_label_mode: value as "peak" | "valley" | "both" })}
                          disabled={!draft.config.line_data_labels_enabled}
                        >
                          <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="both">Picos e vales</SelectItem>
                            <SelectItem value="peak">Somente picos</SelectItem>
                            <SelectItem value="valley">Somente vales</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                    </>
                  )}

                  {isBarLikeWidget && (
                    <>
                      <div className="flex items-center justify-between">
                        <Label className="text-caption text-muted-foreground">Mostrar linhas de grade</Label>
                        <Switch checked={!!draft.config.bar_show_grid} onCheckedChange={(checked) => setConfig({ bar_show_grid: checked })} />
                      </div>
                      <div className="flex items-center justify-between">
                        <Label className="text-caption text-muted-foreground">Mostrar rotulos de dados</Label>
                        <Switch checked={draft.config.bar_data_labels_enabled !== false} onCheckedChange={(checked) => setConfig({ bar_data_labels_enabled: checked })} />
                      </div>
                    </>
                  )}

                  {isDonutWidget && (
                    <>
                      <div className="flex items-center justify-between">
                        <Label className="text-caption text-muted-foreground">Mostrar legenda</Label>
                        <Switch checked={draft.config.donut_show_legend !== false} onCheckedChange={(checked) => setConfig({ donut_show_legend: checked })} />
                      </div>
                      <div className="flex items-center justify-between">
                        <Label className="text-caption text-muted-foreground">Mostrar rotulos de dados</Label>
                        <Switch checked={!!draft.config.donut_data_labels_enabled} onCheckedChange={(checked) => setConfig({ donut_data_labels_enabled: checked })} />
                      </div>
                      <div className="flex items-center justify-between">
                        <Label className="text-caption text-muted-foreground">Agrupar em Outros</Label>
                        <Switch checked={draft.config.donut_group_others_enabled !== false} onCheckedChange={(checked) => setConfig({ donut_group_others_enabled: checked })} />
                      </div>
                      <div className="grid grid-cols-[140px_minmax(0,1fr)] items-center gap-2">
                        <Label className="text-caption text-muted-foreground">Top N categorias</Label>
                        <Input
                          type="number"
                          min={2}
                          max={12}
                          className="h-8 text-xs"
                          value={draft.config.donut_group_others_top_n ?? 3}
                          onChange={(event) => setConfig({ donut_group_others_top_n: Math.max(2, Math.min(12, Math.trunc(Number(event.target.value) || 3))) })}
                          disabled={draft.config.donut_group_others_enabled === false}
                        />
                      </div>
                      <div className="grid grid-cols-[140px_minmax(0,1fr)] items-center gap-2">
                        <Label className="text-caption text-muted-foreground">Exibir valores</Label>
                        <Select
                          value={draft.config.donut_metric_display || "value"}
                          onValueChange={(value) => setConfig({ donut_metric_display: value === "percent" ? "percent" : "value" })}
                        >
                          <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="value">Valor</SelectItem>
                            <SelectItem value="percent">Percentual</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="grid grid-cols-[140px_minmax(0,1fr)] items-center gap-2">
                        <Label className="text-caption text-muted-foreground">Percentual minimo</Label>
                        <Input
                          type="number"
                          min={1}
                          max={100}
                          className="h-8 text-xs"
                          value={draft.config.donut_data_labels_min_percent ?? 6}
                          onChange={(event) => setConfig({ donut_data_labels_min_percent: Math.max(1, Math.min(100, Number(event.target.value) || 6)) })}
                          disabled={!draft.config.donut_data_labels_enabled}
                        />
                      </div>
                    </>
                  )}
                </div>
              )}

              {draft.config.widget_type !== "table" && draft.config.widget_type !== "dre" && (
                <div className="rounded-xl border border-border/60 bg-background/45 p-3 space-y-1.5">
                  <p className="text-label font-semibold text-foreground">Paleta de cores</p>
                  {(Object.keys(paletteByName) as Array<keyof typeof paletteByName>).map((paletteName) => {
                    const selected = (draft.config.visual_palette || "default") === paletteName;
                    return (
                      <button key={paletteName} type="button" className={cn("w-full rounded-md border px-2.5 py-1.5", selected ? "border-accent/40 bg-accent/10" : "border-border/70 bg-background hover:bg-muted/50")} onClick={() => setConfig({ visual_palette: paletteName })}>
                        <div className="flex items-center justify-between"><div className="flex gap-1">{paletteByName[paletteName].map((colorClass) => <span key={`${paletteName}-${colorClass}`} className={cn("h-3 w-3 rounded-full border border-background/40", colorClass)} />)}</div><span className="text-caption text-muted-foreground">{paletteName}</span></div>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {activeTab === "filtros" && (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <Button type="button" variant="outline" size="sm" className="h-8 text-caption" onClick={addFilter}><Plus className="h-3.5 w-3.5 mr-1" />Adicionar filtro</Button>
                {(draft.config.filters || []).length > 1 && <Button type="button" variant="outline" size="sm" className="h-8 text-caption" onClick={() => setFilterJoin((current) => current === "AND" ? "OR" : "AND")}>{filterJoin}</Button>}
              </div>
              {(draft.config.filters || []).map((filter, index) => (
                <div key={`filter-${index}`} className="rounded-xl border border-border/60 bg-background/45 p-2 space-y-2">
                  <div className="grid grid-cols-[minmax(0,1fr)_120px_30px] gap-1.5">
                    <Select value={filter.column || "__none__"} onValueChange={(value) => updateFilter(index, { column: value === "__none__" ? "" : value })}>
                      <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="Coluna" /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__none__">Sem coluna</SelectItem>
                        {resolvedColumns.map((column) => <SelectItem key={column.name} value={column.name}>{column.name}</SelectItem>)}
                      </SelectContent>
                    </Select>
                    <Select value={filter.op} onValueChange={(value) => updateFilter(index, { op: value as WidgetFilter["op"] })}>
                      <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                      <SelectContent>{filterOps.map((op) => <SelectItem key={op.value} value={op.value}>{op.label}</SelectItem>)}</SelectContent>
                    </Select>
                    <Button type="button" size="icon" variant="ghost" className="h-8 w-8 text-muted-foreground hover:text-destructive hover:bg-destructive/10" onClick={() => removeFilter(index)}><Trash2 className="h-3.5 w-3.5" /></Button>
                  </div>
                  {filter.op !== "is_null" && filter.op !== "not_null" && (
                    <Input className="h-8 text-xs" value={String(filter.value ?? "")} onChange={(event) => updateFilter(index, { value: event.target.value })} placeholder="Valor" />
                  )}
                </div>
              ))}
            </div>
          )}

          {activeTab === "interacoes" && (
            <div className="rounded-xl border border-border/60 bg-background/45 p-4 text-center">
              <Sparkles className="h-5 w-5 text-accent mx-auto mb-2" />
              <p className="text-label font-semibold text-foreground">Em breve</p>
              <p className="text-caption text-muted-foreground mt-1">Drilldown e navegacao entre widgets.</p>
            </div>
          )}
        </div>
      </ScrollArea>

      <div className="h-14 border-t border-border/60 bg-[hsl(var(--card)/0.6)] backdrop-blur-sm px-3 flex items-center gap-2 shrink-0">
        <Button className="flex-1 h-9 text-caption rounded-xl bg-accent text-accent-foreground hover:bg-accent/90" onClick={save}>Concluir</Button>
        <Button type="button" variant="ghost" size="icon" className="h-9 w-9 text-muted-foreground hover:text-destructive hover:bg-destructive/10" onClick={onDelete}><Trash2 className="h-4 w-4" /></Button>
      </div>
    </aside>
  );
};

export default BuilderRightPanel;
