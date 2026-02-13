from pydantic import BaseModel, Field, model_validator
from datetime import datetime
from typing import Any, List, Optional, Literal

from app.widget_config import FilterConfig, WidgetConfig, WidgetType

# ==================== AUTH ====================

class UserLogin(BaseModel):
    email: str
    password: str

class UserRegister(BaseModel):
    email: str
    password: str
    full_name: Optional[str] = None

class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: "UserResponse"

class UserResponse(BaseModel):
    id: int
    email: str
    full_name: Optional[str]
    is_admin: bool
    created_at: datetime
    
    class Config:
        from_attributes = True


# ==================== VIEWS / DATASETS ====================

class ViewColumnResponse(BaseModel):
    id: int
    column_name: str
    column_type: str
    description: Optional[str]
    is_aggregatable: bool
    is_filterable: bool
    is_groupable: bool
    
    class Config:
        from_attributes = True

class ViewResponse(BaseModel):
    id: int
    datasource_id: int
    schema_name: str
    view_name: str
    description: Optional[str]
    is_active: bool
    columns: List[ViewColumnResponse]
    created_at: datetime
    
    class Config:
        from_attributes = True

class ViewCreateRequest(BaseModel):
    schema_name: str
    view_name: str
    description: Optional[str] = None

class ViewUpdateRequest(BaseModel):
    description: Optional[str] = None
    is_active: Optional[bool] = None


class DatasetResponse(BaseModel):
    id: int
    datasource_id: int
    view_id: int
    name: str
    description: Optional[str]
    is_active: bool
    view: ViewResponse
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


class AdminUserBaseResponse(BaseModel):
    id: int
    email: str
    full_name: Optional[str]
    role: Literal["ADMIN", "USER"]
    is_active: bool
    created_at: datetime
    updated_at: datetime
    last_login_at: Optional[datetime] = None
    deleted_at: Optional[datetime] = None


class AdminUserResponse(AdminUserBaseResponse):
    pass


class AdminUserListResponse(BaseModel):
    items: List[AdminUserResponse]
    total: int
    page: int
    page_size: int


