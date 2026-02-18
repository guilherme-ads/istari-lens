from __future__ import annotations

import asyncio
import hashlib
import re
from typing import Any

from psycopg import AsyncConnection

from app.errors import EngineError


_DANGEROUS_PATTERN = re.compile(
    r"\b(insert|update|delete|drop|alter|truncate|create|grant|revoke|merge|call|execute|copy|vacuum|analyze|refresh|reindex)\b",
    re.IGNORECASE,
)


def _validate_sql(sql: str) -> None:
    normalized = " ".join(sql.strip().split())
    lowered = normalized.lower().strip("; ").strip()
    if not lowered:
        raise EngineError(status_code=400, code="empty_query", message="Empty query")
    if ";" in lowered:
        raise EngineError(status_code=400, code="multiple_statements", message="Multiple statements are not allowed")
    if not (lowered.startswith("select ") or lowered.startswith("with ") or lowered.startswith("explain ")):
        raise EngineError(status_code=400, code="read_only_only", message="Only read-only SELECT statements are allowed")
    if _DANGEROUS_PATTERN.search(lowered):
        raise EngineError(status_code=400, code="dangerous_sql", message="Dangerous SQL operation blocked")


class PostgresAdapter:
    def __init__(self, database_url: str) -> None:
        self._database_url = database_url

    async def execute(self, *, sql: str, params: list[object], timeout_seconds: int) -> tuple[list[str], list[dict[str, object]]]:
        _validate_sql(sql)
        conn: AsyncConnection[Any] | None = None
        try:
            conn = await AsyncConnection.connect(self._database_url)
            result = await asyncio.wait_for(conn.execute(sql, params), timeout=timeout_seconds)
            rows = await result.fetchall()
            columns = [desc[0] for desc in result.description]
            dict_rows: list[dict[str, object]] = []
            for row in rows:
                dict_rows.append({column: row[idx] for idx, column in enumerate(columns)})
            return columns, dict_rows
        except asyncio.TimeoutError as exc:
            raise EngineError(status_code=504, code="query_timeout", message="Query execution timed out") from exc
        except EngineError:
            raise
        except Exception as exc:
            raise EngineError(status_code=500, code="datasource_error", message="Datasource execution failed") from exc
        finally:
            if conn:
                await conn.close()

    async def list_resources(self) -> list[dict[str, str]]:
        sql = """
            SELECT table_schema, table_name, table_type
            FROM information_schema.tables
            WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
            ORDER BY table_schema, table_name
        """
        columns, rows = await self.execute(sql=sql, params=[], timeout_seconds=15)
        _ = columns
        payload: list[dict[str, str]] = []
        for row in rows:
            payload.append(
                {
                    "id": f"{row['table_schema']}.{row['table_name']}",
                    "schema_name": str(row["table_schema"]),
                    "resource_name": str(row["table_name"]),
                    "resource_type": str(row["table_type"]),
                }
            )
        return payload

    async def get_schema(self, *, schema_name: str, resource_name: str) -> list[dict[str, object]]:
        sql = """
            SELECT column_name, data_type, is_nullable
            FROM information_schema.columns
            WHERE table_schema = %s AND table_name = %s
            ORDER BY ordinal_position
        """
        columns, rows = await self.execute(sql=sql, params=[schema_name, resource_name], timeout_seconds=15)
        _ = columns
        payload: list[dict[str, object]] = []
        for row in rows:
            payload.append(
                {
                    "name": str(row["column_name"]),
                    "data_type": str(row["data_type"]),
                    "nullable": str(row["is_nullable"]).upper() == "YES",
                }
            )
        return payload


def sql_hash(sql: str) -> str:
    normalized = " ".join(sql.split()).strip().lower()
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()
