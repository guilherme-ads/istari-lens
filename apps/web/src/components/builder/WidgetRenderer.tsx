import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  LineChart as ReLineChart, Line, LabelList,
} from "recharts";
import { ArrowUpDown, Download, ChevronLeft, ChevronRight } from "lucide-react";
import type { DashboardWidget } from "@/types/dashboard";
import { api, type ApiDashboardWidgetDataResponse } from "@/lib/api";

const tooltipStyle = {
  borderRadius: 8,
  border: "1px solid hsl(214, 20%, 88%)",
  fontSize: 12,
  boxShadow: "0 4px 12px -2px rgba(0,0,0,0.08)",
};

const formatFullNumber = (value: unknown): string => {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number)) return "0";
  return new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 2 }).format(number);
};

const formatCompactNumber = (value: unknown): string => {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number)) return "0";
  const abs = Math.abs(number);

  const formatShort = (base: number, suffix: string) => {
    const scaled = number / base;
    const digits = Math.abs(scaled) >= 100 ? 0 : Math.abs(scaled) >= 10 ? 1 : 2;
    const text = new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 0, maximumFractionDigits: digits }).format(scaled);
    return `${text} ${suffix}`;
  };

  if (abs >= 1_000_000_000) return formatShort(1_000_000_000, "Bi");
  if (abs >= 1_000_000) return formatShort(1_000_000, "Mi");
  if (abs >= 1_000) return formatShort(1_000, "Mil");

  return formatFullNumber(number);
};

const toFiniteNumber = (value: unknown): number => {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : 0;
  }
  if (typeof value !== "string") return 0;

  const trimmed = value.trim();
  if (!trimmed) return 0;

  const normalized = trimmed
    .replace(/\s+/g, "")
    .replace(/\./g, "")
    .replace(",", ".");
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
};

const getMetricLabel = (widget: DashboardWidget): string => {
  if (widget.config.composite_metric) {
    const cfg = widget.config.composite_metric;
    const innerAgg = cfg.inner_agg || cfg.agg || "sum";
    const outerAgg = cfg.outer_agg || "avg";
    const compositeInnerLabel = innerAgg === "count"
      ? `COUNT(${cfg.value_column || "*"})`
      : `${innerAgg.toUpperCase()}(${cfg.value_column || "*"})`;
    return `${outerAgg.toUpperCase()}(${compositeInnerLabel} por ${cfg.granularity})`;
  }
  const metric = widget.config.metrics[0];
  if (!metric) return "Metrica";
  if (metric.op === "count") {
    return metric.column ? `COUNT(${metric.column})` : "COUNT(*)";
  }
  if (metric.op === "distinct_count") {
    return `COUNT(DISTINCT ${metric.column || "*"})`;
  }
  return `${metric.op.toUpperCase()}(${metric.column || "*"})`;
};

type RendererProps = {
  widget: DashboardWidget;
  dashboardId?: string;
  disableFetch?: boolean;
  heightMultiplier?: 0.5 | 1;
  preloadedData?: ApiDashboardWidgetDataResponse;
  preloadedLoading?: boolean;
  preloadedError?: string | null;
};

const EmptyWidgetState = ({ text }: { text: string }) => (
  <div className="text-xs text-muted-foreground text-center">{text}</div>
);

const parseDateLike = (value: unknown): Date | null => {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value !== "string") return null;
  const isDateString = /^\d{4}-\d{2}-\d{2}/.test(value) || /^\d{4}\/\d{2}\/\d{2}/.test(value);
  if (!isDateString) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

