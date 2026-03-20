from sqlalchemy import Column, Integer, String, DateTime, Boolean, Text, JSON, ForeignKey, Index
from sqlalchemy.orm import relationship
from datetime import datetime
from app.shared.infrastructure.database import Base

class User(Base):
    __tablename__ = "users"
    
    id = Column(Integer, primary_key=True, index=True)
    email = Column(String(255), unique=True, index=True, nullable=False)
    hashed_password = Column(String(255), nullable=False)
    full_name = Column(String(255))
    is_admin = Column(Boolean, default=False)
    is_owner = Column(Boolean, default=False)
    is_active = Column(Boolean, default=True)
    last_login_at = Column(DateTime, nullable=True)
    deleted_at = Column(DateTime, nullable=True, index=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
    
    analyses = relationship("Analysis", back_populates="owner")
    shares = relationship("Share", back_populates="created_by_user")
    datasources = relationship("DataSource", back_populates="created_by_user")
    dashboards = relationship("Dashboard", back_populates="created_by_user")
    llm_integrations_created = relationship(
        "LLMIntegration",
        foreign_keys="LLMIntegration.created_by_id",
        back_populates="created_by_user",
    )
    llm_integrations_updated = relationship(
        "LLMIntegration",
        foreign_keys="LLMIntegration.updated_by_id",
        back_populates="updated_by_user",
    )
    spreadsheet_imports = relationship("SpreadsheetImport", back_populates="created_by_user")
    dashboard_email_shares_created = relationship("DashboardEmailShare", back_populates="created_by_user")
    dataset_email_shares_created = relationship("DatasetEmailShare", back_populates="created_by_user")
    dashboard_favorites = relationship("DashboardFavorite", back_populates="user", cascade="all, delete-orphan")
    dashboard_edit_locks = relationship("DashboardEditLock", back_populates="user", overlaps="user")
    auth_sessions = relationship("AuthSession", back_populates="user", cascade="all, delete-orphan")


class AuthSession(Base):
    __tablename__ = "auth_sessions"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    token_hash = Column(String(128), nullable=False, unique=True, index=True)
    ip_address = Column(String(64), nullable=True)
    user_agent = Column(String(512), nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    is_persistent = Column(Boolean, nullable=False, default=True, index=True)
    expires_at = Column(DateTime, nullable=False, index=True)
    last_used_at = Column(DateTime, nullable=True)
    revoked_at = Column(DateTime, nullable=True, index=True)

    user = relationship("User", back_populates="auth_sessions")


class DataSource(Base):
    """External PostgreSQL database source for views."""
    __tablename__ = "datasources"
    
    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(255), nullable=False, index=True)
    description = Column(Text)
    database_url = Column(String(1024), nullable=False)  # Encrypted
    schema_pattern = Column(String(255))  # Optional regex to filter schemas
    source_type = Column(String(64), nullable=False, default="postgres_external", index=True)
    tenant_id = Column(Integer, nullable=True, index=True)
    status = Column(String(32), nullable=False, default="active", index=True)
    is_active = Column(Boolean, default=True, index=True)
    created_by_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
    last_synced_at = Column(DateTime, nullable=True)
    
    created_by_user = relationship("User", back_populates="datasources")
    views = relationship("View", back_populates="datasource", cascade="all, delete-orphan")
    datasets = relationship("Dataset", back_populates="datasource", cascade="all, delete-orphan")
    spreadsheet_imports = relationship(
        "SpreadsheetImport",
        back_populates="datasource",
        cascade="all, delete-orphan",
    )


class View(Base):
    __tablename__ = "views"
    
    id = Column(Integer, primary_key=True, index=True)
    datasource_id = Column(Integer, ForeignKey("datasources.id"), nullable=False)
    schema_name = Column(String(255), nullable=False)
    view_name = Column(String(255), nullable=False)
    description = Column(Text)
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
    
    datasource = relationship("DataSource", back_populates="views")
    columns = relationship("ViewColumn", back_populates="view", cascade="all, delete-orphan")
    datasets = relationship("Dataset", back_populates="view", cascade="all, delete-orphan")
    
    __table_args__ = (
        Index("view_datasource_schema_name_idx", "datasource_id", "schema_name", "view_name"),
    )


class ViewColumn(Base):
    __tablename__ = "view_columns"
    
    id = Column(Integer, primary_key=True, index=True)
    view_id = Column(Integer, ForeignKey("views.id", ondelete="CASCADE"), nullable=False)
    column_name = Column(String(255), nullable=False)
    column_type = Column(String(50), nullable=False)  # numeric, text, boolean, date, etc
    description = Column(Text)
    is_aggregatable = Column(Boolean, default=False)
    is_filterable = Column(Boolean, default=True)
    is_groupable = Column(Boolean, default=False)
    created_at = Column(DateTime, default=datetime.utcnow)
    
    view = relationship("View", back_populates="columns")


class Dataset(Base):
    __tablename__ = "datasets"

    id = Column(Integer, primary_key=True, index=True)
    datasource_id = Column(Integer, ForeignKey("datasources.id"), nullable=False)
    view_id = Column(Integer, ForeignKey("views.id"), nullable=True)
    name = Column(String(255), nullable=False)
    description = Column(Text)
    base_query_spec = Column(JSON, nullable=True)
    semantic_columns = Column(JSON, nullable=False, default=list)
    is_active = Column(Boolean, default=True, index=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    datasource = relationship("DataSource", back_populates="datasets")
    view = relationship("View", back_populates="datasets")
    dashboards = relationship("Dashboard", back_populates="dataset", cascade="all, delete-orphan")
    email_shares = relationship("DatasetEmailShare", back_populates="dataset", cascade="all, delete-orphan")
    metrics = relationship("Metric", back_populates="dataset", cascade="all, delete-orphan")
    dimensions = relationship("Dimension", back_populates="dataset", cascade="all, delete-orphan")

    __table_args__ = (
        Index("dataset_datasource_idx", "datasource_id"),
        Index("dataset_view_idx", "view_id"),
    )


class Metric(Base):
    __tablename__ = "metrics"

    id = Column(Integer, primary_key=True, index=True)
    dataset_id = Column(Integer, ForeignKey("datasets.id", ondelete="CASCADE"), nullable=False, index=True)
    name = Column(String(255), nullable=False, index=True)
    description = Column(Text)
    formula = Column(Text, nullable=False)
    unit = Column(String(64))
    default_grain = Column(String(64))
    synonyms = Column(JSON, nullable=False, default=list)
    examples = Column(JSON, nullable=False, default=list)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False)

    dataset = relationship("Dataset", back_populates="metrics")
    dimensions = relationship("Dimension", secondary="metric_dimensions", back_populates="metrics")

    __table_args__ = (
        Index("metrics_dataset_name_idx", "dataset_id", "name", unique=True),
    )


class Dimension(Base):
    __tablename__ = "dimensions"

    id = Column(Integer, primary_key=True, index=True)
    dataset_id = Column(Integer, ForeignKey("datasets.id", ondelete="CASCADE"), nullable=False, index=True)
    name = Column(String(255), nullable=False, index=True)
    description = Column(Text)
    type = Column(String(32), nullable=False, default="categorical", index=True)
    synonyms = Column(JSON, nullable=False, default=list)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False)

    dataset = relationship("Dataset", back_populates="dimensions")
    metrics = relationship("Metric", secondary="metric_dimensions", back_populates="dimensions")

    __table_args__ = (
        Index("dimensions_dataset_name_idx", "dataset_id", "name", unique=True),
    )


