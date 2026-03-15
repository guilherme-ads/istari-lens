import { Plus, Trash2 } from "lucide-react";

import type { MetricOp } from "@/types/dashboard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

type LineMetricDraft = {
  op: MetricOp;
  column?: string;
  alias?: string;
  prefix?: string;
  suffix?: string;
  line_style?: "solid" | "dashed" | "dotted";
  line_y_axis?: "left" | "right";
};

type OptionItem = { value: string; label: string; disabled?: boolean };

type SentenceTokenSelectLikeProps = {
  tone: "agg" | "column" | "time" | "segment";
  value: string;
  onChange: (value: string) => void;
  options: OptionItem[];
  placeholder?: string;
  showCalendarIcon?: boolean;
};

type SentenceTokenSelectLike = (props: SentenceTokenSelectLikeProps) => JSX.Element;

export type LineWidgetDataConfigProps = {
  lineMetrics: LineMetricDraft[];
  setLineMetrics: (nextMetrics: LineMetricDraft[]) => void;
  metricOps: MetricOp[];
  metricLabelByOp: Record<MetricOp, string>;
  countLikeOps: Set<MetricOp>;
  numericColumns: Array<{ name: string; type: string }>;
  resolvedColumns: Array<{ name: string; type: string }>;
  temporalColumns: Array<{ name: string; type: string }>;
  categoricalColumns: Array<{ name: string; type: string }>;
  lineTimeColumnValue: string;
  lineTimeGranularityValue: string;
  lineSeriesDimensionValue: string;
  setConfig: (patch: Record<string, unknown>) => void;
  draftTimeGranularity?: "day" | "week" | "month" | "hour" | "timestamp";
  draftTimeColumn?: string;
  SentenceTokenSelect: SentenceTokenSelectLike;
};

export const LineWidgetDataConfig = ({
  lineMetrics,
  setLineMetrics,
  metricOps,
  metricLabelByOp,
  countLikeOps,
  numericColumns,
  resolvedColumns,
  temporalColumns,
  categoricalColumns,
  lineTimeColumnValue,
  lineTimeGranularityValue,
  lineSeriesDimensionValue,
  setConfig,
  draftTimeGranularity,
  draftTimeColumn,
  SentenceTokenSelect,
}: LineWidgetDataConfigProps) => (
  <div className="space-y-2">
    <div className="rounded-lg border border-border/60 bg-background/70 p-2.5 space-y-2">
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2">
        <div className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
          <SentenceTokenSelect
            tone="agg"
            value={lineMetrics[0]?.op || "count"}
            onChange={(value) => {
              const nextOp = value as MetricOp;
              const current = lineMetrics[0] || { op: "count" as const, column: undefined };
              const nextColumn = countLikeOps.has(nextOp)
                ? current.column
                : (current.column && numericColumns.some((column) => column.name === current.column)
                  ? current.column
                  : numericColumns[0]?.name);
              const nextMetrics = [...lineMetrics];
              nextMetrics[0] = { ...current, op: nextOp, column: nextColumn, line_y_axis: "left" };
              setLineMetrics(nextMetrics);
            }}
            options={metricOps.map((op) => ({
              value: op,
              label: metricLabelByOp[op],
              disabled: (op === "sum" || op === "avg" || op === "min" || op === "max") && numericColumns.length === 0,
            }))}
          />
          <span>de</span>
          <SentenceTokenSelect
            tone="column"
            value={(lineMetrics[0]?.column || "__none__")}
            onChange={(value) => {
              const current = lineMetrics[0] || { op: "count" as const, column: undefined };
              const nextMetrics = [...lineMetrics];
              nextMetrics[0] = { ...current, column: value === "__none__" ? undefined : value, line_y_axis: "left" };
              setLineMetrics(nextMetrics);
            }}
            options={[
              ...(countLikeOps.has(lineMetrics[0]?.op || "count") ? [{ value: "__none__", label: "sem coluna" }] : []),
              ...(countLikeOps.has(lineMetrics[0]?.op || "count") ? resolvedColumns : numericColumns).map((column) => ({ value: column.name, label: column.name })),
            ]}
            placeholder="coluna"
          />
        </div>
        {lineMetrics.length < 2 && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-5 w-5 text-muted-foreground hover:text-foreground"
            onClick={() => {
              const next = [...lineMetrics, { op: "count" as const, column: undefined, line_y_axis: "right" as const }];
              setLineMetrics(next);
            }}
            aria-label="Adicionar segunda métrica"
          >
            <Plus className="h-3 w-3" />
          </Button>
        )}
      </div>

      {lineMetrics.length > 1 && (
        <div className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
          <SentenceTokenSelect
            tone="agg"
            value={lineMetrics[1]?.op || "count"}
            onChange={(value) => {
              const nextOp = value as MetricOp;
              const current = lineMetrics[1] || { op: "count" as const, column: undefined };
              const nextColumn = countLikeOps.has(nextOp)
                ? current.column
                : (current.column && numericColumns.some((column) => column.name === current.column)
                  ? current.column
                  : numericColumns[0]?.name);
              const nextMetrics = [...lineMetrics];
              nextMetrics[1] = { ...current, op: nextOp, column: nextColumn, line_y_axis: "right" };
              setLineMetrics(nextMetrics);
            }}
            options={metricOps.map((op) => ({
              value: op,
              label: metricLabelByOp[op],
              disabled: (op === "sum" || op === "avg" || op === "min" || op === "max") && numericColumns.length === 0,
            }))}
          />
          <span>de</span>
          <SentenceTokenSelect
            tone="column"
            value={(lineMetrics[1]?.column || "__none__")}
            onChange={(value) => {
              const current = lineMetrics[1] || { op: "count" as const, column: undefined };
              const nextMetrics = [...lineMetrics];
              nextMetrics[1] = { ...current, column: value === "__none__" ? undefined : value, line_y_axis: "right" };
              setLineMetrics(nextMetrics);
            }}
            options={[
              ...(countLikeOps.has(lineMetrics[1]?.op || "count") ? [{ value: "__none__", label: "sem coluna" }] : []),
              ...(countLikeOps.has(lineMetrics[1]?.op || "count") ? resolvedColumns : numericColumns).map((column) => ({ value: column.name, label: column.name })),
            ]}
            placeholder="coluna"
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
            onClick={() => setLineMetrics(lineMetrics.filter((_, metricIndex) => metricIndex !== 1))}
            aria-label="Remover segunda métrica"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
        <span>por</span>
        <SentenceTokenSelect
          tone="time"
          value={lineTimeColumnValue}
          onChange={(value) => setConfig({ time: { column: value === "__none__" ? "" : value, granularity: draftTimeGranularity || "day" } })}
          options={[
            { value: "__none__", label: "sem tempo" },
            ...temporalColumns.map((column) => ({ value: column.name, label: column.name })),
          ]}
          placeholder="tempo"
          showCalendarIcon
        />
        {lineTimeColumnValue !== "__none__" && (
          <>
            <span>como</span>
            <SentenceTokenSelect
              tone="time"
              value={lineTimeGranularityValue}
              onChange={(value) =>
                setConfig({
                  time: {
                    column: draftTimeColumn || "",
                    granularity: value as "day" | "week" | "month" | "hour" | "timestamp",
                  },
                })}
              options={[
                { value: "day", label: "dia" },
                { value: "week", label: "semana" },
                { value: "month", label: "mês" },
                { value: "hour", label: "hora" },
                { value: "timestamp", label: "instante" },
              ]}
            />
          </>
        )}
      </div>

      {lineSeriesDimensionValue === "__none__" ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-xs text-muted-foreground"
          onClick={() => setConfig({ dimensions: categoricalColumns[0] ? [categoricalColumns[0].name] : [] })}
          disabled={categoricalColumns.length === 0}
        >
          <Plus className="h-3.5 w-3.5 mr-1" />
          adicionar segmentação
        </Button>
      ) : (
        <div className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
          <span>segmentado por</span>
          <SentenceTokenSelect
            tone="segment"
            value={lineSeriesDimensionValue}
            onChange={(value) => setConfig({ dimensions: value === "__none__" ? [] : [value] })}
            options={[
              { value: "__none__", label: "sem legenda" },
              ...categoricalColumns.map((column) => ({ value: column.name, label: column.name })),
            ]}
            placeholder="legenda"
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
            onClick={() => setConfig({ dimensions: [] })}
            aria-label="Remover segmentação"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      )}
    </div>
  </div>
);

