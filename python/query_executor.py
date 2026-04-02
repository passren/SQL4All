#!/usr/bin/env python3
"""
SQL4ALL Query Executor
Executes SQL queries via any DB-API 2.0 compliant driver.
"""

import sys
import json
import argparse
import importlib
import subprocess
from pathlib import Path
from typing import Any
from urllib.parse import urlparse, parse_qs, unquote


DRIVER_CONFIG_PATH = (
    Path(__file__).resolve().parent.parent / 'media' / 'driver_config.json'
)
_DRIVER_CONFIG_CACHE = None


def install_package(package: str) -> None:
    """Install a Python package via pip."""
    print(f"Installing {package}...", file=sys.stderr)
    subprocess.check_call([sys.executable, '-m', 'pip', 'install', package])


def load_driver(driver_module: str):
    """
    Import a DB-API 2.0 compliant driver by module name.
    Auto-installs the package via pip if it is not found.
    """
    try:
        return importlib.import_module(driver_module)
    except ImportError:
        install_package(driver_module)
        try:
            return importlib.import_module(driver_module)
        except ImportError as exc:
            raise ImportError(
                f"Failed to import driver '{driver_module}' after installation. "
                "Please install it manually."
            ) from exc


def parse_arguments():
    """Parse command line arguments."""
    parser = argparse.ArgumentParser(
        description='Execute SQL queries via any DB-API 2.0 compliant driver'
    )
    parser.add_argument(
        '--driver',
        required=True,
        help='Python module name of the DB-API 2.0 driver (e.g., pymongosql, psycopg2)'
    )
    parser.add_argument(
        '--connection',
        required=True,
        help=(
            'JSON object with connection details. '
            'Expected field: {"connectionString"}'
        )
    )
    parser.add_argument('--query', required=True, help='SQL query to execute')
    parser.add_argument(
        '--params',
        default='',
        help=(
            'Optional JSON query parameters. '
            'Supports list (for ?) or object (for :name).'
        )
    )
    return parser.parse_args()


def parse_connection(connection_raw: str) -> dict:
    """Parse the --connection JSON argument into a dict."""
    try:
        conn = json.loads(connection_raw)
    except json.JSONDecodeError as exc:
        raise ValueError(f"Invalid --connection JSON: {exc}") from exc
    if not isinstance(conn, dict):
        raise ValueError("--connection must be a JSON object")
    return conn


def get_connection_string(conn: dict) -> str:
    """Get the frontend-provided connection string from connection payload."""
    raw_uri = (
        conn.get('connectionString')
        or conn.get('uri')
        or conn.get('dsn')
        or ''
    )
    uri = str(raw_uri).strip()
    if not uri:
        raise ValueError(
            'Missing connection string in --connection JSON. '
            'Expected field "connectionString".'
        )
    return uri


def build_mysql_kwargs_from_uri(uri: str) -> dict:
    """Parse a mysql/mariadb URI into kwargs accepted by mysql drivers."""
    parsed = urlparse(uri)
    db_name = parsed.path.lstrip('/') if parsed.path else ''
    query_params = parse_qs(parsed.query or '', keep_blank_values=True)

    kwargs = {
        'host': parsed.hostname or 'localhost',
        'port': parsed.port or 3306,
        'database': unquote(db_name),
        'user': unquote(parsed.username) if parsed.username else '',
        'password': unquote(parsed.password) if parsed.password else '',
    }

    for key, values in query_params.items():
        if not key:
            continue
        kwargs[key] = values[-1] if values else ''

    return kwargs


def load_driver_config() -> dict:
    """Load and cache driver configuration from media/driver_config.json."""
    global _DRIVER_CONFIG_CACHE

    if _DRIVER_CONFIG_CACHE is not None:
        return _DRIVER_CONFIG_CACHE

    try:
        with DRIVER_CONFIG_PATH.open('r', encoding='utf-8') as f:
            parsed = json.load(f)
    except Exception:
        parsed = {}

    if not isinstance(parsed, dict):
        parsed = {}

    _DRIVER_CONFIG_CACHE = parsed
    return _DRIVER_CONFIG_CACHE


def resolve_database_key_from_driver(driver: str, config: dict) -> str:
    """Resolve database key from configured driver names."""
    target = (driver or '').strip().lower()
    if not target:
        return ''

    aliases = {
        'mysql.connector': 'mysql-connector-python',
        'elasticsearch_dbapi': 'elasticsearch-dbapi',
    }

    databases = config.get('databases', {}) if isinstance(config, dict) else {}
    if not isinstance(databases, dict):
        return ''

    for db_key, db_config in databases.items():
        if not isinstance(db_config, dict):
            continue

        configured_driver = str(db_config.get('driver', '')).strip().lower()
        if target == configured_driver:
            return str(db_key)

        alias_for_target = aliases.get(target, '')
        if alias_for_target and alias_for_target == configured_driver:
            return str(db_key)

    return ''


def build_connect_kwargs(driver: str, conn: dict) -> dict:
    """Build connect kwargs based on driver_config database mapping."""
    uri = get_connection_string(conn)
    config = load_driver_config()
    db_key = resolve_database_key_from_driver(driver, config)

    if db_key == 'mongodb':
        return {'host': uri}
    if db_key in ('mysql', 'mariadb'):
        return build_mysql_kwargs_from_uri(uri)

    # Generic fallback for drivers that consume DSN/URI style input.
    return {'dsn': uri}