class MetricDimension(Base):
    __tablename__ = "metric_dimensions"

    metric_id = Column(Integer, ForeignKey("metrics.id", ondelete="CASCADE"), primary_key=True)
    dimension_id = Column(Integer, ForeignKey("dimensions.id", ondelete="CASCADE"), primary_key=True)


class Dashboard(Base):
    __tablename__ = "dashboards"

    id = Column(Integer, primary_key=True, index=True)
    dataset_id = Column(Integer, ForeignKey("datasets.id"), nullable=False)
    name = Column(String(255), nullable=False)
    description = Column(Text)
    layout_config = Column(JSON, nullable=False, default=list)
    native_filters = Column(JSON, nullable=False, default=list)
    is_active = Column(Boolean, default=True, index=True)
    visibility = Column(String(32), nullable=False, default="private", index=True)
    public_share_key = Column(String(64), nullable=True, unique=True, index=True)
    created_by_id = Column(Integer, ForeignKey("users.id"), nullable=True, index=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    dataset = relationship("Dataset", back_populates="dashboards")
    widgets = relationship("DashboardWidget", back_populates="dashboard", cascade="all, delete-orphan")
    created_by_user = relationship("User", back_populates="dashboards")
    email_shares = relationship("DashboardEmailShare", back_populates="dashboard", cascade="all, delete-orphan")
    favorites = relationship("DashboardFavorite", back_populates="dashboard", cascade="all, delete-orphan")
    versions = relationship("DashboardVersion", back_populates="dashboard", cascade="all, delete-orphan")
    edit_lock = relationship(
        "DashboardEditLock",
        back_populates="dashboard",
        cascade="all, delete-orphan",
        uselist=False,
        overlaps="dashboard",
    )

    __table_args__ = (
        Index("dashboard_dataset_idx", "dataset_id"),
    )


class DatasetEmailShare(Base):
    __tablename__ = "dataset_email_shares"

    id = Column(Integer, primary_key=True, index=True)
    dataset_id = Column(Integer, ForeignKey("datasets.id", ondelete="CASCADE"), nullable=False, index=True)
    email = Column(String(255), nullable=False, index=True)
    created_by_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    dataset = relationship("Dataset", back_populates="email_shares")
    created_by_user = relationship("User", back_populates="dataset_email_shares_created")

    __table_args__ = (
        Index("dataset_email_share_unique_idx", "dataset_id", "email", unique=True),
    )


class DashboardEmailShare(Base):
    __tablename__ = "dashboard_email_shares"

    id = Column(Integer, primary_key=True, index=True)
    dashboard_id = Column(Integer, ForeignKey("dashboards.id", ondelete="CASCADE"), nullable=False, index=True)
    email = Column(String(255), nullable=False, index=True)
    permission = Column(String(16), nullable=False, default="view")
    created_by_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    dashboard = relationship("Dashboard", back_populates="email_shares")
    created_by_user = relationship("User", back_populates="dashboard_email_shares_created")

    __table_args__ = (
        Index("dashboard_email_share_unique_idx", "dashboard_id", "email", unique=True),
    )


class DashboardFavorite(Base):
    __tablename__ = "dashboard_favorites"

    id = Column(Integer, primary_key=True, index=True)
    dashboard_id = Column(Integer, ForeignKey("dashboards.id", ondelete="CASCADE"), nullable=False, index=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False)

    dashboard = relationship("Dashboard", back_populates="favorites")
    user = relationship("User", back_populates="dashboard_favorites")

    __table_args__ = (
        Index("dashboard_favorite_unique_idx", "dashboard_id", "user_id", unique=True),
    )


class DashboardWidget(Base):
    __tablename__ = "dashboard_widgets"

    id = Column(Integer, primary_key=True, index=True)
    dashboard_id = Column(Integer, ForeignKey("dashboards.id"), nullable=False)
    widget_type = Column(String(50), nullable=False)  # table, kpi, line, bar, pie, etc
    title = Column(String(255))
    position = Column(Integer, default=0)
    query_config = Column(JSON, nullable=False)
    config_version = Column(Integer, nullable=False, default=1)
    visualization_config = Column(JSON)
    last_execution_ms = Column(Integer, nullable=True)
    last_executed_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    dashboard = relationship("Dashboard", back_populates="widgets")

    __table_args__ = (
        Index("widget_dashboard_idx", "dashboard_id"),
    )


class DashboardVersion(Base):
    __tablename__ = "dashboard_versions"

    id = Column(Integer, primary_key=True, index=True)
    dashboard_id = Column(Integer, ForeignKey("dashboards.id", ondelete="CASCADE"), nullable=False, index=True)
    version_number = Column(Integer, nullable=False)
    snapshot = Column(JSON, nullable=False, default=dict)
    created_by_id = Column(Integer, ForeignKey("users.id"), nullable=True, index=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False, index=True)

    dashboard = relationship("Dashboard", back_populates="versions")

    __table_args__ = (
        Index("dashboard_versions_dashboard_version_idx", "dashboard_id", "version_number", unique=True),
    )


class DashboardEditLock(Base):
    __tablename__ = "dashboard_edit_locks"

    id = Column(Integer, primary_key=True, index=True)
    dashboard_id = Column(Integer, ForeignKey("dashboards.id", ondelete="CASCADE"), nullable=False, index=True, unique=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    acquired_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    expires_at = Column(DateTime, nullable=False, index=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False)

    dashboard = relationship("Dashboard", back_populates="edit_lock", overlaps="edit_lock")
    user = relationship("User", back_populates="dashboard_edit_locks", overlaps="dashboard_edit_locks")


class Analysis(Base):
    __tablename__ = "analyses"
    
    id = Column(Integer, primary_key=True, index=True)
    owner_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    dataset_id = Column(Integer, ForeignKey("views.id"), nullable=False)
    datasource_id = Column(Integer, ForeignKey("datasources.id"), nullable=False)
    name = Column(String(255), nullable=False)
    description = Column(Text)
    query_config = Column(JSON, nullable=False)  # Stores the query spec
    visualization_config = Column(JSON)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
    
    owner = relationship("User", back_populates="analyses")
    dataset = relationship("View")
    datasource = relationship("DataSource")
    shares = relationship("Share", back_populates="analysis")
    cache = relationship("QueryCache", back_populates="analysis", uselist=False, cascade="all, delete-orphan")


class QueryCache(Base):
    """Cache query results to avoid overloading external databases."""
    __tablename__ = "query_cache"
    
    id = Column(Integer, primary_key=True, index=True)
    analysis_id = Column(Integer, ForeignKey("analyses.id"), nullable=False, unique=True)
    result_data = Column(JSON, nullable=False)  # Raw query results
    row_count = Column(Integer, default=0)
    execution_time_ms = Column(Integer, default=0)
    last_executed_at = Column(DateTime, default=datetime.utcnow)
    expires_at = Column(DateTime, nullable=False)  # TTL for cache validity
    
    analysis = relationship("Analysis", back_populates="cache")


class Share(Base):
    __tablename__ = "shares"
    
    id = Column(Integer, primary_key=True, index=True)
    analysis_id = Column(Integer, ForeignKey("analyses.id"), nullable=False, unique=True)
    created_by_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    token = Column(String(255), unique=True, index=True, nullable=False)
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    expires_at = Column(DateTime, nullable=True)
    
    analysis = relationship("Analysis", back_populates="shares")
    created_by_user = relationship("User", back_populates="shares")


class LLMIntegration(Base):
    __tablename__ = "llm_integrations"

    id = Column(Integer, primary_key=True, index=True)
    provider = Column(String(50), nullable=False, index=True, default="openai")
    encrypted_api_key = Column(Text, nullable=False)
    model = Column(String(100), nullable=False, default="gpt-4o-mini")
    is_active = Column(Boolean, nullable=False, default=True)
    created_by_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    updated_by_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False)

    created_by_user = relationship(
        "User",
        foreign_keys=[created_by_id],
        back_populates="llm_integrations_created",
    )
    updated_by_user = relationship(
        "User",
        foreign_keys=[updated_by_id],
        back_populates="llm_integrations_updated",
    )
    billing_snapshots = relationship(
        "LLMIntegrationBillingSnapshot",
        back_populates="integration",
        cascade="all, delete-orphan",
    )

    __table_args__ = (
        Index("llm_integrations_provider_idx", "provider"),
    )


class LLMIntegrationBillingSnapshot(Base):
    __tablename__ = "llm_integration_billing_snapshots"

    id = Column(Integer, primary_key=True, index=True)
    integration_id = Column(Integer, ForeignKey("llm_integrations.id", ondelete="CASCADE"), nullable=False, index=True)
    spent_usd = Column(String(50), nullable=False, default="0")
    budget_usd = Column(String(50), nullable=True)
    estimated_remaining_usd = Column(String(50), nullable=True)
    period_start = Column(DateTime, nullable=False)
    period_end = Column(DateTime, nullable=False)
    fetched_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    created_by_id = Column(Integer, ForeignKey("users.id"), nullable=False)

    integration = relationship("LLMIntegration", back_populates="billing_snapshots")

    __table_args__ = (
        Index("llm_integration_billing_snapshot_integration_idx", "integration_id", "fetched_at"),
    )


class SpreadsheetImport(Base):
    __tablename__ = "spreadsheet_imports"

    id = Column(Integer, primary_key=True, index=True)
    datasource_id = Column(Integer, ForeignKey("datasources.id", ondelete="CASCADE"), nullable=False, index=True)
    tenant_id = Column(Integer, nullable=False, index=True)
    created_by_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    status = Column(String(32), nullable=False, default="created", index=True)
    display_name = Column(String(255), nullable=False)
    timezone = Column(String(64), nullable=False, default="UTC")
    header_row = Column(Integer, nullable=False, default=1)
    sheet_name = Column(String(255), nullable=True)
    cell_range = Column(String(64), nullable=True)
    csv_delimiter = Column(String(8), nullable=True)
    file_uri = Column(String(1024), nullable=True)
    file_hash = Column(String(128), nullable=True)
    file_size_bytes = Column(Integer, nullable=True)
    file_format = Column(String(16), nullable=True)
    inferred_schema = Column(JSON, nullable=False, default=list)
    mapped_schema = Column(JSON, nullable=False, default=list)
    preview_rows = Column(JSON, nullable=False, default=list)
    row_count = Column(Integer, nullable=False, default=0)
    table_name = Column(String(255), nullable=True)
    resource_id = Column(String(512), nullable=True)
    dataset_id = Column(Integer, ForeignKey("datasets.id"), nullable=True, index=True)
    started_at = Column(DateTime, nullable=True)
    finished_at = Column(DateTime, nullable=True)
    confirmed_at = Column(DateTime, nullable=True)
    error_samples = Column(JSON, nullable=False, default=list)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False)

    datasource = relationship("DataSource", back_populates="spreadsheet_imports")
    created_by_user = relationship("User", back_populates="spreadsheet_imports")

