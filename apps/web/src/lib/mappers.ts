import type { Dashboard, DashboardSection, DashboardWidget, WidgetConfig } from "@/types/dashboard";
import type { Datasource, Dataset, View } from "@/types";
import type { ApiDashboard, ApiDashboardWidget, ApiDataset, ApiDatasource, ApiView } from "@/lib/api";

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const asString = (value: unknown, fallback = ""): string =>
  typeof value === "string" ? value : fallback;

const asNumber = (value: unknown, fallback = 0): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

const normalizeColumnType = (rawType: string): "numeric" | "temporal" | "text" | "boolean" => {
  const value = (rawType || "").toLowerCase();
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

const parseWidgetConfig = (raw: unknown): WidgetConfig | null => {
  if (!isObject(raw)) return null;
  const widgetType = asString(raw.widget_type, "table");
  if (!["kpi", "line", "bar", "column", "donut", "table", "text", "dre"].includes(widgetType)) return null;
  const metrics = Array.isArray(raw.metrics)
    ? raw.metrics
        .filter(isObject)
        .map((metric) => ({
          op: asString(metric.op, "count") as WidgetConfig["metrics"][number]["op"],
          column: typeof metric.column === "string" ? metric.column : undefined,
          line_y_axis: (asString(metric.line_y_axis, "left") === "right" ? "right" : "left") as "left" | "right",
        }))
    : [];

  const filters = Array.isArray(raw.filters)
    ? raw.filters
        .filter(isObject)
        .map((filter) => ({
          column: asString(filter.column),
          op: asString(filter.op, "eq") as WidgetConfig["filters"][number]["op"],
          value: filter.value,
        }))
    : [];

  const orderBy = Array.isArray(raw.order_by)
    ? raw.order_by
        .filter(isObject)
        .map((order) => ({
          column: typeof order.column === "string" ? order.column : undefined,
          metric_ref: typeof order.metric_ref === "string" ? order.metric_ref : undefined,
          direction: asString(order.direction, "desc") as "asc" | "desc",
        }))
    : [];

  const dimensions = Array.isArray(raw.dimensions) ? raw.dimensions.filter((item): item is string => typeof item === "string") : [];
  const columns = Array.isArray(raw.columns) ? raw.columns.filter((item): item is string => typeof item === "string") : undefined;

  const parsed: WidgetConfig = {
    widget_type: widgetType as WidgetConfig["widget_type"],
    view_name: asString(raw.view_name),
    show_title: typeof raw.show_title === "boolean" ? raw.show_title : true,
    kpi_show_as: (["currency_brl", "number_2", "integer"].includes(asString(raw.kpi_show_as, "number_2"))
      ? asString(raw.kpi_show_as, "number_2")
      : "number_2") as "currency_brl" | "number_2" | "integer",
    composite_metric: isObject(raw.composite_metric)
      ? {
          type: (asString(raw.composite_metric.type, "agg_over_time_bucket") as "avg_per_time_bucket" | "agg_over_time_bucket"),
          inner_agg: asString(
            raw.composite_metric.inner_agg,
            asString(raw.composite_metric.agg, "sum"),
          ) as "count" | "sum" | "avg" | "min" | "max" | "distinct_count",
          outer_agg: asString(raw.composite_metric.outer_agg, "avg") as "count" | "sum" | "avg" | "min" | "max" | "distinct_count",
          value_column: asString(raw.composite_metric.value_column) || undefined,
          time_column: asString(raw.composite_metric.time_column),
          granularity: asString(raw.composite_metric.granularity, "day") as "day" | "week" | "month" | "hour",
        }
      : undefined,
    size: {
      width: [1, 2, 3, 4].includes(asNumber((raw.size as Record<string, unknown> | undefined)?.width, 1))
        ? (asNumber((raw.size as Record<string, unknown> | undefined)?.width, 1) as 1 | 2 | 3 | 4)
        : 1,
      height: asNumber((raw.size as Record<string, unknown> | undefined)?.height, 1) === 0.5 ? 0.5 : 1,
    },
    text_style: isObject(raw.text_style)
      ? {
          content: asString(raw.text_style.content),
          font_size: Math.max(12, Math.min(72, asNumber(raw.text_style.font_size, 18))),
          align: (["left", "center", "right"].includes(asString(raw.text_style.align, "left"))
            ? asString(raw.text_style.align, "left")
            : "left") as "left" | "center" | "right",
        }
      : undefined,
    metrics,
    dimensions,
    line_data_labels_enabled: typeof raw.line_data_labels_enabled === "boolean" ? raw.line_data_labels_enabled : false,
    line_data_labels_percent: Math.max(25, Math.min(100, asNumber(raw.line_data_labels_percent, 60))),
    line_label_window: [3, 5, 7].includes(asNumber(raw.line_label_window, 3)) ? asNumber(raw.line_label_window, 3) : 3,
    line_label_min_gap: Math.max(1, Math.min(6, asNumber(raw.line_label_min_gap, 2))),
    line_label_mode: (["peak", "valley", "both"].includes(asString(raw.line_label_mode, "both"))
      ? asString(raw.line_label_mode, "both")
      : "both") as "peak" | "valley" | "both",
    donut_show_legend: typeof raw.donut_show_legend === "boolean" ? raw.donut_show_legend : true,
    donut_data_labels_enabled: typeof raw.donut_data_labels_enabled === "boolean" ? raw.donut_data_labels_enabled : false,
    donut_data_labels_min_percent: Math.max(1, Math.min(100, asNumber(raw.donut_data_labels_min_percent, 6))),
    donut_metric_display: asString(raw.donut_metric_display, "value") === "percent" ? "percent" : "value",
    dre_rows: Array.isArray(raw.dre_rows)
      ? raw.dre_rows
          .filter(isObject)
          .map((item) => ({
            title: asString(item.title),
            row_type: (["result", "deduction", "detail"].includes(asString(item.row_type, "result"))
              ? asString(item.row_type, "result")
              : "result") as "result" | "deduction" | "detail",
            metrics: Array.isArray(item.metrics)
              ? item.metrics
                  .filter(isObject)
                  .map((metric) => ({
                    op: asString(metric.op, "count") as WidgetConfig["metrics"][number]["op"],
                    column: typeof metric.column === "string" ? metric.column : undefined,
                    line_y_axis: (asString(metric.line_y_axis, "left") === "right" ? "right" : "left") as "left" | "right",
                  }))
              : isObject(item.metric)
                ? [{
                    op: asString(item.metric.op, "count") as WidgetConfig["metrics"][number]["op"],
                    column: typeof item.metric.column === "string" ? item.metric.column : undefined,
                    line_y_axis: (asString(item.metric.line_y_axis, "left") === "right" ? "right" : "left") as "left" | "right",
                  }]
                : [{ op: "count" as const, column: undefined, line_y_axis: "left" as const }],
          }))
      : undefined,
    dre_percent_base_row_index: typeof raw.dre_percent_base_row_index === "number"
      ? Math.max(0, Math.trunc(raw.dre_percent_base_row_index))
      : undefined,
    filters,
    order_by: orderBy,
    table_column_formats: isObject(raw.table_column_formats)
      ? Object.entries(raw.table_column_formats).reduce<Record<string, string>>((acc, [key, value]) => {
          if (typeof value === "string") acc[key] = value;
          return acc;
        }, {})
      : undefined,
    table_page_size: Math.max(1, asNumber(raw.table_page_size, 25)),
  };

  if (isObject(raw.time) && typeof raw.time.column === "string" && typeof raw.time.granularity === "string") {
    parsed.time = {
      column: raw.time.column,
      granularity: raw.time.granularity as "day" | "week" | "month" | "hour",
    };
  }
  if (columns) {
    parsed.columns = columns;
  }
  if (typeof raw.limit === "number") {
    parsed.limit = raw.limit;
  }
  if (typeof raw.top_n === "number") {
    parsed.top_n = raw.top_n;
  }
  if (typeof raw.offset === "number") {
    parsed.offset = raw.offset;
  }
  return parsed;
};

const mapWidget = (item: ApiDashboardWidget): DashboardWidget | null => {
  const config = parseWidgetConfig(item.query_config);
  if (!config) return null;
  return {
    id: String(item.id),
    title: item.title || "",
    position: item.position,
    configVersion: item.config_version || 1,
    config,
  };
};

const parseSection = (raw: unknown, widgetsById: Map<string, DashboardWidget>): DashboardSection | null => {
  if (!isObject(raw)) return null;
  const columnsRaw = asNumber(raw.columns, 2);
  const columns = columnsRaw === 1 || columnsRaw === 2 || columnsRaw === 3 || columnsRaw === 4 ? columnsRaw : 2;
  const refs = Array.isArray(raw.widgets) ? raw.widgets : [];
  const widgets: DashboardWidget[] = [];

  refs.forEach((ref) => {
    if (typeof ref === "number" || typeof ref === "string") {
      const widget = widgetsById.get(String(ref));
      if (widget) widgets.push(widget);
      return;
    }
    if (isObject(ref)) {
      const refId = String(ref.widget_id || ref.id || "");
      const widget = widgetsById.get(refId);
      if (widget) widgets.push(widget);
    }
  });

  return {
    id: asString(raw.id, `sec-${Date.now()}`),
    title: asString(raw.title),
    showTitle: typeof raw.show_title === "boolean" ? raw.show_title : true,
    columns,
    widgets,
  };
};

export const mapDatasource = (item: ApiDatasource): Datasource => ({
  id: String(item.id),
  name: item.name,
  schemaPattern: item.schema_pattern || "*",
  lastSync: item.last_synced_at || "Never",
  status: item.is_active ? "active" : "inactive",
  description: item.description || "",
});

export const mapView = (item: ApiView): View => ({
  id: String(item.id),
  schema: item.schema_name,
  name: item.view_name,
  status: item.is_active ? "active" : "inactive",
  description: item.description || "",
  rowCount: 0,
  datasourceId: String(item.datasource_id),
  columns: item.columns.map((col) => ({
    name: col.column_name,
    type: normalizeColumnType(col.column_type),
    description: col.description || undefined,
  })),
});

export const mapDataset = (item: ApiDataset, dashboardIds: string[] = []): Dataset => ({
  id: String(item.id),
  name: item.name,
  description: item.description || "",
  viewId: String(item.view_id),
  dashboardIds,
  createdAt: item.created_at,
});

export const mapDashboard = (item: ApiDashboard): Dashboard => {
  const widgets = item.widgets.map(mapWidget).filter((widget): widget is DashboardWidget => !!widget);
  const widgetsById = new Map<string, DashboardWidget>();
  widgets.forEach((widget) => widgetsById.set(widget.id, widget));

  const parsedSections = (item.layout_config || [])
    .map((section) => parseSection(section, widgetsById))
    .filter((section): section is DashboardSection => !!section);

  const placedIds = new Set(parsedSections.flatMap((section) => section.widgets.map((widget) => widget.id)));
  const unplacedWidgets = widgets.filter((widget) => !placedIds.has(widget.id));

  if (unplacedWidgets.length > 0) {
    parsedSections.push({
      id: `sec-unplaced-${item.id}`,
      title: "Geral",
      columns: 2,
      widgets: unplacedWidgets,
    });
  }

  const sections = parsedSections.length > 0
    ? parsedSections
    : [{
        id: `sec-${item.id}`,
        title: "Geral",
        columns: 2 as const,
        widgets,
      }];

  return {
    id: String(item.id),
    title: item.name,
    datasetId: String(item.dataset_id),
    nativeFilters: (item.native_filters || []).filter(isObject).map((filter) => ({
      column: asString(filter.column),
      op: asString(filter.op, "eq") as Dashboard["nativeFilters"][number]["op"],
      value: filter.value,
    })),
    sections,
    createdAt: item.created_at,
    updatedAt: item.updated_at,
  };
};

export const sectionsToLayoutConfig = (sections: DashboardSection[]): Record<string, unknown>[] =>
  sections.map((section) => ({
    id: section.id,
    title: section.title,
    show_title: section.showTitle !== false,
    columns: section.columns,
    widgets: section.widgets.map((widget) => ({ widget_id: Number(widget.id) })),
  }));
