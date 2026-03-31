#!/usr/bin/env python3
"""
SQL4No Query Executor
Executes SQL4No queries against MongoDB using PyMongoSQL
"""

import sys
import json
import argparse
from typing import Any
from urllib.parse import quote_plus


def install_dependencies():
    """Install required Python packages if not available"""
    import subprocess
    packages = ['pymongo', 'pymongosql']

    for package in packages:
        try:
            __import__(package)
        except ImportError:
            print(f"Installing {package}...", file=sys.stderr)
            subprocess.check_call(
                [sys.executable, '-m', 'pip', 'install', package]
            )


# Install dependencies first
try:
    import pymongo  # noqa: F401  # type: ignore[import-not-found]
    from pymongosql import connect  # type: ignore[import-not-found]
    from pymongosql.cursor import DictCursor  # type: ignore[import-not-found]
except ImportError:
    install_dependencies()
    try:
        import pymongo  # noqa: F401  # type: ignore[import-not-found]
        from pymongosql import connect  # type: ignore[import-not-found]
        from pymongosql.cursor import (  # type: ignore[import-not-found]
            DictCursor,
        )
    except ImportError:
        print(
            json.dumps(
                {
                    "error": (
                        "Failed to install required packages. "
                        "Please install pymongo and pymongosql manually."
                    ),
                    "results": []
                }
            )
        )
        sys.exit(1)


def parse_arguments():
    """Parse command line arguments"""
    parser = argparse.ArgumentParser(
        description='Execute PyMongoSQL queries against MongoDB'
    )
    parser.add_argument('--host', default='localhost', help='MongoDB host')
    parser.add_argument('--port', type=int, default=27017, help='MongoDB port')
    parser.add_argument('--database', required=True, help='Database name')
    parser.add_argument('--username', default='', help='MongoDB username')
    parser.add_argument('--password', default='', help='MongoDB password')
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


def build_connection_uri(
    host: str,
    port: int,
    database: str,
    username: str = '',
    password: str = ''
) -> str:
    """Build MongoDB URI for PyMongoSQL connect()."""
    if username and password:
        encoded_user = quote_plus(username)
        encoded_password = quote_plus(password)
        return (
            f"mongodb://{encoded_user}:{encoded_password}@{host}:{port}/"
            f"{database}?authSource={database}"
        )
    return f"mongodb://{host}:{port}/{database}"


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
    """Serialize MongoDB document for JSON output"""
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
    """Best-effort detection for SQL statements with tabular output."""
    normalized = sql_query.strip().lower()
    return normalized.startswith(('select', 'show', 'describe', 'with'))


def execute_query(uri: str, sql_query: str, query_params: Any = None) -> Any:
    """Execute SQL with PyMongoSQL DB-API and return serializable results."""
    try:
        with connect(host=uri) as conn:
            with conn.cursor(DictCursor) as cursor:
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
                    for column in cursor.description:
                        if isinstance(column, (list, tuple)) and column:
                            description_columns.append(str(column[0]))
                        else:
                            description_columns.append(str(column))

                if (
                    fetched_rows is not None
                    or cursor.description
                    or looks_like_result_set_query(sql_query)
                ):
                    rows = fetched_rows or []
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
    """Main function"""
    try:
        args = parse_arguments()

        uri = build_connection_uri(
            host=args.host,
            port=args.port,
            database=args.database,
            username=args.username,
            password=args.password
        )

        params = parse_query_params(args.params)
        results = execute_query(uri, args.query, params)

        # Output results as JSON
        print(json.dumps(results))
        return 0

    except Exception as e:
        # Output error as JSON
        print(json.dumps([]))
        print(json.dumps({"error": str(e)}), file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
