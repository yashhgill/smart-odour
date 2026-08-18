"""
Async data-access layer over Neon Postgres.

Why a query shim rather than raw SQL at every call site: the routes in main.py
were written against a PostgREST-style filter dialect. Keeping that dialect and
compiling it to parameterised SQL here means the migration off Supabase touched
exactly one file, and every query in the app still goes through a single place
where it can be logged or rate-limited.

Everything is parameterised. Table and column names are validated against an
allow-list built from the schema, because those cannot be bound as parameters
and would otherwise be an injection route.
"""

import re
import uuid
from datetime import datetime
from typing import Any

import asyncpg

from config import settings

_pool: asyncpg.Pool | None = None

# Anything not in here is rejected outright. Update this when the schema grows.
_TABLES = {
    "zones", "readings", "incidents", "uptime_samples",
    "alert_log", "reports", "admin_users",
    "v_latest_readings", "v_uptime_24h",
}

_COLUMNS = {
    "id", "zone_id", "node_id", "ts", "temperature", "humidity",
    "mq5", "mq6", "mq7_1", "mq7_2", "aqi_score", "rssi", "source",
    "name", "code", "latitude", "longitude", "is_physical", "description",
    "kind", "severity", "metric", "value", "threshold", "message",
    "opened_at", "acknowledged_at", "acknowledged_by", "resolved_at",
    "origin", "healthy", "latency_ms", "status_code",
    "incident_id", "channel", "target", "ok", "detail", "sent_at",
    "title", "period_start", "period_end", "r2_key", "generated_at",
    "generated_by", "email", "password_hash", "full_name", "role",
    "created_at", "zone_name", "samples", "healthy_samples",
    "uptime_pct", "avg_latency_ms",
}

# PostgREST filter prefixes -> SQL operators.
_OPS = {
    "eq": "=", "neq": "<>", "gt": ">", "gte": ">=",
    "lt": "<", "lte": "<=", "like": "like", "is": "is",
}


def _ident(name: str, allowed: set[str], kind: str) -> str:
    if name not in allowed:
        raise ValueError(f"unknown {kind}: {name!r}")
    return f'"{name}"'


_INT_RE = re.compile(r"^-?\d+$")
_FLOAT_RE = re.compile(r"^-?\d+\.\d+$")
_UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I)
_TS_RE = re.compile(r"^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}")


def _coerce(value: Any) -> Any:
    """
    PostgREST accepted everything as a string and cast server-side. asyncpg
    infers the parameter type from the column and then demands a matching
    Python object, so a filter like ``zone_id=eq.1`` has to become an int
    before it is bound. Anything unrecognised is left as text.
    """
    if not isinstance(value, str):
        return value
    if value == "null":
        return None
    low = value.lower()
    if low in ("true", "false"):
        return low == "true"
    if _INT_RE.match(value):
        return int(value)
    if _FLOAT_RE.match(value):
        return float(value)
    if _UUID_RE.match(value):
        return uuid.UUID(value)
    if _TS_RE.match(value):
        try:
            return datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return value
    return value


async def init_pool() -> None:
    """Called once on startup. Small pool: Render free tier is a single worker."""
    global _pool
    if _pool is None:
        _pool = await asyncpg.create_pool(
            settings.DATABASE_URL,
            min_size=1,
            max_size=4,
            command_timeout=10,
            # Neon closes idle connections; recycle before it does.
            max_inactive_connection_lifetime=60,
            statement_cache_size=0,   # required when going through the pooler
        )


async def close_pool() -> None:
    global _pool
    if _pool is not None:
        await _pool.close()
        _pool = None


async def _acquire():
    if _pool is None:
        await init_pool()
    return _pool


