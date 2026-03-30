# SQL4No

A powerful VS Code extension for querying MongoDB using PyMongoSQL SQL syntax. Write SQL queries and execute them against MongoDB without writing complex aggregation pipelines.

## Features

✨ **Key Features:**
- 🔍 **SQL Query Editor** - Write MongoDB queries using familiar SQL syntax
- 🗄️ **Connection Manager** - Save and manage multiple MongoDB connections
- 📊 **Result Viewer** - View query results in an organized table format
- 📝 **Query History** - Track all previously executed queries
- 💾 **Export Results** - Export query results to CSV or JSON format
- ⌨️ **Keyboard Shortcuts** - Quick access with `Ctrl+Shift+M` (Windows/Linux) or `Cmd+Shift+M` (Mac)
- 🔐 **Secure Storage** - Connection profiles stored securely in VS Code

## Requirements

### System Requirements
- VS Code 1.110.0 or higher
- Python 3.7 or higher
- MongoDB 4.0 or higher (local or remote)

### Python Dependencies
The extension automatically installs required Python packages:
- `pymongo` - MongoDB driver for Python
- `pymongosql` - SQL to MongoDB query translator

## Installation

### From VS Code Marketplace
1. Open VS Code
2. Go to Extensions (Ctrl+Shift+X / Cmd+Shift+X)
3. Search for "SQL4No"
4. Click Install

## Quick Start

1. **Open Query Panel**: Press `Ctrl+Shift+M` (Windows/Linux) or `Cmd+Shift+M` (Mac)
2. **Create Connection**: Fill in MongoDB connection details and click Save
3. **Write Query**: Enter SQL query in the editor
4. **Execute**: Click Execute Query or press Ctrl+Enter
5. **View Results**: Results appear in the table below
6. **Export**: Click Export CSV or Export JSON to save results

## Example Queries

```sql
-- Basic SELECT
SELECT * FROM users

-- With WHERE clause
SELECT name, email FROM users WHERE age > 25

-- With ORDER BY
SELECT * FROM products ORDER BY price DESC

-- With LIMIT
SELECT * FROM posts LIMIT 10 OFFSET 20
```

## Extension Settings

Connection profiles and query history are stored in VS Code's global state for persistence across sessions.

## Known Issues

- PyMongoSQL syntax limitations may affect complex queries
- Very large result sets (>100K rows) may have performance impact
- Real-time MongoDB changes are not reflected until re-query

## Release Notes

### 1.0.0
Initial release with:
- SQL query editor
- MongoDB connection management
- Query execution with PyMongoSQL
- Result viewing and export
- Query history tracking

---

For more help and documentation, visit the [GitHub repository](https://github.com).

## Following extension guidelines

Ensure that you've read through the extensions guidelines and follow the best practices for creating your extension.

* [Extension Guidelines](https://code.visualstudio.com/api/references/extension-guidelines)

## Working with Markdown

You can author your README using Visual Studio Code. Here are some useful editor keyboard shortcuts:

* Split the editor (`Cmd+\` on macOS or `Ctrl+\` on Windows and Linux).
* Toggle preview (`Shift+Cmd+V` on macOS or `Shift+Ctrl+V` on Windows and Linux).
* Press `Ctrl+Space` (Windows, Linux, macOS) to see a list of Markdown snippets.

## For more information

* [Visual Studio Code's Markdown Support](http://code.visualstudio.com/docs/languages/markdown)
* [Markdown Syntax Reference](https://help.github.com/articles/markdown-basics/)

**Enjoy!**
