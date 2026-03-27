from collections.abc import Generator

import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.modules.core.legacy.models import Base, DataSource, User, View, ViewColumn
from app.modules.datasets import validate_and_resolve_base_query_spec


@pytest.fixture
def db_session() -> Generator[Session, None, None]:
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    TestingSessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
    Base.metadata.create_all(bind=engine)

    session = TestingSessionLocal()

    user = User(email="dataset-spec@test.com", hashed_password="x", is_admin=True, is_active=True)
    session.add(user)
    session.flush()

    datasource = DataSource(
        name="analytics",
        description="",
        database_url="postgresql://fake",
        created_by_id=user.id,
        is_active=True,
    )
    spreadsheet_datasource = DataSource(
        name="spreadsheet",
        description="",
        database_url="postgresql://fake-internal",
        source_type="file_spreadsheet_import",
        created_by_id=user.id,
        is_active=True,
    )
    session.add_all([datasource, spreadsheet_datasource])
    session.flush()

    view_orders = View(datasource_id=datasource.id, schema_name="public", view_name="vw_orders", is_active=True)
    view_customers = View(datasource_id=datasource.id, schema_name="public", view_name="vw_customers", is_active=True)
    view_sheet = View(
        datasource_id=spreadsheet_datasource.id,
        schema_name=f"lens_imp_t{int(user.id)}",
        view_name="payments_sheet",
        is_active=True,
    )
    session.add_all([view_orders, view_customers, view_sheet])
    session.flush()

    session.add_all(
        [
            ViewColumn(view_id=view_orders.id, column_name="order_id", column_type="bigint", is_aggregatable=True, is_groupable=True),
            ViewColumn(view_id=view_orders.id, column_name="customer_id", column_type="bigint", is_aggregatable=True, is_groupable=True),
            ViewColumn(view_id=view_orders.id, column_name="amount", column_type="numeric", is_aggregatable=True, is_groupable=False),
            ViewColumn(view_id=view_orders.id, column_name="created_at", column_type="timestamp", is_aggregatable=False, is_groupable=True),
            ViewColumn(view_id=view_customers.id, column_name="id", column_type="bigint", is_aggregatable=True, is_groupable=True),
            ViewColumn(view_id=view_customers.id, column_name="name", column_type="text", is_aggregatable=False, is_groupable=True),
            ViewColumn(view_id=view_sheet.id, column_name="customer_id", column_type="bigint", is_aggregatable=True, is_groupable=True),
            ViewColumn(view_id=view_sheet.id, column_name="ear", column_type="boolean", is_aggregatable=False, is_groupable=True),
        ]
    )
    session.commit()

    try:
        yield session
    finally:
        session.close()


def _valid_base_query_spec(datasource_id: int) -> dict:
    return {
        "version": 1,
        "source": {"datasource_id": datasource_id},
        "base": {
            "primary_resource": "public.vw_orders",
            "resources": [
                {"id": "orders", "resource_id": "public.vw_orders"},
                {"id": "customers", "resource_id": "public.vw_customers"},
            ],
            "joins": [
                {
                    "type": "left",
                    "left_resource": "orders",
                    "right_resource": "customers",
                    "on": [{"left_column": "customer_id", "right_column": "id"}],
                }
            ],
        },
        "preprocess": {
            "columns": {
                "include": [
                    {"resource": "orders", "column": "order_id", "alias": "order_id"},
                    {"resource": "orders", "column": "amount", "alias": "amount"},
                    {"resource": "customers", "column": "name", "alias": "customer_name"},
                ],
                "exclude": [],
            },
            "computed_columns": [
                {
                    "alias": "amount_with_fee",
                    "expr": {"op": "add", "args": [{"column": "amount"}, {"literal": 2.5}]},
                    "data_type": "numeric",
                }
            ],
            "filters": [{"field": "amount", "op": "gt", "value": 0}],
        },
    }


def test_validate_base_query_spec_resolves_semantic_columns(db_session: Session) -> None:
    datasource_id = int(db_session.query(DataSource).first().id)
    spec = _valid_base_query_spec(datasource_id)

    resolved_spec, semantic_columns = validate_and_resolve_base_query_spec(
        db=db_session,
        datasource_id=datasource_id,
        base_query_spec=spec,
    )

    assert resolved_spec == spec
    assert [col["name"] for col in semantic_columns] == ["order_id", "amount", "customer_name", "amount_with_fee"]
    assert [col["type"] for col in semantic_columns] == ["numeric", "numeric", "text", "numeric"]
    assert [col["raw_type"] for col in semantic_columns] == ["bigint", "numeric", "text", "numeric"]


