const vscode = acquireVsCodeApi();

let currentResults = [];
let activeConnection = null;

// Initialize
document.addEventListener('DOMContentLoaded', () => {
    setupEventListeners();
    vscode.postMessage({ command: 'ready' });
});

function setupEventListeners() {
    // Query execution
    document.getElementById('runBtn').addEventListener('click', executeQuery);
    document.getElementById('clearBtn').addEventListener('click', () => {
        document.getElementById('queryEditor').value = '';
    });

    document.getElementById('queryEditor').addEventListener('keydown', (event) => {
        if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
            event.preventDefault();
            executeQuery();
        }
    });
    
    // Export
    document.getElementById('exportCsvBtn').addEventListener('click', () => exportResults('csv'));
    document.getElementById('exportJsonBtn').addEventListener('click', () => exportResults('json'));
    
    // Message handler from extension
    window.addEventListener('message', handleMessage);
}

function executeQuery() {
    const query = document.getElementById('queryEditor').value.trim();

    if (!activeConnection) {
        showAlert('Connection is not initialized.', 'error');
        return;
    }

    if (!query) {
        showAlert('Query is empty', 'error');
        return;
    }

    // Disable button and show loading state
    const executeBtn = document.getElementById('runBtn');
    const originalText = executeBtn.textContent;
    executeBtn.disabled = true;
    executeBtn.textContent = 'Executing...';

    vscode.postMessage({
        command: 'executeQuery',
        query
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

function handleMessage(event) {
    const message = event.data;

    switch (message.command) {
        case 'initConnection':
            activeConnection = message.data;
            showAlert(`Connected: ${activeConnection.name}`, 'info');
            break;
        case 'queryResults':
            displayResults(message.data);
            break;
        case 'queryError':
            showAlert(`Query Error: ${message.error}`, 'error');
            document.getElementById('runBtn').disabled = false;
            document.getElementById('runBtn').textContent = 'Run Query';
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
}

// Save state periodically
setInterval(() => {
    vscode.setState({
        query: document.getElementById('queryEditor').value
    });
}, 1000);
