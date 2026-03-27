import { clearAuthSession, getAuthToken, isAuthTokenFresh, setAuthSession, updateAuthToken, updateStoredUser } from "@/lib/auth";

const API_BASE_URL =
  import.meta.env.VITE_API_URL || import.meta.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

export class ApiError extends Error {
  status: number;
  detail?: string;

  constructor(message: string, status: number, detail?: string) {
    super(message);
    this.status = status;
    this.detail = detail;
  }
}

let refreshInFlight: Promise<boolean> | null = null;

async function refreshAccessToken(): Promise<boolean> {
  if (!refreshInFlight) {
    refreshInFlight = (async () => {
      try {
        const response = await request<AuthLoginResponse>(
          "/auth/refresh",
          { method: "POST" },
          false,
          true,
          false,
        );
        updateAuthToken(response.access_token);
        updateStoredUser({
          id: response.user.id,
          email: response.user.email,
          full_name: response.user.full_name,
          is_admin: response.user.is_admin,
          is_owner: response.user.is_owner,
        });
        return true;
      } catch {
        return false;
      } finally {
        refreshInFlight = null;
      }
    })();
  }
  return refreshInFlight;
}

async function request<T>(
  path: string,
  init: RequestInit = {},
  requiresAuth = true,
  includeCredentials = false,
  retryOn401 = true,
): Promise<T> {
  const token = getAuthToken();
  const headers = new Headers(init.headers);

  if (!headers.has("Content-Type") && init.body && !(init.body instanceof FormData)) {
    headers.set("Content-Type", "application/json");
  }

  if (requiresAuth && token) {
    headers.set("Authorization", `Bearer ${token}`);
  }

  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    headers,
    credentials: includeCredentials ? "include" : init.credentials,
  });

  if (response.status === 204) {
    return undefined as T;
  }

  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    const rawDetail = payload?.detail as unknown;
    const detail =
      typeof rawDetail === "string"
        ? rawDetail
        : rawDetail
          ? JSON.stringify(rawDetail)
          : undefined;

    if (requiresAuth && response.status === 401) {
      if (retryOn401) {
        const refreshed = await refreshAccessToken();
        if (refreshed) {
          return request<T>(path, init, requiresAuth, includeCredentials, false);
        }
      }
      if (typeof window !== "undefined" && window.location.pathname !== "/login") {
        clearAuthSession();
        window.location.assign("/login");
      }
    }

    throw new ApiError(detail || `Request failed with status ${response.status}`, response.status, detail);
  }

  return payload as T;
}

export type ApiUser = {
  id: number;
  email: string;
  full_name?: string | null;
  is_admin: boolean;
  is_owner: boolean;
  is_active?: boolean;
  last_login_at?: string | null;
  updated_at?: string;
  deleted_at?: string | null;
  created_at: string;
};

export type AuthLoginResponse = {
  access_token: string;
  token_type: string;
  remember_me: boolean;
  user: ApiUser;
};

export type ApiColumn = {
  id: number;
  column_name: string;
  column_type: string;
  description?: string | null;
  is_aggregatable: boolean;
  is_filterable: boolean;
  is_groupable: boolean;
};

export type ApiView = {
  id: number;
  datasource_id: number;
  schema_name: string;
  view_name: string;
  description?: string | null;
  is_active: boolean;
  columns: ApiColumn[];
  created_at: string;
};

export type ApiDatasource = {
  id: number;
  name: string;
  description?: string | null;
  schema_pattern?: string | null;
  copy_policy?: "allowed" | "forbidden";
  default_dataset_access_mode?: "direct" | "imported";
  source_type?: string;
  status?: string;
  is_active: boolean;
  last_synced_at?: string | null;
  created_at: string;
};

export type ApiDatasourceDeletionImpactDashboard = {
  dashboard_id: number;
  dashboard_name: string;
  dataset_id: number;
  dataset_name: string;
};

export type ApiDatasourceDeletionImpact = {
  datasource_id: number;
  datasource_name: string;
  datasets_count: number;
  dashboards_count: number;
  dashboards: ApiDatasourceDeletionImpactDashboard[];
};

export type ApiSpreadsheetImport = {
  id: number;
  datasource_id: number;
  created_by_id: number;
  tenant_id: number;
  status: string;
  display_name: string;
  header_row: number;
  sheet_name?: string | null;
  cell_range?: string | null;
  csv_delimiter?: string | null;
  file_uri?: string | null;
  file_hash?: string | null;
  file_size_bytes?: number | null;
  row_count: number;
  available_sheet_names?: string[];
  selected_sheet_name?: string | null;
  inferred_schema?: Array<Record<string, unknown>>;
  mapped_schema?: Array<Record<string, unknown>>;
  preview_rows?: Array<Record<string, unknown>>;
  file_format?: string | null;
  created_at: string;
  updated_at: string;
};

export type ApiSpreadsheetImportConfirm = {
  table_id: number;
  table_name: string;
  resource_id: string;
  row_count: number;
  sheet_name?: string | null;
};

export type ApiSpreadsheetImportConfirmSummary = {
  import_id: number;
  datasource_id: number;
  row_count: number;
  tables: ApiSpreadsheetImportConfirm[];
  error_samples?: Array<Record<string, unknown>>;
  status: string;
};

export type ApiDataset = {
  id: number;
  datasource_id: number;
  view_id?: number | null;
  access_mode?: "direct" | "imported";
  execution_datasource_id?: number | null;
  execution_view_id?: number | null;
  data_status?: string;
  last_successful_sync_at?: string | null;
  name: string;
  description?: string | null;
  base_query_spec?: Record<string, unknown> | null;
  semantic_columns?: Array<{
    name: string;
    type: "numeric" | "temporal" | "text" | "boolean";
    source?: string;
    description?: string;
  }>;
  is_active: boolean;
  view?: ApiView | null;
  created_at: string;
  updated_at: string;
};

