import { useEffect, useMemo, useState } from "react";
import { Hash, Columns3, Filter, ArrowUpDown, Trash2, ChevronUp, ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { Separator } from "@/components/ui/separator";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import type { DashboardWidget } from "@/types/dashboard";
import type { View } from "@/types";

interface WidgetConfigPanelProps {
  widget: DashboardWidget | null;
  view?: View;
  sectionColumns?: 1 | 2 | 3 | 4;
  open: boolean;
  onClose: () => void;
  onSave: (widget: DashboardWidget) => Promise<void> | void;
  onDelete: () => void;
}

const numOps = ["sum", "avg", "min", "max"];
const countLikeOps = ["count", "distinct_count"];

export const WidgetConfigPanel = ({ widget, view, sectionColumns = 3, open, onClose, onSave, onDelete }: WidgetConfigPanelProps) => {
  const [draft, setDraft] = useState<DashboardWidget | null>(widget);
  const [errors, setErrors] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setDraft(widget);
    setErrors([]);
  }, [widget]);

  const columns = view?.columns || [];
  const numericColumns = useMemo(() => columns.filter((column) => column.type === "numeric"), [columns]);
  const temporalColumns = useMemo(() => columns.filter((column) => column.type === "temporal"), [columns]);
  const categoricalColumns = useMemo(() => columns.filter((column) => column.type === "text" || column.type === "boolean"), [columns]);

  if (!draft) return null;

  const update = (patch: Partial<DashboardWidget>) => {
    setDraft({ ...draft, ...patch });
  };

  const validate = (target: DashboardWidget): string[] => {
    const messages: string[] = [];
    const config = target.config;

    if (config.widget_type === "kpi") {
      const baseMetric = config.metrics[0] || (config.composite_metric
        ? { op: config.composite_metric.inner_agg, column: config.composite_metric.value_column }
        : undefined);

      if (!baseMetric) {
        messages.push("KPI requer exatamente 1 metrica.");
      } else if (baseMetric.op && numOps.includes(baseMetric.op) && (!baseMetric.column || !numericColumns.some((column) => column.name === baseMetric.column))) {
        messages.push("KPI com sum/avg/min/max requer coluna numerica.");
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
      if (config.metrics.length !== 1) messages.push("Grafico de linha requer exatamente 1 metrica.");
    }

    if (config.widget_type === "bar") {
      if (config.dimensions.length !== 1) messages.push("Grafico de barras requer exatamente 1 dimensao.");
      if (config.dimensions[0] && !categoricalColumns.some((column) => column.name === config.dimensions[0])) {
        messages.push("A dimensao precisa ser categorica.");
      }
      if (config.metrics.length !== 1) messages.push("Grafico de barras requer exatamente 1 metrica.");
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

    return messages;
  };

  const handleSave = async () => {
    let normalizedDraft = draft.config.widget_type === "table"
      ? { ...draft, config: { ...draft.config, limit: undefined, top_n: undefined } }
      : draft.config.widget_type === "bar"
        ? draft
        : { ...draft, config: { ...draft.config, top_n: undefined } };

    if (normalizedDraft.config.widget_type === "kpi") {
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
            metrics: [],
            composite_metric: {
              ...normalizedDraft.config.composite_metric,
              inner_agg: draftMetric.op,
              value_column: draftMetric.column,
            },
          },
        };
      } else {
        normalizedDraft = {
          ...normalizedDraft,
          config: {
            ...normalizedDraft.config,
            composite_metric: undefined,
            metrics: [{ op: draftMetric.op, column: draftMetric.column }],
          },
        };
      }
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
  const periodLabelMap: Record<"day" | "week" | "month", string> = { day: "dia", week: "semana", month: "mes" };
  const compositeDescription = compositeMetric
    ? `${compositeMetric.outer_agg.toUpperCase()} da ${metric.op.toUpperCase()}(${metric.column || "*"}) por ${periodLabelMap[compositeMetric.granularity]}`
    : "";
  const barDim = draft.config.dimensions[0] || "";
  const selectedTableColumns = draft.config.columns || [];
  const getColumnType = (name: string) => columns.find((column) => column.name === name)?.type || "text";

  return (
    <Sheet open={open} onOpenChange={(value) => !value && onClose()}>
      <SheetContent className="w-[380px] sm:w-[440px] overflow-y-auto">
        <SheetHeader>
          <SheetTitle className="text-base">Configurar Widget</SheetTitle>
          <SheetDescription className="text-xs">
            {view ? `${view.schema}.${view.name}` : "View nao encontrada"}
          </SheetDescription>
        </SheetHeader>

        <div className="space-y-5 py-5">
          <div className="space-y-1.5">
            <Label className="text-xs font-semibold text-muted-foreground">Titulo</Label>
            <Input
              value={draft.title}
              onChange={(e) => update({ title: e.target.value })}
              placeholder="Nome do widget"
              className="h-8 text-sm"
            />
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs font-semibold text-muted-foreground">Tipo</Label>
            <Select
              value={draft.config.widget_type}
              onValueChange={(value) => {
                const nextType = value as DashboardWidget["config"]["widget_type"];
                if (nextType === "text") {
                  update({
                    config: {
                      ...draft.config,
                      widget_type: "text",
                      text_style: draft.config.text_style || { content: "Texto", font_size: 18, align: "left" },
                      metrics: [],
                      dimensions: [],
                      filters: [],
                      order_by: [],
                      columns: undefined,
                      time: undefined,
                      top_n: undefined,
                    },
                  });
                  return;
                }

                if (nextType === "kpi") {
                  update({
                    config: {
                      ...draft.config,
                      widget_type: "kpi",
                      composite_metric: undefined,
                      order_by: [],
                      dimensions: [],
                      time: undefined,
                      columns: undefined,
                      top_n: undefined,
                      metrics: draft.config.metrics.length > 0 ? draft.config.metrics : [{ op: "count" }],
                    },
                  });
                  return;
                }

                update({
                  config: {
                    ...draft.config,
                    widget_type: nextType,
                    composite_metric: undefined,
                    top_n: nextType === "bar" ? draft.config.top_n : undefined,
                  },
                });
              }}
            >
              <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="kpi">KPI</SelectItem>
                <SelectItem value="line">Linha</SelectItem>
                <SelectItem value="bar">Barras</SelectItem>
                <SelectItem value="table">Tabela</SelectItem>
                <SelectItem value="text">Texto</SelectItem>
              </SelectContent>
            </Select>
          </div>
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

          {draft.config.widget_type !== "table" && draft.config.widget_type !== "text" && (
            <div className="space-y-2">
              <Label className="text-xs font-semibold text-muted-foreground flex items-center gap-1.5">
                <Hash className="h-3 w-3" /> Metrica
              </Label>
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
                    <SelectItem value="count">COUNT</SelectItem>
                    <SelectItem value="distinct_count">COUNT DISTINCT</SelectItem>
                    <SelectItem value="sum">SUM</SelectItem>
                    <SelectItem value="avg">AVG</SelectItem>
                    <SelectItem value="min">MIN</SelectItem>
                    <SelectItem value="max">MAX</SelectItem>
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
              </div>
            </div>
          )}

          {draft.config.widget_type === "kpi" && (
            <div className="space-y-2">
              <div className="flex items-center justify-between rounded-md border border-border p-2">
                <span className="text-xs text-muted-foreground">Metrica composta</span>
                <Switch
                  checked={compositeEnabled}
                  onCheckedChange={(checked) =>
                    update({
                      config: {
                        ...draft.config,
                        metrics: [{ op: metric.op, column: metric.column }],
                        composite_metric: checked
                          ? {
                              type: "agg_over_time_bucket",
                              inner_agg: metric.op,
                              outer_agg: "avg",
                              value_column: metric.column,
                              time_column: draft.config.composite_metric?.time_column || temporalColumns[0]?.name || "",
                              granularity: draft.config.composite_metric?.granularity || "day",
                            }
                          : undefined,
                      },
                    })}
                />
              </div>

              {compositeEnabled && draft.config.composite_metric && (
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
                        <SelectItem value="avg">AVG</SelectItem>
                        <SelectItem value="sum">SUM</SelectItem>
                        <SelectItem value="count">COUNT</SelectItem>
                        <SelectItem value="distinct_count">COUNT DISTINCT</SelectItem>
                        <SelectItem value="min">MIN</SelectItem>
                        <SelectItem value="max">MAX</SelectItem>
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
                              granularity: value as "day" | "week" | "month",
                            },
                          },
                        })}
                    >
                      <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="day">Dia</SelectItem>
                        <SelectItem value="week">Semana</SelectItem>
                        <SelectItem value="month">Mes</SelectItem>
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
            </div>
          )}

          {draft.config.widget_type === "line" && (
            <div className="space-y-2">
              <Label className="text-xs font-semibold text-muted-foreground">Tempo</Label>
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
                          granularity: value as "day" | "week" | "month",
                        },
                      },
                    })}
                >
                  <SelectTrigger className="w-[110px] h-8 text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="day">Dia</SelectItem>
                    <SelectItem value="week">Semana</SelectItem>
                    <SelectItem value="month">Mes</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          )}

          {draft.config.widget_type === "bar" && (
            <div className="space-y-2">
              <Label className="text-xs font-semibold text-muted-foreground flex items-center gap-1.5">
                <Columns3 className="h-3 w-3" /> Dimensao
              </Label>
              <Select
                value={draft.config.dimensions[0] || ""}
                onValueChange={(value) => update({ config: { ...draft.config, dimensions: [value] } })}
              >
                <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="Selecione a dimensao" /></SelectTrigger>
                <SelectContent>
                  {categoricalColumns.map((column) => (
                    <SelectItem key={column.name} value={column.name}>{column.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {draft.config.widget_type === "table" && (
            <div className="space-y-2">
              <Label className="text-xs font-semibold text-muted-foreground">Colunas da tabela</Label>
              <div className="space-y-1.5 max-h-40 overflow-auto border rounded-md p-2">
                {columns.map((column) => {
                  const checked = !!draft.config.columns?.includes(column.name);
                  return (
                    <label key={column.name} className="flex items-center gap-2 text-xs">
                      <Checkbox
                        checked={checked}
                        onCheckedChange={(value) => {
                          const current = draft.config.columns || [];
                          const next = value
                            ? [...current, column.name]
                            : current.filter((name) => name !== column.name);
                          const currentFormats = draft.config.table_column_formats || {};
                          const nextFormats = value
                            ? currentFormats
                            : Object.fromEntries(Object.entries(currentFormats).filter(([key]) => key !== column.name));
                          update({ config: { ...draft.config, columns: next, table_column_formats: nextFormats } });
                        }}
                      />
                      <span>{column.name}</span>
                    </label>
                  );
                })}
              </div>
              {selectedTableColumns.length > 0 && (
                <div className="space-y-1.5 border rounded-md p-2">
                  <Label className="text-[11px] text-muted-foreground">Ordem e formato das colunas selecionadas</Label>
                  {selectedTableColumns.map((columnName, index) => {
                    const columnType = getColumnType(columnName);
                    const formatValue = draft.config.table_column_formats?.[columnName] || "native";
                    const formatOptions =
                      columnType === "numeric"
                        ? [
                            { value: "native", label: "Nativo" },
                            { value: "currency_brl", label: "Moeda (R$)" },
                              { value: "number_2", label: "Numero (2 casas)" },
                            { value: "integer", label: "Inteiro" },
                            { value: "text", label: "Texto" },
                          ]
                        : columnType === "temporal"
                          ? [
                              { value: "native", label: "Nativo" },
                              { value: "datetime", label: "Data e hora" },
                              { value: "date", label: "So data" },
                              { value: "time", label: "So hora" },
                              { value: "year", label: "So ano" },
                              { value: "month", label: "So mes" },
                              { value: "day", label: "So dia" },
                              { value: "text", label: "Texto" },
                            ]
                          : [
                              { value: "native", label: "Nativo" },
                              { value: "text", label: "Texto" },
                            ];
                    return (
                      <div key={columnName} className="flex items-center gap-1">
                        <span className="text-xs flex-1 truncate">{columnName}</span>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-6 w-6"
                          disabled={index === 0}
                          onClick={() => {
                            const next = [...selectedTableColumns];
                            [next[index - 1], next[index]] = [next[index], next[index - 1]];
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
                          disabled={index === selectedTableColumns.length - 1}
                          onClick={() => {
                            const next = [...selectedTableColumns];
                            [next[index + 1], next[index]] = [next[index], next[index + 1]];
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
                                  [columnName]: value,
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
                    );
                  })}
                </div>
              )}
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

          <Separator />

          {draft.config.widget_type !== "text" && <div className="space-y-2">
            <Label className="text-xs font-semibold text-muted-foreground flex items-center gap-1.5">
              <Filter className="h-3 w-3" /> Filtro simples
            </Label>
            <div className="flex items-center gap-2">
              <Select
                value={draft.config.filters[0]?.column || "__none__"}
                onValueChange={(value) =>
                  update({
                    config: {
                      ...draft.config,
                      filters: value === "__none__" ? [] : [{
                        column: value,
                        op: draft.config.filters[0]?.op || "eq",
                        value: draft.config.filters[0]?.value || "",
                      }],
                    },
                  })}
              >
                <SelectTrigger className="flex-1 h-8 text-xs"><SelectValue placeholder="Sem filtro" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">Sem filtro</SelectItem>
                  {columns.map((column) => (
                    <SelectItem key={column.name} value={column.name}>{column.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {draft.config.filters[0] && (
                <>
                  <Select
                    value={draft.config.filters[0].op}
                    onValueChange={(value) =>
                      update({
                        config: {
                          ...draft.config,
                          filters: [{ ...draft.config.filters[0], op: value as typeof draft.config.filters[0]["op"] }],
                        },
                      })}
                  >
                    <SelectTrigger className="w-[90px] h-8 text-xs"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="eq">=</SelectItem>
                      <SelectItem value="neq">!=</SelectItem>
                      <SelectItem value="gt">&gt;</SelectItem>
                      <SelectItem value="lt">&lt;</SelectItem>
                      <SelectItem value="gte">&gt;=</SelectItem>
                      <SelectItem value="lte">&lt;=</SelectItem>
                      <SelectItem value="contains">cont</SelectItem>
                    </SelectContent>
                  </Select>
                  <Input
                    className="w-[110px] h-8 text-xs"
                    value={String(draft.config.filters[0].value || "")}
                    onChange={(e) =>
                      update({
                        config: {
                          ...draft.config,
                          filters: [{ ...draft.config.filters[0], value: e.target.value }],
                        },
                      })}
                  />
                </>
              )}
            </div>
          </div>}

          {draft.config.widget_type === "bar" && <div className="space-y-2">
            <Label className="text-xs font-semibold text-muted-foreground flex items-center gap-1.5">
              <ArrowUpDown className="h-3 w-3" /> Ordenacao (bar)
            </Label>
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
                <SelectTrigger className="flex-1 h-8 text-xs"><SelectValue placeholder="Sem ordenacao" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">Sem ordenacao</SelectItem>
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
          </div>}

          {draft.config.widget_type !== "text" && draft.config.widget_type !== "kpi" && draft.config.widget_type !== "bar" && <div className="space-y-2">
            <Label className="text-xs font-semibold text-muted-foreground flex items-center gap-1.5">
              <ArrowUpDown className="h-3 w-3" /> Ordenacao simples
            </Label>
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
                <SelectTrigger className="flex-1 h-8 text-xs"><SelectValue placeholder="Sem ordenacao" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">Sem ordenacao</SelectItem>
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
          </div>}

          <Separator />

          <div className="space-y-2">
            <Label className="text-xs font-semibold text-muted-foreground">Configuracoes visuais</Label>
            <div className="flex items-center justify-between rounded-md border border-border p-2">
              <span className="text-xs text-muted-foreground">Mostrar titulo do widget</span>
              <Switch
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
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <Label className="text-[11px] text-muted-foreground">Largura</Label>
                <Select
                  value={String(size.width)}
                  onValueChange={(value) =>
                    update({
                      config: {
                        ...draft.config,
                        size: {
                          ...size,
                          width: Math.min(maxWidth, Number(value)) as 1 | 2 | 3 | 4,
                        },
                      },
                    })}
                >
                  <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="1">1x</SelectItem>
                    {maxWidth >= 2 && <SelectItem value="2">2x</SelectItem>}
                    {maxWidth >= 3 && <SelectItem value="3">3x</SelectItem>}
                    {maxWidth >= 4 && <SelectItem value="4">4x</SelectItem>}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label className="text-[11px] text-muted-foreground">Altura</Label>
                <Select
                  value={String(size.height)}
                  onValueChange={(value) =>
                    update({
                      config: {
                        ...draft.config,
                        size: { ...size, height: value === "0.5" ? 0.5 : 1 },
                      },
                    })}
                >
                  <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="1">1x (padrao)</SelectItem>
                    <SelectItem value="0.5">0.5x</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>

          {errors.length > 0 && (
            <div className="rounded-md border border-destructive/40 bg-destructive/5 p-2 text-xs text-destructive space-y-1">
              {errors.map((error) => (
                <p key={error}>{error}</p>
              ))}
            </div>
          )}

          <div className="flex gap-2">
            <Button className="flex-1" onClick={handleSave} disabled={saving}>
              {saving ? "Salvando..." : "Salvar alteracoes"}
            </Button>
            <Button variant="destructive" size="icon" onClick={onDelete}>
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
};