const formatDateBR = (date: Date, includeTime = false): string => {
  if (!includeTime) {
    return new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" }).format(date);
  }
  return new Intl.DateTimeFormat("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
};

const formatByTableConfig = (value: unknown, format: string): string => {
  if (value === null || value === undefined) return "";
  const asNumber = typeof value === "number" ? value : Number(value);
  const asDate = parseDateLike(value);

  if (format === "text") return String(value);
  if (format === "currency_brl" && Number.isFinite(asNumber)) {
    return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(asNumber);
  }
  if (format === "number_2" && Number.isFinite(asNumber)) {
    return new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(asNumber);
  }
  if (format === "integer" && Number.isFinite(asNumber)) {
    return Math.trunc(asNumber).toLocaleString("pt-BR");
  }
  if (asDate) {
    if (format === "datetime") return formatDateBR(asDate, true);
    if (format === "time") return new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit" }).format(asDate);
    if (format === "year") return String(asDate.getFullYear());
    if (format === "month") return String(asDate.getMonth() + 1).padStart(2, "0");
    if (format === "day") return String(asDate.getDate()).padStart(2, "0");
    return formatDateBR(asDate, false);
  }
  if (Number.isFinite(asNumber) && typeof value === "number") {
    return asNumber.toLocaleString("pt-BR");
  }
  return String(value);
};

const MiniTable = ({ rows, widget }: { rows: Record<string, unknown>[]; widget: DashboardWidget }) => {
  const [sortBy, setSortBy] = useState<{ column: string; direction: "asc" | "desc" } | null>(null);
  const [page, setPage] = useState(1);
  const configured = widget.config.columns || [];
  const rowKeys = Object.keys(rows[0] || {});
  const pageSize = Math.max(1, widget.config.table_page_size || 25);
  const tableColumns = configured.length > 0
    ? [...configured.filter((column) => rowKeys.includes(column)), ...rowKeys.filter((column) => !configured.includes(column))]
    : rowKeys;

  const sortedRows = useMemo(() => {
    if (!sortBy) return rows;
    const copy = [...rows];
    copy.sort((a, b) => {
      const av = a[sortBy.column];
      const bv = b[sortBy.column];
      if (av === bv) return 0;
      if (av === null || av === undefined) return 1;
      if (bv === null || bv === undefined) return -1;
      const aDate = parseDateLike(av);
      const bDate = parseDateLike(bv);
      if (aDate && bDate) {
        return sortBy.direction === "asc" ? aDate.getTime() - bDate.getTime() : bDate.getTime() - aDate.getTime();
      }
      if (typeof av === "number" && typeof bv === "number") {
        return sortBy.direction === "asc" ? av - bv : bv - av;
      }
      return sortBy.direction === "asc"
        ? String(av).localeCompare(String(bv), "pt-BR")
        : String(bv).localeCompare(String(av), "pt-BR");
    });
    return copy;
  }, [rows, sortBy]);

  const totalPages = Math.max(1, Math.ceil(sortedRows.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const pageRows = sortedRows.slice((safePage - 1) * pageSize, safePage * pageSize);

  if (rows.length === 0) return <EmptyWidgetState text="Nenhum dado retornado" />;

  const exportCsv = () => {
    const escapeCsv = (value: string) => {
      if (value.includes("\"") || value.includes(",") || value.includes("\n")) {
        return `"${value.replace(/"/g, "\"\"")}"`;
      }
      return value;
    };
    const header = tableColumns.map(escapeCsv).join(",");
    const body = sortedRows.map((row) =>
      tableColumns
        .map((key) => escapeCsv(formatByTableConfig(row[key], widget.config.table_column_formats?.[key] || "native")))
        .join(","))
      .join("\n");
    const csv = `${header}\n${body}`;
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.setAttribute("download", `${(widget.title || "tabela").replace(/\s+/g, "_").toLowerCase()}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  return (
    <div className="flex h-full w-full flex-col gap-2 text-sm">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] text-muted-foreground">{sortedRows.length.toLocaleString("pt-BR")} linhas</span>
        <Button type="button" size="sm" variant="outline" className="h-7 text-xs" onClick={exportCsv}>
          <Download className="h-3.5 w-3.5 mr-1.5" />
          Exportar CSV
        </Button>
      </div>

      <div className="flex-1 overflow-auto rounded-lg border border-border">
        <div className="min-w-max">
          <Table>
            <TableHeader className="sticky top-0 z-10 bg-muted/40 backdrop-blur-sm">
              <TableRow className="hover:bg-muted/30">
                {tableColumns.map((key) => (
                  <TableHead key={key} className="text-xs font-semibold whitespace-nowrap py-2 min-w-[120px]">
                    <button
                      className="inline-flex items-center gap-1 hover:text-foreground"
                      onClick={() => {
                        setPage(1);
                        setSortBy((prev) => {
                          if (!prev || prev.column !== key) return { column: key, direction: "asc" };
                          if (prev.direction === "asc") return { column: key, direction: "desc" };
                          return null;
                        });
                      }}
                    >
                      {key}
                      <ArrowUpDown className="h-3 w-3" />
                    </button>
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {pageRows.map((row, idx) => (
                <TableRow key={`${safePage}-${idx}`} className="even:bg-muted/20">
                  {tableColumns.map((key) => (
                    <TableCell key={key} className={`py-1.5 text-xs whitespace-nowrap ${typeof row[key] === "number" ? "font-mono text-right tabular-nums" : ""}`}>
                      {formatByTableConfig(row[key], widget.config.table_column_formats?.[key] || "native")}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </div>

      <div className="flex items-center justify-between text-[11px] text-muted-foreground">
        <span>Pagina {safePage} de {totalPages}</span>
        <div className="inline-flex items-center gap-1">
          <Button
            type="button"
            size="icon"
            variant="outline"
            className="h-7 w-7"
            disabled={safePage <= 1}
            onClick={() => setPage((prev) => Math.max(1, prev - 1))}
          >
            <ChevronLeft className="h-3.5 w-3.5" />
          </Button>
          <Button
            type="button"
            size="icon"
            variant="outline"
            className="h-7 w-7"
            disabled={safePage >= totalPages}
            onClick={() => setPage((prev) => Math.min(totalPages, prev + 1))}
          >
            <ChevronRight className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
    </div>
  );
};

export const WidgetRenderer = ({
  widget,
  dashboardId,
  disableFetch = false,
  heightMultiplier = 1,
  preloadedData,
  preloadedLoading = false,
  preloadedError = null,
}: RendererProps) => {
  const isTextWidget = widget.config.widget_type === "text";
  const shouldFetch = !disableFetch && !!dashboardId && !isTextWidget;

  const widgetQuery = useQuery({
    queryKey: ["widget-data", dashboardId, widget.id],
    queryFn: () => api.getDashboardWidgetData(Number(dashboardId), Number(widget.id)),
    enabled: shouldFetch,
  });

  const rows = useMemo(
    () => preloadedData?.rows || widgetQuery.data?.rows || [],
    [preloadedData, widgetQuery.data],
  );
  const metricLabel = useMemo(() => getMetricLabel(widget), [widget]);
  const chartHeight = heightMultiplier === 0.5 ? 110 : 220;
  const lineTargetTicks = heightMultiplier === 0.5 ? 4 : 8;
  const lineTickInterval = rows.length > lineTargetTicks ? Math.ceil(rows.length / lineTargetTicks) - 1 : 0;

  if (isTextWidget) {
    const textStyle = widget.config.text_style || { content: "", font_size: 18, align: "left" as const };
    const alignClass = {
      left: "text-left",
      center: "text-center",
      right: "text-right",
    }[textStyle.align];
    return (
      <div className={`flex h-full w-full items-center ${alignClass}`}>
        <p className="w-full break-words leading-snug text-foreground" style={{ fontSize: `${textStyle.font_size}px` }}>
          {textStyle.content || "Texto"}
        </p>
      </div>
    );
  }

  if (disableFetch && preloadedLoading) {
    return <EmptyWidgetState text="Carregando dados..." />;
  }
  if (disableFetch && preloadedError) {
    return <EmptyWidgetState text={preloadedError} />;
  }
  if (!disableFetch && widgetQuery.isLoading) {
    return <EmptyWidgetState text="Carregando dados..." />;
  }
  if (!disableFetch && widgetQuery.isError) {
    return <EmptyWidgetState text={(widgetQuery.error as Error).message || "Falha ao carregar dados"} />;
  }
  if (rows.length === 0) {
    return <EmptyWidgetState text="Nenhum dado retornado" />;
  }

  const type = widget.config.widget_type;

  if (type === "table") {
    return <MiniTable rows={rows} widget={widget} />;
  }

  if (type === "kpi") {
    const value = Number(rows[0]?.m0 || 0);
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 py-4">
        <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
          {widget.title || "KPI"}
        </span>
        <span className="text-3xl font-extrabold tracking-tight text-foreground" title={formatFullNumber(value)}>
          {formatCompactNumber(value)}
        </span>
      </div>
    );
  }

  if (type === "line") {
    return (
      <ResponsiveContainer width="100%" height={chartHeight}>
        <ReLineChart data={rows} margin={{ top: 8, right: 8, bottom: 8, left: 8 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="hsl(214, 20%, 88%)" vertical={false} />
          <XAxis
            dataKey="time_bucket"
            tick={{ fontSize: 10 }}
            axisLine={false}
            tickLine={false}
            interval={lineTickInterval}
            minTickGap={20}
            tickFormatter={(value) => {
              const parsed = parseDateLike(value);
              return parsed ? formatDateBR(parsed) : String(value);
            }}
          />
          <YAxis
            tick={{ fontSize: 10 }}
            axisLine={false}
            tickLine={false}
            width={50}
            tickFormatter={(value) => formatCompactNumber(value)}
          />
          <Tooltip
            contentStyle={tooltipStyle}
            labelFormatter={(label) => {
              const parsed = parseDateLike(label);
              return parsed ? formatDateBR(parsed) : String(label);
            }}
            formatter={(value) => [formatCompactNumber(value), metricLabel]}
          />
          <Line type="monotone" dataKey="m0" stroke="hsl(250, 78%, 75%)" strokeWidth={2} dot={false} />
        </ReLineChart>
      </ResponsiveContainer>
    );
  }

  const dim = widget.config.dimensions[0];
  const fixedBarHeight = 22;
  const barGap = 8;
  const barRows = rows.map((row) => ({ ...row, m0: toFiniteNumber(row.m0) }));
  const barDataMax = barRows.reduce((maxValue, row) => Math.max(maxValue, toFiniteNumber(row.m0)), 0);
  const barAxisMax = barDataMax > 0 ? barDataMax * 1.18 : 1;
  const barChartHeight = Math.max(chartHeight, rows.length * (fixedBarHeight + barGap) + 24);
  return (
    <div className="w-full overflow-y-auto" style={{ maxHeight: `${chartHeight}px` }}>
      <div style={{ height: `${barChartHeight}px` }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={barRows} margin={{ top: 8, right: 64, bottom: 8, left: 8 }} layout="vertical" barCategoryGap={barGap}>
            <CartesianGrid strokeDasharray="3 3" stroke="hsl(214, 20%, 88%)" horizontal={false} />
            <XAxis
              type="number"
              tick={{ fontSize: 10 }}
              axisLine={false}
              tickLine={false}
              domain={[0, barAxisMax]}
              allowDataOverflow={false}
              tickFormatter={(value) => formatCompactNumber(value)}
            />
            <YAxis
              type="category"
              dataKey={dim}
              tick={{ fontSize: 10 }}
              axisLine={false}
              tickLine={false}
              width={90}
              tickFormatter={(value) => {
                const parsed = parseDateLike(value);
                return parsed ? formatDateBR(parsed) : String(value);
              }}
            />
            <Tooltip contentStyle={tooltipStyle} formatter={(value) => [formatCompactNumber(value), metricLabel]} />
            <Bar dataKey="m0" fill="hsl(250, 78%, 75%)" radius={[4, 4, 0, 0]} barSize={fixedBarHeight}>
              <LabelList
                dataKey="m0"
                position="right"
                formatter={(value: unknown) => formatCompactNumber(value)}
                offset={10}
                style={{ fontSize: 10, fill: "hsl(0, 0%, 25%)" }}
              />
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
};
