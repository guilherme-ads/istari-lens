from sqlalchemy import Column, Integer, String, DateTime, Boolean, Text, JSON, ForeignKey, Index
from sqlalchemy.orm import relationship
from datetime import datetime
from app.database import Base

class User(Base):
    __tablename__ = "users"
    
    id = Column(Integer, primary_key=True, index=True)
    email = Column(String(255), unique=True, index=True, nullable=False)
    hashed_password = Column(String(255), nullable=False)
    full_name = Column(String(255))
    is_admin = Column(Boolean, default=False)
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


class DataSource(Base):
    """External PostgreSQL database source for views."""
    __tablename__ = "datasources"
    
    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(255), nullable=False, index=True)
    description = Column(Text)
    database_url = Column(String(1024), nullable=False)  # Encrypted
    schema_pattern = Column(String(255))  # Optional regex to filter schemas
    is_active = Column(Boolean, default=True, index=True)
    created_by_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
    last_synced_at = Column(DateTime, nullable=True)
    
    created_by_user = relationship("User", back_populates="datasources")
    views = relationship("View", back_populates="datasource", cascade="all, delete-orphan")
    datasets = relationship("Dataset", back_populates="datasource", cascade="all, delete-orphan")


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
    view_id = Column(Integer, ForeignKey("views.id"), nullable=False)
    name = Column(String(255), nullable=False)
    description = Column(Text)
    is_active = Column(Boolean, default=True, index=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    datasource = relationship("DataSource", back_populates="datasets")
    view = relationship("View", back_populates="datasets")
    dashboards = relationship("Dashboard", back_populates="dataset", cascade="all, delete-orphan")

    __table_args__ = (
        Index("dataset_datasource_idx", "datasource_id"),
        Index("dataset_view_idx", "view_id"),
    )


class Dashboard(Base):
    __tablename__ = "dashboards"

    id = Column(Integer, primary_key=True, index=True)
    dataset_id = Column(Integer, ForeignKey("datasets.id"), nullable=False)
    name = Column(String(255), nullable=False)
    description = Column(Text)
    layout_config = Column(JSON, nullable=False, default=list)
    native_filters = Column(JSON, nullable=False, default=list)
    is_active = Column(Boolean, default=True, index=True)
    created_by_id = Column(Integer, ForeignKey("users.id"), nullable=True, index=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    dataset = relationship("Dataset", back_populates="dashboards")
    widgets = relationship("DashboardWidget", back_populates="dashboard", cascade="all, delete-orphan")
    created_by_user = relationship("User", back_populates="dashboards")

    __table_args__ = (
        Index("dashboard_dataset_idx", "dataset_id"),
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

    __table_args__ = (
        Index("llm_integrations_provider_idx", "provider"),
    )
