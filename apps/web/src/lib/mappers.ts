import {
  SECTION_GRID_COLS,
  gridRowsToWidgetHeight,
  normalizeLayoutItem,
  snapToCanonicalWidgetWidth,
  widgetHeightToGridRows,
  type Dashboard,
  type DashboardLayoutItem,
  type DashboardSection,
  type DashboardWidget,
  type WidgetConfig,
} from "@/types/dashboard";
import type { Datasource, Dataset, View } from "@/types";
import type { ApiDashboard, ApiDashboardWidget, ApiDataset, ApiDatasource, ApiView } from "@/lib/api";
import { normalizeText } from "@/lib/text";
import { normalizeApiDateTime } from "@/lib/datetime";

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const asString = (value: unknown, fallback = ""): string =>
  typeof value === "string" ? normalizeText(value) : fallback;

const asNumber = (value: unknown, fallback = 0): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

const normalizeWidgetDependencyId = (value: unknown): number | string | undefined => {
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

const normalizeColumnType = (rawType: string): "numeric" | "temporal" | "text" | "boolean" => {
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
          alias: typeof metric.alias === "string" ? metric.alias : undefined,
          prefix: typeof metric.prefix === "string" ? metric.prefix : undefined,
          suffix: typeof metric.suffix === "string" ? metric.suffix : undefined,
          line_style: (["solid", "dashed", "dotted"].includes(asString(metric.line_style, "solid"))
            ? asString(metric.line_style, "solid")
            : "solid") as "solid" | "dashed" | "dotted",
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
    kpi_show_as: (["currency_brl", "number_2", "integer", "percent"].includes(asString(raw.kpi_show_as, "number_2"))
      ? asString(raw.kpi_show_as, "number_2")
      : "number_2") as "currency_brl" | "number_2" | "integer" | "percent",
    kpi_abbreviation_mode: (["auto", "always"].includes(asString(raw.kpi_abbreviation_mode, "always"))
      ? asString(raw.kpi_abbreviation_mode, "always")
      : "always") as "auto" | "always",
    kpi_decimals: Math.max(0, Math.min(8, asNumber(raw.kpi_decimals, 2))),
    kpi_prefix: asString(raw.kpi_prefix) || undefined,
    kpi_suffix: asString(raw.kpi_suffix) || undefined,
    kpi_show_trend: typeof raw.kpi_show_trend === "boolean" ? raw.kpi_show_trend : false,
    kpi_type: (["atomic", "derived"].includes(asString(raw.kpi_type, "atomic"))
      ? asString(raw.kpi_type, "atomic")
      : "atomic") as "atomic" | "derived",
    formula: asString(raw.formula) || undefined,
    dependencies: Array.isArray(raw.dependencies)
      ? raw.dependencies.filter((item): item is string => typeof item === "string")
      : [],
    kpi_dependencies: Array.isArray(raw.kpi_dependencies)
      ? raw.kpi_dependencies
          .filter(isObject)
          .map((item) => {
            const normalizedWidgetId = normalizeWidgetDependencyId(item.widget_id);
            return {
              source_type: (asString(item.source_type, "widget") === "column" ? "column" : "widget") as "widget" | "column",
              widget_id: normalizedWidgetId,
              column: asString(item.column) || undefined,
              alias: asString(item.alias),
            };
          })
          .filter((item) => item.alias.length > 0 && (
            item.source_type === "column"
              ? !!item.column
              : normalizeWidgetDependencyId(item.widget_id) !== undefined
          ))
      : [],
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
          granularity: asString(raw.composite_metric.granularity, "day") as "day" | "week" | "month" | "hour" | "timestamp",
        }
      : undefined,
    size: {
      width: [1, 2, 3, 4, 5, 6].includes(asNumber((raw.size as Record<string, unknown> | undefined)?.width, 1))
        ? (asNumber((raw.size as Record<string, unknown> | undefined)?.width, 1) as 1 | 2 | 3 | 4 | 5 | 6)
        : 1,
      height: (
        asNumber((raw.size as Record<string, unknown> | undefined)?.height, 1) === 0.5
          ? 0.5
          : asNumber((raw.size as Record<string, unknown> | undefined)?.height, 1) === 2
            ? 2
            : 1
      ) as 0.5 | 1 | 2,
    },
    visual_padding: (["compact", "normal", "comfortable"].includes(asString(raw.visual_padding, "normal"))
      ? asString(raw.visual_padding, "normal")
      : "normal") as "compact" | "normal" | "comfortable",
    visual_palette: (["default", "warm", "cool", "mono", "vivid"].includes(asString(raw.visual_palette, "default"))
      ? asString(raw.visual_palette, "default")
      : "default") as "default" | "warm" | "cool" | "mono" | "vivid",
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
    line_show_grid: typeof raw.line_show_grid === "boolean" ? raw.line_show_grid : true,
    bar_data_labels_enabled: typeof raw.bar_data_labels_enabled === "boolean" ? raw.bar_data_labels_enabled : true,
    bar_show_grid: typeof raw.bar_show_grid === "boolean" ? raw.bar_show_grid : false,
    bar_show_percent_of_total: typeof raw.bar_show_percent_of_total === "boolean" ? raw.bar_show_percent_of_total : false,
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
            impact: (["add", "subtract"].includes(asString(item.impact, ""))
              ? asString(item.impact, "")
              : (asString(item.row_type, "result") === "deduction" ? "subtract" : "add")) as "add" | "subtract",
            metrics: Array.isArray(item.metrics)
              ? item.metrics
                  .filter(isObject)
                  .map((metric) => ({
                    op: asString(metric.op, "count") as WidgetConfig["metrics"][number]["op"],
                    column: typeof metric.column === "string" ? metric.column : undefined,
                    alias: typeof metric.alias === "string" ? metric.alias : undefined,
                    prefix: typeof metric.prefix === "string" ? metric.prefix : undefined,
                    suffix: typeof metric.suffix === "string" ? metric.suffix : undefined,
                    line_style: (["solid", "dashed", "dotted"].includes(asString(metric.line_style, "solid"))
                      ? asString(metric.line_style, "solid")
                      : "solid") as "solid" | "dashed" | "dotted",
                    line_y_axis: (asString(metric.line_y_axis, "left") === "right" ? "right" : "left") as "left" | "right",
                  }))
              : isObject(item.metric)
                ? [{
                    op: asString(item.metric.op, "count") as WidgetConfig["metrics"][number]["op"],
                    column: typeof item.metric.column === "string" ? item.metric.column : undefined,
                    alias: typeof item.metric.alias === "string" ? item.metric.alias : undefined,
                    prefix: typeof item.metric.prefix === "string" ? item.metric.prefix : undefined,
                    suffix: typeof item.metric.suffix === "string" ? item.metric.suffix : undefined,
                    line_style: (["solid", "dashed", "dotted"].includes(asString(item.metric.line_style, "solid"))
                      ? asString(item.metric.line_style, "solid")
                      : "solid") as "solid" | "dashed" | "dotted",
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
    table_column_instances: Array.isArray(raw.table_column_instances)
      ? raw.table_column_instances
          .filter(isObject)
          .map((item, index) => {
            const source = asString(item.source);
            const id = asString(item.id) || `${source || "column"}__${index}`;
            const aggregationRaw = asString(item.aggregation, "none");
            const aggregation = ["none", "count", "sum", "avg", "min", "max", "distinct_count"].includes(aggregationRaw)
              ? aggregationRaw as "none" | "count" | "sum" | "avg" | "min" | "max" | "distinct_count"
              : "none";
            return {
              id,
              source,
              label: asString(item.label) || undefined,
              aggregation,
              format: asString(item.format) || undefined,
              prefix: asString(item.prefix) || undefined,
              suffix: asString(item.suffix) || undefined,
            };
          })
          .filter((item) => !!item.source)
      : undefined,
    table_column_labels: isObject(raw.table_column_labels)
      ? Object.entries(raw.table_column_labels).reduce<Record<string, string>>((acc, [key, value]) => {
          if (typeof value === "string" && value.trim()) acc[key] = value;
          return acc;
        }, {})
      : undefined,
    table_column_aggs: isObject(raw.table_column_aggs)
      ? Object.entries(raw.table_column_aggs).reduce<Record<string, "none" | "count" | "sum" | "avg" | "min" | "max" | "distinct_count">>((acc, [key, value]) => {
          if (typeof value === "string" && ["none", "count", "sum", "avg", "min", "max", "distinct_count"].includes(value)) {
            acc[key] = value as "none" | "count" | "sum" | "avg" | "min" | "max" | "distinct_count";
          }
          return acc;
        }, {})
      : undefined,
    table_column_formats: isObject(raw.table_column_formats)
      ? Object.entries(raw.table_column_formats).reduce<Record<string, string>>((acc, [key, value]) => {
          if (typeof value === "string") acc[key] = value;
          return acc;
        }, {})
      : undefined,
    table_column_prefixes: isObject(raw.table_column_prefixes)
      ? Object.entries(raw.table_column_prefixes).reduce<Record<string, string>>((acc, [key, value]) => {
          if (typeof value === "string") acc[key] = value;
          return acc;
        }, {})
      : undefined,
    table_column_suffixes: isObject(raw.table_column_suffixes)
      ? Object.entries(raw.table_column_suffixes).reduce<Record<string, string>>((acc, [key, value]) => {
          if (typeof value === "string") acc[key] = value;
          return acc;
        }, {})
      : undefined,
    table_page_size: Math.max(1, asNumber(raw.table_page_size, 25)),
    table_density: (["compact", "normal", "comfortable"].includes(asString(raw.table_density, "normal"))
      ? asString(raw.table_density, "normal")
      : "normal") as "compact" | "normal" | "comfortable",
    table_zebra_rows: typeof raw.table_zebra_rows === "boolean" ? raw.table_zebra_rows : true,
    table_sticky_header: typeof raw.table_sticky_header === "boolean" ? raw.table_sticky_header : true,
    table_borders: typeof raw.table_borders === "boolean" ? raw.table_borders : true,
    table_default_text_align: (["left", "center", "right"].includes(asString(raw.table_default_text_align, "left"))
      ? asString(raw.table_default_text_align, "left")
      : "left") as "left" | "center" | "right",
    table_default_number_align: (["left", "center", "right"].includes(asString(raw.table_default_number_align, "right"))
      ? asString(raw.table_default_number_align, "right")
      : "right") as "left" | "center" | "right",
  };

  if (isObject(raw.time) && typeof raw.time.column === "string" && typeof raw.time.granularity === "string") {
    parsed.time = {
      column: raw.time.column,
      granularity: raw.time.granularity as "day" | "week" | "month" | "hour" | "timestamp",
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

const clampSectionColumns = (value: number): DashboardSection["columns"] => (
  value === 1 || value === 2 || value === 3 || value === 4 || value === 5 || value === 6
    ? value as DashboardSection["columns"]
    : SECTION_GRID_COLS
);

const parseLayoutItemFromRef = (raw: unknown, widgetId: string): DashboardLayoutItem | null => {
  if (!isObject(raw)) return null;
  if (typeof raw.x !== "number" || typeof raw.y !== "number" || typeof raw.w !== "number" || typeof raw.h !== "number") {
    return null;
  }
  return normalizeLayoutItem({
    i: widgetId,
    x: raw.x,
    y: raw.y,
    w: raw.w,
    h: raw.h,
  });
};

const defaultWidgetLayout = (widget: DashboardWidget): DashboardLayoutItem => ({
  i: widget.id,
  x: 0,
  y: 0,
  w: snapToCanonicalWidgetWidth(widget.props.size?.width || widget.config.size?.width || 2),
  h: widgetHeightToGridRows(widget.props.size?.height || widget.config.size?.height || 1),
});

const buildSectionLayout = (
  widgets: DashboardWidget[],
  existingItems: DashboardLayoutItem[],
): DashboardLayoutItem[] => {
  const byId = new Map(existingItems.map((item) => [item.i, normalizeLayoutItem(item)]));
  const normalizedExisting = Array.from(byId.values());
  const bottom = normalizedExisting.reduce((maxY, item) => Math.max(maxY, item.y + item.h), 0);
  let cursorX = 0;
  let cursorY = bottom;
  let currentRowHeight = 1;

  const nextLayout: DashboardLayoutItem[] = [];
  widgets.forEach((widget) => {
    const existing = byId.get(widget.id);
    if (existing) {
      nextLayout.push({ ...existing, i: widget.id });
      return;
    }

    const fallback = defaultWidgetLayout(widget);
    if (cursorX + fallback.w > SECTION_GRID_COLS) {
      cursorX = 0;
      cursorY += currentRowHeight;
      currentRowHeight = 1;
    }

    nextLayout.push({
      i: widget.id,
      x: cursorX,
      y: cursorY,
      w: fallback.w,
      h: fallback.h,
    });

    cursorX += fallback.w;
    currentRowHeight = Math.max(currentRowHeight, fallback.h);
    if (cursorX >= SECTION_GRID_COLS) {
      cursorX = 0;
      cursorY += currentRowHeight;
      currentRowHeight = 1;
    }
  });

  return nextLayout.sort((a, b) => (a.y - b.y) || (a.x - b.x));
};

const mapWidget = (item: ApiDashboardWidget): DashboardWidget | null => {
  const config = parseWidgetConfig(item.query_config);
  if (!config) return null;
  return {
    id: String(item.id),
    type: config.widget_type,
    sectionId: "",
    props: config,
    title: item.title || "",
    position: item.position,
    configVersion: item.config_version || 1,
    config,
  };
};

const parseSection = (raw: unknown, widgetsById: Map<string, DashboardWidget>): DashboardSection | null => {
  if (!isObject(raw)) return null;
  const sectionId = asString(raw.id, `sec-${Date.now()}`);
  const columnsRaw = asNumber(raw.columns, SECTION_GRID_COLS);
  const columns = clampSectionColumns(columnsRaw);
  const refs = Array.isArray(raw.widgets) ? raw.widgets : [];
  const widgets: DashboardWidget[] = [];
  const sectionLayout: DashboardLayoutItem[] = [];

  refs.forEach((ref) => {
    let widgetId = "";
    if (typeof ref === "number" || typeof ref === "string") {
      widgetId = String(ref);
    }
    if (isObject(ref) && !widgetId) {
      widgetId = String(ref.widget_id || ref.id || "");
    }

    if (!widgetId) return;
    const widget = widgetsById.get(widgetId);
    if (!widget) return;

    const nextWidget: DashboardWidget = {
      ...widget,
      sectionId,
      type: widget.props.widget_type,
      props: widget.props,
      config: widget.props,
    };
    widgets.push(nextWidget);

    if (isObject(ref)) {
      const layoutItem = parseLayoutItemFromRef(ref, widgetId);
      if (layoutItem) sectionLayout.push(layoutItem);
    }
  });

  const layout = buildSectionLayout(widgets, sectionLayout);
  const layoutById = new Map(layout.map((item) => [item.i, item]));
  const widgetsWithLayoutSizing = widgets.map((widget) => {
    const item = layoutById.get(widget.id);
    if (!item) return widget;
    const nextProps: WidgetConfig = {
      ...widget.props,
      size: {
        width: item.w as 1 | 2 | 3 | 4 | 5 | 6,
        height: gridRowsToWidgetHeight(item.h),
      },
    };
    return {
      ...widget,
      props: nextProps,
      config: nextProps,
    };
  });

  return {
    id: sectionId,
    title: asString(raw.title),
    showTitle: typeof raw.show_title === "boolean" ? raw.show_title : true,
    columns,
    layout,
    widgets: widgetsWithLayoutSizing,
  };
};

export const mapDatasource = (item: ApiDatasource): Datasource => ({
  id: String(item.id),
  name: item.name,
  schemaPattern: item.schema_pattern || "*",
  lastSync: item.last_synced_at ? normalizeApiDateTime(item.last_synced_at) : "Never",
  status: item.is_active ? "active" : "inactive",
  sourceType: item.source_type === "file_spreadsheet_import" ? "spreadsheet" : "database",
  description: item.description || "",
  copyPolicy: item.copy_policy === "forbidden" ? "forbidden" : "allowed",
  defaultDatasetAccessMode: item.default_dataset_access_mode === "imported" ? "imported" : "direct",
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
  datasourceId: String(item.datasource_id),
  name: item.name,
  description: item.description || "",
  viewId: item.view_id != null ? String(item.view_id) : undefined,
  baseQuerySpec: item.base_query_spec || null,
  accessMode: item.access_mode === "imported" ? "imported" : "direct",
  executionDatasourceId: item.execution_datasource_id != null ? String(item.execution_datasource_id) : undefined,
  executionViewId: item.execution_view_id != null ? String(item.execution_view_id) : undefined,
  dataStatus: (item.data_status || "ready") as Dataset["dataStatus"],
  lastSuccessfulSyncAt: item.last_successful_sync_at ? normalizeApiDateTime(item.last_successful_sync_at) : null,
  semanticColumns: (item.semantic_columns || [])
    .filter((col) => typeof col?.name === "string" && typeof col?.type === "string")
    .map((col) => ({
      name: String(col.name),
      type: normalizeColumnType(String(col.type)),
      source: typeof col.source === "string" ? col.source : undefined,
      description: typeof col.description === "string" && col.description.trim() ? col.description.trim() : undefined,
    })),
  dashboardIds,
  createdAt: normalizeApiDateTime(item.created_at),
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
    const withSection = unplacedWidgets.map((widget) => ({
      ...widget,
      sectionId: `sec-unplaced-${item.id}`,
      type: widget.props.widget_type,
      props: widget.props,
      config: widget.props,
    }));
    parsedSections.push({
      id: `sec-unplaced-${item.id}`,
      title: "Geral",
      columns: SECTION_GRID_COLS,
      layout: buildSectionLayout(withSection, []),
      widgets: withSection,
    });
  }

  const sections = parsedSections.length > 0
    ? parsedSections
    : [{
        id: `sec-${item.id}`,
        title: "Geral",
        columns: SECTION_GRID_COLS,
        layout: buildSectionLayout(widgets.map((widget) => ({
          ...widget,
          sectionId: `sec-${item.id}`,
          type: widget.props.widget_type,
          props: widget.props,
          config: widget.props,
        })), []),
        widgets: widgets.map((widget) => ({
          ...widget,
          sectionId: `sec-${item.id}`,
          type: widget.props.widget_type,
          props: widget.props,
          config: widget.props,
        })),
      }];

  return {
    id: String(item.id),
    title: item.name,
    datasetId: String(item.dataset_id),
    isOwner: item.is_owner,
    accessLevel: item.access_level,
    accessSource: item.access_source,
    visibility: item.visibility,
    publicShareKey: item.public_share_key || undefined,
    nativeFilters: (item.native_filters || []).filter(isObject).map((filter) => ({
      column: asString(filter.column),
      op: asString(filter.op, "eq") as Dashboard["nativeFilters"][number]["op"],
      value: filter.value,
      visible: typeof filter.visible === "boolean" ? filter.visible : false,
    })),
    sections,
    createdAt: normalizeApiDateTime(item.created_at),
    updatedAt: normalizeApiDateTime(item.updated_at),
  };
};

export const sectionsToLayoutConfig = (sections: DashboardSection[]): Record<string, unknown>[] =>
  sections.map((section) => ({
    id: section.id,
    title: section.title,
    show_title: section.showTitle !== false,
    columns: SECTION_GRID_COLS,
    widgets: buildSectionLayout(section.widgets, section.layout || [])
      .map((layoutItem) => {
        const numericId = Number(layoutItem.i);
        return {
          widget_id: Number.isFinite(numericId) ? numericId : layoutItem.i,
          i: layoutItem.i,
          x: layoutItem.x,
          y: layoutItem.y,
          w: layoutItem.w,
          h: layoutItem.h,
        };
      })
      .filter((entry) => section.widgets.some((widget) => widget.id === String(entry.widget_id))),
  }));

export const syncSectionWidgetsWithLayout = (section: DashboardSection): DashboardSection => {
  const layout = buildSectionLayout(section.widgets, section.layout || []);
  const layoutById = new Map(layout.map((item) => [item.i, item]));
  const widgets = section.widgets.map((widget) => {
    const item = layoutById.get(widget.id);
    if (!item) return widget;
    const nextProps: WidgetConfig = {
      ...widget.props,
      size: {
        width: item.w as 1 | 2 | 3 | 4 | 5 | 6,
        height: gridRowsToWidgetHeight(item.h),
      },
    };
    return {
      ...widget,
      sectionId: section.id,
      type: nextProps.widget_type,
      props: nextProps,
      config: nextProps,
    };
  });
  return {
    ...section,
    columns: SECTION_GRID_COLS,
    layout,
    widgets,
  };
};
