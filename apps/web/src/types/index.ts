export type DatasourceStatus = "active" | "inactive" | "syncing";
export type ViewStatus = "active" | "inactive";

export interface Datasource {
  id: string;
  name: string;
  schemaPattern: string;
  lastSync: string;
  status: DatasourceStatus;
  description: string;
}

export interface View {
  id: string;
  schema: string;
  name: string;
  status: ViewStatus;
  description: string;
  columns: Column[];
  rowCount: number;
  datasourceId: string;
}

export interface Column {
  name: string;
  type: string;
  description?: string;
}

export interface Dataset {
  id: string;
  name: string;
  description: string;
  viewId: string;
  dashboardIds: string[];
  createdAt: string;
}

export type VisualizationType = "table" | "kpi" | "line" | "bar" | "column" | "pie";

export interface Metric {
  column: string;
  aggregation: "sum" | "avg" | "count" | "min" | "max" | "distinct_count";
  label?: string;
}

export interface Filter {
  column: string;
  operator: "=" | "!=" | ">" | "<" | ">=" | "<=" | "contains" | "not_contains";
  value: string;
}

export interface SortConfig {
  column: string;
  direction: "asc" | "desc";
}

export interface AnalysisConfig {
  viewId: string;
  metrics: Metric[];
  dimensions: string[];
  filters: Filter[];
  sorts: SortConfig[];
  limit: number;
  visualizationType: VisualizationType;
}

export interface SavedAnalysis {
  id: string;
  title: string;
  description: string;
  config: AnalysisConfig;
  createdAt: string;
  shareToken?: string;
}
