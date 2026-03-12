import type { VisualizationType } from "@/types";
import type { CanonicalWidgetWidth, WidgetConfig, WidgetType } from "@/types/dashboard";

export type WidgetCatalogEntry = {
  id: string;
  visualizationType: VisualizationType;
  widgetType: WidgetType;
  title: string;
  description: string;
  defaultW: CanonicalWidgetWidth;
  defaultH: number;
  minW: CanonicalWidgetWidth;
  minH: number;
  maxW: CanonicalWidgetWidth;
  maxH: number;
  defaultProps: Partial<WidgetConfig>;
};

const ENTRY_KPI: WidgetCatalogEntry = {
  id: "kpi",
  visualizationType: "kpi",
  widgetType: "kpi",
  title: "KPI",
  description: "Numero em destaque",
  defaultW: 1,
  defaultH: 3,
  minW: 1,
  minH: 3,
  maxW: 6,
  maxH: 12,
  defaultProps: {
    show_title: false,
    kpi_show_as: "number_2",
    kpi_decimals: 2,
    kpi_show_trend: false,
    kpi_type: "atomic",
    visual_padding: "normal",
    visual_palette: "default",
  },
};

const ENTRY_BAR: WidgetCatalogEntry = {
  id: "bar",
  visualizationType: "bar",
  widgetType: "bar",
  title: "Barra",
  description: "Comparacao entre categorias",
  defaultW: 2,
  defaultH: 6,
  minW: 2,
  minH: 6,
  maxW: 6,
  maxH: 40,
  defaultProps: {
    show_title: true,
    visual_padding: "normal",
    visual_palette: "default",
    bar_data_labels_enabled: false,
    bar_show_grid: false,
    bar_show_percent_of_total: false,
  },
};

const ENTRY_LINE: WidgetCatalogEntry = {
  id: "line",
  visualizationType: "line",
  widgetType: "line",
  title: "Linha",
  description: "Tendencia temporal",
  defaultW: 2,
  defaultH: 6,
  minW: 2,
  minH: 6,
  maxW: 6,
  maxH: 40,
  defaultProps: {
    show_title: true,
    visual_padding: "normal",
    visual_palette: "default",
    line_data_labels_enabled: false,
    line_show_grid: false,
    line_data_labels_percent: 60,
    line_label_window: 3,
    line_label_min_gap: 2,
    line_label_mode: "both",
  },
};

const ENTRY_PIE: WidgetCatalogEntry = {
  id: "pie",
  visualizationType: "pie",
  widgetType: "donut",
  title: "Pizza",
  description: "Distribuicao proporcional",
  defaultW: 2,
  defaultH: 6,
  minW: 2,
  minH: 6,
  maxW: 6,
  maxH: 40,
  defaultProps: {
    show_title: true,
    visual_padding: "normal",
    visual_palette: "default",
    donut_show_legend: true,
    donut_data_labels_enabled: false,
    donut_data_labels_min_percent: 6,
    donut_metric_display: "value",
    donut_group_others_enabled: true,
    donut_group_others_top_n: 3,
  },
};

const ENTRY_TABLE: WidgetCatalogEntry = {
  id: "table",
  visualizationType: "table",
  widgetType: "table",
  title: "Tabela",
  description: "Dados detalhados",
  defaultW: 3,
  defaultH: 8,
  minW: 3,
  minH: 7,
  maxW: 6,
  maxH: 40,
  defaultProps: {
    show_title: true,
    visual_padding: "normal",
    visual_palette: "default",
    table_page_size: 25,
  },
};

const ENTRY_COLUMN: WidgetCatalogEntry = {
  id: "column",
  visualizationType: "column",
  widgetType: "column",
  title: "Coluna",
  description: "Comparacao em colunas",
  defaultW: 2,
  defaultH: 6,
  minW: 2,
  minH: 6,
  maxW: 6,
  maxH: 40,
  defaultProps: {
    show_title: true,
    visual_padding: "normal",
    visual_palette: "default",
    bar_data_labels_enabled: false,
    bar_show_grid: false,
    bar_show_percent_of_total: false,
  },
};

const ENTRY_TEXT: WidgetCatalogEntry = {
  id: "text",
  visualizationType: "table",
  widgetType: "text",
  title: "Texto",
  description: "Bloco de texto livre",
  defaultW: 1,
  defaultH: 4,
  minW: 1,
  minH: 3,
  maxW: 6,
  maxH: 30,
  defaultProps: {
    show_title: true,
    visual_padding: "normal",
    visual_palette: "default",
  },
};

const ENTRY_DRE: WidgetCatalogEntry = {
  id: "dre",
  visualizationType: "table",
  widgetType: "dre",
  title: "DRE",
  description: "Demonstrativo de resultado",
  defaultW: 4,
  defaultH: 10,
  minW: 4,
  minH: 8,
  maxW: 6,
  maxH: 40,
  defaultProps: {
    show_title: true,
    visual_padding: "normal",
    visual_palette: "default",
  },
};

export const WIDGET_CATALOG: WidgetCatalogEntry[] = [
  ENTRY_KPI,
  ENTRY_BAR,
  ENTRY_COLUMN,
  ENTRY_LINE,
  ENTRY_PIE,
  ENTRY_TABLE,
  ENTRY_DRE,
];

const WIDGET_CATALOG_BY_TYPE: Record<WidgetType, WidgetCatalogEntry> = {
  kpi: ENTRY_KPI,
  bar: ENTRY_BAR,
  line: ENTRY_LINE,
  donut: ENTRY_PIE,
  table: ENTRY_TABLE,
  column: ENTRY_COLUMN,
  text: ENTRY_TEXT,
  dre: ENTRY_DRE,
};

const WIDGET_CATALOG_BY_VISUALIZATION: Partial<Record<VisualizationType, WidgetCatalogEntry>> = {
  kpi: ENTRY_KPI,
  bar: ENTRY_BAR,
  line: ENTRY_LINE,
  pie: ENTRY_PIE,
  table: ENTRY_TABLE,
  column: ENTRY_COLUMN,
};

export const getWidgetCatalogByType = (type: WidgetType): WidgetCatalogEntry => WIDGET_CATALOG_BY_TYPE[type] || ENTRY_TABLE;

export const getWidgetCatalogByVisualization = (type: VisualizationType): WidgetCatalogEntry =>
  WIDGET_CATALOG_BY_VISUALIZATION[type] || ENTRY_TABLE;
