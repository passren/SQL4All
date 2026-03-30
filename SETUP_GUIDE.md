# SQL4No - Setup Guide

## ✅ Extension Created Successfully!

Your SQL4No extension has been created with all requested features.

## Project Structure

```
SQL4No/
├── src/
│   ├── extension.ts          # Main extension logic
│   └── test/                 # Test files
├── media/
│   ├── webview.html          # Query editor UI
│   ├── style.css             # Styling
│   └── script.js             # Client-side logic
├── python/
│   └── query_executor.py    # PyMongoSQL query executor
├── dist/
│   └── extension.js          # Compiled extension
├── package.json              # Extension manifest
├── tsconfig.json             # TypeScript config
├── webpack.config.js         # Build configuration
└── README.md                 # Full documentation
```

## What's Included

### ✨ Features
- [x] SQL Query Editor with PyMongoSQL syntax
- [x] MongoDB Connection Manager
- [x] Connection Profile Storage
- [x] Query History (last 50 queries)
- [x] Results Table Viewer
- [x] Export to CSV/JSON
- [x] Responsive UI with dark theme
- [x] Secure connection storage

### 🏗️ Architecture
- **Frontend**: VS Code Webview with TypeScript
- **Backend**: Python with PyMongoSQL library
- **Communication**: VS Code Message API
- **Storage**: VS Code Global State API

## How to Use

### 1. Install Python Dependencies (First Time Only)

```bash
pip install pymongo pymongosql
```

The extension will attempt to auto-install these on first query execution.

### 2. Run the Extension

#### Option A: Debug Mode (Development)
```bash
cd SQL4No
npm install
npm run compile
```
Then press **F5** in VS Code to launch the extension in debug mode.

#### Option B: Package Extension
```bash
npm run package
```
This creates a `.vsix` file you can distribute.

### 3. Launch the Query Panel

- **Keyboard Shortcut**: `Ctrl+Shift+M` (Windows/Linux) or `Cmd+Shift+M` (Mac)
- **Command Palette**: Press `Ctrl+Shift+P` and type "SQL4No: Open Query Panel"

### 4. Create a MongoDB Connection

1. Open the Query Panel
2. In the left sidebar, fill in:
   - **Connection Name**: e.g., "Local MongoDB"
   - **Host**: MongoDB server address (default: localhost)
   - **Port**: MongoDB port (default: 27017)
   - **Database**: Database name to query
   - **Username** (optional): If authentication enabled
   - **Password** (optional): If authentication enabled
3. Click **"Save Connection"**

### 5. Execute Queries

```sql
-- Example: Get all users
SELECT * FROM users

-- Example: Find by condition
SELECT name, email FROM users WHERE age > 25

-- Example: With ordering and limit
SELECT * FROM products 
ORDER BY price DESC 
LIMIT 20
```

### 6. Export Results

- Click **"Export CSV"** to download as CSV file
- Click **"Export JSON"** to download as JSON file

## File Descriptions

### src/extension.ts
Main extension file containing:
- Webview panel management
- Message handlers for webview communication
- MongoDB query execution
- Connection and history storage
- CSV/JSON export functionality

### media/webview.html
HTML interface with:
- Connection manager form
- Query editor textarea
- Results table display
- Query history list
- Export buttons

### media/script.js
Client-side JavaScript handling:
- Form validation and submission
- Message passing to extension
- Results rendering
- Connection management UI
- History display logic

### media/style.css
Complete styling with:
- VS Code dark theme colors
- Responsive grid layout
- Form and button styles
- Table styling
- Scrollbar customization

### python/query_executor.py
Python script that:
- Parses command-line arguments
- Connects to MongoDB
- Converts SQL to MongoDB queries using PyMongoSQL
- Executes the query
- Returns results as JSON

## Configuration

### Keyboard Shortcuts

Add to your `keybindings.json` for custom shortcuts:

```json
{
  "key": "ctrl+shift+m",
  "command": "sql4no.openQueryPanel"
}
```

### VS Code Settings

No special VS Code settings are required. All configuration is stored in:
- Extension global state
- Secure VS Code storage (for passwords)

## Development

### Build Commands

```bash
npm run compile          # Build extension
npm run watch          # Watch for changes
npm run package        # Create distributable
npm run lint           # Run ESLint
npm test              # Run tests
```

### Debug Tips

1. Set breakpoints in TypeScript code
2. Press F5 to launch
3. Open Developer Tools: `Ctrl+Shift+I` in extension window
4. Check console for messages and errors

### Testing the Extension

```bash
# In the extension host window
1. Open Query Panel (Ctrl+Shift+M)
2. Enter MongoDB connection details
3. Save connection
4. Enter test query: SELECT * FROM admin
5. Execute and verify results appear
```

## Troubleshooting

### Python Not Found
```bash
# Verify Python is installed
python --version

# Add Python to PATH if needed (Windows):
setx PATH "%PATH%;C:\Python39"
```

### MongoDB Connection Failed
- Verify MongoDB is running: `mongo` or `mongosh`
- Check host/port are correct
- Try with MongoDB Compass first to verify

### Extension Won't Activate
- Ensure VS Code version >= 1.110.0
- Check Output panel for errors: View > Output > SQL4No
- Reload window: Ctrl+R

### Webview Not Loading
- Check VS Code version
- Verify media files exist in media/ directory
- Check browser console for errors

## Next Steps

To enhance the extension further, consider adding:

1. **Visual Query Builder** - Drag-and-drop query creation
2. **Schema Explorer** - Browse collections and fields
3. **Saved Queries** - Store frequently used queries
4. **Query Debugging** - Show generated MongoDB aggregation pipeline
5. **Performance Profiling** - Analyze query execution time
6. **Transaction Support** - Multi-document operations
7. **Real-time Updates** - Subscribe to collection changes
8. **Data Import/Export** - Bulk operations

## Publishing to VS Code Marketplace

To publish your extension:

```bash
# Install vsce (VS Code Extension CLI)
npm install -g @vscode/vsce

# Create publisher account at https://marketplace.visualstudio.com

# Login
vsce login <publisher-name>

# Publish
vsce publish
```

## Support & Contributing

- 📝 See README.md for full documentation
- 🐛 Report issues via GitHub
- 💡 Feature requests welcome
- 🤝 Pull requests appreciated

## License

MIT License - See LICENSE file for details

## Quick Reference

| Action | Shortcut |
|--------|----------|
| Open Query Panel | Ctrl+Shift+M |
| Open Command Palette | Ctrl+Shift+P |
| Execute Query | Button Click |
| Export Results | Button Click |
| Delete Connection | Button Click |

---

**Happy querying with MongoDB and SQL!** 🎉
