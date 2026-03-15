export type WidgetType = "kpi" | "line" | "bar" | "column" | "donut" | "table" | "text" | "dre";
export type BuilderWidgetPresetKey =
  | "kpi_primary"
  | "kpi_trend"
  | "category_comparison"
  | "top_10_ranking"
  | "temporal_evolution_monthly"
  | "share_distribution"
  | "temporal_composition"
  | "detailed_table";
export type MetricOp = "count" | "sum" | "avg" | "min" | "max" | "distinct_count";
export type TimeGranularity = "day" | "week" | "month" | "hour" | "timestamp";
export type WidgetWidth = 1 | 2 | 3 | 4 | 5 | 6;
export type SectionColumns = 1 | 2 | 3 | 4 | 5 | 6;
export type SectionGridCols = 6;
export type CanonicalWidgetWidth = 1 | 2 | 3 | 4 | 6;
export type WidgetHeight = 0.5 | 1 | 2;
export type WidgetPadding = "compact" | "normal" | "comfortable";
export type WidgetPalette = "default" | "warm" | "cool" | "mono" | "vivid";
export type TextAlign = "left" | "center" | "right";
export type TableColumnAggregation = "none" | MetricOp;
export interface TableColumnInstance {
  id: string;
  source: string;
  label?: string;
  aggregation?: TableColumnAggregation;
  format?: string;
  prefix?: string;
  suffix?: string;
}
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
  alias?: string;
  prefix?: string;
  suffix?: string;
  line_style?: "solid" | "dashed" | "dotted";
  line_y_axis?: "left" | "right";
}

export interface WidgetFilter {
  column: string;
  op: FilterOp;
  value?: unknown;
}

export interface DashboardNativeFilter extends WidgetFilter {
  visible?: boolean;
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
  kpi_show_as?: "currency_brl" | "number_2" | "integer" | "percent";
  kpi_abbreviation_mode?: "auto" | "always";
  kpi_decimals?: number;
  kpi_prefix?: string;
  kpi_suffix?: string;
  kpi_show_trend?: boolean;
  kpi_type?: "atomic" | "derived";
  formula?: string;
  dependencies?: string[];
  kpi_dependencies?: Array<{
    source_type?: "widget" | "column";
    widget_id?: number | string;
    column?: string;
    alias: string;
  }>;
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
  visual_padding?: WidgetPadding;
  visual_palette?: WidgetPalette;
  metrics: WidgetMetric[];
  dimensions: string[];
  time?: {
    column: string;
    granularity: TimeGranularity;
  };
  line_data_labels_enabled?: boolean;
  line_show_grid?: boolean;
  bar_data_labels_enabled?: boolean;
  bar_show_grid?: boolean;
  bar_show_percent_of_total?: boolean;
  line_data_labels_percent?: number;
  line_label_window?: number;
  line_label_min_gap?: number;
  line_label_mode?: "peak" | "valley" | "both";
  donut_show_legend?: boolean;
  donut_data_labels_enabled?: boolean;
  donut_data_labels_min_percent?: number;
  donut_metric_display?: "value" | "percent";
  donut_group_others_enabled?: boolean;
  donut_group_others_top_n?: number;
  dre_rows?: Array<{
    title: string;
    row_type: "result" | "deduction" | "detail";
    impact?: "add" | "subtract";
    metrics: WidgetMetric[];
  }>;
  dre_percent_base_row_index?: number;
  columns?: string[];
  table_column_instances?: TableColumnInstance[];
  table_column_labels?: Record<string, string>;
  table_column_aggs?: Record<string, TableColumnAggregation>;
  table_column_formats?: Record<string, string>;
  table_column_prefixes?: Record<string, string>;
  table_column_suffixes?: Record<string, string>;
  table_page_size?: number;
  table_density?: WidgetPadding;
  table_zebra_rows?: boolean;
  table_sticky_header?: boolean;
  table_borders?: boolean;
  table_default_text_align?: TextAlign;
  table_default_number_align?: TextAlign;
  filters: WidgetFilter[];
  order_by: WidgetOrderBy[];
  top_n?: number;
  limit?: number;
  offset?: number;
}

