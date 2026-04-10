const vscode = acquireVsCodeApi();

let currentResults = [];
let activeConnection = null;
let activeResultTab = "table";
let sqlEditor = null;
let paneLayout = {
  queryPaneHeight: null,
};
let draftSaveTimer = null;
let paneHeightSyncTimer = null;
let lastSentPaneHeight = null;
let applySavedPaneHeight = null;
let isQueryExecuting = false;
let queryExecutionStartedAt = null;
let queryExecutionTimer = null;
let lastExecutedQuery = null;
let recentFiles = [];
let linkedFilePath = null;
let executionHistory = []; // Session-only execution history
const MAX_RECENT_FILES = 10;
let savedContent = "";
let isDirty = false;
let hasMoreRows = false;
let isFetchingMore = false;
let currentColumns = [];

const MIN_QUERY_PANE_HEIGHT = 80;
const MIN_RESULTS_PANE_HEIGHT = 140;

function getResultsContainer() {
  return document.getElementById("resultsContainer");
}

function getResultsJsonContainer() {
  return document.getElementById("resultsJsonContainer");
}

function getResultsJsonWrap() {
  return document.getElementById("resultsJsonWrap");
}

function setActiveResultTab(tab) {
  activeResultTab = tab;
  const isTable = tab === "table";
  const isHistory = tab === "history";
  const tableTab = document.getElementById("resultsTabTable");
  const jsonTab = document.getElementById("resultsTabJson");
  const historyTab = document.getElementById("resultsTabHistory");
  const tablePanel = getResultsContainer();
  const jsonPanel = getResultsJsonWrap();
  const historyPanel = document.getElementById("resultsHistoryWrap");
  
  tableTab.classList.toggle("is-active", isTable);
  jsonTab.classList.toggle("is-active", !isTable && !isHistory);
  historyTab.classList.toggle("is-active", isHistory);
  
  tableTab.setAttribute("aria-selected", String(isTable));
  jsonTab.setAttribute("aria-selected", String(!isTable && !isHistory));
  historyTab.setAttribute("aria-selected", String(isHistory));
  
  tablePanel.classList.toggle("is-active", isTable);
  jsonPanel.classList.toggle("is-active", !isTable && !isHistory);
  historyPanel.classList.toggle("is-active", isHistory);
}

function getStatementCategoryFromQuery(query) {
  const utils = window.SQL4ALLExecutorUtils;
  const statementType = utils.getStatementType(query);
  
  if (!statementType) {
    return "unknown";
  }
  
  const dql = ["SELECT"];
  const ddl = ["CREATE", "ALTER", "DROP", "TRUNCATE", "RENAME", "COMMENT"];
  const dml = ["INSERT", "UPDATE", "DELETE", "MERGE"];
  
  if (dql.includes(statementType)) {
    return "dql";
  }
  if (ddl.includes(statementType)) {
    return "ddl";
  }
  if (dml.includes(statementType)) {
    return "dml";
  }
  return "unknown";
}

function addExecutionHistoryEntry(query, resultCount, error, duration) {
  const startTime = queryExecutionStartedAt || Date.now();
  const category = getStatementCategoryFromQuery(query);
  
  const entry = {
    id: Date.now() + Math.random(),
    startTime: new Date(startTime),
    duration: duration || 0,
    query: query,
    resultCount: resultCount || 0,
    error: error || null,
    category: category,
  };
  
  executionHistory.unshift(entry);
  renderExecutionHistory();
}

function renderExecutionHistory() {
  const container = document.getElementById("historyContainer");
  
  if (executionHistory.length === 0) {
    container.innerHTML = '<p class="placeholder">Execution history will appear here.</p>';
    return;
  }
  
  const historyHtml = executionHistory.map((entry) => {
    const utils = window.SQL4ALLExecutorUtils;
    const escapeHtml = utils.escapeHtmlChars;
    const timeStr = entry.startTime.toLocaleTimeString();
    const durationStr = entry.duration.toFixed(2);
    const resultText = entry.error
      ? `<span class="history-error">Error: ${escapeHtml(entry.error)}</span>`
      : `<span class="history-success">${entry.resultCount} result${entry.resultCount === 1 ? "" : "s"}</span>`;
    
    const sqlPreview = entry.query.substring(0, 100).replace(/\n/g, " ");
    const sqlFull = entry.query.trim();
    
    return `
      <div class="history-entry history-${entry.category}${entry.error ? " has-error" : ""}">
        <div class="history-header">
          <div class="history-time">${timeStr}</div>
          <div class="history-duration">${durationStr}s</div>
          <div class="history-result">${resultText}</div>
        </div>
        <div class="history-sql" title="${escapeHtml(sqlFull)}">${escapeHtml(sqlPreview)}</div>
      </div>
    `;
  }).join("");
  
  container.innerHTML = historyHtml;
}

