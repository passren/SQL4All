const vscode = acquireVsCodeApi();

let currentResults = [];
let connections = {};

// Initialize
document.addEventListener('DOMContentLoaded', () => {
    setupEventListeners();
    loadConnections();
    loadHistory();
});

function setupEventListeners() {
    // Connection management
    document.getElementById('saveConnBtn').addEventListener('click', saveConnection);
    document.getElementById('connectionSelect').addEventListener('change', onConnectionSelect);
    
    // Query execution
    document.getElementById('executeBtn').addEventListener('click', executeQuery);
    document.getElementById('clearBtn').addEventListener('click', () => {
        document.getElementById('queryEditor').value = '';
    });
    
    // Export
    document.getElementById('exportCsvBtn').addEventListener('click', () => exportResults('csv'));
    document.getElementById('exportJsonBtn').addEventListener('click', () => exportResults('json'));
    
    // Message handler from extension
    window.addEventListener('message', handleMessage);
}

function saveConnection() {
    const name = document.getElementById('connName').value.trim();
    const host = document.getElementById('connHost').value.trim();
    const port = parseInt(document.getElementById('connPort').value) || 27017;
    const database = document.getElementById('connDatabase').value.trim();
    const username = document.getElementById('connUsername').value.trim();
    const password = document.getElementById('connPassword').value.trim();

    if (!name) {
        showAlert('Connection name is required', 'error');
        return;
    }

    if (!host) {
        showAlert('Host is required', 'error');
        return;
    }

    if (!database) {
        showAlert('Database is required', 'error');
        return;
    }

    vscode.postMessage({
        command: 'saveConnection',
        data: {
            name,
            host,
            port,
            database,
            username,
            password
        }
    });

    // Clear form
    document.getElementById('connName').value = '';
    document.getElementById('connUsername').value = '';
    document.getElementById('connPassword').value = '';
    document.getElementById('connDatabase').value = '';

    showAlert('Connection saved successfully', 'success');
}

function loadConnections() {
    vscode.postMessage({ command: 'loadConnections' });
}

function onConnectionSelect() {
    const selected = document.getElementById('connectionSelect').value;
    // No special action needed - just stores the selection
}

function executeQuery() {
    const selectedConn = document.getElementById('connectionSelect').value;
    const query = document.getElementById('queryEditor').value.trim();

    if (!selectedConn) {
        showAlert('No connection selected', 'error');
        return;
    }

    if (!query) {
        showAlert('Query is empty', 'error');
        return;
    }

    const connection = connections[selectedConn];
    if (!connection) {
        showAlert('Connection not found', 'error');
        return;
    }

    // Disable button and show loading state
    const executeBtn = document.getElementById('executeBtn');
    const originalText = executeBtn.textContent;
    executeBtn.disabled = true;
    executeBtn.textContent = 'Executing...';

    vscode.postMessage({
        command: 'executeQuery',
        data: {
            connection: selectedConn,
            query,
            host: connection.host,
            port: connection.port,
            database: connection.database,
            username: connection.username,
            password: connection.password
        }
    });

    // Reset button after a timeout (will be re-enabled when results arrive)
    setTimeout(() => {
        executeBtn.disabled = false;
        executeBtn.textContent = originalText;
    }, 30000);
}

function exportResults(format) {
    if (currentResults.length === 0) {
        showAlert('No results to export', 'error');
        return;
    }

    vscode.postMessage({
        command: 'exportResults',
        data: currentResults,
        format: format
    });
}

function displayResults(data) {
    const container = document.getElementById('resultsContainer');
    currentResults = Array.isArray(data) ? data : [data];

    if (currentResults.length === 0) {
        container.innerHTML = '<p class="placeholder">No results returned</p>';
        document.getElementById('resultCount').textContent = 'Results: 0';
        return;
    }

    // Create table
    const table = document.createElement('table');
    const headers = Object.keys(currentResults[0]);

    // Table header
    const thead = document.createElement('thead');
    const headerRow = document.createElement('tr');
    headers.forEach(h => {
        const th = document.createElement('th');
        th.textContent = h;
        headerRow.appendChild(th);
    });
    thead.appendChild(headerRow);
    table.appendChild(thead);

    // Table body
    const tbody = document.createElement('tbody');
    currentResults.forEach(row => {
        const tr = document.createElement('tr');
        headers.forEach(h => {
            const td = document.createElement('td');
            const value = row[h];
            if (value === null || value === undefined) {
                td.textContent = 'NULL';
                td.style.color = 'var(--text-secondary)';
                td.style.fontStyle = 'italic';
            } else if (typeof value === 'object') {
                td.textContent = JSON.stringify(value);
                td.title = JSON.stringify(value, null, 2);
            } else {
                td.textContent = String(value);
                td.title = String(value);
            }
            tr.appendChild(td);
        });
        tbody.appendChild(tr);
    });
    table.appendChild(tbody);

    container.innerHTML = '';
    container.appendChild(table);

    document.getElementById('resultCount').textContent = `Results: ${currentResults.length}`;
    document.getElementById('executeBtn').disabled = false;
    document.getElementById('executeBtn').textContent = 'Execute Query';

    showAlert(`Query executed successfully. ${currentResults.length} row(s) returned.`, 'success');
}