export type ApiDatasetImportConfig = {
  id: number;
  dataset_id: number;
  refresh_mode: "full_refresh";
  drift_policy: "block_on_breaking";
  enabled: boolean;
  max_runtime_seconds?: number | null;
  state_hash?: string | null;
  created_by_id?: number | null;
  updated_by_id?: number | null;
  created_at: string;
  updated_at: string;
};

export type ApiDatasetSyncRun = {
  id: number;
  dataset_id: number;
  trigger_type: string;
  status: string;
  queued_at: string;
  started_at?: string | null;
  finished_at?: string | null;
  attempt: number;
  published_execution_view_id?: number | null;
  drift_summary?: Record<string, unknown> | null;
  error_code?: string | null;
  error_message?: string | null;
  input_snapshot?: Record<string, unknown>;
  stats?: Record<string, unknown>;
  correlation_id?: string | null;
  coalesced?: boolean;
};

export type ApiDatasetSyncRunListResponse = {
  items: ApiDatasetSyncRun[];
};

export type ApiAdminDatasetSyncRun = {
  id: number;
  dataset_id: number;
  dataset_name: string;
  dataset_access_mode: string;
  dataset_data_status: string;
  datasource_id: number;
  datasource_name: string;
  import_enabled: boolean;
  trigger_type: string;
  status: string;
  queued_at: string;
  started_at?: string | null;
  finished_at?: string | null;
  attempt: number;
  published_execution_view_id?: number | null;
  drift_summary?: Record<string, unknown> | null;
  error_code?: string | null;
  error_message?: string | null;
  error_details?: Record<string, unknown> | null;
  input_snapshot?: Record<string, unknown>;
  stats?: Record<string, unknown>;
  correlation_id?: string | null;
};

export type ApiAdminDatasetSyncRunListResponse = {
  items: ApiAdminDatasetSyncRun[];
  total: number;
  limit: number;
  offset: number;
};

export type ApiDatasetSyncSchedule = {
  id: number;
  dataset_id: number;
  enabled: boolean;
  schedule_kind: "interval" | "cron";
  cron_expr?: string | null;
  interval_minutes?: number | null;
  timezone: string;
  next_run_at?: string | null;
  last_run_at?: string | null;
  misfire_policy: "run_once" | "skip";
  updated_by_id?: number | null;
  created_at: string;
  updated_at: string;
};

export type ApiDatasetComputedExpressionCatalog = {
  mode: "row_level";
  description: string;
  forbidden_aggregations: string[];
  allowed_functions: Record<string, string[]>;
  allowed_operators: string[];
  examples: string[];
};

export type ApiDatasetBulkImportEnableResponse = {
  targeted_count: number;
  updated_count: number;
  skipped_count: number;
  run_enqueued_count: number;
  skipped_items: Array<{ dataset_id: number; reason: string }>;
};

export type ApiCatalogMetric = {
  id: number;
  dataset_id: number;
  name: string;
  description?: string | null;
  formula: string;
  unit?: string | null;
  default_grain?: string | null;
  synonyms: string[];
  examples: string[];
};

export type ApiCatalogDimension = {
  id: number;
  dataset_id: number;
  name: string;
  description?: string | null;
  type: "categorical" | "temporal" | "relational";
  synonyms: string[];
};

export type ApiCatalogDataset = {
  id: number;
  datasource_id: number;
  view_id?: number | null;
  name: string;
  description?: string | null;
  metrics: ApiCatalogMetric[];
  dimensions: ApiCatalogDimension[];
};

export type ApiCatalogProfilePreviewPayload = {
  datasource_id: number;
  base_query_spec: Record<string, unknown>;
  columns: Array<{
    name: string;
    type: "numeric" | "temporal" | "text" | "boolean";
  }>;
};

export type ApiCatalogColumnQuickStats = {
  name: string;
  unique_count?: number | null;
  min?: number | string | null;
  max?: number | string | null;
  avg?: number | null;
};

export type ApiCatalogProfilePreviewResponse = {
  items: ApiCatalogColumnQuickStats[];
};

export type ApiCatalogDataPreviewPayload = {
  datasource_id: number;
  base_query_spec: Record<string, unknown>;
  columns: string[];
  limit?: number;
};

export type ApiCatalogDataPreviewResponse = {
  columns: string[];
  rows: Record<string, unknown>[];
  row_count: number;
};

export type ApiCatalogResource = {
  id: string;
  schema_name: string;
  resource_name: string;
  resource_type: string;
};

export type ApiCatalogResourcesResponse = {
  items: ApiCatalogResource[];
};

export type ApiCatalogResourceSchemaField = {
  name: string;
  data_type: string;
  nullable: boolean;
};

export type ApiCatalogResourceSchemaResponse = {
  resource_id: string;
  fields: ApiCatalogResourceSchemaField[];
};

export type ApiCatalogMetricCreatePayload = {
  dataset_id: number;
  name: string;
  description?: string;
  formula: string;
  unit?: string;
  default_grain?: string;
  synonyms?: string[];
  examples?: string[];
};

export type ApiCatalogMetricUpdatePayload = Partial<{
  name: string;
  description: string;
  formula: string;
  unit: string;
  default_grain: string;
  synonyms: string[];
  examples: string[];
}>;

export type ApiCatalogDimensionCreatePayload = {
  dataset_id: number;
  name: string;
  description?: string;
  type: "categorical" | "temporal" | "relational";
  synonyms?: string[];
};

export type ApiCatalogDimensionUpdatePayload = Partial<{
  name: string;
  description: string;
  type: "categorical" | "temporal" | "relational";
  synonyms: string[];
}>;