function renderResultsJson(payload) {
  const utils = window.SQL4ALLExecutorUtils;
  const json = JSON.stringify(payload, null, 2);
  getResultsJsonContainer().innerHTML = utils.syntaxHighlightJson(json);
}

function getResultsStatus() {
  return document.getElementById("resultsStatus");
}

function setResultMetrics(rows, columns) {
  document.getElementById("resultCount").textContent = `Rows: ${rows}`;
  document.getElementById("columnCount").textContent = `Columns: ${columns}`;
}

function setResultStatus(message, type = "neutral") {
  const status = getResultsStatus();
  status.className = `results-status results-status-${type}`;
  status.textContent = message;
}

function startExecutionStatus(targetName) {
  const utils = window.SQL4ALLExecutorUtils;
  queryExecutionStartedAt = Date.now();
  setResultStatus(`Executing SQL against ${targetName}... (0.00s)`, "loading");

  if (queryExecutionTimer !== null) {
    clearInterval(queryExecutionTimer);
  }

  queryExecutionTimer = setInterval(() => {
    if (!Number.isFinite(queryExecutionStartedAt)) {
      return;
    }
    const elapsedSeconds = (Date.now() - queryExecutionStartedAt) / 1000;
    setResultStatus(
      `Executing SQL against ${targetName}... (${utils.formatElapsedSeconds(elapsedSeconds)}s)`,
      "loading",
    );
  }, 100);
}

function stopExecutionStatus() {
  if (queryExecutionTimer !== null) {
    clearInterval(queryExecutionTimer);
    queryExecutionTimer = null;
  }

  if (!Number.isFinite(queryExecutionStartedAt)) {
    queryExecutionStartedAt = null;
    return null;
  }

  const elapsedSeconds = (Date.now() - queryExecutionStartedAt) / 1000;
  queryExecutionStartedAt = null;
  return elapsedSeconds;
}

function setExportState(enabled) {
  document.getElementById("exportCsvBtn").disabled = !enabled;
  document.getElementById("exportJsonBtn").disabled = !enabled;
}

function renderPlaceholder(message, type = "neutral") {
  const container = getResultsContainer();
  container.innerHTML = "";

  const emptyState = document.createElement("div");
  emptyState.className = `results-empty results-empty-${type}`;
  emptyState.textContent = message;
  container.appendChild(emptyState);
}

function showRowDetailModal(row, columns, rowIndex) {
  const utils = window.SQL4ALLExecutorUtils;

  // Remove any existing modal
  const existing = document.querySelector(".row-detail-overlay");
  if (existing) existing.remove();

  const overlay = document.createElement("div");
  overlay.className = "row-detail-overlay";

  const modal = document.createElement("div");
  modal.className = "row-detail-modal";

  // Header
  const header = document.createElement("div");
  header.className = "row-detail-header";
  const title = document.createElement("span");
  title.className = "row-detail-title";
  title.textContent = `Row #${rowIndex + 1}`;
  const closeBtn = document.createElement("button");
  closeBtn.className = "row-detail-close";
  closeBtn.textContent = "\u00d7";
  closeBtn.title = "Close (Esc)";
  header.appendChild(title);
  header.appendChild(closeBtn);
  modal.appendChild(header);

  // Body
  const body = document.createElement("div");
  body.className = "row-detail-body";

  columns.forEach((col) => {
    const field = document.createElement("div");
    field.className = "row-detail-field";

    const label = document.createElement("div");
    label.className = "row-detail-label";
    label.textContent = col;
    label.title = col;

    const valueWrap = document.createElement("div");
    valueWrap.className = "row-detail-value-wrap";

    const formatted = utils.formatCellValue(row[col]);
    const rawValue = formatted.title || formatted.text;

    const valueEl = document.createElement("div");
    valueEl.className = "row-detail-value";
    if (formatted.className) valueEl.classList.add(formatted.className);
    valueEl.textContent = typeof row[col] === "object" && row[col] !== null
      ? JSON.stringify(row[col], null, 2)
      : formatted.text;

    const copyBtn = document.createElement("button");
    copyBtn.className = "row-detail-copy-btn";
    copyBtn.textContent = "Copy";
    copyBtn.title = "Copy value";
    copyBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      navigator.clipboard.writeText(rawValue).then(() => {
        copyBtn.textContent = "\u2713";
        copyBtn.classList.add("copied");
        setTimeout(() => {
          copyBtn.textContent = "Copy";
          copyBtn.classList.remove("copied");
        }, 1500);
      });
    });

    valueWrap.appendChild(valueEl);
    valueWrap.appendChild(copyBtn);
    field.appendChild(label);
    field.appendChild(valueWrap);
    body.appendChild(field);
  });

  modal.appendChild(body);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  // Close handlers
  function close() {
    overlay.remove();
    document.removeEventListener("keydown", onKey);
  }
  function onKey(e) {
    if (e.key === "Escape") close();
  }
  closeBtn.addEventListener("click", close);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });
  document.addEventListener("keydown", onKey);
}