def parse_query_params(params_raw: str) -> Any:
    """Parse optional JSON parameters for cursor.execute()."""
    if not params_raw:
        return None

    try:
        parsed = json.loads(params_raw)
    except json.JSONDecodeError as exc:
        raise ValueError(f"Invalid --params JSON: {exc}") from exc

    if not isinstance(parsed, (list, dict)):
        raise ValueError("--params must be a JSON array or object")

    return parsed


def serialize_result(obj: Any) -> Any:
    """Recursively serialize a query result value for JSON output."""
    if hasattr(obj, '__dict__'):
        return serialize_result(obj.__dict__)
    elif isinstance(obj, dict):
        return {k: serialize_result(v) for k, v in obj.items()}
    elif isinstance(obj, (list, tuple)):
        return [serialize_result(item) for item in obj]
    elif hasattr(obj, 'isoformat'):
        return obj.isoformat()
    elif isinstance(obj, bytes):
        return obj.decode('utf-8', errors='replace')
    else:
        try:
            json.dumps(obj)
            return obj
        except TypeError:
            return str(obj)


def looks_like_result_set_query(sql_query: str) -> bool:
    """Best-effort detection for SQL statements that return a result set."""
    normalized = sql_query.strip().lower()
    return normalized.startswith(('select', 'show', 'describe', 'with'))


def get_dict_cursor(conn, driver):
    """
    Return a dict-row cursor when the driver supports it; fall back to a
    standard cursor otherwise.

    Search order:
      1. Top-level driver attributes (DictCursor, dictcursor, dict_cursor)
      2. Common submodules: cursor, cursors, extras
    """
    for attr in ('DictCursor', 'dictcursor', 'dict_cursor'):
        candidate = getattr(driver, attr, None)
        if candidate is not None:
            try:
                return conn.cursor(candidate)
            except Exception:
                pass

    for submodule in ('cursor', 'cursors', 'extras'):
        try:
            mod = importlib.import_module(f"{driver.__name__}.{submodule}")
            for attr in ('DictCursor', 'RealDictCursor'):
                candidate = getattr(mod, attr, None)
                if candidate is not None:
                    try:
                        return conn.cursor(candidate)
                    except Exception:
                        pass
        except ImportError:
            pass

    return conn.cursor()


def rows_to_dicts(rows: list, description) -> list:
    """
    Convert tuple rows to dicts using cursor.description column names.
    Rows that are already dicts are returned unchanged.
    """
    if not rows or not description:
        return rows or []

    if isinstance(rows[0], dict):
        return rows

    columns = [
        col[0] if isinstance(col, (list, tuple)) else str(col)
        for col in description
    ]
    return [dict(zip(columns, row)) for row in rows]


def execute_query(
    driver,
    connect_kwargs: dict,
    sql_query: str,
    query_params: Any = None,
) -> Any:
    """Execute SQL via the given DB-API 2.0 driver and return serialisable results."""
    try:
        conn = driver.connect(**connect_kwargs)
        with conn:
            cursor = get_dict_cursor(conn, driver)
            with cursor:
                if query_params is None:
                    cursor.execute(sql_query)
                else:
                    cursor.execute(sql_query, query_params)

                fetched_rows = None
                try:
                    fetched_rows = cursor.fetchall()
                except Exception:
                    fetched_rows = None

                description_columns = []
                if cursor.description:
                    for col in cursor.description:
                        if isinstance(col, (list, tuple)) and col:
                            description_columns.append(str(col[0]))
                        else:
                            description_columns.append(str(col))

                if (
                    fetched_rows is not None
                    or cursor.description
                    or looks_like_result_set_query(sql_query)
                ):
                    rows = rows_to_dicts(fetched_rows or [], cursor.description)
                    serialized_rows = serialize_result(rows)
                    columns = list(description_columns)
                    seen = set(columns)
                    for row in serialized_rows:
                        if isinstance(row, dict):
                            for key in row.keys():
                                if key not in seen:
                                    seen.add(key)
                                    columns.append(key)

                    return {
                        "kind": "result-set",
                        "rows": serialized_rows,
                        "columns": columns,
                        "rowCount": len(serialized_rows),
                        "message": f"Returned {len(serialized_rows)} row(s)"
                    }

                return {
                    "kind": "command-result",
                    "rows": [],
                    "columns": [],
                    "rowCount": 0,
                    "affectedRows": cursor.rowcount,
                    "message": "Statement executed successfully"
                }

    except Exception as e:
        raise Exception(f"Query execution error: {str(e)}")


def main():
    """Main entry point."""
    try:
        args = parse_arguments()

        driver_module = load_driver(args.driver)
        connection = parse_connection(args.connection)
        connect_kwargs = build_connect_kwargs(args.driver, connection)
        query_params = parse_query_params(args.params)
        results = execute_query(driver_module, connect_kwargs, args.query, query_params)

        print(json.dumps(results))
        return 0

    except Exception as e:
        print(json.dumps([]))
        print(json.dumps({"error": str(e)}), file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
