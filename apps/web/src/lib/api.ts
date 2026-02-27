import { clearAuthSession, getAuthToken } from "@/lib/auth";

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

async function request<T>(path: string, init: RequestInit = {}, requiresAuth = true): Promise<T> {
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
  is_active?: boolean;
  last_login_at?: string | null;
  updated_at?: string;
  deleted_at?: string | null;
  created_at: string;
};

export type AuthLoginResponse = {
  access_token: string;
  token_type: string;
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
  view_id: number;
  name: string;
  description?: string | null;
  is_active: boolean;
  view: ApiView;
  created_at: string;
  updated_at: string;
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

export type ApiDashboard = {
  id: number;
  dataset_id: number;
  created_by_id?: number | null;
  is_owner: boolean;
  access_level: "owner" | "edit" | "view";
  access_source: "owner" | "direct" | "workspace";
  visibility: "private" | "workspace_view" | "workspace_edit";
  name: string;
  description?: string | null;
  is_active: boolean;
  layout_config?: Record<string, unknown>[];
  native_filters?: Array<{ column: string; op: string; value?: unknown }>;
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
  access_level: "owner" | "edit" | "view";
  access_source: "owner" | "direct" | "workspace";
  visibility: "private" | "workspace_view" | "workspace_edit";
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

export type ApiSharedAnalysisResponse = {
  analysis: {
    id: number;
    datasource_id: number;
    dataset_id: number;
    name: string;
    description?: string | null;
    query_config: Record<string, unknown>;
    visualization_config?: Record<string, unknown> | null;
    created_at: string;
    updated_at: string;
  };
  data: ApiQueryPreviewResponse;
};

export type ApiQuerySpec = {
  datasetId: number;
  metrics: Array<{ field: string; agg: string }>;
  dimensions: string[];
  filters: Array<{ field: string; op: string; value?: unknown[] }>;
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
  role: "ADMIN" | "USER";
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
  line_y_axis?: "left" | "right";
};

export type ApiWidgetConfig = {
  widget_type: "kpi" | "line" | "bar" | "column" | "donut" | "table" | "text" | "dre";
  view_name: string;
  show_title?: boolean;
  kpi_show_as?: "currency_brl" | "number_2" | "integer" | "percent";
  kpi_decimals?: number;
  kpi_prefix?: string;
  kpi_suffix?: string;
  kpi_type?: "atomic" | "derived";
  formula?: string;
  dependencies?: string[];
  kpi_dependencies?: Array<{
    source_type?: "widget" | "column";
    widget_id?: number;
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
    granularity: "day" | "week" | "month" | "hour";
  };
  size?: {
    width: 1 | 2 | 3 | 4;
    height: 0.5 | 1;
  };
  text_style?: {
    content: string;
    font_size: number;
    align: "left" | "center" | "right";
  };
  metrics: ApiWidgetMetric[];
  dimensions: string[];
  time?: {
    column: string;
    granularity: "day" | "week" | "month" | "hour";
  };
  line_data_labels_enabled?: boolean;
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
    metrics: ApiWidgetMetric[];
  }>;
  dre_percent_base_row_index?: number;
  columns?: string[];
  table_column_formats?: Record<string, string>;
  table_page_size?: number;
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
  visibility: "private" | "workspace_view" | "workspace_edit";
  shares: ApiDashboardEmailShare[];
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
  login: (email: string, password: string) =>
    request<AuthLoginResponse>("/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    }, false),

  listDatasources: () => request<ApiDatasource[]>("/datasources"),

  createDatasource: (payload: {
    name: string;
    description?: string;
    database_url: string;
    schema_pattern?: string;
  }) => request<ApiDatasource>("/datasources/", { method: "POST", body: JSON.stringify(payload) }),

  updateDatasource: (
    datasourceId: number,
    payload: Partial<{ name: string; description: string; schema_pattern: string; is_active: boolean }>,
  ) => request<ApiDatasource>(`/datasources/${datasourceId}`, { method: "PATCH", body: JSON.stringify(payload) }),

  deleteDatasource: (datasourceId: number) => request<void>(`/datasources/${datasourceId}`, { method: "DELETE" }),
  getDatasourceDeletionImpact: (datasourceId: number) =>
    request<ApiDatasourceDeletionImpact>(`/datasources/${datasourceId}/deletion-impact`),

  syncDatasource: (datasourceId: number) => request<{ status: string; synced_views: number }>(`/datasources/${datasourceId}/sync`, { method: "POST" }),

  createSpreadsheetImport: (payload: {
    tenant_id: number;
    name: string;
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
    role: "ADMIN" | "USER";
    is_active: boolean;
    password: string;
  }) => request<ApiAdminUser>("/admin/users", { method: "POST", body: JSON.stringify(payload) }),

  updateAdminUser: (
    userId: number,
    payload: Partial<{
      name: string;
      email: string;
      role: "ADMIN" | "USER";
      is_active: boolean;
    }>,
  ) => request<ApiAdminUser>(`/admin/users/${userId}`, { method: "PATCH", body: JSON.stringify(payload) }),

  deleteAdminUser: (userId: number) => request<void>(`/admin/users/${userId}`, { method: "DELETE" }),

  resetAdminUserPassword: (userId: number, payload: { password: string }) =>
    request<ApiAdminUser>(`/admin/users/${userId}/reset-password`, { method: "POST", body: JSON.stringify(payload) }),

  updateView: (viewId: number, payload: Partial<{ description: string; is_active: boolean }>) =>
    request<ApiView>(`/admin/views/${viewId}`, { method: "PATCH", body: JSON.stringify(payload) }),

  deleteView: (viewId: number) => request<void>(`/admin/views/${viewId}`, { method: "DELETE" }),

  getViewColumns: (viewName: string, schemaName?: string) => {
    const query = schemaName ? `?schema_name=${encodeURIComponent(schemaName)}` : "";
    return request<ApiViewSchemaColumn[]>(`/views/${encodeURIComponent(viewName)}/columns${query}`);
  },

  listDatasets: () => request<ApiDataset[]>("/datasets"),

  createDataset: (payload: { datasource_id: number; view_id: number; name: string; description?: string; is_active?: boolean }) =>
    request<ApiDataset>("/datasets", { method: "POST", body: JSON.stringify(payload) }),

  deleteDataset: (datasetId: number) => request<void>(`/datasets/${datasetId}`, { method: "DELETE" }),

  listDashboards: (datasetId?: number) => {
    const query = datasetId ? `?dataset_id=${datasetId}` : "";
    return request<ApiDashboard[]>(`/dashboards${query}`);
  },

  listDashboardCatalog: () => request<ApiDashboardCatalogItem[]>("/dashboards/catalog"),

  getDashboard: (dashboardId: number) => request<ApiDashboard>(`/dashboards/${dashboardId}`),

  createDashboard: (payload: {
    dataset_id: number;
    name: string;
    description?: string;
    is_active?: boolean;
    layout_config?: Record<string, unknown>[];
    native_filters?: Array<{ column: string; op: string; value?: unknown }>;
  }) => request<ApiDashboard>("/dashboards", { method: "POST", body: JSON.stringify(payload) }),

  updateDashboard: (
    dashboardId: number,
    payload: Partial<{
      name: string;
      description: string;
      is_active: boolean;
      layout_config: Record<string, unknown>[];
      native_filters: Array<{ column: string; op: string; value?: unknown }>;
    }>,
  ) => request<ApiDashboard>(`/dashboards/${dashboardId}`, { method: "PATCH", body: JSON.stringify(payload) }),

  deleteDashboard: (dashboardId: number) => request<void>(`/dashboards/${dashboardId}`, { method: "DELETE" }),

  getDashboardSharing: (dashboardId: number) =>
    request<ApiDashboardSharingResponse>(`/dashboards/${dashboardId}/sharing`),

  updateDashboardVisibility: (
    dashboardId: number,
    payload: { visibility: "private" | "workspace_view" | "workspace_edit" },
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

  getDashboardDebugQueries: (
    dashboardId: number,
    payload: {
      native_filters_override?: Array<{ column: string; op: string; value?: unknown }>;
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

  getSharedAnalysis: (token: string) =>
    request<ApiSharedAnalysisResponse>(`/analyses/shared/${token}`, undefined, false),

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
