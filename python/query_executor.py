#!/usr/bin/env python3
"""
MongoDB PyMongoSQL Query Executor
Executes SQL queries against MongoDB using PyMongoSQL
"""

import sys
import json
import argparse
from typing import Any, List, Dict

def install_dependencies():
    """Install required Python packages if not available"""
    import subprocess
    packages = ['pymongo', 'pymongosql']
    
    for package in packages:
        try:
            __import__(package)
        except ImportError:
            print(f"Installing {package}...", file=sys.stderr)
            subprocess.check_call([sys.executable, '-m', 'pip', 'install', package])

# Install dependencies first
try:
    import pymongo
    from pymongosql import Parser
except ImportError:
    install_dependencies()
    try:
        import pymongo
        from pymongosql import Parser
    except ImportError:
        print(json.dumps({
            "error": "Failed to install required packages. Please install pymongo and pymongosql manually.",
            "results": []
        }))
        sys.exit(1)

from pymongo import MongoClient
from pymongo.errors import ConnectionFailure, OperationFailure

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
    
    return parser.parse_args()

def connect_mongodb(host: str, port: int, database: str, username: str = '', password: str = ''):
    """Connect to MongoDB"""
    try:
        if username and password:
            connection_string = f"mongodb://{username}:{password}@{host}:{port}/{database}"
        else:
            connection_string = f"mongodb://{host}:{port}/{database}"
        
        client = MongoClient(connection_string, serverSelectionTimeoutMS=5000)
        # Verify connection
        client.admin.command('ping')
        return client[database]
    except ConnectionFailure as e:
        raise Exception(f"Failed to connect to MongoDB: {str(e)}")
    except Exception as e:
        raise Exception(f"Connection error: {str(e)}")

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
    else:
        return obj

def execute_query(db, sql_query: str) -> List[Dict]:
    """Execute SQL query and return results"""
    try:
        # Parse SQL query
        parser = Parser()
        parsed = parser.parse(sql_query)
        
        # Extract collection name from parsed query
        collection_name = parsed.get('collection', None)
        if not collection_name:
            raise ValueError("Could not determine collection from query")
        
        # Get collection
        collection = db[collection_name]
        
        # Build MongoDB query from parsed SQL
        mongo_query = build_mongo_query(parsed)
        
        # Execute query
        cursor = collection.find(
            filter=mongo_query.get('filter', {}),
            projection=mongo_query.get('projection', None),
            sort=mongo_query.get('sort', None),
            skip=mongo_query.get('skip', 0),
            limit=mongo_query.get('limit', 0)
        )
        
        # Convert results to list
        results = []
        for doc in cursor:
            # Remove _id field if not explicitly requested
            if '_id' not in mongo_query.get('projection', {}):
                doc.pop('_id', None)
            results.append(serialize_result(doc))
        
        return results
    
    except Exception as e:
        raise Exception(f"Query execution error: {str(e)}")

def build_mongo_query(parsed: Dict) -> Dict:
    """Build MongoDB query from parsed SQL"""
    query = {
        'filter': {},
        'projection': None,
        'sort': None,
        'skip': 0,
        'limit': 0
    }
    
    # Handle WHERE clause
    if 'where' in parsed and parsed['where']:
        query['filter'] = convert_where_clause(parsed['where'])
    
    # Handle SELECT fields (projection)
    if 'fields' in parsed and parsed['fields']:
        query['projection'] = {field: 1 for field in parsed['fields']}
        query['projection']['_id'] = 0
    
    # Handle ORDER BY
    if 'orderby' in parsed and parsed['orderby']:
        query['sort'] = [(field, 1 if order.upper() == 'ASC' else -1) 
                         for field, order in parsed['orderby']]
    
    # Handle LIMIT
    if 'limit' in parsed:
        query['limit'] = parsed['limit']
    
    # Handle OFFSET
    if 'skip' in parsed:
        query['skip'] = parsed['skip']
    
    return query

def convert_where_clause(where_clause: Any) -> Dict:
    """Convert WHERE clause to MongoDB filter"""
    # This is a simplified converter - extend based on your needs
    if isinstance(where_clause, str):
        # Simple comparison (this is a placeholder)
        return {}
    return {}

def main():
    """Main function"""
    try:
        args = parse_arguments()
        
        # Connect to MongoDB
        db = connect_mongodb(
            host=args.host,
            port=args.port,
            database=args.database,
            username=args.username,
            password=args.password
        )
        
        # Execute query
        results = execute_query(db, args.query)
        
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