export const LineWidgetFormattingGroup = ({
  lineMetrics,
  setLineMetrics,
}: {
  lineMetrics: LineMetricDraft[];
  setLineMetrics: (nextMetrics: LineMetricDraft[]) => void;
}) => (
  <div className="space-y-2">
    {lineMetrics.map((item, index) => (
      <div key={`line-alias-${index}`} className="rounded-md border border-border/60 p-2 space-y-2">
        <div className="grid grid-cols-[84px_minmax(0,1fr)] items-center gap-2">
          <Label className="text-caption text-muted-foreground truncate" title={item.column || `m${index + 1}`}>
            {item.column || `m${index + 1}`}
          </Label>
          <Input
            className="h-8 min-w-[84px] text-xs"
            value={item.alias || ""}
            placeholder="Mostrar como..."
            onChange={(event) => {
              const nextMetrics = [...lineMetrics];
              nextMetrics[index] = { ...item, alias: event.target.value || undefined };
              setLineMetrics(nextMetrics);
            }}
          />
        </div>
        <div className="grid grid-cols-[72px_72px_minmax(0,1fr)] items-center gap-2">
          <Input
            className="h-8 text-xs px-2"
            value={item.prefix || ""}
            placeholder="Prefix."
            onChange={(event) => {
              const nextMetrics = [...lineMetrics];
              nextMetrics[index] = { ...item, prefix: event.target.value || undefined };
              setLineMetrics(nextMetrics);
            }}
          />
          <Input
            className="h-8 text-xs px-2"
            value={item.suffix || ""}
            placeholder="Sufix."
            onChange={(event) => {
              const nextMetrics = [...lineMetrics];
              nextMetrics[index] = { ...item, suffix: event.target.value || undefined };
              setLineMetrics(nextMetrics);
            }}
          />
          <Select
            value={item.line_style || "solid"}
            onValueChange={(value) => {
              const nextMetrics = [...lineMetrics];
              nextMetrics[index] = { ...item, line_style: value as "solid" | "dashed" | "dotted" };
              setLineMetrics(nextMetrics);
            }}
          >
            <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="solid">
                <span className="inline-flex items-center gap-2">
                  <span className="w-8 border-t border-foreground/80" />
                  Normal
                </span>
              </SelectItem>
              <SelectItem value="dashed">
                <span className="inline-flex items-center gap-2">
                  <span className="w-8 border-t border-dashed border-foreground/80" />
                  Tracejada
                </span>
              </SelectItem>
              <SelectItem value="dotted">
                <span className="inline-flex items-center gap-2">
                  <span className="w-8 border-t border-dotted border-foreground/80" />
                  Pontilhada
                </span>
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
    ))}
  </div>
);
