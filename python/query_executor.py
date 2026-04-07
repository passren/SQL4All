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
import warnings

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

# Redirect Python warnings to log file instead of stderr
warnings.simplefilter('always')
logging.captureWarnings(True)
_warnings_logger = logging.getLogger('py.warnings')
_warnings_logger.addHandler(_log_handler)
_warnings_logger.propagate = False

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
        choices=[
            'query', 'ping',
            'list-tables', 'list-views', 'list-materialized-views',
            'list-sequences', 'list-temp-tables', 'list-temp-views',
            'list-columns', 'list-indexes',
        ],
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
    parser.add_argument(
        '--mode',
        default='single',
        choices=['single', 'server'],
        help='Execution mode: single (one-shot) or server (persistent stdin/stdout loop)',
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


ENTITY_ACTIONS = {
    'list-tables': ('get_table_names', 'table_name', 'table'),
    'list-views': ('get_view_names', 'view_name', 'view'),
    'list-materialized-views': (
        'get_materialized_view_names',
        'materialized_view_name',
        'materialized view',
    ),
    'list-sequences': (
        'get_sequence_names', 'sequence_name', 'sequence',
    ),
    'list-temp-tables': (
        'get_temp_table_names', 'temp_table_name', 'temp table',
    ),
    'list-temp-views': (
        'get_temp_view_names', 'temp_view_name', 'temp view',
    ),
}


def action_list_entities(engine, action, conn=None):
    """List entity names via SQLAlchemy inspect."""
    method_name, col_name, label = ENTITY_ACTIONS[action]
    try:
        from sqlalchemy import inspect as sa_inspect
        inspector = sa_inspect(conn if conn is not None else engine)
        method = getattr(inspector, method_name)
        try:
            names = method()
        except NotImplementedError:
            logger.debug(
                '%s not supported by this dialect', action,
            )
            names = []
        rows = [{col_name: n} for n in names]
        return {
            "kind": "result-set",
            "rows": rows,
            "columns": [col_name],
            "rowCount": len(names),
            "message": f"Found {len(names)} {label}(s)",
        }
    except Exception as e:
        raise Exception(
            f"Failed to list {label}s: {e}"
        ) from e


def action_list_columns(engine, table_name, conn=None):
    """List column details for a table via SQLAlchemy inspect."""
    try:
        from sqlalchemy import inspect as sa_inspect
        inspector = sa_inspect(conn if conn is not None else engine)
        columns = inspector.get_columns(table_name)
        rows = []
        for col in columns:
            rows.append({
                'column_name': col['name'],
                'type': str(col['type']),
                'nullable': col.get('nullable', True),
                'default': (
                    str(col['default'])
                    if col.get('default') is not None
                    else None
                ),
                'autoincrement': col.get('autoincrement', False),
                'primary_key': col.get('primary_key', False),
            })
        return {
            "kind": "result-set",
            "rows": rows,
            "columns": [
                'column_name', 'type', 'nullable',
                'default', 'autoincrement', 'primary_key',
            ],
            "rowCount": len(rows),
            "message": f"Found {len(rows)} column(s)",
        }
    except Exception as e:
        raise Exception(
            f"Failed to list columns: {e}"
        ) from e


def action_list_indexes(engine, table_name, conn=None):
    """List index details for a table via SQLAlchemy inspect."""
    try:
        from sqlalchemy import inspect as sa_inspect
        inspector = sa_inspect(conn if conn is not None else engine)
        # Get regular indexes
        indexes = inspector.get_indexes(table_name)
        # Get primary key constraint
        try:
            pk = inspector.get_pk_constraint(table_name)
            if pk and pk.get('constrained_columns'):
                indexes = [{
                    'name': pk.get('name') or 'PRIMARY',
                    'column_names': pk['constrained_columns'],
                    'unique': True,
                    'primary_key': True,
                }] + indexes
        except Exception:
            pass
        rows = []
        for idx in indexes:
            rows.append({
                'index_name': idx.get('name') or '(unnamed)',
                'columns': ', '.join(
                    str(c) for c in idx.get('column_names', []) if c
                ),
                'unique': idx.get('unique', False),
                'primary_key': idx.get('primary_key', False),
            })
        return {
            "kind": "result-set",
            "rows": rows,
            "columns": ['index_name', 'columns', 'unique', 'primary_key'],
            "rowCount": len(rows),
            "message": f"Found {len(rows)} index(es)",
        }
    except Exception as e:
        raise Exception(
            f"Failed to list indexes: {e}"
        ) from e


def action_query(engine, sql_query, query_params, conn=None):
    """Execute a SQL query and return results."""
    try:
        from sqlalchemy import text
        own_conn = conn is None
        if own_conn:
            conn = engine.connect()
        try:
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
        except Exception:
            try:
                conn.rollback()
            except Exception:
                pass
            raise
        finally:
            if own_conn:
                conn.close()
    except Exception as e:
        raise Exception(
            f"Query execution failed: {e}"
        ) from e


def dispatch_action(engine, action, query='', params_raw='', conn=None):
    """Route an action to the appropriate handler and log the result."""
    logger.debug('Action: %s', action)

    if action == 'ping':
        result = action_ping(engine)
    elif action in ENTITY_ACTIONS:
        result = action_list_entities(engine, action, conn)
    elif action == 'list-columns':
        if not query or not query.strip():
            raise ValueError('Table name is required for list-columns.')
        result = action_list_columns(engine, query.strip(), conn)
    elif action == 'list-indexes':
        if not query or not query.strip():
            raise ValueError('Table name is required for list-indexes.')
        result = action_list_indexes(engine, query.strip(), conn)
    elif action == 'query':
        if not query or not query.strip():
            raise ValueError('Query is empty.')
        logger.debug('Query: %s', query)
        params = parse_query_params(params_raw)
        result = action_query(engine, query, params, conn)
    else:
        raise ValueError(f"Unknown action: {action}")

    row_count = (
        len(result.get('rows', []))
        if isinstance(result, dict) else 0
    )
    logger.debug('Result: %d row(s)', row_count)
    return result


def create_engine(connection_string):
    """Create a SQLAlchemy engine, installing dependencies if needed."""
    sa = ensure_sqlalchemy()
    return sa.create_engine(connection_string)


def dispose_engine(engine):
    """Safely dispose a SQLAlchemy engine."""
    if engine is not None:
        try:
            engine.dispose()
        except Exception as dispose_error:
            logger.warning(
                'Failed to dispose engine: %s',
                dispose_error,
            )


def log_env_vars(env_vars_raw):
    """Parse and log environment variables from CLI argument."""
    if not env_vars_raw:
        return
    try:
        env_vars = json.loads(env_vars_raw)
        if isinstance(env_vars, dict) and env_vars:
            logger.debug(
                'Environment variables: %s',
                json.dumps(env_vars)
            )
    except (json.JSONDecodeError, Exception) as e:
        logger.warning('Failed to parse env-vars: %s', e)


def write_response(response):
    """Write a JSON response line to stdout."""
    sys.stdout.write(json.dumps(response) + '\n')
    sys.stdout.flush()


def server_loop(args):
    """Run as a persistent process, reading JSON commands from stdin."""
    engine = None
    conn = None
    try:
        masked = _mask_password(args.connection_string)
        logger.debug(
            'Server mode started. Connection (masked): %s',
            masked,
        )
        log_env_vars(args.env_vars)

        engine = create_engine(args.connection_string)
        conn = engine.connect()
        write_response({"kind": "ready"})

        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue

            try:
                request = json.loads(line)
            except json.JSONDecodeError as e:
                logger.warning(
                    'Invalid JSON from stdin: %s', e
                )
                write_response(
                    {"error": f"Invalid JSON: {e}"}
                )
                continue

            action = request.get('action', 'query')

            if action == 'shutdown':
                logger.debug('Shutdown requested')
                break

            try:
                result = dispatch_action(
                    engine,
                    action,
                    request.get('query', ''),
                    request.get('params', ''),
                    conn,
                )
                write_response(result)
            except Exception as e:
                logger.error(
                    'Server action failed: %s',
                    e, exc_info=True,
                )
                write_response({"error": str(e)})

    except Exception as e:
        logger.error(
            'Server loop fatal: %s',
            e, exc_info=True,
        )
        write_response({"error": str(e)})
        return 1
    finally:
        if conn is not None:
            try:
                conn.close()
            except Exception:
                pass
        dispose_engine(engine)

    logger.debug('Server mode exited')
    return 0


def main():
    """Main entry point."""
    engine = None
    try:
        args = parse_arguments()

        if args.mode == 'server':
            return server_loop(args)

        masked = _mask_password(args.connection_string)
        logger.debug('Connection (masked): %s', masked)
        log_env_vars(args.env_vars)

        engine = create_engine(args.connection_string)
        result = dispatch_action(
            engine,
            args.action,
            args.query,
            args.params,
        )

        print(json.dumps(result))
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
        dispose_engine(engine)


if __name__ == '__main__':
    sys.exit(main())
