const vscode = acquireVsCodeApi();

let currentResults = [];
let activeConnection = null;
let paneLayout = {
    queryPaneHeight: null
};

const MIN_QUERY_PANE_HEIGHT = 80;
const MIN_RESULTS_PANE_HEIGHT = 140;

function getResultsContainer() {
    return document.getElementById('resultsContainer');
}

function getResultsStatus() {
    return document.getElementById('resultsStatus');
}

function setResultMetrics(rows, columns) {
    document.getElementById('resultCount').textContent = `Rows: ${rows}`;
    document.getElementById('columnCount').textContent = `Columns: ${columns}`;
}

function setResultStatus(message, type = 'neutral') {
    const status = getResultsStatus();
    status.className = `results-status results-status-${type}`;
    status.textContent = message;
}

function setExportState(enabled) {
    document.getElementById('exportCsvBtn').disabled = !enabled;
    document.getElementById('exportJsonBtn').disabled = !enabled;
}

function renderPlaceholder(message, type = 'neutral') {
    const container = getResultsContainer();
    container.innerHTML = '';

    const emptyState = document.createElement('div');
    emptyState.className = `results-empty results-empty-${type}`;
    emptyState.textContent = message;
    container.appendChild(emptyState);
}

function getTableColumns(rows) {
    const columns = new Set();
    rows.forEach((row) => {
        if (row && typeof row === 'object' && !Array.isArray(row)) {
            Object.keys(row).forEach((key) => columns.add(key));
        }
    });
    return Array.from(columns);
}

function normalizeQueryPayload(data) {
    if (Array.isArray(data)) {
        const columns = getTableColumns(data);
        return {
            kind: 'result-set',
            rows: data,
            columns,
            rowCount: data.length,
            affectedRows: undefined,
            message: `Returned ${data.length} row(s)`
        };
    }

    if (data && typeof data === 'object') {
        const rows = Array.isArray(data.rows)
            ? data.rows
            : (Array.isArray(data.results) ? data.results : []);
        const columns = Array.isArray(data.columns) && data.columns.length > 0
            ? data.columns
            : getTableColumns(rows);

        return {
            kind: data.kind || (rows.length > 0 ? 'result-set' : 'command-result'),
            rows,
            columns,
            rowCount: Number.isInteger(data.rowCount) ? data.rowCount : rows.length,
            affectedRows: Number.isInteger(data.affectedRows) ? data.affectedRows : undefined,
            message: data.message || ''
        };
    }

    return {
        kind: 'command-result',
        rows: [],
        columns: [],
        rowCount: 0,
        affectedRows: undefined,
        message: ''
    };
}

function formatCellValue(value) {
    if (value === null || value === undefined) {
        return { text: 'NULL', title: 'NULL', className: 'cell-null' };
    }

    if (typeof value === 'object') {
        const json = JSON.stringify(value);
        return { text: json, title: JSON.stringify(value, null, 2), className: 'cell-object' };
    }

    const text = String(value);
    return { text, title: text, className: '' };
}

function renderResultsTable(payload) {
    const container = getResultsContainer();
    const rows = payload.rows;
    const columns = payload.columns;

    if (payload.kind !== 'result-set') {
        setResultMetrics(0, 0);
        setExportState(false);
        renderPlaceholder(payload.message || 'Statement executed successfully.', 'neutral');
        setResultStatus(payload.message || 'Statement executed successfully.', 'neutral');
        return;
    }

    if (rows.length === 0 || columns.length === 0) {
        setResultMetrics(0, 0);
        setExportState(false);
        renderPlaceholder('No documents matched the query.', 'neutral');
        setResultStatus('Query completed with no matching documents.', 'neutral');
        return;
    }

    const table = document.createElement('table');
    table.className = 'data-grid';

    const thead = document.createElement('thead');
    const headerRow = document.createElement('tr');

    const rowNumberHeader = document.createElement('th');
    rowNumberHeader.textContent = '#';
    rowNumberHeader.className = 'row-number-cell';
    headerRow.appendChild(rowNumberHeader);

    columns.forEach((column) => {
        const th = document.createElement('th');
        th.textContent = column;
        th.title = column;
        headerRow.appendChild(th);
    });

    thead.appendChild(headerRow);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    rows.forEach((row, index) => {
        const tr = document.createElement('tr');

        const rowNumber = document.createElement('td');
        rowNumber.textContent = String(index + 1);
        rowNumber.className = 'row-number-cell';
        tr.appendChild(rowNumber);

        columns.forEach((column) => {
            const td = document.createElement('td');
            const formatted = formatCellValue(row[column]);
            td.textContent = formatted.text;
            td.title = formatted.title;
            if (formatted.className) {
                td.classList.add(formatted.className);
            }
            tr.appendChild(td);
        });

        tbody.appendChild(tr);
    });

    table.appendChild(tbody);
    container.innerHTML = '';
    container.appendChild(table);

    setResultMetrics(payload.rowCount, columns.length);
    setExportState(true);
    setResultStatus(
        payload.message || `Showing ${payload.rowCount} document${payload.rowCount === 1 ? '' : 's'} from MongoDB.`,
        'success'
    );
}

function resetRunButton(label = 'Run') {
    const runBtn = document.getElementById('runBtn');
    runBtn.disabled = false;
    runBtn.textContent = label;
}

