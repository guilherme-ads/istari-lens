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
    session.add(datasource)
    session.flush()

    view_orders = View(datasource_id=datasource.id, schema_name="public", view_name="vw_orders", is_active=True)
    view_customers = View(datasource_id=datasource.id, schema_name="public", view_name="vw_customers", is_active=True)
    session.add_all([view_orders, view_customers])
    session.flush()

    session.add_all(
        [
            ViewColumn(view_id=view_orders.id, column_name="order_id", column_type="bigint", is_aggregatable=True, is_groupable=True),
            ViewColumn(view_id=view_orders.id, column_name="customer_id", column_type="bigint", is_aggregatable=True, is_groupable=True),
            ViewColumn(view_id=view_orders.id, column_name="amount", column_type="numeric", is_aggregatable=True, is_groupable=False),
            ViewColumn(view_id=view_orders.id, column_name="created_at", column_type="timestamp", is_aggregatable=False, is_groupable=True),
            ViewColumn(view_id=view_customers.id, column_name="id", column_type="bigint", is_aggregatable=True, is_groupable=True),
            ViewColumn(view_id=view_customers.id, column_name="name", column_type="text", is_aggregatable=False, is_groupable=True),
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