class AdminUserCreateRequest(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    email: str = Field(min_length=3, max_length=255)
    role: Literal["ADMIN", "USER"] = "USER"
    is_active: bool = True
    password: str = Field(min_length=8, max_length=128)


class AdminUserUpdateRequest(BaseModel):
    name: Optional[str] = Field(default=None, min_length=1, max_length=255)
    email: Optional[str] = Field(default=None, min_length=3, max_length=255)
    role: Optional[Literal["ADMIN", "USER"]] = None
    is_active: Optional[bool] = None


class AdminUserResetPasswordRequest(BaseModel):
    password: str = Field(min_length=8, max_length=128)


class DatasetCreateRequest(BaseModel):
    datasource_id: int
    view_id: int
    name: str
    description: Optional[str] = None
    is_active: bool = True


class DatasetUpdateRequest(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    is_active: Optional[bool] = None


class DashboardWidgetResponse(BaseModel):
    id: int
    dashboard_id: int
    widget_type: str
    title: Optional[str]
    position: int
    query_config: dict
    config_version: int
    visualization_config: Optional[dict]
    last_execution_ms: Optional[int] = None
    last_executed_at: Optional[datetime] = None
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


class DashboardResponse(BaseModel):
    id: int
    dataset_id: int
    created_by_id: Optional[int] = None
    name: str
    description: Optional[str]
    is_active: bool
    layout_config: List[dict] = Field(default_factory=list)
    native_filters: List[FilterConfig] = Field(default_factory=list)
    widgets: List[DashboardWidgetResponse]
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


class DashboardCreateRequest(BaseModel):
    dataset_id: int
    name: str
    description: Optional[str] = None
    layout_config: List[dict] = Field(default_factory=list)
    native_filters: List[FilterConfig] = Field(default_factory=list)
    is_active: bool = True


class DashboardUpdateRequest(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    layout_config: Optional[List[dict]] = None
    native_filters: Optional[List[FilterConfig]] = None
    is_active: Optional[bool] = None


class DashboardWidgetCreateRequest(BaseModel):
    widget_type: WidgetType
    title: Optional[str] = None
    position: int = 0
    config: WidgetConfig | None = None
    query_config: dict | None = None
    config_version: int = 1
    visualization_config: Optional[dict] = None

    @model_validator(mode="after")
    def validate_config_payload(self) -> "DashboardWidgetCreateRequest":
        if self.config is None and self.query_config is None:
            raise ValueError("Either config or query_config is required")
        return self


class DashboardWidgetUpdateRequest(BaseModel):
    widget_type: Optional[WidgetType] = None
    title: Optional[str] = None
    position: Optional[int] = None
    config: WidgetConfig | None = None
    query_config: Optional[dict] = None
    config_version: Optional[int] = None
    visualization_config: Optional[dict] = None


class DashboardWidgetDataResponse(BaseModel):
    columns: List[str]
    rows: List[dict]
    row_count: int
    cache_hit: bool = False
    stale: bool = False
    deduped: bool = False
    batched: bool = False
    degraded: bool = False
    execution_time_ms: int = 0
    sql_hash: Optional[str] = None


class DashboardWidgetBatchDataRequest(BaseModel):
    widget_ids: List[int] = Field(default_factory=list)
    global_filters: List[FilterConfig] = Field(default_factory=list)


class DashboardWidgetBatchDataItemResponse(BaseModel):
    widget_id: int
    columns: List[str]
    rows: List[dict]
    row_count: int
    cache_hit: bool = False
    stale: bool = False
    deduped: bool = False
    batched: bool = False
    degraded: bool = False
    execution_time_ms: int = 0
    sql_hash: Optional[str] = None


class DashboardWidgetBatchDataResponse(BaseModel):
    results: List[DashboardWidgetBatchDataItemResponse]


class DashboardDebugQueriesRequest(BaseModel):
    native_filters_override: Optional[List[FilterConfig]] = None
    global_filters: List[FilterConfig] = Field(default_factory=list)
    mode: Literal["widget", "dashboard"] = "widget"


class DashboardDebugQueryItemResponse(BaseModel):
    widget_id: int
    widget_type: str
    title: Optional[str] = None
    status: Literal["ok", "text_widget", "error"]
    sql: Optional[str] = None
    params: List[Any] = Field(default_factory=list)
    error: Optional[str] = None


class DashboardDebugFinalQueryItemResponse(BaseModel):
    execution_kind: Literal["single", "deduped", "kpi_batched"]
    widget_ids: List[int] = Field(default_factory=list)
    sql: str
    params: List[Any] = Field(default_factory=list)
    sql_hash: str
    fingerprint_key: str


class DashboardDebugQueriesResponse(BaseModel):
    dashboard_id: int
    dashboard_name: str
    dataset_id: int
    datasource_id: Optional[int] = None
    view_name: Optional[str] = None
    items: List[DashboardDebugQueryItemResponse]
    final_items: List[DashboardDebugFinalQueryItemResponse] = Field(default_factory=list)
    mode: Literal["widget", "dashboard"] = "widget"


class DashboardCatalogItemResponse(BaseModel):
    id: int
    dataset_id: int
    dataset_name: str
    name: str
    created_by_id: Optional[int] = None
    created_by_name: Optional[str] = None
    created_by_email: Optional[str] = None
    widget_count: int
    last_edited_at: datetime
    last_data_refresh_at: Optional[datetime] = None
    load_score: float
    complexity_score: float
    runtime_score: Optional[float] = None
    telemetry_coverage: float = 0.0
    avg_widget_execution_ms: Optional[float] = None
    p95_widget_execution_ms: Optional[int] = None
    slowest_widget_execution_ms: Optional[int] = None
    last_widget_executed_at: Optional[datetime] = None


# ==================== QUERY SPEC ====================

class MetricSpec(BaseModel):
    field: str
    agg: str = Field(..., description="count, sum, avg, min, max, distinct_count")

class FilterSpec(BaseModel):
    field: str
    op: str = Field(..., description="eq, neq, in, not_in, contains, is_null, not_null, gte, lte, between")
    value: Optional[List] = None

class SortSpec(BaseModel):
    field: str
    dir: str = Field(..., description="asc, desc")

class VisualizationConfig(BaseModel):
    type: str = Field(..., description="table, kpi, line, bar, column, pie")
    config: Optional[dict] = {}

class QuerySpec(BaseModel):
    datasetId: int
    metrics: List[MetricSpec]
    dimensions: List[str] = []
    filters: List[FilterSpec] = []
    sort: List[SortSpec] = []
    limit: int = 500
    offset: int = 0
    visualization: Optional[VisualizationConfig] = None

class QueryPreviewResponse(BaseModel):
    columns: List[str]
    rows: List[dict]
    row_count: int


class QueryPreviewBatchItem(BaseModel):
    widget_id: str
    spec: QuerySpec


class QueryPreviewBatchRequest(BaseModel):
    queries: List[QueryPreviewBatchItem] = Field(default_factory=list)


class QueryPreviewBatchItemResponse(BaseModel):
    widget_id: str
    columns: List[str]
    rows: List[dict]
    row_count: int
    cache_hit: bool = False


class QueryPreviewBatchResponse(BaseModel):
    results: List[QueryPreviewBatchItemResponse]


# ==================== DATASOURCES ====================

class DataSourceCreateRequest(BaseModel):
    name: str
    description: Optional[str] = None
    database_url: str
    schema_pattern: Optional[str] = None

class DataSourceUpdateRequest(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    schema_pattern: Optional[str] = None
    is_active: Optional[bool] = None

class DataSourceResponse(BaseModel):
    id: int
    name: str
    description: Optional[str]
    schema_pattern: Optional[str]
    is_active: bool
    last_synced_at: Optional[datetime]
    created_at: datetime
    
    class Config:
        from_attributes = True

class DataSourceDetailResponse(DataSourceResponse):
    """DataSource with views."""
    views: List["ViewResponse"] = []


class ViewSchemaColumnResponse(BaseModel):
    column_name: str
    column_type: str
    normalized_type: str


# ==================== QUERY CACHE ====================

class QueryCacheResponse(BaseModel):
    id: int
    analysis_id: int
    row_count: int
    execution_time_ms: int
    last_executed_at: datetime
    expires_at: datetime
    
    class Config:
        from_attributes = True


# ==================== ANALYSES ====================

class AnalysisCreateRequest(BaseModel):
    datasource_id: Optional[int] = None
    dataset_id: int
    name: str
    description: Optional[str] = None
    query_config: QuerySpec
    visualization_config: Optional[VisualizationConfig] = None

class AnalysisResponse(BaseModel):
    id: int
    datasource_id: int
    dataset_id: int
    name: str
    description: Optional[str]
    query_config: QuerySpec
    visualization_config: Optional[VisualizationConfig]
    created_at: datetime
    updated_at: datetime
    
    class Config:
        from_attributes = True

class AnalysisUpdateRequest(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    query_config: Optional[QuerySpec] = None
    visualization_config: Optional[VisualizationConfig] = None


# ==================== SHARES ====================

class ShareCreateRequest(BaseModel):
    pass

class ShareResponse(BaseModel):
    token: str
    analysis_id: int
    created_at: datetime
    
    class Config:
        from_attributes = True

class SharedAnalysisResponse(BaseModel):
    analysis: AnalysisResponse
    data: QueryPreviewResponse


# ==================== INSIGHTS / LLM ====================

class LLMIntegrationResponse(BaseModel):
    provider: Literal["openai"]
    configured: bool
    model: Optional[str] = None
    masked_api_key: Optional[str] = None
    updated_at: Optional[datetime] = None
    updated_by_id: Optional[int] = None


class OpenAIIntegrationUpsertRequest(BaseModel):
    api_key: str = Field(min_length=20, max_length=512)
    model: str = Field(default="gpt-4o-mini", min_length=3, max_length=100)


class OpenAIIntegrationTestRequest(BaseModel):
    api_key: Optional[str] = Field(default=None, min_length=20, max_length=512)
    model: str = Field(default="gpt-4o-mini", min_length=3, max_length=100)


class OpenAIIntegrationTestResponse(BaseModel):
    ok: bool
    message: str
    model: str


class InsightChatRequest(BaseModel):
    dataset_id: int
    question: str = Field(max_length=2000)
    history: List[dict] = Field(default_factory=list)
    planner_previous_response_id: Optional[str] = Field(default=None, max_length=200)
    answer_previous_response_id: Optional[str] = Field(default=None, max_length=200)


class InsightLLMContext(BaseModel):
    planner_response_id: Optional[str] = None
    answer_response_id: Optional[str] = None


class InsightPlanPeriod(BaseModel):
    field: Optional[str] = None
    start: Optional[str] = None
    end: Optional[str] = None
    granularity: Optional[Literal["day", "week", "month"]] = None
    preset: Optional[str] = None


class InsightQueryPlan(BaseModel):
    metrics: List[MetricSpec] = Field(default_factory=list)
    dimensions: List[str] = Field(default_factory=list)
    filters: List[FilterSpec] = Field(default_factory=list)
    period: Optional[InsightPlanPeriod] = None
    sort: List[SortSpec] = Field(default_factory=list)
    limit: int = 100
    assumptions: List[str] = Field(default_factory=list)


class InsightCalculationResponse(BaseModel):
    sql: str
    params: List[Any] = Field(default_factory=list)
    applied_filters: List[FilterSpec] = Field(default_factory=list)
    cost_estimate: int
    execution_time_ms: int
    cache_hit: bool = False
    deduped: bool = False
    timeout_seconds: int


class InsightClarificationResponse(BaseModel):
    type: Literal["clarification"] = "clarification"
    clarification_question: str
    stages: List[Literal["analyzing", "building_query", "querying", "generating"]] = Field(default_factory=list)
    llm_context: Optional[InsightLLMContext] = None


class InsightAnswerResponse(BaseModel):
    type: Literal["answer"] = "answer"
    answer: str
    interpreted_question: str
    query_plan: InsightQueryPlan
    query_config: QuerySpec
    columns: List[str]
    rows: List[dict]
    row_count: int
    calculation: InsightCalculationResponse
    cache_hit: bool = False
    stages: List[Literal["analyzing", "building_query", "querying", "generating"]] = Field(default_factory=list)
    llm_context: Optional[InsightLLMContext] = None


class InsightErrorResponse(BaseModel):
    type: Literal["error"] = "error"
    error_code: str
    message: str
    suggestions: List[str] = Field(default_factory=list)
    stages: List[Literal["analyzing", "building_query", "querying", "generating"]] = Field(default_factory=list)
    llm_context: Optional[InsightLLMContext] = None
