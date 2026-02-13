// Shared types and utilities
// Generated from API OpenAPI schema

export interface User {
  id: number;
  email: string;
  full_name?: string;
  is_admin: boolean;
  created_at: string;
}

export interface ViewColumn {
  id: number;
  column_name: string;
  column_type: string;
  description?: string;
  is_aggregatable: boolean;
  is_filterable: boolean;
  is_groupable: boolean;
}

export interface View {
  id: number;
  schema_name: string;
  view_name: string;
  description?: string;
  is_active: boolean;
  columns: ViewColumn[];
  created_at: string;
}

export type AggregationType = 'count' | 'sum' | 'avg' | 'min' | 'max' | 'distinct_count';

export interface MetricSpec {
  field: string;
  agg: AggregationType;
}

export type FilterOperator = 'eq' | 'neq' | 'in' | 'not_in' | 'contains' | 'is_null' | 'not_null' | 'gte' | 'lte' | 'between';

export interface FilterSpec {
  field: string;
  op: FilterOperator;
  value?: any[];
}

export interface SortSpec {
  field: string;
  dir: 'asc' | 'desc';
}

export type VisualizationType = 'table' | 'kpi' | 'line' | 'bar' | 'column' | 'pie';

export interface VisualizationConfig {
  type: VisualizationType;
  config?: Record<string, any>;
}

export interface QuerySpec {
  datasetId: number;
  metrics: MetricSpec[];
  dimensions: string[];
  filters: FilterSpec[];
  sort: SortSpec[];
  limit: number;
  offset: number;
  visualization?: VisualizationConfig;
}

export interface QueryPreviewResponse {
  columns: string[];
  rows: Record<string, any>[];
  row_count: number;
}

export interface Analysis {
  id: number;
  name: string;
  description?: string;
  query_config: QuerySpec;
  visualization_config?: VisualizationConfig;
  created_at: string;
  updated_at: string;
}

export interface Share {
  token: string;
  analysis_id: number;
  created_at: string;
}
