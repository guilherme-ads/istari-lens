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

  if (!headers.has("Content-Type") && init.body) {
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
      clearAuthSession();
      if (typeof window !== "undefined" && window.location.pathname !== "/login") {
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
  is_active: boolean;
  last_synced_at?: string | null;
  created_at: string;
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
  line_y_axis?: "left" | "right";
};

export type ApiWidgetConfig = {
  widget_type: "kpi" | "line" | "bar" | "table" | "text";
  view_name: string;
  show_title?: boolean;
  kpi_show_as?: "currency_brl" | "number_2" | "integer";
  composite_metric?: {
    type: "avg_per_time_bucket" | "agg_over_time_bucket";
    inner_agg: "count" | "sum" | "avg" | "min" | "max" | "distinct_count";
    outer_agg: "count" | "sum" | "avg" | "min" | "max" | "distinct_count";
    agg?: "count" | "sum" | "avg" | "min" | "max" | "distinct_count";
    value_column?: string;
    time_column: string;
    granularity: "day" | "week" | "month";
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
    granularity: "day" | "week" | "month";
  };
  line_data_labels_enabled?: boolean;
  line_data_labels_percent?: number;
  line_label_window?: number;
  line_label_min_gap?: number;
  line_label_mode?: "peak" | "valley" | "both";
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
  params: unknown[];
  error?: string | null;
};

export type ApiDashboardDebugFinalQueryItem = {
  execution_kind: "single" | "deduped" | "kpi_batched";
  widget_ids: number[];
  sql: string;
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

export type ApiInsightChatRequest = {
  dataset_id: number;
  question: string;
  history?: Array<{
    role: "user" | "assistant" | "clarification" | "error";
    content: string;
  }>;
  planner_previous_response_id?: string;
  answer_previous_response_id?: string;
};

export type ApiInsightLLMContext = {
  planner_response_id?: string | null;
  answer_response_id?: string | null;
};

export type ApiInsightChatAnswer = {
  type: "answer";
  answer: string;
  interpreted_question: string;
  query_plan: {
    metrics: Array<{ field: string; agg: string }>;
    dimensions: string[];
    filters: Array<{ field: string; op: string; value?: unknown[] | null }>;
    period?: {
      field?: string | null;
      start?: string | null;
      end?: string | null;
      granularity?: "day" | "week" | "month" | null;
      preset?: string | null;
    } | null;
    sort: Array<{ field: string; dir: "asc" | "desc" }>;
    limit: number;
    assumptions: string[];
  };
  query_config: ApiQuerySpec;
  columns: string[];
  rows: Record<string, unknown>[];
  row_count: number;
  calculation: {
    sql: string;
    params: unknown[];
    applied_filters: Array<{ field: string; op: string; value?: unknown[] | null }>;
    cost_estimate: number;
    conversation_cost_estimate_usd: number;
    llm_input_tokens: number;
    llm_output_tokens: number;
    llm_total_tokens: number;
    execution_time_ms: number;
    cache_hit: boolean;
    deduped: boolean;
    timeout_seconds: number;
  };
  cache_hit: boolean;
  stages?: Array<"analyzing" | "building_query" | "querying" | "generating">;
  llm_context?: ApiInsightLLMContext | null;
};

export type ApiInsightChatClarification = {
  type: "clarification";
  clarification_question: string;
  stages?: Array<"analyzing" | "building_query" | "querying" | "generating">;
  llm_context?: ApiInsightLLMContext | null;
};

export type ApiInsightChatError = {
  type: "error";
  error_code: string;
  message: string;
  suggestions: string[];
  stages?: Array<"analyzing" | "building_query" | "querying" | "generating">;
  llm_context?: ApiInsightLLMContext | null;
};

export type ApiInsightChatResponse =
  | ApiInsightChatAnswer
  | ApiInsightChatClarification
  | ApiInsightChatError;

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

  syncDatasource: (datasourceId: number) => request<{ status: string; synced_views: number }>(`/datasources/${datasourceId}/sync`, { method: "POST" }),

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

  createDashboardWidget: (
    dashboardId: number,
    payload: {
      widget_type: "kpi" | "line" | "bar" | "table" | "text";
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
      widget_type: "kpi" | "line" | "bar" | "table" | "text";
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

  getInsightsIntegration: () =>
    request<ApiLLMIntegrationStatus>("/insights/integration"),

  listInsightsIntegrations: () =>
    request<ApiLLMIntegrationListResponse>("/insights/integrations"),

  createOpenAIIntegration: (payload: { api_key: string; model?: string; is_active?: boolean }) =>
    request<ApiLLMIntegrationItem>("/insights/integrations/openai", {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  activateInsightsIntegration: (integrationId: number) =>
    request<ApiLLMIntegrationItem>(`/insights/integrations/${integrationId}/activate`, {
      method: "PATCH",
    }),

  deactivateInsightsIntegration: (integrationId: number) =>
    request<ApiLLMIntegrationItem>(`/insights/integrations/${integrationId}/deactivate`, {
      method: "PATCH",
    }),

  testInsightsIntegration: (integrationId: number) =>
    request<ApiOpenAIIntegrationTestResponse>(`/insights/integrations/${integrationId}/test`, {
      method: "POST",
    }),

  refreshInsightsIntegrationsBilling: () =>
    request<ApiLLMIntegrationBillingRefreshResponse>("/insights/integrations/billing/refresh", {
      method: "POST",
    }),

  upsertOpenAIIntegration: (payload: { api_key: string; model?: string }) =>
    request<ApiLLMIntegrationStatus>("/insights/integration/openai", {
      method: "PUT",
      body: JSON.stringify(payload),
    }),

  testOpenAIIntegration: (payload: { api_key?: string; model?: string }) =>
    request<ApiOpenAIIntegrationTestResponse>("/insights/integration/openai/test", {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  askInsight: (payload: ApiInsightChatRequest) =>
    request<ApiInsightChatResponse>("/insights/chat", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
};