export type ApiDatasetBaseQuerySpec = {
  version: 1;
  source: {
    datasource_id: number;
  };
  base: {
    primary_resource: string;
    resources: Array<{
      id: string;
      resource_id: string;
    }>;
    joins: Array<{
      type: "inner" | "left";
      left_resource: string;
      right_resource: string;
      cardinality?: {
        estimated?: {
          value?: "1-1" | "1-N" | "N-1" | "N-N" | "indefinida";
          method?: string;
          sample_rows?: number;
          sample_rows_left?: number;
          sample_rows_right?: number;
          sample_limit?: number;
          sampled_at?: string;
        };
        actual?: {
          value?: "1-1" | "1-N" | "N-1" | "N-N" | "indefinida";
          method?: string;
          left_rows?: number;
          right_rows?: number;
          computed_at?: string;
        };
      };
      on: Array<{
        left_column: string;
        right_column: string;
      }>;
    }>;
  };
  preprocess: {
    columns: {
      include: Array<{
        resource: string;
        column: string;
        alias: string;
      }>;
      exclude: Array<string | { alias?: string; resource?: string; column?: string }>;
    };
    computed_columns: Array<{
      alias: string;
      expr: Record<string, unknown>;
      data_type: "numeric" | "temporal" | "text" | "boolean";
    }>;
    filters: Array<{ field: string; op: string; value?: unknown }>;
  };
};

export type ApiDashboardWidget = {
  id: number;
  dashboard_id: number;
  widget_type: string;
  title?: string | null;
  position: number;
  query_config: Record<string, unknown>;
  config_version: number;
  visualization_config?: Record<string, unknown> | null;
  last_execution_ms?: number | null;
  last_executed_at?: string | null;
  created_at: string;
  updated_at: string;
};

export type ApiDashboardNativeFilter = {
  column: string;
  op: string;
  value?: unknown;
  visible?: boolean;
};

export type ApiDashboard = {
  id: number;
  dataset_id: number;
  created_by_id?: number | null;
  is_owner: boolean;
  access_level: "owner" | "edit" | "view";
  access_source: "owner" | "direct" | "workspace" | "public" | "organization";
  visibility: "private" | "workspace_view" | "workspace_edit" | "public_view";
  public_share_key?: string | null;
  name: string;
  description?: string | null;
  is_active: boolean;
  layout_config?: Record<string, unknown>[];
  native_filters?: ApiDashboardNativeFilter[];
  widgets: ApiDashboardWidget[];
  created_at: string;
  updated_at: string;
};

export type ApiDashboardCatalogItem = {
  id: number;
  dataset_id: number;
  dataset_name: string;
  name: string;
  created_by_id?: number | null;
  is_owner: boolean;
  is_favorite: boolean;
  access_level: "owner" | "edit" | "view";
  access_source: "owner" | "direct" | "workspace" | "public" | "organization";
  visibility: "private" | "workspace_view" | "workspace_edit" | "public_view";
  public_share_key?: string | null;
  created_by_name?: string | null;
  created_by_email?: string | null;
  widget_count: number;
  last_edited_at: string;
  last_data_refresh_at?: string | null;
  load_score: number;
  complexity_score: number;
  runtime_score?: number | null;
  telemetry_coverage: number;
  avg_widget_execution_ms?: number | null;
  p95_widget_execution_ms?: number | null;
  slowest_widget_execution_ms?: number | null;
  last_widget_executed_at?: string | null;
};

export type ApiQueryPreviewResponse = {
  columns: string[];
  rows: Record<string, unknown>[];
  row_count: number;
};

export type ApiQueryPreviewBatchRequest = {
  queries: Array<{
    widget_id: string;
    spec: ApiQuerySpec;
  }>;
};

export type ApiQueryPreviewBatchResponse = {
  results: Array<
    ApiQueryPreviewResponse & {
      widget_id: string;
      cache_hit: boolean;
    }
  >;
};

export type ApiQuerySpec = {
  datasetId: number;
  metrics: Array<{ field: string; agg: string }>;
  dimensions: string[];
  filters: Array<{ field: string; op: string; value?: unknown }>;
  sort: Array<{ field: string; dir: "asc" | "desc" }>;
  limit: number;
  offset: number;
  visualization?: {
    type: string;
    config?: Record<string, unknown>;
  };
};

export type ApiAdminUser = {
  id: number;
  email: string;
  full_name?: string | null;
  role: "ADMIN" | "OWNER" | "USER";
  is_active: boolean;
  created_at: string;
  updated_at: string;
  last_login_at?: string | null;
  deleted_at?: string | null;
};

export type ApiAdminUserListResponse = {
  items: ApiAdminUser[];
  total: number;
  page: number;
  page_size: number;
};

export type ApiWidgetMetric = {
  op: "count" | "sum" | "avg" | "min" | "max" | "distinct_count";
  column?: string;
  alias?: string;
  prefix?: string;
  suffix?: string;
  line_style?: "solid" | "dashed" | "dotted";
  line_y_axis?: "left" | "right";
};

export type ApiWidgetConfig = {
  widget_type: "kpi" | "line" | "bar" | "column" | "donut" | "table" | "text" | "dre";
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
    inner_agg: "count" | "sum" | "avg" | "min" | "max" | "distinct_count";
    outer_agg: "count" | "sum" | "avg" | "min" | "max" | "distinct_count";
    agg?: "count" | "sum" | "avg" | "min" | "max" | "distinct_count";
    value_column?: string;
    time_column: string;
    granularity: "day" | "week" | "month" | "hour" | "timestamp";
  };
  size?: {
    width: 1 | 2 | 3 | 4 | 5 | 6;
    height: 0.5 | 1 | 2;
  };
  text_style?: {
    content: string;
    font_size: number;
    align: "left" | "center" | "right";
  };
  visual_padding?: "compact" | "normal" | "comfortable";
  visual_palette?: "default" | "warm" | "cool" | "mono" | "vivid";
  metrics: ApiWidgetMetric[];
  dimensions: string[];
  time?: {
    column: string;
    granularity: "day" | "week" | "month" | "hour" | "timestamp";
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
  dre_rows?: Array<{
    title: string;
    row_type: "result" | "deduction" | "detail";
    impact?: "add" | "subtract";
    metrics: ApiWidgetMetric[];
  }>;
  dre_percent_base_row_index?: number;
  columns?: string[];
  table_column_instances?: Array<{
    id: string;
    source: string;
    label?: string;
    aggregation?: "none" | "count" | "sum" | "avg" | "min" | "max" | "distinct_count";
    format?: string;
    prefix?: string;
    suffix?: string;
  }>;
  table_column_labels?: Record<string, string>;
  table_column_aggs?: Record<string, "none" | "count" | "sum" | "avg" | "min" | "max" | "distinct_count">;
  table_column_formats?: Record<string, string>;
  table_column_prefixes?: Record<string, string>;
  table_column_suffixes?: Record<string, string>;
  table_page_size?: number;
  table_density?: "compact" | "normal" | "comfortable";
  table_zebra_rows?: boolean;
  table_sticky_header?: boolean;
  table_borders?: boolean;
  table_default_text_align?: "left" | "center" | "right";
  table_default_number_align?: "left" | "center" | "right";
  filters: Array<{ column: string; op: string; value?: unknown }>;
  order_by: Array<{ column?: string; metric_ref?: string; direction: "asc" | "desc" }>;
  top_n?: number;
  limit?: number;
  offset?: number;
};