function initColumnResize(table) {
  // Measure natural column widths before switching to fixed layout
  const rowNumTh = table.querySelector("thead th.row-number-cell");
  const headers = table.querySelectorAll("thead th:not(.row-number-cell)");

  const naturalWidths = Array.from(headers).map((th) => th.offsetWidth);

  // Now lock widths and switch to fixed layout
  if (rowNumTh) {
    rowNumTh.style.width = "52px";
  }
  headers.forEach((th, i) => {
    th.style.width = naturalWidths[i] + "px";
  });
  table.style.tableLayout = "fixed";

  let activeHandle = null;
  let startX = 0;
  let startWidth = 0;
  let activeTh = null;

  function onMouseMove(e) {
    if (!activeTh) return;
    const delta = e.clientX - startX;
    const newWidth = Math.max(40, startWidth + delta);
    activeTh.style.width = newWidth + "px";
  }

  function onMouseUp() {
    if (activeHandle) activeHandle.classList.remove("is-resizing");
    activeHandle = null;
    activeTh = null;
    document.removeEventListener("mousemove", onMouseMove);
    document.removeEventListener("mouseup", onMouseUp);
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  }

  table.addEventListener("mousedown", (e) => {
    const handle = e.target.closest(".resize-handle");
    if (!handle) return;
    e.preventDefault();
    activeTh = handle.parentElement;
    activeHandle = handle;
    startX = e.clientX;
    startWidth = activeTh.offsetWidth;
    handle.classList.add("is-resizing");
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  });
}