function displayConnections(conns) {
    connections = conns;

    // Update connection select dropdown
    const select = document.getElementById('connectionSelect');
    const selectedValue = select.value;
    select.innerHTML = '<option value="">Select Connection...</option>';

    Object.keys(conns).forEach(name => {
        const option = document.createElement('option');
        option.value = name;
        option.textContent = name;
        select.appendChild(option);
    });

    if (selectedValue) {
        select.value = selectedValue;
    }

    // Update connections list
    const list = document.getElementById('connectionsList');
    if (Object.keys(conns).length === 0) {
        list.innerHTML = '<p class="placeholder">No connections saved</p>';
        return;
    }

    list.innerHTML = '';
    Object.entries(conns).forEach(([name, conn]) => {
        const item = document.createElement('div');
        item.className = 'connection-item';

        const info = document.createElement('div');
        const nameSpan = document.createElement('div');
        nameSpan.className = 'connection-item-name';
        nameSpan.textContent = name;

        const details = document.createElement('div');
        details.className = 'connection-item-details';
        details.textContent = `${conn.host}:${conn.port}/${conn.database}`;

        info.appendChild(nameSpan);
        info.appendChild(details);

        const actions = document.createElement('div');
        actions.className = 'connection-item-actions';

        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'btn btn-danger';
        deleteBtn.textContent = 'Delete';
        deleteBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (confirm(`Delete connection "${name}"?`)) {
                vscode.postMessage({
                    command: 'deleteConnection',
                    name: name
                });
            }
        });

        actions.appendChild(deleteBtn);

        item.appendChild(info);
        item.appendChild(actions);
        list.appendChild(item);
    });
}

function displayHistory(history) {
    const list = document.getElementById('historyList');

    if (history.length === 0) {
        list.innerHTML = '<p class="placeholder">No queries executed yet</p>';
        return;
    }

    list.innerHTML = '';
    history.slice().reverse().forEach((item, idx) => {
        const historyItem = document.createElement('div');
        historyItem.className = 'history-item';

        const query = document.createElement('div');
        query.className = 'history-item-query';
        query.textContent = item.query;

        const meta = document.createElement('div');
        meta.className = 'history-item-meta';
        const timeStr = new Date(item.timestamp).toLocaleString();
        meta.textContent = `${item.connection} - ${timeStr}${item.resultCount !== undefined ? ` (${item.resultCount} rows)` : ''}`;

        historyItem.appendChild(query);
        historyItem.appendChild(meta);

        historyItem.addEventListener('click', () => {
            document.getElementById('queryEditor').value = item.query;
            document.getElementById('connectionSelect').value = item.connection;
        });

        list.appendChild(historyItem);
    });
}

function loadHistory() {
    vscode.postMessage({ command: 'loadHistory' });
}

function handleMessage(event) {
    const message = event.data;

    switch (message.command) {
        case 'connectionSaved':
            break;
        case 'connectionsLoaded':
            displayConnections(message.data);
            break;
        case 'queryResults':
            displayResults(message.data);
            break;
        case 'queryError':
            showAlert(`Query Error: ${message.error}`, 'error');
            document.getElementById('executeBtn').disabled = false;
            document.getElementById('executeBtn').textContent = 'Execute Query';
            break;
        case 'historyLoaded':
            displayHistory(message.data);
            break;
    }
}

function showAlert(message, type = 'info') {
    const alert = document.createElement('div');
    alert.className = `alert alert-${type}`;
    alert.textContent = message;

    const container = document.querySelector('.container');
    container.insertBefore(alert, container.firstChild.nextSibling);

    setTimeout(() => {
        alert.remove();
    }, 5000);
}

// Restore state on reload
const state = vscode.getState();
if (state) {
    if (state.query) {
        document.getElementById('queryEditor').value = state.query;
    }
    if (state.selectedConnection) {
        document.getElementById('connectionSelect').value = state.selectedConnection;
    }
}

// Save state periodically
setInterval(() => {
    vscode.setState({
        query: document.getElementById('queryEditor').value,
        selectedConnection: document.getElementById('connectionSelect').value
    });
}, 1000);