export type ApiViewSchemaColumn = {
  column_name: string;
  column_type: string;
  normalized_type: "numeric" | "temporal" | "text" | "boolean";
};

export type ApiDashboardWidgetDataResponse = {
  columns: string[];
  rows: Record<string, unknown>[];
  row_count: number;
};

export type ApiDashboardWidgetBatchDataResponse = {
  results: Array<
    ApiDashboardWidgetDataResponse & {
      widget_id: number;
    }
  >;
};

export type ApiDashboardDebugQueryItem = {
  widget_id: number;
  widget_type: string;
  title?: string | null;
  status: "ok" | "text_widget" | "error";
  sql?: string | null;
  query_spec?: Record<string, unknown> | null;
  params: unknown[];
  error?: string | null;
};

export type ApiDashboardDebugFinalQueryItem = {
  execution_kind: "single" | "deduped" | "kpi_batched";
  widget_ids: number[];
  sql: string;
  query_spec?: Record<string, unknown> | null;
  params: unknown[];
  sql_hash: string;
  fingerprint_key: string;
};

export type ApiDashboardDebugQueriesResponse = {
  dashboard_id: number;
  dashboard_name: string;
  dataset_id: number;
  datasource_id?: number | null;
  view_name?: string | null;
  mode: "widget" | "dashboard";
  items: ApiDashboardDebugQueryItem[];
  final_items: ApiDashboardDebugFinalQueryItem[];
};

export type ApiDashboardEmailShare = {
  id: number;
  dashboard_id: number;
  email: string;
  permission: "view" | "edit";
  created_by_id: number;
  created_at: string;
  updated_at: string;
};

export type ApiDashboardSharingResponse = {
  dashboard_id: number;
  visibility: "private" | "workspace_view" | "workspace_edit" | "public_view";
  public_share_key?: string | null;
  shares: ApiDashboardEmailShare[];
};

export type ApiPublicDashboard = {
  id: number;
  dataset_id: number;
  visibility: "public_view";
  public_share_key?: string | null;
  name: string;
  description?: string | null;
  is_active: boolean;
  layout_config?: Record<string, unknown>[];
  native_filters?: ApiDashboardNativeFilter[];
  widgets: ApiDashboardWidget[];
  created_at: string;
  updated_at: string;
};

export type ApiDashboardVersion = {
  id: number;
  dashboard_id: number;
  version_number: number;
  created_by_id?: number | null;
  created_at: string;
};

export type ApiDashboardExportResponse = {
  format: "istari.dashboard.v1";
  exported_at: string;
  dashboard: Record<string, unknown>;
};

export type ApiDashboardImportConflict = {
  scope: "widget" | "native_filter" | "metadata";
  code: string;
  message: string;
  widget_index?: number | null;
  widget_title?: string | null;
  field?: string | null;
};

export type ApiDashboardImportPreviewResponse = {
  source_dataset_id?: number | null;
  target_dataset_id: number;
  same_dataset: boolean;
  compatibility: "compatible" | "partial" | "incompatible";
  total_widgets: number;
  valid_widgets: number;
  invalid_widgets: number;
  conflicts: ApiDashboardImportConflict[];
};

export type ApiAIGeneratedWidget = {
  id: string;
  title: string;
  position: number;
  config_version: number;
  config: Record<string, unknown>;
};

export type ApiAIGeneratedSection = {
  id: string;
  title: string;
  show_title: boolean;
  columns: 1 | 2 | 3 | 4 | 5 | 6;
  widgets: ApiAIGeneratedWidget[];
};

export type ApiAIGenerateDashboardResponse = {
  title: string;
  explanation: string;
  planning_steps: string[];
  native_filters: ApiDashboardNativeFilter[];
  sections: ApiAIGeneratedSection[];
};

export type ApiDashboardEditLockResponse = {
  dashboard_id: number;
  is_locked: boolean;
  is_locked_by_current_user: boolean;
  locked_by_user_id?: number | null;
  locked_by_email?: string | null;
  expires_at?: string | null;
};

export type ApiDashboardFavoriteResponse = {
  dashboard_id: number;
  is_favorite: boolean;
};

export type ApiDashboardShareableUser = {
  id: number;
  email: string;
  full_name?: string | null;
};

export type ApiLLMIntegrationStatus = {
  provider: "openai";
  configured: boolean;
  model?: string | null;
  masked_api_key?: string | null;
  updated_at?: string | null;
  updated_by_id?: number | null;
};

export type ApiLLMIntegrationItem = {
  id: number;
  provider: "openai";
  model: string;
  masked_api_key: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
  created_by_id: number;
  updated_by_id: number;
  billing_spent_usd?: number | null;
  billing_budget_usd?: number | null;
  billing_estimated_remaining_usd?: number | null;
  billing_period_start?: string | null;
  billing_period_end?: string | null;
  billing_fetched_at?: string | null;
};

export type ApiLLMIntegrationListResponse = {
  items: ApiLLMIntegrationItem[];
};

export type ApiLLMIntegrationBillingRefreshResponse = {
  refreshed: number;
  failed: number;
};

export type ApiOpenAIIntegrationTestResponse = {
  ok: boolean;
  message: string;
  model: string;
};

