#!/usr/bin/env python3
"""
SQL4ALL Query Executor
Executes SQL queries via SQLAlchemy.
"""

import sys
import json
import logging
import argparse
import subprocess
from logging.handlers import RotatingFileHandler
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

LOG_DIR = Path(__file__).resolve().parent.parent / 'logs'
LOG_DIR.mkdir(exist_ok=True)
logger = logging.getLogger('sql4all')
logger.setLevel(logging.DEBUG)

_log_handler = RotatingFileHandler(
    filename=str(LOG_DIR / 'query_executor.log'),
    maxBytes=5 * 1024 * 1024,
    backupCount=5,
    encoding='utf-8',
)
_log_handler.setFormatter(
    logging.Formatter('%(asctime)s [%(levelname)s] %(message)s')
)
logger.handlers = [_log_handler]
logger.propagate = False

REQUIREMENTS_PATH = Path(__file__).resolve().parent / 'requirements.txt'


def install_requirements() -> None:
    """Install Python packages from requirements.txt via pip."""
    print(
        f"Installing requirements from {REQUIREMENTS_PATH}...",
        file=sys.stderr,
    )
    if not REQUIREMENTS_PATH.exists():
        raise FileNotFoundError(
            f"requirements.txt not found: {REQUIREMENTS_PATH}"
        )
    subprocess.check_call(
        [
            sys.executable,
            '-m',
            'pip',
            'install',
            '-r',
            str(REQUIREMENTS_PATH),
        ],
        stdout=sys.stderr,
        stderr=sys.stderr,
    )


def ensure_sqlalchemy():
    """Import sqlalchemy, auto-installing if absent."""
    try:
        import sqlalchemy
        return sqlalchemy
    except ImportError:
        install_requirements()
        import sqlalchemy
        return sqlalchemy


def parse_arguments():
    """Parse command line arguments."""
    parser = argparse.ArgumentParser(
        description='Execute SQL queries via SQLAlchemy'
    )
    parser.add_argument(
        '--connection-string',
        required=True,
        dest='connection_string',
        help='SQLAlchemy connection URL',
    )
    parser.add_argument(
        '--action',
        default='query',
        choices=['query', 'list-tables', 'ping'],
        help='Action to perform',
    )
    parser.add_argument(
        '--query',
        default='',
        help='SQL query to execute',
    )
    parser.add_argument(
        '--params',
        default='',
        help='Optional JSON query parameters',
    )
    parser.add_argument(
        '--env-vars',
        default='',
        dest='env_vars',
        help='JSON object of environment variables set by frontend',
    )
    return parser.parse_args()


def parse_query_params(params_raw: str) -> Any:
    """Parse optional JSON parameters."""
    if not params_raw:
        return None
    try:
        parsed = json.loads(params_raw)
    except json.JSONDecodeError as exc:
        raise ValueError(
            f"Invalid --params JSON: {exc}"
        ) from exc
    if not isinstance(parsed, (list, dict)):
        raise ValueError(
            "--params must be a JSON array or object"
        )
    return parsed


def serialize_result(obj: Any) -> Any:
    """Recursively serialize a value for JSON."""
    if hasattr(obj, '__dict__'):
        return serialize_result(obj.__dict__)
    elif isinstance(obj, dict):
        return {
            k: serialize_result(v)
            for k, v in obj.items()
        }
    elif isinstance(obj, (list, tuple)):
        return [
            serialize_result(item) for item in obj
        ]
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


def _mask_password(s: str) -> str:
    """Mask password in a URI for safe logging."""
    try:
        if isinstance(s, str) and '://' in s:
            parsed = urlparse(s)
            if parsed.password:
                original = f':{parsed.password}@'
                return s.replace(original, ':***@')
        return s
    except Exception:
        return s


def action_ping(engine):
    """Test connectivity using the dialect's ping."""
    try:
        with engine.connect() as conn:
            try:
                is_ok = engine.dialect.do_ping(conn)
                if not is_ok:
                    logger.warning(
                        'do_ping returned false; '
                        'ignoring and treating as connected'
                    )
            except Exception as ping_error:
                logger.warning(
                    'do_ping failed and was ignored: %s',
                    ping_error,
                )
        return {
            "kind": "ping",
            "ok": True,
            "message": "Connection successful",
        }
    except Exception as e:
        raise Exception(
            f"Connection test failed: {e}"
        ) from e


def action_list_tables(engine):
    """List table names via SQLAlchemy inspect."""
    try:
        from sqlalchemy import inspect as sa_inspect
        inspector = sa_inspect(engine)
        tables = inspector.get_table_names()
        rows = [{"table_name": t} for t in tables]
        return {
            "kind": "result-set",
            "rows": rows,
            "columns": ["table_name"],
            "rowCount": len(tables),
            "message": f"Found {len(tables)} table(s)",
        }
    except Exception as e:
        raise Exception(
            f"Failed to list tables: {e}"
        ) from e


def action_query(engine, sql_query, query_params):
    """Execute a SQL query and return results."""
    try:
        from sqlalchemy import text
        with engine.connect() as conn:
            stmt = text(sql_query)
            if isinstance(query_params, dict):
                result = conn.execute(stmt, query_params)
            else:
                result = conn.execute(stmt)

            if result.returns_rows:
                columns = list(result.keys())
                rows = [
                    dict(row._mapping)
                    for row in result
                ]
                serialized = serialize_result(rows)
                count = len(serialized)
                return {
                    "kind": "result-set",
                    "rows": serialized,
                    "columns": columns,
                    "rowCount": count,
                    "message": (
                        f"Returned {count} row(s)"
                    ),
                }

            conn.commit()
            return {
                "kind": "command-result",
                "rows": [],
                "columns": [],
                "rowCount": 0,
                "affectedRows": result.rowcount,
                "message": (
                    "Statement executed successfully"
                ),
            }
    except Exception as e:
        raise Exception(
            f"Query execution failed: {e}"
        ) from e


def main():
    """Main entry point."""
    engine = None
    try:
        args = parse_arguments()
        logger.debug('Action: %s', args.action)
        masked = _mask_password(args.connection_string)
        logger.debug('Connection (masked): %s', masked)

        if args.env_vars:
            try:
                env_vars = json.loads(args.env_vars)
                if isinstance(env_vars, dict) and env_vars:
                    logger.debug(
                        'Environment variables: %s',
                        json.dumps(env_vars)
                    )
            except (json.JSONDecodeError, Exception) as e:
                logger.warning(
                    'Failed to parse env-vars: %s', e
                )

        sa = ensure_sqlalchemy()
        engine = sa.create_engine(
            args.connection_string
        )

        if args.action == 'ping':
            results = action_ping(engine)
        elif args.action == 'list-tables':
            results = action_list_tables(engine)
        else:
            query = args.query
            if not query or not query.strip():
                raise ValueError('Query is empty.')
            logger.debug('Query: %s', query)
            params = parse_query_params(args.params)
            results = action_query(
                engine, query, params
            )

        row_count = (
            len(results.get('rows', []))
            if isinstance(results, dict) else 0
        )
        logger.debug(
            'Result: %d row(s)', row_count
        )

        print(json.dumps(results))
        return 0

    except Exception as e:
        logger.error(
            'Failed: %s', e, exc_info=True
        )
        print(json.dumps([]))
        error = {"error": str(e)}
        print(
            json.dumps(error), file=sys.stderr
        )
        return 1
    finally:
        if engine is not None:
            try:
                engine.dispose()
            except Exception as dispose_error:
                logger.warning(
                    'Failed to dispose engine: %s',
                    dispose_error,
                )


if __name__ == '__main__':
    sys.exit(main())