export interface DashboardLayoutItem {
  i: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface DashboardWidget {
  id: string;
  type: WidgetType;
  sectionId: string;
  props: WidgetConfig;
  title: string;
  position: number;
  configVersion: number;
  // Legacy alias kept for existing renderer/config-panel integration.
  config: WidgetConfig;
}

export interface DashboardSection {
  id: string;
  title: string;
  showTitle?: boolean;
  columns: SectionColumns;
  layout: DashboardLayoutItem[];
  widgets: DashboardWidget[];
}

export interface Dashboard {
  id: string;
  title: string;
  datasetId: string;
  isOwner: boolean;
  accessLevel: "owner" | "edit" | "view";
  accessSource: "owner" | "direct" | "workspace" | "public";
  visibility: "private" | "workspace_view" | "workspace_edit" | "public_view";
  publicShareKey?: string;
  nativeFilters: DashboardNativeFilter[];
  sections: DashboardSection[];
  createdAt: string;
  updatedAt: string;
}

export const SECTION_GRID_COLS: SectionGridCols = 6;
export const CANONICAL_WIDGET_WIDTHS: readonly CanonicalWidgetWidth[] = [1, 2, 3, 4, 6] as const;
export const CANONICAL_WIDGET_ROW_SPANS: readonly [2, 4, 8] = [2, 4, 8];

export const snapToCanonicalWidgetWidth = (value: number): CanonicalWidgetWidth => {
  let best = CANONICAL_WIDGET_WIDTHS[0];
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of CANONICAL_WIDGET_WIDTHS) {
    const distance = Math.abs(candidate - value);
    if (distance < bestDistance || (distance === bestDistance && candidate > best)) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
};

export const widgetHeightToGridRows = (height?: WidgetHeight): number => {
  if (height === 0.5) return 2;
  if (height === 2) return 8;
  return 4;
};

export const snapToCanonicalWidgetRows = (
  value: number,
  minRows: number = 2,
  maxRows: number = CANONICAL_WIDGET_ROW_SPANS[CANONICAL_WIDGET_ROW_SPANS.length - 1],
): number => {
  const candidates = CANONICAL_WIDGET_ROW_SPANS.filter((rows) => rows >= minRows && rows <= maxRows);
  if (candidates.length === 0) {
    return Math.max(minRows, Math.min(maxRows, Math.floor(value)));
  }

  let best = candidates[0];
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const distance = Math.abs(candidate - value);
    if (distance < bestDistance || (distance === bestDistance && candidate > best)) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
};

export const gridRowsToWidgetHeight = (rows: number): WidgetHeight => {
  if (rows <= 2) return 0.5;
  if (rows >= 7) return 2;
  return 1;
};

export const normalizeLayoutItem = (item: DashboardLayoutItem): DashboardLayoutItem => ({
  i: item.i,
  x: Math.max(0, Math.min(SECTION_GRID_COLS - 1, Math.floor(item.x))),
  y: Math.max(0, Math.floor(item.y)),
  w: snapToCanonicalWidgetWidth(Math.max(1, Math.min(SECTION_GRID_COLS, Math.floor(item.w)))),
  h: Math.max(1, Math.floor(item.h)),
});

export const createSection = (): DashboardSection => ({
  id: `sec-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
  title: "",
  showTitle: true,
  columns: SECTION_GRID_COLS,
  layout: [],
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
      show_title: false,
      visual_padding: "normal",
      visual_palette: "default",
      kpi_show_as: "number_2",
      kpi_abbreviation_mode: "always",
      kpi_decimals: 2,
      kpi_show_trend: false,
      kpi_type: "atomic",
      formula: undefined,
      dependencies: [],
      kpi_dependencies: [],
      size: { width: 1, height: 0.5 },
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
      visual_padding: "normal",
      visual_palette: "default",
      line_data_labels_enabled: false,
      line_show_grid: false,
      line_data_labels_percent: 60,
      line_label_window: 3,
      line_label_min_gap: 2,
      line_label_mode: "both",
      size: { width: 1, height: 1 },
      metrics: [{ op: "count", column: fallback?.name, line_y_axis: "left" }],
      dimensions: [],
      time: {
        column: temporal?.name || fallback?.name || "",
        granularity: "day",
      },
      filters: [],
      order_by: [],
    };
  }

  if (type === "bar" || type === "column" || type === "donut") {
    const defaultDimension = type === "column"
      ? (temporal?.name ? `__time_month__:${temporal.name}` : (categorical?.name || fallback?.name || ""))
      : (categorical?.name || fallback?.name || "");
    return {
      widget_type: type,
      view_name: viewName,
      show_title: true,
      visual_padding: "normal",
      visual_palette: "default",
      bar_data_labels_enabled: type === "bar" || type === "column" ? false : undefined,
      bar_show_grid: type === "bar" || type === "column" ? false : undefined,
      bar_show_percent_of_total: type === "bar" || type === "column" ? false : undefined,
      donut_show_legend: type === "donut" ? true : undefined,
      donut_data_labels_enabled: type === "donut" ? false : undefined,
      donut_data_labels_min_percent: type === "donut" ? 6 : undefined,
      donut_metric_display: type === "donut" ? "value" : undefined,
      donut_group_others_enabled: type === "donut" ? true : undefined,
      donut_group_others_top_n: type === "donut" ? 3 : undefined,
      size: { width: 1, height: 1 },
      metrics: [{ op: "count", column: fallback?.name }],
      dimensions: [defaultDimension],
      filters: [],
      order_by: type === "bar"
        ? [{ metric_ref: "m0", direction: "desc" }]
        : type === "column"
          ? [{ column: defaultDimension, direction: "asc" }]
        : [],
    };
  }

  if (type === "text") {
    return {
      widget_type: "text",
      view_name: viewName,
      show_title: true,
      visual_padding: "normal",
      visual_palette: "default",
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

  if (type === "dre") {
    return {
      widget_type: "dre",
      view_name: viewName,
      show_title: true,
      visual_padding: "normal",
      visual_palette: "default",
      size: { width: 1, height: 1 },
      metrics: [],
      dimensions: [],
      dre_rows: [],
      dre_percent_base_row_index: undefined,
      filters: [],
      order_by: [],
    };
  }

  return {
    widget_type: "table",
    view_name: viewName,
    show_title: true,
    visual_padding: "normal",
    visual_palette: "default",
    size: { width: 1, height: 1 },
    metrics: [],
    dimensions: [],
    columns: columns.slice(0, Math.min(5, columns.length)).map((column) => column.name),
    table_column_instances: columns.slice(0, Math.min(5, columns.length)).map((column, index) => ({
      id: `${column.name}__${index}`,
      source: column.name,
      label: undefined,
      aggregation: "none",
      format: undefined,
      prefix: undefined,
      suffix: undefined,
    })),
    table_column_labels: {},
    table_column_aggs: {},
    table_column_formats: {},
    table_column_prefixes: {},
    table_column_suffixes: {},
    table_page_size: 25,
    table_density: "normal",
    table_zebra_rows: true,
    table_sticky_header: true,
    table_borders: true,
    table_default_text_align: "left",
    table_default_number_align: "right",
    filters: [],
    order_by: [],
  };
};