function renderResultsTable(payload, elapsedSeconds) {
  const utils = window.SQL4ALLExecutorUtils;
  const container = getResultsContainer();
  const rows = payload.rows;
  const columns = payload.columns;

  if (payload.kind !== "result-set") {
    setResultMetrics(0, 0);
    setExportState(false);
    renderPlaceholder(
      payload.message || "Statement executed successfully.",
      "neutral",
    );
    setResultStatus(
      `${payload.message || "Statement executed successfully."} (${utils.formatElapsedSeconds(elapsedSeconds || 0)}s)`,
      "neutral",
    );
    return;
  }

  if (columns.length === 0) {
    setResultMetrics(0, 0);
    setExportState(false);
    renderPlaceholder("Execution returned no data.", "neutral");
    setResultStatus(
      `Execution completed with no returned data. (${utils.formatElapsedSeconds(elapsedSeconds || 0)}s)`,
      "neutral",
    );
    return;
  }

  const table = document.createElement("table");
  table.className = "data-grid";

  const thead = document.createElement("thead");
  const headerRow = document.createElement("tr");

  const rowNumberHeader = document.createElement("th");
  rowNumberHeader.textContent = "#";
  rowNumberHeader.className = "row-number-cell";
  headerRow.appendChild(rowNumberHeader);

  columns.forEach((column) => {
    const th = document.createElement("th");
    const label = document.createElement("span");
    label.textContent = column;
    th.appendChild(label);
    th.title = column;
    const resizeHandle = document.createElement("div");
    resizeHandle.className = "resize-handle";
    th.appendChild(resizeHandle);
    headerRow.appendChild(th);
  });

  thead.appendChild(headerRow);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");

  if (rows.length === 0) {
    setResultMetrics(0, 0);
    setExportState(false);
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = columns.length + 1;
    td.className = "no-data-cell";
    td.textContent = "No data";
    tr.appendChild(td);
    tbody.appendChild(tr);
    table.appendChild(tbody);
    container.innerHTML = "";
    container.appendChild(table);
    setResultStatus(
      `Returned 0 rows. (${utils.formatElapsedSeconds(elapsedSeconds || 0)}s)`,
      "neutral",
    );
    return;
  }
  rows.forEach((row, index) => {
    const tr = document.createElement("tr");
    tr.style.cursor = "pointer";
    tr.addEventListener("dblclick", () => {
      showRowDetailModal(row, columns, index);
    });

    const rowNumber = document.createElement("td");
    rowNumber.textContent = String(index + 1);
    rowNumber.className = "row-number-cell";
    tr.appendChild(rowNumber);

    columns.forEach((column) => {
      const td = document.createElement("td");
      const formatted = utils.formatCellValue(row[column]);
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
  container.innerHTML = "";
  container.appendChild(table);

  if (hasMoreRows) {
    const loadingEl = document.createElement("div");
    loadingEl.id = "fetchMoreLoading";
    loadingEl.className = "fetch-more-loading";
    loadingEl.textContent = "Scroll down to load more rows...";
    container.appendChild(loadingEl);
  }

  initColumnResize(table);
  setupInfiniteScroll(container);

  setResultMetrics(payload.rowCount, columns.length);
  setExportState(true);
  setResultStatus(
    `${
      payload.message ||
      `Showing ${payload.rowCount} document${payload.rowCount === 1 ? "" : "s"} from MongoDB.`
    } (${utils.formatElapsedSeconds(elapsedSeconds || 0)}s)`,
    "success",
  );
}

function setupInfiniteScroll(container) {
  // Remove previous listener if any
  if (container._scrollHandler) {
    container.removeEventListener("scroll", container._scrollHandler);
  }

  const handler = () => {
    if (!hasMoreRows || isFetchingMore) {
      return;
    }
    const threshold = 50;
    if (container.scrollHeight - container.scrollTop - container.clientHeight < threshold) {
      isFetchingMore = true;
      const loadingEl = document.getElementById("fetchMoreLoading");
      if (loadingEl) {
        loadingEl.textContent = "Loading more rows...";
      }
      vscode.postMessage({ command: "fetchMore" });
    }
  };

  container._scrollHandler = handler;
  container.addEventListener("scroll", handler);
}

function appendMoreRows(data) {
  const utils = window.SQL4ALLExecutorUtils;
  const container = getResultsContainer();
  const table = container.querySelector("table.data-grid");
  if (!table) {
    return;
  }

  const tbody = table.querySelector("tbody");
  if (!tbody) {
    return;
  }

  const columns = data.columns || currentColumns;
  const rows = data.rows || [];
  const existingRowCount = currentResults.length;

  rows.forEach((row, index) => {
    const tr = document.createElement("tr");
    tr.style.cursor = "pointer";
    const globalIndex = existingRowCount + index;
    tr.addEventListener("dblclick", () => {
      showRowDetailModal(row, columns, globalIndex);
    });

    const rowNumber = document.createElement("td");
    rowNumber.textContent = String(globalIndex + 1);
    rowNumber.className = "row-number-cell";
    tr.appendChild(rowNumber);

    columns.forEach((column) => {
      const td = document.createElement("td");
      const formatted = utils.formatCellValue(row[column]);
      td.textContent = formatted.text;
      td.title = formatted.title;
      if (formatted.className) {
        td.classList.add(formatted.className);
      }
      tr.appendChild(td);
    });

    tbody.appendChild(tr);
  });

  // Update state
  currentResults = currentResults.concat(rows);
  hasMoreRows = !!data.hasMore;
  isFetchingMore = false;

  // Update or remove loading indicator
  const loadingEl = document.getElementById("fetchMoreLoading");
  if (hasMoreRows) {
    if (loadingEl) {
      loadingEl.textContent = "Scroll down to load more rows...";
    }
  } else {
    if (loadingEl) {
      loadingEl.remove();
    }
  }

  // Update metrics
  setResultMetrics(currentResults.length, columns.length);
  renderResultsJson(currentResults);

  // Update the latest history entry with the new total count
  if (executionHistory.length > 0) {
    executionHistory[0].resultCount = currentResults.length;
    renderExecutionHistory();
  }

  const totalRows = currentResults.length;
  setResultStatus(
    `Showing ${totalRows} row${totalRows === 1 ? "" : "s"}.${hasMoreRows ? " More available." : ""}`,
    "success",
  );
}

var PLAY_ICON = '<svg viewBox="0 0 16 16" focusable="false"><path d="M3 2.5v11l10-5.5-10-5.5z" /></svg>';
var STOP_ICON = '<svg viewBox="0 0 16 16" focusable="false"><rect x="3" y="3" width="10" height="10" rx="1" /></svg>';

function resetRunButton(label = "Run") {
  const runBtn = document.getElementById("runBtn");
  const runBtnLabel = runBtn.querySelector(".btn-label");
  const runBtnIcon = runBtn.querySelector(".icon");
  runBtn.disabled = false;
  runBtn.classList.remove("btn-danger");
  runBtn.classList.add("btn-primary");
  runBtn.title = "Execute SQL (Ctrl/Cmd+Enter)";
  runBtnLabel.textContent = label;
  runBtnIcon.innerHTML = PLAY_ICON;
}

function setupPaneResizer(initialHeight) {
  const utils = window.SQL4ALLExecutorUtils;
  const container = document.querySelector(".container");
  const queryPane = document.querySelector(".query-pane");
  const resultsPane = document.querySelector(".results-pane");
  const divider = document.getElementById("paneDivider");

  if (!container || !queryPane || !resultsPane || !divider) {
    return;
  }

  const clampQueryHeight = (height) => {
    const gap = utils.getContainerGap(container);
    const containerHeight = container.clientHeight;
    const dividerHeight = divider.getBoundingClientRect().height;
    const availablePaneHeight =
      containerHeight - dividerHeight - gap * 2;
    const maxQueryHeight = Math.max(
      MIN_QUERY_PANE_HEIGHT,
      availablePaneHeight - MIN_RESULTS_PANE_HEIGHT,
    );

    return Math.min(Math.max(height, MIN_QUERY_PANE_HEIGHT), maxQueryHeight);
  };

  const applyQueryHeight = (height) => {
    const clampedHeight = clampQueryHeight(height);
    queryPane.style.flex = `0 0 ${clampedHeight}px`;
    paneLayout.queryPaneHeight = clampedHeight;
  };

  applySavedPaneHeight = applyQueryHeight;

  const resetQueryHeight = () => {
    queryPane.style.flex = "";
    paneLayout.queryPaneHeight = null;
  };

  if (typeof initialHeight === "number" && Number.isFinite(initialHeight)) {
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
    divider.classList.remove("is-dragging");
    document.body.classList.remove("is-resizing");
    if (
      activePointerId !== null &&
      divider.hasPointerCapture?.(activePointerId)
    ) {
      divider.releasePointerCapture(activePointerId);
    }
    activePointerId = null;
  };

  divider.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    isDragging = true;
    dragStartY = event.clientY;
    dragStartHeight = queryPane.getBoundingClientRect().height;
    activePointerId = event.pointerId;
    divider.classList.add("is-dragging");
    document.body.classList.add("is-resizing");
    divider.setPointerCapture(event.pointerId);
  });

  divider.addEventListener("pointermove", (event) => {
    if (!isDragging) {
      return;
    }

    const deltaY = event.clientY - dragStartY;
    applyQueryHeight(dragStartHeight + deltaY);
  });

  divider.addEventListener("pointerup", stopDragging);
  divider.addEventListener("pointercancel", stopDragging);

  divider.addEventListener("dblclick", () => {
    stopDragging();
    resetQueryHeight();
  });

  window.addEventListener("resize", () => {
    if (typeof paneLayout.queryPaneHeight === "number") {
      applyQueryHeight(paneLayout.queryPaneHeight);
    }
  });
}

function syncPaneLayoutToExtension() {
  if (
    typeof paneLayout.queryPaneHeight !== "number" ||
    !Number.isFinite(paneLayout.queryPaneHeight)
  ) {
    return;
  }

  if (paneLayout.queryPaneHeight === lastSentPaneHeight) {
    return;
  }

  lastSentPaneHeight = paneLayout.queryPaneHeight;
  vscode.postMessage({
    command: "updatePaneLayout",
    queryPaneHeight: paneLayout.queryPaneHeight,
  });
}

// Initialize
document.addEventListener("DOMContentLoaded", () => {
  sqlEditor = CodeMirror(document.getElementById("queryEditor"), {
    mode: "text/x-sql",
    lineNumbers: true,
    indentWithTabs: false,
    smartIndent: true,
    tabSize: 4,
    autofocus: true,
    extraKeys: {
      "Ctrl-Enter": executeQuery,
      "Cmd-Enter": executeQuery,
      "Ctrl-S": function () {
        document.getElementById("saveFileBtn").click();
      },
      "Cmd-S": function () {
        document.getElementById("saveFileBtn").click();
      },
      "Ctrl-F": function () {
        var fi = document.getElementById("findInput");
        fi.focus();
        fi.select();
      },
      "Cmd-F": function () {
        var fi = document.getElementById("findInput");
        fi.focus();
        fi.select();
      },
    },
  });
  sqlEditor.on("contextmenu", (cm, e) => e.preventDefault());
  setTimeout(() => sqlEditor.refresh(), 0);
  const saved = vscode.getState();
  if (saved && saved.query) {
    sqlEditor.setValue(saved.query);
  }
  setupPaneResizer(paneLayout.queryPaneHeight);
  setupEventListeners();
  setActiveResultTab(activeResultTab);
  setExportState(false);
  setResultMetrics(0, 0);
  vscode.postMessage({ command: "ready" });
});

function setupEventListeners() {
  // Query execution
  document.getElementById("runBtn").addEventListener("click", executeQuery);
  document.getElementById("clearBtn").addEventListener("click", () => {
    sqlEditor.setValue("");
  });

  document
    .getElementById("resultsTabTable")
    .addEventListener("click", () => setActiveResultTab("table"));
  document
    .getElementById("resultsTabJson")
    .addEventListener("click", () => setActiveResultTab("json"));
  document
    .getElementById("resultsTabHistory")
    .addEventListener("click", () => setActiveResultTab("history"));

  document.getElementById("copyJsonBtn").addEventListener("click", async () => {
    const text = getResultsJsonContainer().textContent || "";
    const btn = document.getElementById("copyJsonBtn");
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const t = document.createElement("textarea");
        t.value = text;
        t.style.position = "absolute";
        t.style.left = "-9999px";
        document.body.appendChild(t);
        t.select();
        document.execCommand("copy");
        document.body.removeChild(t);
      }
      btn.textContent = "Copied!";
      setTimeout(() => {
        btn.textContent = "Copy";
      }, 1500);
    } catch {
      btn.textContent = "Failed";
      setTimeout(() => {
        btn.textContent = "Copy";
      }, 1500);
    }
  });

  // Export
  document
    .getElementById("exportCsvBtn")
    .addEventListener("click", () => exportResults("csv"));
  document
    .getElementById("exportJsonBtn")
    .addEventListener("click", () => exportResults("json"));

  // File operations
  document.getElementById("openFileBtn").addEventListener("click", () => {
    vscode.postMessage({ command: "openFile" });
  });
  document.getElementById("saveFileBtn").addEventListener("click", () => {
    vscode.postMessage({
      command: "saveFile",
      content: sqlEditor.getValue(),
    });
  });
  document.getElementById("saveAsFileBtn").addEventListener("click", () => {
    vscode.postMessage({
      command: "saveFileAs",
      content: sqlEditor.getValue(),
    });
  });
  document.getElementById("formatBtn").addEventListener("click", () => {
    const selection = sqlEditor.getSelection();
    if (selection) {
      vscode.postMessage({ command: "formatSql", sql: selection });
    }
  });

  // Find in editor
  let lastFindQuery = "";
  let lastFindPos = null;
  const findInput = document.getElementById("findInput");
  const findBtn = document.getElementById("findBtn");

  function findInEditor() {
    const query = findInput.value.toLowerCase();
    if (!query || !sqlEditor) {
      return;
    }
    const content = sqlEditor.getValue().toLowerCase();
    // Determine start position for search
    let startOffset = 0;
    if (query === lastFindQuery && lastFindPos !== null) {
      startOffset = lastFindPos + 1;
    }
    lastFindQuery = query;
    let idx = content.indexOf(query, startOffset);
    if (idx === -1) {
      // wrap around
      idx = content.indexOf(query, 0);
    }
    if (idx === -1) {
      return;
    }
    lastFindPos = idx;
    // Convert offset to line/ch
    const before = sqlEditor.getValue().slice(0, idx);
    const lines = before.split("\n");
    const fromLine = lines.length - 1;
    const fromCh = lines[lines.length - 1].length;
    const matchEnd = idx + findInput.value.length;
    const beforeEnd = sqlEditor.getValue().slice(0, matchEnd);
    const linesEnd = beforeEnd.split("\n");
    const toLine = linesEnd.length - 1;
    const toCh = linesEnd[linesEnd.length - 1].length;
    sqlEditor.setSelection({ line: fromLine, ch: fromCh }, { line: toLine, ch: toCh });
    sqlEditor.scrollIntoView({ from: { line: fromLine, ch: fromCh }, to: { line: toLine, ch: toCh } }, 40);
  }

  findBtn.addEventListener("click", findInEditor);
  findInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      findInEditor();
    }
    if (e.key === "Escape") {
      findInput.value = "";
      lastFindQuery = "";
      lastFindPos = null;
      sqlEditor.focus();
    }
  });

  // Recent files dropdown
  const recentFilesBtn = document.getElementById("recentFilesBtn");
  const recentFilesMenu = document.getElementById("recentFilesMenu");
  const recentFilesWrap = recentFilesBtn.closest(".recent-files-wrap");
  let recentHideTimer = null;
  recentFilesWrap.addEventListener("mouseenter", () => {
    if (recentHideTimer) { clearTimeout(recentHideTimer); recentHideTimer = null; }
    renderRecentFilesMenu();
    recentFilesMenu.classList.remove("hidden");
  });
  recentFilesWrap.addEventListener("mouseleave", () => {
    recentHideTimer = setTimeout(() => {
      recentFilesMenu.classList.add("hidden");
    }, 200);
  });
  document.addEventListener("click", (e) => {
    if (!recentFilesWrap.contains(e.target)) {
      recentFilesMenu.classList.add("hidden");
    }
  });

  // Auto-focus editor when window/tab regains focus.
  // Use multiple strategies because webview iframe focus events are unreliable.
  function focusSqlEditor() {
    if (sqlEditor && !sqlEditor.hasFocus()) {
      sqlEditor.focus();
    }
  }

  window.addEventListener("focus", focusSqlEditor);

  document.addEventListener("visibilitychange", function () {
    if (!document.hidden) {
      // Small delay lets the webview fully settle before grabbing focus
      setTimeout(focusSqlEditor, 50);
    }
  });

  // Message handler from extension
  window.addEventListener("message", handleMessage);

  sqlEditor.on("change", () => {
    if (draftSaveTimer !== null) {
      clearTimeout(draftSaveTimer);
    }

    const currentContent = sqlEditor.getValue();
    const nowDirty = currentContent !== savedContent;
    if (nowDirty !== isDirty) {
      isDirty = nowDirty;
      vscode.postMessage({ command: "contentDirty", dirty: isDirty });
    }

    draftSaveTimer = setTimeout(() => {
      vscode.postMessage({
        command: "updateQueryDraft",
        query: currentContent,
      });
    }, 200);
  });
}