export const api = {
  login: (email: string, password: string, rememberMe = true) =>
    request<AuthLoginResponse>("/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password, remember_me: rememberMe }),
    }, false, true),

  restoreSession: async () => {
    const hasToken = !!getAuthToken();
    if (isAuthTokenFresh()) return true;
    try {
      const response = await request<AuthLoginResponse>(
        "/auth/refresh",
        { method: "POST" },
        false,
        true,
        false,
      );
      setAuthSession(response.access_token, response.user, response.remember_me);
      return true;
    } catch {
      if (hasToken) {
        clearAuthSession();
      }
      return false;
    }
  },

  changePassword: (payload: { current_password: string; new_password: string }) =>
    request<void>("/auth/change-password", {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  logout: async () => {
    try {
      await request<void>("/auth/logout", { method: "POST" }, false, true, false);
    } finally {
      clearAuthSession();
    }
  },

  logoutAll: async () => {
    await request<void>("/auth/logout-all", { method: "POST" }, true, true);
    clearAuthSession();
  },

  getMe: () => request<ApiUser>("/auth/me"),

  updateMe: (payload: Partial<Pick<ApiUser, "email" | "full_name">>) =>
    request<ApiUser>("/auth/me", {
      method: "PATCH",
      body: JSON.stringify(payload),
    }),

  listDatasources: () => request<ApiDatasource[]>("/datasources/"),

  createDatasource: (payload: {
    name: string;
    description?: string;
    database_url: string;
    schema_pattern?: string;
    copy_policy?: "allowed" | "forbidden";
    default_dataset_access_mode?: "direct" | "imported";
  }) => request<ApiDatasource>("/datasources/", { method: "POST", body: JSON.stringify(payload) }),

  updateDatasource: (
    datasourceId: number,
    payload: Partial<{
      name: string;
      description: string;
      schema_pattern: string;
      is_active: boolean;
      copy_policy: "allowed" | "forbidden";
      default_dataset_access_mode: "direct" | "imported";
    }>,
  ) => request<ApiDatasource>(`/datasources/${datasourceId}`, { method: "PATCH", body: JSON.stringify(payload) }),

  deleteDatasource: (datasourceId: number) => request<void>(`/datasources/${datasourceId}`, { method: "DELETE" }),
  getDatasourceDeletionImpact: (datasourceId: number) =>
    request<ApiDatasourceDeletionImpact>(`/datasources/${datasourceId}/deletion-impact`),

  syncDatasource: (datasourceId: number) => request<{ status: string; synced_views: number }>(`/datasources/${datasourceId}/sync`, { method: "POST" }),

  createSpreadsheetImport: (payload: {
    tenant_id: number;
    name: string;
    datasource_id?: number;
    description?: string;
    timezone?: string;
    header_row?: number;
    sheet_name?: string;
    cell_range?: string;
    delimiter?: string;
  }) => request<ApiSpreadsheetImport>("/imports/create", { method: "POST", body: JSON.stringify(payload) }),

  uploadSpreadsheetImportFile: (importId: number, file: File) => {
    const formData = new FormData();
    formData.append("file", file);
    return request<ApiSpreadsheetImport>(`/imports/${importId}/upload`, { method: "POST", body: formData });
  },

  updateSpreadsheetImportTransform: (
    importId: number,
    payload: {
      header_row: number;
      sheet_name?: string;
      cell_range?: string;
      delimiter?: string;
    },
  ) => request<ApiSpreadsheetImport>(`/imports/${importId}/transform`, { method: "PATCH", body: JSON.stringify(payload) }),

  updateSpreadsheetImportSchema: (
    importId: number,
    payload: {
      columns: Array<{
        source_name: string;
        target_name: string;
        type: "string" | "number" | "date" | "bool";
      }>;
    },
  ) => request<ApiSpreadsheetImport>(`/imports/${importId}/schema`, { method: "PATCH", body: JSON.stringify(payload) }),

  confirmSpreadsheetImport: (importId: number) =>
    request<ApiSpreadsheetImportConfirmSummary>(`/imports/${importId}/confirm`, { method: "POST" }),

  listViews: () => request<ApiView[]>("/admin/views"),

  listAdminUsers: (params: { search?: string; page?: number; page_size?: number; sort?: string } = {}) => {
    const query = new URLSearchParams();
    if (params.search) query.set("search", params.search);
    if (params.page) query.set("page", String(params.page));
    if (params.page_size) query.set("page_size", String(params.page_size));
    if (params.sort) query.set("sort", params.sort);
    const suffix = query.toString() ? `?${query.toString()}` : "";
    return request<ApiAdminUserListResponse>(`/admin/users${suffix}`);
  },

  getAdminUser: (userId: number) => request<ApiAdminUser>(`/admin/users/${userId}`),

  createAdminUser: (payload: {
    name: string;
    email: string;
    role: "ADMIN" | "OWNER" | "USER";
    is_active: boolean;
    password: string;
  }) => request<ApiAdminUser>("/admin/users", { method: "POST", body: JSON.stringify(payload) }),

  updateAdminUser: (
    userId: number,
    payload: Partial<{
      name: string;
      email: string;
      role: "ADMIN" | "OWNER" | "USER";
      is_active: boolean;
    }>,
  ) => request<ApiAdminUser>(`/admin/users/${userId}`, { method: "PATCH", body: JSON.stringify(payload) }),

  deleteAdminUser: (userId: number) => request<void>(`/admin/users/${userId}`, { method: "DELETE" }),

  resetAdminUserPassword: (userId: number, payload: { password: string }) =>
    request<ApiAdminUser>(`/admin/users/${userId}/reset-password`, { method: "POST", body: JSON.stringify(payload) }),

  updateView: (viewId: number, payload: Partial<{ description: string; is_active: boolean }>) =>
    request<ApiView>(`/admin/views/${viewId}`, { method: "PATCH", body: JSON.stringify(payload) }),

  deleteView: (viewId: number) => request<void>(`/admin/views/${viewId}`, { method: "DELETE" }),

  getViewColumns: (viewName: string, schemaName?: string, datasourceId?: number) => {
    const queryParts: string[] = [];
    if (schemaName) queryParts.push(`schema_name=${encodeURIComponent(schemaName)}`);
    if (typeof datasourceId === "number" && Number.isFinite(datasourceId)) queryParts.push(`datasource_id=${datasourceId}`);
    const query = queryParts.length > 0 ? `?${queryParts.join("&")}` : "";
    return request<ApiViewSchemaColumn[]>(`/views/${encodeURIComponent(viewName)}/columns${query}`);
  },

  listDatasets: () => request<ApiDataset[]>("/datasets"),

  createDataset: (payload: {
    datasource_id: number;
    name: string;
    description?: string;
    is_active?: boolean;
    access_mode?: "direct" | "imported";
    view_id?: number;
    base_query_spec?: ApiDatasetBaseQuerySpec;
    semantic_columns?: Array<{
      name: string;
      type: "numeric" | "temporal" | "text" | "boolean";
      source?: string;
      description?: string;
    }>;
  }) =>
    request<ApiDataset>("/datasets", { method: "POST", body: JSON.stringify(payload) }),

  updateDataset: (
    datasetId: number,
    payload: Partial<{
      name: string;
      description: string;
      is_active: boolean;
      access_mode: "direct" | "imported";
      view_id: number;
      base_query_spec: ApiDatasetBaseQuerySpec;
      semantic_columns: Array<{
        name: string;
        type: "numeric" | "temporal" | "text" | "boolean";
        source?: string;
        description?: string;
      }>;
    }>,
  ) => request<ApiDataset>(`/datasets/${datasetId}`, { method: "PATCH", body: JSON.stringify(payload) }),

  enableImportedDatasetsForDatasource: (
    datasourceId: number,
    payload: {
      dataset_ids?: number[];
      only_if_copy_policy_allowed?: boolean;
      enqueue_initial_sync?: boolean;
    } = {},
  ) =>
    request<ApiDatasetBulkImportEnableResponse>(`/datasets/datasources/${datasourceId}/import-enable`, {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  getDatasetImportConfig: (datasetId: number) =>
    request<ApiDatasetImportConfig>(`/datasets/${datasetId}/import-config`),

  upsertDatasetImportConfig: (
    datasetId: number,
    payload: {
      enabled?: boolean;
      max_runtime_seconds?: number | null;
    },
  ) =>
    request<ApiDatasetImportConfig>(`/datasets/${datasetId}/import-config`, {
      method: "PUT",
      body: JSON.stringify(payload),
    }),

  triggerDatasetSync: (datasetId: number, payload: { input_snapshot?: Record<string, unknown> } = {}) =>
    request<ApiDatasetSyncRun>(`/datasets/${datasetId}/syncs`, {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  listDatasetSyncRuns: (datasetId: number, limit = 20) =>
    request<ApiDatasetSyncRunListResponse>(`/datasets/${datasetId}/syncs?limit=${limit}`),

  listAdminDatasetSyncRuns: (payload: {
    status?: string;
    dataset_id?: number;
    search?: string;
    limit?: number;
    offset?: number;
  } = {}) => {
    const query = new URLSearchParams();
    if (payload.status) query.set("status", payload.status);
    if (typeof payload.dataset_id === "number") query.set("dataset_id", String(payload.dataset_id));
    if (payload.search) query.set("search", payload.search);
    query.set("limit", String(payload.limit || 50));
    query.set("offset", String(payload.offset || 0));
    return request<ApiAdminDatasetSyncRunListResponse>(`/datasets/admin/syncs?${query.toString()}`);
  },

  getDatasetSyncRun: (datasetId: number, runId: number) =>
    request<ApiDatasetSyncRun>(`/datasets/${datasetId}/syncs/${runId}`),

  retryDatasetSyncRun: (datasetId: number, runId: number) =>
    request<ApiDatasetSyncRun>(`/datasets/${datasetId}/syncs/${runId}/retry`, { method: "POST" }),

  cancelAdminDatasetSyncRun: (runId: number) =>
    request<ApiDatasetSyncRun>(`/datasets/admin/syncs/${runId}/cancel`, { method: "POST" }),

  pauseAdminDatasetSync: (datasetId: number) =>
    request<ApiDatasetImportConfig>(`/datasets/admin/datasets/${datasetId}/pause-sync`, { method: "POST" }),

  resumeAdminDatasetSync: (datasetId: number) =>
    request<ApiDatasetImportConfig>(`/datasets/admin/datasets/${datasetId}/resume-sync`, { method: "POST" }),

  getDatasetSyncSchedule: (datasetId: number) =>
    request<ApiDatasetSyncSchedule>(`/datasets/${datasetId}/sync-schedule`),

  getDatasetComputedExpressionCatalog: () =>
    request<ApiDatasetComputedExpressionCatalog>("/datasets/computed-expression/catalog"),

  upsertDatasetSyncSchedule: (
    datasetId: number,
    payload: {
      enabled: boolean;
      schedule_kind: "interval" | "cron";
      cron_expr?: string;
      interval_minutes?: number;
      timezone?: string;
      misfire_policy?: "run_once" | "skip";
    },
  ) =>
    request<ApiDatasetSyncSchedule>(`/datasets/${datasetId}/sync-schedule`, {
      method: "PUT",
      body: JSON.stringify(payload),
    }),

  deleteDatasetSyncSchedule: (datasetId: number) =>
    request<void>(`/datasets/${datasetId}/sync-schedule`, { method: "DELETE" }),

  deleteDataset: (datasetId: number) => request<void>(`/datasets/${datasetId}`, { method: "DELETE" }),

  getCatalogDataset: (datasetId: number) =>
    request<ApiCatalogDataset>(`/catalog/dataset/${datasetId}`),

  regenerateCatalogDataset: (datasetId: number) =>
    request<ApiCatalogDataset>(`/catalog/dataset/${datasetId}/regenerate`, { method: "POST" }),

  getCatalogProfilePreview: (payload: ApiCatalogProfilePreviewPayload) =>
    request<ApiCatalogProfilePreviewResponse>("/catalog/profile/preview", { method: "POST", body: JSON.stringify(payload) }),

  previewCatalogData: (payload: ApiCatalogDataPreviewPayload) =>
    request<ApiCatalogDataPreviewResponse>("/catalog/data/preview", { method: "POST", body: JSON.stringify(payload) }),

  listCatalogResources: (datasourceId: number) =>
    request<ApiCatalogResourcesResponse>(`/catalog/resources?datasource_id=${datasourceId}`),

  getCatalogResourceSchema: (resourceId: string, datasourceId: number) =>
    request<ApiCatalogResourceSchemaResponse>(
      `/schema/${encodeURIComponent(resourceId)}?datasource_id=${datasourceId}`,
    ),

  createCatalogMetric: (payload: ApiCatalogMetricCreatePayload) =>
    request<ApiCatalogMetric>("/catalog/metrics", { method: "POST", body: JSON.stringify(payload) }),

  updateCatalogMetric: (metricId: number, payload: ApiCatalogMetricUpdatePayload) =>
    request<ApiCatalogMetric>(`/catalog/metrics/${metricId}`, { method: "PATCH", body: JSON.stringify(payload) }),

  deleteCatalogMetric: (metricId: number) =>
    request<void>(`/catalog/metrics/${metricId}`, { method: "DELETE" }),

  createCatalogDimension: (payload: ApiCatalogDimensionCreatePayload) =>
    request<ApiCatalogDimension>("/catalog/dimensions", { method: "POST", body: JSON.stringify(payload) }),

  updateCatalogDimension: (dimensionId: number, payload: ApiCatalogDimensionUpdatePayload) =>
    request<ApiCatalogDimension>(`/catalog/dimensions/${dimensionId}`, { method: "PATCH", body: JSON.stringify(payload) }),

  deleteCatalogDimension: (dimensionId: number) =>
    request<void>(`/catalog/dimensions/${dimensionId}`, { method: "DELETE" }),

  listDashboards: (datasetId?: number) => {
    const query = datasetId ? `?dataset_id=${datasetId}` : "";
    return request<ApiDashboard[]>(`/dashboards${query}`);
  },

  listDashboardCatalog: () => request<ApiDashboardCatalogItem[]>("/dashboards/catalog"),
  favoriteDashboard: (dashboardId: number) =>
    request<ApiDashboardFavoriteResponse>(`/dashboards/${dashboardId}/favorite`, { method: "PUT" }),
  unfavoriteDashboard: (dashboardId: number) =>
    request<ApiDashboardFavoriteResponse>(`/dashboards/${dashboardId}/favorite`, { method: "DELETE" }),

  getDashboard: (dashboardId: number) => request<ApiDashboard>(`/dashboards/${dashboardId}`),

  createDashboard: (payload: {
    dataset_id: number;
    name: string;
    description?: string;
    is_active?: boolean;
    layout_config?: Record<string, unknown>[];
    native_filters?: ApiDashboardNativeFilter[];
  }) => request<ApiDashboard>("/dashboards", { method: "POST", body: JSON.stringify(payload) }),

  updateDashboard: (
    dashboardId: number,
    payload: Partial<{
      name: string;
      description: string;
      is_active: boolean;
      layout_config: Record<string, unknown>[];
      native_filters: ApiDashboardNativeFilter[];
    }>,
  ) => request<ApiDashboard>(`/dashboards/${dashboardId}`, { method: "PATCH", body: JSON.stringify(payload) }),

  deleteDashboard: (dashboardId: number) => request<void>(`/dashboards/${dashboardId}`, { method: "DELETE" }),

  getDashboardSharing: (dashboardId: number) =>
    request<ApiDashboardSharingResponse>(`/dashboards/${dashboardId}/sharing`),

  updateDashboardVisibility: (
    dashboardId: number,
    payload: { visibility: "private" | "workspace_view" | "workspace_edit" | "public_view" },
  ) => request<ApiDashboardSharingResponse>(`/dashboards/${dashboardId}/sharing/visibility`, { method: "PUT", body: JSON.stringify(payload) }),

  upsertDashboardEmailShare: (
    dashboardId: number,
    payload: { email: string; permission: "view" | "edit" },
  ) => request<ApiDashboardSharingResponse>(`/dashboards/${dashboardId}/sharing/email`, { method: "POST", body: JSON.stringify(payload) }),

  deleteDashboardEmailShare: (dashboardId: number, shareId: number) =>
    request<ApiDashboardSharingResponse>(`/dashboards/${dashboardId}/sharing/email/${shareId}`, { method: "DELETE" }),

  listDashboardShareableUsers: (search?: string, limit = 8) => {
    const query = new URLSearchParams();
    if (search && search.trim()) query.set("search", search.trim());
    query.set("limit", String(limit));
    return request<ApiDashboardShareableUser[]>(`/dashboards/shareable-users?${query.toString()}`);
  },

  createDashboardWidget: (
    dashboardId: number,
    payload: {
      widget_type: "kpi" | "line" | "bar" | "column" | "donut" | "table" | "text" | "dre";
      title?: string;
      position?: number;
      config: ApiWidgetConfig;
      config_version?: number;
      visualization_config?: Record<string, unknown>;
    },
  ) => request<ApiDashboardWidget>(`/dashboards/${dashboardId}/widgets`, { method: "POST", body: JSON.stringify(payload) }),

  updateDashboardWidget: (
    dashboardId: number,
    widgetId: number,
    payload: Partial<{
      widget_type: "kpi" | "line" | "bar" | "column" | "donut" | "table" | "text" | "dre";
      title: string;
      position: number;
      config: ApiWidgetConfig;
      config_version: number;
      visualization_config: Record<string, unknown>;
    }>,
  ) => request<ApiDashboardWidget>(`/dashboards/${dashboardId}/widgets/${widgetId}`, { method: "PATCH", body: JSON.stringify(payload) }),

  deleteDashboardWidget: (dashboardId: number, widgetId: number) =>
    request<void>(`/dashboards/${dashboardId}/widgets/${widgetId}`, { method: "DELETE" }),

  getDashboardWidgetData: (dashboardId: number, widgetId: number) =>
    request<ApiDashboardWidgetDataResponse>(`/dashboards/${dashboardId}/widgets/${widgetId}/data`),

  getDashboardWidgetsData: (
    dashboardId: number,
    widgetIds: number[],
    globalFilters: Array<{ column: string; op: string; value?: unknown }> = [],
  ) =>
    request<ApiDashboardWidgetBatchDataResponse>(`/dashboards/${dashboardId}/widgets/data`, {
      method: "POST",
      body: JSON.stringify({ widget_ids: widgetIds, global_filters: globalFilters }),
    }),

  saveDashboard: (
    dashboardId: number,
    payload: {
      name?: string;
      description?: string | null;
      is_active?: boolean;
      visibility?: "private" | "workspace_view" | "workspace_edit" | "public_view";
      layout_config: Record<string, unknown>[];
      native_filters: ApiDashboardNativeFilter[];
      widgets: Array<{
        id?: number | string;
        widget_type: "kpi" | "line" | "bar" | "column" | "donut" | "table" | "text" | "dre";
        title?: string;
        position?: number;
        config: ApiWidgetConfig;
        config_version?: number;
        visualization_config?: Record<string, unknown>;
      }>;
    },
  ) => request<ApiDashboard>(`/dashboards/${dashboardId}/save`, { method: "POST", body: JSON.stringify(payload) }),

  listDashboardVersions: (dashboardId: number) =>
    request<ApiDashboardVersion[]>(`/dashboards/${dashboardId}/versions`),

  restoreDashboardVersion: (dashboardId: number, versionId: number) =>
    request<ApiDashboard>(`/dashboards/${dashboardId}/versions/${versionId}/restore`, { method: "POST" }),

  exportDashboard: (dashboardId: number) =>
    request<ApiDashboardExportResponse>(`/dashboards/${dashboardId}/export`),

  previewDashboardImport: (payload: { dataset_id?: number; dashboard: Record<string, unknown> }) =>
    request<ApiDashboardImportPreviewResponse>("/dashboards/import/preview", { method: "POST", body: JSON.stringify(payload) }),

  generateDashboardWithAi: (payload: { dataset_id: number; prompt: string; title?: string }) =>
    request<ApiAIGenerateDashboardResponse>("/dashboards/ai/generate", { method: "POST", body: JSON.stringify(payload) }),

  importDashboard: (payload: { dataset_id?: number; dashboard: Record<string, unknown> }) =>
    request<ApiDashboard>("/dashboards/import", { method: "POST", body: JSON.stringify(payload) }),

  getDashboardLock: (dashboardId: number) =>
    request<ApiDashboardEditLockResponse>(`/dashboards/${dashboardId}/lock`),

  acquireDashboardLock: (dashboardId: number) =>
    request<ApiDashboardEditLockResponse>(`/dashboards/${dashboardId}/lock/acquire`, { method: "POST" }),

  releaseDashboardLock: (dashboardId: number) =>
    request<ApiDashboardEditLockResponse>(`/dashboards/${dashboardId}/lock`, { method: "DELETE" }),

  getPublicDashboard: (publicShareKey: string) =>
    request<ApiPublicDashboard>(`/dashboards/public/${encodeURIComponent(publicShareKey)}`, undefined, false),

  getPublicDashboardWidgetsData: (
    publicShareKey: string,
    widgetIds: number[],
    globalFilters: Array<{ column: string; op: string; value?: unknown }> = [],
  ) =>
    request<ApiDashboardWidgetBatchDataResponse>(`/dashboards/public/${encodeURIComponent(publicShareKey)}/widgets/data`, {
      method: "POST",
      body: JSON.stringify({ widget_ids: widgetIds, global_filters: globalFilters }),
    }, false),

  getDashboardDebugQueries: (
    dashboardId: number,
    payload: {
      native_filters_override?: ApiDashboardNativeFilter[];
      global_filters?: Array<{ column: string; op: string; value?: unknown }>;
      mode?: "widget" | "dashboard";
    } = {},
  ) =>
    request<ApiDashboardDebugQueriesResponse>(`/dashboards/${dashboardId}/debug/queries`, {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  previewQuery: (payload: ApiQuerySpec) =>
    request<ApiQueryPreviewResponse>("/query/preview", { method: "POST", body: JSON.stringify(payload) }),

  previewQueryBatch: (payload: ApiQueryPreviewBatchRequest) =>
    request<ApiQueryPreviewBatchResponse>("/query/preview/batch", { method: "POST", body: JSON.stringify(payload) }),

  getApiIntegration: () =>
    request<ApiLLMIntegrationStatus>("/api-config/integration"),

  listApiIntegrations: () =>
    request<ApiLLMIntegrationListResponse>("/api-config/integrations"),

  createOpenAIIntegration: (payload: { api_key: string; model?: string; is_active?: boolean }) =>
    request<ApiLLMIntegrationItem>("/api-config/integrations/openai", {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  activateApiIntegration: (integrationId: number) =>
    request<ApiLLMIntegrationItem>(`/api-config/integrations/${integrationId}/activate`, {
      method: "PATCH",
    }),

  deactivateApiIntegration: (integrationId: number) =>
    request<ApiLLMIntegrationItem>(`/api-config/integrations/${integrationId}/deactivate`, {
      method: "PATCH",
    }),

  testApiIntegration: (integrationId: number) =>
    request<ApiOpenAIIntegrationTestResponse>(`/api-config/integrations/${integrationId}/test`, {
      method: "POST",
    }),

  refreshApiIntegrationsBilling: () =>
    request<ApiLLMIntegrationBillingRefreshResponse>("/api-config/integrations/billing/refresh", {
      method: "POST",
    }),

  upsertOpenAIIntegration: (payload: { api_key: string; model?: string }) =>
    request<ApiLLMIntegrationStatus>("/api-config/integration/openai", {
      method: "PUT",
      body: JSON.stringify(payload),
    }),

  testOpenAIIntegration: (payload: { api_key?: string; model?: string }) =>
    request<ApiOpenAIIntegrationTestResponse>("/api-config/integration/openai/test", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
};