def test_validate_base_query_spec_rejects_unknown_expr_column(db_session: Session) -> None:
    datasource_id = int(db_session.query(DataSource).first().id)
    spec = _valid_base_query_spec(datasource_id)
    spec["preprocess"]["computed_columns"][0]["expr"] = {"op": "add", "args": [{"column": "missing"}, {"literal": 1}]}

    with pytest.raises(HTTPException) as exc:
        validate_and_resolve_base_query_spec(
            db=db_session,
            datasource_id=datasource_id,
            base_query_spec=spec,
        )

    error = exc.value
    assert error.status_code == 400
    detail = error.detail
    assert "field_errors" in detail
    assert "preprocess.computed_columns[0].expr.args[0]" in detail["field_errors"]


def test_validate_base_query_spec_enriches_include_metadata_defaults(db_session: Session) -> None:
    datasource_id = int(db_session.query(DataSource).first().id)
    spec = _valid_base_query_spec(datasource_id)
    include = spec["preprocess"]["columns"]["include"]
    include[0]["semantic_type"] = "numeric"
    include[0]["aggregation"] = "sum"
    include[0]["prefix"] = "R$ "

    resolved_spec, _ = validate_and_resolve_base_query_spec(
        db=db_session,
        datasource_id=datasource_id,
        base_query_spec=spec,
    )

    normalized_include = resolved_spec["preprocess"]["columns"]["include"]
    for index, item in enumerate(normalized_include):
        assert "semantic_type" in item
        assert "aggregation" in item
        assert "sql_type" in item
        assert "hidden" in item
        assert "order" in item
        assert item["order"] == index


def test_validate_base_query_spec_allows_workspace_internal_resource_for_imported_mode(db_session: Session) -> None:
    datasource_id = int(db_session.query(DataSource).filter(DataSource.name == "analytics").first().id)
    workspace_owner_id = int(db_session.query(DataSource).filter(DataSource.id == datasource_id).first().created_by_id)
    internal_schema = f"lens_imp_t{workspace_owner_id}"
    spec = {
        "version": 1,
        "source": {"datasource_id": datasource_id},
        "base": {
            "primary_resource": "public.vw_orders",
            "resources": [
                {"id": "orders", "resource_id": "public.vw_orders"},
                {"id": "sheet", "resource_id": f"{internal_schema}.payments_sheet"},
            ],
            "joins": [
                {
                    "type": "left",
                    "left_resource": "orders",
                    "right_resource": "sheet",
                    "on": [{"left_column": "customer_id", "right_column": "customer_id"}],
                }
            ],
        },
        "preprocess": {
            "columns": {
                "include": [
                    {"resource": "orders", "column": "order_id", "alias": "order_id"},
                    {"resource": "sheet", "column": "ear", "alias": "ear"},
                ],
                "exclude": [],
            },
            "computed_columns": [],
            "filters": [],
        },
    }

    _, semantic_columns = validate_and_resolve_base_query_spec(
        db=db_session,
        datasource_id=datasource_id,
        base_query_spec=spec,
        allow_workspace_internal_resources=True,
        workspace_id=workspace_owner_id,
    )

    assert [col["name"] for col in semantic_columns] == ["order_id", "ear"]


def test_validate_base_query_spec_rejects_incompatible_join_key_types(db_session: Session) -> None:
    datasource_id = int(db_session.query(DataSource).filter(DataSource.name == "analytics").first().id)
    spec = _valid_base_query_spec(datasource_id)
    spec["base"]["joins"][0]["on"] = [{"left_column": "customer_id", "right_column": "name"}]

    with pytest.raises(HTTPException) as exc:
        validate_and_resolve_base_query_spec(
            db=db_session,
            datasource_id=datasource_id,
            base_query_spec=spec,
        )

    error = exc.value
    assert error.status_code == 400
    detail = error.detail
    assert detail["message"] == "Dataset base_query_spec validation failed"
    assert "base.joins[0].on[0]" in detail["field_errors"]