function getContainerGap(container) {
    const styles = window.getComputedStyle(container);
    const gapValue = styles.rowGap && styles.rowGap !== 'normal' ? styles.rowGap : styles.gap;
    const parsed = parseFloat(gapValue || '0');
    return Number.isFinite(parsed) ? parsed : 0;
}

function setupPaneResizer(initialHeight) {
    const container = document.querySelector('.container');
    const header = document.querySelector('.header');
    const queryPane = document.querySelector('.query-pane');
    const resultsPane = document.querySelector('.results-pane');
    const divider = document.getElementById('paneDivider');

    if (!container || !header || !queryPane || !resultsPane || !divider) {
        return;
    }

    const clampQueryHeight = (height) => {
        const gap = getContainerGap(container);
        const containerHeight = container.clientHeight;
        const headerHeight = header.getBoundingClientRect().height;
        const dividerHeight = divider.getBoundingClientRect().height;
        const availablePaneHeight = containerHeight - headerHeight - dividerHeight - (gap * 3);
        const maxQueryHeight = Math.max(MIN_QUERY_PANE_HEIGHT, availablePaneHeight - MIN_RESULTS_PANE_HEIGHT);

        return Math.min(Math.max(height, MIN_QUERY_PANE_HEIGHT), maxQueryHeight);
    };

    const applyQueryHeight = (height) => {
        const clampedHeight = clampQueryHeight(height);
        queryPane.style.flex = `0 0 ${clampedHeight}px`;
        paneLayout.queryPaneHeight = clampedHeight;
    };

    const resetQueryHeight = () => {
        queryPane.style.flex = '';
        paneLayout.queryPaneHeight = null;
    };

    if (typeof initialHeight === 'number' && Number.isFinite(initialHeight)) {
        applyQueryHeight(initialHeight);
    }

    let isDragging = false;
    let dragStartY = 0;
    let dragStartHeight = 0;
    let activePointerId = null;

    const stopDragging = () => {
        if (!isDragging) {
            return;
        }

        isDragging = false;
        divider.classList.remove('is-dragging');
        document.body.classList.remove('is-resizing');
        if (activePointerId !== null && divider.hasPointerCapture?.(activePointerId)) {
            divider.releasePointerCapture(activePointerId);
        }
        activePointerId = null;
    };

    divider.addEventListener('pointerdown', (event) => {
        event.preventDefault();
        isDragging = true;
        dragStartY = event.clientY;
        dragStartHeight = queryPane.getBoundingClientRect().height;
        activePointerId = event.pointerId;
        divider.classList.add('is-dragging');
        document.body.classList.add('is-resizing');
        divider.setPointerCapture(event.pointerId);
    });

    divider.addEventListener('pointermove', (event) => {
        if (!isDragging) {
            return;
        }

        const deltaY = event.clientY - dragStartY;
        applyQueryHeight(dragStartHeight + deltaY);
    });

    divider.addEventListener('pointerup', stopDragging);
    divider.addEventListener('pointercancel', stopDragging);

    divider.addEventListener('dblclick', () => {
        stopDragging();
        resetQueryHeight();
    });

    window.addEventListener('resize', () => {
        if (typeof paneLayout.queryPaneHeight === 'number') {
            applyQueryHeight(paneLayout.queryPaneHeight);
        }
    });
}

// Initialize
document.addEventListener('DOMContentLoaded', () => {
    setupPaneResizer(paneLayout.queryPaneHeight);
    setupEventListeners();
    setExportState(false);
    setResultMetrics(0, 0);
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
        setResultStatus('Connection is not initialized.', 'error');
        return;
    }

    if (!query) {
        setResultStatus('Query is empty.', 'error');
        return;
    }

    // Disable button and show loading state
    const executeBtn = document.getElementById('runBtn');
    const originalText = executeBtn.textContent;
    executeBtn.disabled = true;
    executeBtn.textContent = 'Executing...';
    setResultStatus('Running query against MongoDB...', 'loading');

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
        setResultStatus('No results to export.', 'error');
        return;
    }

    vscode.postMessage({
        command: 'exportResults',
        data: currentResults,
        format: format
    });
}

function displayResults(data) {
    const payload = normalizeQueryPayload(data);
    currentResults = payload.rows;
    renderResultsTable(payload);
    resetRunButton('Run');
}

function handleMessage(event) {
    const message = event.data;

    switch (message.command) {
        case 'initConnection':
            activeConnection = message.data;
            setResultStatus(`Connected to ${activeConnection.name}. Ready to query.`, 'neutral');
            break;
        case 'queryResults':
            displayResults(message.data);
            break;
        case 'queryError':
            currentResults = [];
            setResultMetrics(0, 0);
            setExportState(false);
            renderPlaceholder(message.error || 'Query failed.', 'error');
            setResultStatus(`Query error: ${message.error}`, 'error');
            resetRunButton('Run');
            break;
    }
}

// Restore state on reload
const state = vscode.getState();
if (state) {
    if (state.query) {
        document.getElementById('queryEditor').value = state.query;
    }
    if (typeof state.queryPaneHeight === 'number' && Number.isFinite(state.queryPaneHeight)) {
        paneLayout.queryPaneHeight = state.queryPaneHeight;
    }
}

// Save state periodically
setInterval(() => {
    vscode.setState({
        query: document.getElementById('queryEditor').value,
        queryPaneHeight: paneLayout.queryPaneHeight
    });
}, 1000);