def _build_select(table: str, params: dict[str, Any]) -> tuple[str, list]:
    params = dict(params or {})
    cols = params.pop("select", "*")
    order = params.pop("order", None)
    limit = params.pop("limit", None)
    offset = params.pop("offset", None)

    tbl = _ident(table, _TABLES, "table")

    if cols == "*":
        projection = "*"
    else:
        projection = ", ".join(
            _ident(c.strip(), _COLUMNS, "column") for c in cols.split(",") if c.strip()
        ) or "*"

    where, args = [], []
    for column, expr in params.items():
        col = _ident(column, _COLUMNS, "column")
        raw = str(expr)
        op_key, _, value = raw.partition(".")
        op = _OPS.get(op_key)
        if op is None:                      # bare value means equality
            op, value = "=", raw
        if op == "is":
            where.append(f"{col} is {'null' if value == 'null' else 'not null'}")
            continue
        args.append(_coerce(value))
        where.append(f"{col} {op} ${len(args)}")

    sql = f"select {projection} from {tbl}"
    if where:
        sql += " where " + " and ".join(where)

    if order:
        parts = []
        for clause in order.split(","):
            field, _, direction = clause.strip().partition(".")
            col = _ident(field, _COLUMNS, "column")
            parts.append(f"{col} {'desc' if direction.startswith('desc') else 'asc'}")
        sql += " order by " + ", ".join(parts)

    if limit:
        args.append(int(limit))
        sql += f" limit ${len(args)}"
    if offset:
        args.append(int(offset))
        sql += f" offset ${len(args)}"

    return sql, args


async def select(table: str, params: dict[str, Any] | None = None) -> list[dict]:
    pool = await _acquire()
    sql, args = _build_select(table, params or {})
    async with pool.acquire() as conn:
        rows = await conn.fetch(sql, *args)
    return [dict(r) for r in rows]


async def insert(table: str, rows: list[dict], returning: bool = False) -> list[dict] | None:
    if not rows:
        return [] if returning else None
    pool = await _acquire()
    tbl = _ident(table, _TABLES, "table")
    columns = list(rows[0].keys())
    cols_sql = ", ".join(_ident(c, _COLUMNS, "column") for c in columns)

    values_sql, args = [], []
    for row in rows:
        placeholders = []
        for c in columns:
            args.append(_coerce(row.get(c)))
            placeholders.append(f"${len(args)}")
        values_sql.append("(" + ", ".join(placeholders) + ")")

    sql = f"insert into {tbl} ({cols_sql}) values " + ", ".join(values_sql)
    # Replayed readings carry a seq the node has already sent. Swallow them.
    if table == "readings":
        sql += " on conflict do nothing"
    if returning:
        sql += " returning *"

    async with pool.acquire() as conn:
        if returning:
            out = await conn.fetch(sql, *args)
            return [dict(r) for r in out]
        await conn.execute(sql, *args)
    return None


async def patch(table: str, filters: dict[str, str], values: dict) -> list[dict]:
    pool = await _acquire()
    tbl = _ident(table, _TABLES, "table")

    args, sets = [], []
    for column, value in values.items():
        args.append(_coerce(value))
        sets.append(f"{_ident(column, _COLUMNS, 'column')} = ${len(args)}")

    where = []
    for column, expr in filters.items():
        col = _ident(column, _COLUMNS, "column")
        raw = str(expr)
        op_key, _, value = raw.partition(".")
        op = _OPS.get(op_key)
        if op is None:
            op, value = "=", raw
        args.append(_coerce(value))
        where.append(f"{col} {op} ${len(args)}")

    sql = f"update {tbl} set " + ", ".join(sets)
    if where:
        sql += " where " + " and ".join(where)
    sql += " returning *"

    async with pool.acquire() as conn:
        rows = await conn.fetch(sql, *args)
    return [dict(r) for r in rows]


async def healthcheck() -> bool:
    """Cheap round-trip used by /health."""
    try:
        pool = await _acquire()
        async with pool.acquire() as conn:
            await conn.fetchval("select 1")
        return True
    except Exception:
        return False