function getFetchSize() {
  const limitSelect = document.getElementById("limitSelect");
  const limitValue = limitSelect ? limitSelect.value : "";
  if (!limitValue) {
    return null;
  }
  const parsed = parseInt(limitValue, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function executeQuery() {
  // Get selected text, or current line if no selection
  const selection = sqlEditor.getSelection();
  const rawQuery = selection
    ? selection.trim()
    : sqlEditor.getLine(sqlEditor.getCursor().line).trim();

  if (!activeConnection) {
    setResultStatus("Connection is not initialized.", "error");
    return;
  }

  if (!rawQuery) {
    setResultStatus("Nothing to execute.", "error");
    return;
  }

  if (isQueryExecuting) {
    // User clicked stop — send cancel
    vscode.postMessage({ command: "cancelQuery" });
    return;
  }

  const query = rawQuery;
  const fetchSize = getFetchSize();

  // Switch button to stop mode
  const executeBtn = document.getElementById("runBtn");
  const executeBtnLabel = executeBtn.querySelector(".btn-label");
  const executeBtnIcon = executeBtn.querySelector(".icon");
  executeBtn.classList.remove("btn-primary");
  executeBtn.classList.add("btn-danger");
  executeBtn.title = "Stop Execution";
  executeBtnLabel.textContent = "Stop";
  executeBtnIcon.innerHTML = STOP_ICON;
  isQueryExecuting = true;
  lastExecutedQuery = rawQuery;
  const targetName = activeConnection?.name || "selected connection";
  startExecutionStatus(targetName);

  vscode.postMessage({
    command: "executeQuery",
    query,
    fetchSize,
  });
}

function exportResults(format) {
  if (currentResults.length === 0) {
    setResultStatus("No results to export.", "error");
    return;
  }

  vscode.postMessage({
    command: "exportResults",
    data: currentResults,
    format: format,
  });
}

function displayResults(data, elapsedSeconds, executedQuery) {
  const payload = window.SQL4ALLExecutorUtils.normalizeQueryPayload(data);
  currentResults = payload.rows;
  currentColumns = payload.columns || [];
  hasMoreRows = !!data.hasMore;
  isFetchingMore = false;
  renderResultsTable(payload, elapsedSeconds);
  renderResultsJson(payload.rows);
  resetRunButton("Run");
  isQueryExecuting = false;
  
  addExecutionHistoryEntry(executedQuery, payload.rowCount, null, elapsedSeconds);
  setActiveResultTab("table");
}

function handleMessage(event) {
  const message = event.data;

  switch (message.command) {
    case "focusEditor":
      setTimeout(focusSqlEditor, 50);
      return;
    case "initConnection":
      activeConnection = message.data;
      if (typeof activeConnection.lastQuery === "string") {
        sqlEditor.setValue(activeConnection.lastQuery);
        savedContent = activeConnection.lastQuery;
      }
      if (Array.isArray(activeConnection.recentFiles)) {
        recentFiles = activeConnection.recentFiles;
      }
      if (typeof activeConnection.linkedFilePath === "string") {
        linkedFilePath = activeConnection.linkedFilePath;
      }
      if (
        typeof activeConnection.queryPaneHeight === "number" &&
        Number.isFinite(activeConnection.queryPaneHeight) &&
        typeof applySavedPaneHeight === "function"
      ) {
        applySavedPaneHeight(activeConnection.queryPaneHeight);
        syncPaneLayoutToExtension();
      }
      setResultStatus(
        `Connected to ${activeConnection.name}. Ready to execute.`,
        "neutral",
      );
      break;
    case "queryResults":
      {
      const elapsedSeconds = stopExecutionStatus();
      const executedQuery = lastExecutedQuery || "";
      const category = getStatementCategoryFromQuery(executedQuery);
      
      // For DQL queries, display results normally (which handles tab switching)
      if (category === "dql") {
        displayResults(message.data, elapsedSeconds, executedQuery);
      } else {
        // For DDL/DML queries, log to history and switch to history tab
        addExecutionHistoryEntry(executedQuery, message.data?.rowCount || 0, null, elapsedSeconds);
        setActiveResultTab("history");
        
        const rowsAffected = message.data?.rowCount || 0;
        const resultMessage = rowsAffected === 0 
          ? "Executed successfully."
          : `Executed successfully. Rows affected: ${rowsAffected}.`;
        setResultStatus(
          `${resultMessage} (${window.SQL4ALLExecutorUtils.formatElapsedSeconds(elapsedSeconds || 0)}s)`,
          "success",
        );
        resetRunButton("Run");
        isQueryExecuting = false;
      }
      }
      break;
    case "fetchMoreResults":
      if (message.data) {
        appendMoreRows(message.data);
      } else {
        hasMoreRows = false;
        isFetchingMore = false;
      }
      break;
    case "queryError":
      {
      const elapsedSeconds = stopExecutionStatus();
      const executedQuery = lastExecutedQuery || "";
      
      currentResults = [];
      setResultMetrics(0, 0);
      setExportState(false);
      renderPlaceholder(message.error || "Execution failed.", "error");
      renderResultsJson({ error: message.error || "Execution failed." });
      
      // Log error to history and switch to history tab
      addExecutionHistoryEntry(executedQuery, 0, message.error || "Execution failed.", elapsedSeconds);
      setActiveResultTab("history");
      
      setResultStatus(
        `Execution failed. (${window.SQL4ALLExecutorUtils.formatElapsedSeconds(elapsedSeconds || 0)}s) — See History for details.`,
        "error",
      );
      resetRunButton("Run");
      isQueryExecuting = false;
      }
      break;
    case "fileOpened":
      if (typeof message.content === "string") {
        sqlEditor.setValue(message.content);
        savedContent = message.content;
        isDirty = false;
        vscode.postMessage({ command: "contentDirty", dirty: false });
      }
      if (typeof message.filePath === "string") {
        linkedFilePath = message.filePath;
        addRecentFile(message.filePath);
      }
      break;
    case "fileLinked":
      if (typeof message.filePath === "string") {
        linkedFilePath = message.filePath;
        addRecentFile(message.filePath);
        savedContent = sqlEditor.getValue();
        isDirty = false;
        vscode.postMessage({ command: "contentDirty", dirty: false });
      }
      break;
    case "formatSqlResult":
      sqlEditor.replaceSelection(message.formatted);
      break;
  }
}

function addRecentFile(filePath) {
  recentFiles = recentFiles.filter((f) => f !== filePath);
  recentFiles.unshift(filePath);
  if (recentFiles.length > MAX_RECENT_FILES) {
    recentFiles = recentFiles.slice(0, MAX_RECENT_FILES);
  }
}

function renderRecentFilesMenu() {
  const menu = document.getElementById("recentFilesMenu");
  menu.innerHTML = "";
  if (recentFiles.length === 0) {
    const empty = document.createElement("div");
    empty.className = "recent-files-empty";
    empty.textContent = "No recent files";
    menu.appendChild(empty);
    return;
  }
  recentFiles.forEach((filePath) => {
    const item = document.createElement("button");
    item.className = "recent-file-item";
    if (filePath === linkedFilePath) {
      item.classList.add("is-linked");
    }
    item.title = filePath;
    item.textContent = filePath;
    item.addEventListener("click", () => {
      menu.classList.add("hidden");
      vscode.postMessage({ command: "openRecentFile", filePath });
    });
    menu.appendChild(item);
  });
}

// Restore state on reload
const state = vscode.getState();
if (state) {
  if (
    typeof state.queryPaneHeight === "number" &&
    Number.isFinite(state.queryPaneHeight)
  ) {
    paneLayout.queryPaneHeight = state.queryPaneHeight;
  }
}

// Save state periodically
setInterval(() => {
  vscode.setState({
    query: sqlEditor ? sqlEditor.getValue() : "",
    queryPaneHeight: paneLayout.queryPaneHeight,
  });
}, 1000);

paneHeightSyncTimer = setInterval(() => {
  syncPaneLayoutToExtension();
}, 600);
