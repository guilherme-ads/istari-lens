export type WidgetType = "kpi" | "line" | "bar" | "table" | "text";
export type MetricOp = "count" | "sum" | "avg" | "min" | "max" | "distinct_count";
export type TimeGranularity = "day" | "week" | "month";
export type WidgetWidth = 1 | 2 | 3 | 4;
export type WidgetHeight = 0.5 | 1;
export type TextAlign = "left" | "center" | "right";
export type FilterOp =
  | "eq"
  | "neq"
  | "gt"
  | "lt"
  | "gte"
  | "lte"
  | "in"
  | "not_in"
  | "contains"
  | "is_null"
  | "not_null"
  | "between";

export interface WidgetMetric {
  op: MetricOp;
  column?: string;
}

export interface WidgetFilter {
  column: string;
  op: FilterOp;
  value?: unknown;
}

export interface WidgetOrderBy {
  column?: string;
  metric_ref?: string;
  direction: "asc" | "desc";
}

export interface WidgetConfig {
  widget_type: WidgetType;
  view_name: string;
  show_title?: boolean;
  composite_metric?: {
    type: "avg_per_time_bucket" | "agg_over_time_bucket";
    inner_agg: MetricOp;
    outer_agg: MetricOp;
    agg?: MetricOp;
    value_column?: string;
    time_column: string;
    granularity: TimeGranularity;
  };
  size?: {
    width: WidgetWidth;
    height: WidgetHeight;
  };
  text_style?: {
    content: string;
    font_size: number;
    align: TextAlign;
  };
  metrics: WidgetMetric[];
  dimensions: string[];
  time?: {
    column: string;
    granularity: TimeGranularity;
  };
  columns?: string[];
  table_column_formats?: Record<string, string>;
  table_page_size?: number;
  filters: WidgetFilter[];
  order_by: WidgetOrderBy[];
  top_n?: number;
  limit?: number;
  offset?: number;
}

export interface DashboardWidget {
  id: string;
  title: string;
  position: number;
  configVersion: number;
  config: WidgetConfig;
}

export interface DashboardSection {
  id: string;
  title: string;
  showTitle?: boolean;
  columns: 1 | 2 | 3 | 4;
  widgets: DashboardWidget[];
}

export interface Dashboard {
  id: string;
  title: string;
  datasetId: string;
  nativeFilters: WidgetFilter[];
  sections: DashboardSection[];
  createdAt: string;
  updatedAt: string;
}

export const createSection = (): DashboardSection => ({
  id: `sec-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
  title: "",
  showTitle: true,
  columns: 2,
  widgets: [],
});

export const createDefaultWidgetConfig = (params: {
  type: WidgetType;
  viewName: string;
  columns: Array<{ name: string; type: string }>;
}): WidgetConfig => {
  const { type, viewName, columns } = params;
  const numeric = columns.find((column) => column.type === "numeric");
  const temporal = columns.find((column) => column.type === "temporal");
  const categorical = columns.find((column) => column.type === "text" || column.type === "boolean");
  const fallback = columns[0];

  if (type === "kpi") {
    return {
      widget_type: "kpi",
      view_name: viewName,
      show_title: true,
      size: { width: 1, height: 1 },
      composite_metric: undefined,
      metrics: [{ op: "count", column: numeric?.name || fallback?.name }],
      dimensions: [],
      filters: [],
      order_by: [],
    };
  }

  if (type === "line") {
    return {
      widget_type: "line",
      view_name: viewName,
      show_title: true,
      size: { width: 1, height: 1 },
      metrics: [{ op: "count", column: fallback?.name }],
      dimensions: [],
      time: {
        column: temporal?.name || fallback?.name || "",
        granularity: "day",
      },
      filters: [],
      order_by: [],
    };
  }

  if (type === "bar") {
    return {
      widget_type: "bar",
      view_name: viewName,
      show_title: true,
      size: { width: 1, height: 1 },
      metrics: [{ op: "count", column: fallback?.name }],
      dimensions: [categorical?.name || fallback?.name || ""],
      filters: [],
      order_by: [],
    };
  }

  if (type === "text") {
    return {
      widget_type: "text",
      view_name: viewName,
      show_title: true,
      size: { width: 1, height: 1 },
      text_style: {
        content: "Texto",
        font_size: 18,
        align: "left",
      },
      metrics: [],
      dimensions: [],
      filters: [],
      order_by: [],
    };
  }

  return {
    widget_type: "table",
    view_name: viewName,
    show_title: true,
    size: { width: 1, height: 1 },
    metrics: [],
    dimensions: [],
    columns: columns.slice(0, Math.min(5, columns.length)).map((column) => column.name),
    table_column_formats: {},
    table_page_size: 25,
    filters: [],
    order_by: [],
  };
};
