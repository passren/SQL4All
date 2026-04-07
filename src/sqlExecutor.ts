import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { ChildProcess } from "child_process";
import {
  DbConnection,
  BRAND_NAME,
  QUERY_DRAFTS_STORE_KEY,
  QUERY_LAYOUTS_STORE_KEY,
  RECENT_FILES_STORE_KEY,
  LINKED_FILES_STORE_KEY,
} from "./types";

export interface SqlExecutorServices {
  panelsByConnection: Map<string, vscode.WebviewPanel>;
  getDriverIcon(connection: DbConnection): vscode.Uri | undefined;
  revealConnection(connectionName: string): void;
  getConnection(name: string): DbConnection | undefined;
  onConnectionStateChanged(connectionName: string, connected: boolean): void;
  runPythonScript(
    context: vscode.ExtensionContext,
    scriptArgs: string[],
    onSpawn?: (child: ChildProcess) => void,
    envVars?: Record<string, string>,
  ): Promise<string>;
}

let services: SqlExecutorServices;
const runningProcesses = new Map<string, ChildProcess>();
const persistentProcesses = new Map<string, PersistentPythonProcess>();
const linkedFiles = new Map<string, string>();

class PersistentPythonProcess {
  private child: ChildProcess | null = null;
  private buffer = "";
  private pendingResolve: ((value: string) => void) | null = null;
  private pendingReject: ((reason: any) => void) | null = null;
  private ready = false;
  private readyPromise: Promise<void> | null = null;
  private dead = false;

  constructor(
    private readonly connectionName: string,
    private readonly context: vscode.ExtensionContext,
    private readonly connectionString: string,
    private readonly envVars?: Record<string, string>,
  ) {}

  async start(): Promise<void> {
    const pythonScript = path.join(
      this.context.extensionPath,
      "python",
      "query_executor.py",
    );

    const args = [
      pythonScript,
      `--connection-string=${this.connectionString}`,
      `--mode=server`,
    ];

    if (this.envVars && Object.keys(this.envVars).length > 0) {
      args.push(`--env-vars=${JSON.stringify(this.envVars)}`);
    }

    this.readyPromise = new Promise<void>((resolve, reject) => {
      services.runPythonScript(this.context, args, (child) => {
        this.child = child;

        child.stdout!.on("data", (data: Buffer) => {
          this.buffer += data.toString();
          this.processBuffer();
        });

        child.stderr!.on("data", (data: Buffer) => {
          const text = data.toString().trim();
          if (text) {
            // Store stderr for the pending request
            if (this.pendingReject) {
              this.pendingReject(new Error(text));
              this.pendingResolve = null;
              this.pendingReject = null;
            }
          }
        });

        child.on("close", () => {
          this.dead = true;
          if (this.pendingReject) {
            this.pendingReject(new Error("Python process exited unexpectedly."));
            this.pendingResolve = null;
            this.pendingReject = null;
          }
          if (!this.ready) {
            reject(new Error("Python process exited before becoming ready."));
          }
          persistentProcesses.delete(this.connectionName);
          services.onConnectionStateChanged(this.connectionName, false);
        });
      }, this.envVars).catch(() => {
        // runPythonScript rejection is handled via child close event
      });

      // Wait for the "ready" signal via processBuffer
      const originalProcessBuffer = this.processBuffer.bind(this);
      this.processBuffer = () => {
        const lines = this.buffer.split("\n");
        while (lines.length > 1) {
          const line = lines.shift()!;
          if (!line.trim()) { continue; }
          try {
            const msg = JSON.parse(line);
            if (msg.kind === "ready") {
              this.ready = true;
              this.processBuffer = originalProcessBuffer;
              this.buffer = lines.join("\n");
              resolve();
              return;
            }
          } catch {
            // ignore parse errors during startup
          }
        }
        this.buffer = lines.join("\n");
      };
    });

    return this.readyPromise;
  }

  private processBuffer(): void {
    const lines = this.buffer.split("\n");
    while (lines.length > 1) {
      const line = lines.shift()!;
      if (!line.trim()) { continue; }
      if (this.pendingResolve) {
        this.pendingResolve(line);
        this.pendingResolve = null;
        this.pendingReject = null;
      }
    }
    this.buffer = lines.join("\n");
  }

  async send(request: Record<string, any>): Promise<any> {
    if (this.dead || !this.child) {
      throw new Error("Python process is not running.");
    }

    if (this.readyPromise) {
      await this.readyPromise;
    }

    return new Promise<any>((resolve, reject) => {
      this.pendingResolve = (line: string) => {
        try {
          const parsed = JSON.parse(line);
          if (parsed.error) {
            reject(new Error(parsed.error));
          } else {
            resolve(parsed);
          }
        } catch (e) {
          reject(new Error(`Invalid JSON response: ${line}`));
        }
      };
      this.pendingReject = reject;

      const payload = JSON.stringify(request) + "\n";
      this.child!.stdin!.write(payload, "utf-8");
    });
  }

  cancelPending(): boolean {
    if (this.pendingReject) {
      this.pendingReject(new Error("Execution cancelled by user."));
      this.pendingResolve = null;
      this.pendingReject = null;
      return true;
    }
    return false;
  }

  getChild(): ChildProcess | null {
    return this.child;
  }

  isDead(): boolean {
    return this.dead;
  }

  kill(): void {
    if (this.child && !this.dead) {
      // Send shutdown command so Python can close connections cleanly
      try {
        this.child.stdin?.write(JSON.stringify({ action: "shutdown" }) + "\n", "utf-8");
      } catch { /* ignore write errors */ }
      // Force kill after a grace period
      const child = this.child;
      setTimeout(() => {
        try { child.kill(); } catch { /* ignore */ }
      }, 3000);
      this.dead = true;
    }
    persistentProcesses.delete(this.connectionName);
  }
}

export function initSqlExecutor(s: SqlExecutorServices): void {
  services = s;
}

export function createOrShowPanel(
  context: vscode.ExtensionContext,
  connectionName: string,
  connection: DbConnection,
): void {
  const existingPanel = services.panelsByConnection.get(connectionName);
  if (existingPanel) {
    existingPanel.reveal(vscode.ViewColumn.Active);
    return;
  }

  const panel = vscode.window.createWebviewPanel(
    "sql4allQuery",
    `${BRAND_NAME} - ${connectionName}`,
    vscode.ViewColumn.Active,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [
        vscode.Uri.file(path.join(context.extensionPath, "media")),
      ],
    },
  );

  services.panelsByConnection.set(connectionName, panel);

  const baseTitle = `${BRAND_NAME} - ${connectionName}`;
  let panelIsDirty = false;

  // Set tab icon based on database driver
  const iconUri = services.getDriverIcon(connection);
  if (iconUri) {
    panel.iconPath = iconUri;
  }

  panel.onDidChangeViewState(() => {
    if (panel.active) {
      services.revealConnection(connectionName);
    }
  });

  panel.webview.onDidReceiveMessage(
    (message: any) =>
      handleWebviewMessage(message, context, panel, connectionName, connection, (dirty: boolean) => {
        panelIsDirty = dirty;
        panel.title = dirty ? `● ${baseTitle}` : baseTitle;
      }),
    undefined,
  );

  panel.onDidDispose(async () => {
    services.panelsByConnection.delete(connectionName);
    const proc = persistentProcesses.get(connectionName);
    if (proc) {
      proc.kill();
    }
    services.onConnectionStateChanged(connectionName, false);
  }, undefined);

  updateWebviewContent(context, panel, connectionName, connection);

  // Eagerly start the persistent Python process and verify connectivity
  // so the connection icon turns colorful only after a successful ping.
  const freshConnection = services.getConnection(connectionName) ?? connection;
  if (freshConnection.connectionString) {
    getOrCreatePersistentProcess(connectionName, context, freshConnection)
      .then((proc) => proc.send({ action: "ping" }))
      .then(() => services.onConnectionStateChanged(connectionName, true))
      .catch(() => {
        // Connection failed — icon stays grey.
      });
  }
}

function updateWebviewContent(
  context: vscode.ExtensionContext,
  panel: vscode.WebviewPanel,
  connectionName: string,
  connection: DbConnection,
): void {
  const htmlPath = path.join(
    context.extensionPath,
    "media",
    "sql-executor.html",
  );

  try {
    let html = fs.readFileSync(htmlPath, "utf8");

    const cssPath = panel.webview.asWebviewUri(
      vscode.Uri.file(
        path.join(context.extensionPath, "media", "sql-executor.css"),
      ),
    );
    const jsPath = panel.webview.asWebviewUri(
      vscode.Uri.file(
        path.join(context.extensionPath, "media", "sql-executor.js"),
      ),
    );
    const sqlUtilsJsPath = panel.webview.asWebviewUri(
      vscode.Uri.file(
        path.join(context.extensionPath, "media", "sql-utils.js"),
      ),
    );
    const cmCssPath = panel.webview.asWebviewUri(
      vscode.Uri.file(
        path.join(context.extensionPath, "media", "codemirror.min.css"),
      ),
    );
    const cmJsPath = panel.webview.asWebviewUri(
      vscode.Uri.file(
        path.join(context.extensionPath, "media", "codemirror.min.js"),
      ),
    );
    const cmSqlPath = panel.webview.asWebviewUri(
      vscode.Uri.file(path.join(context.extensionPath, "media", "sql.min.js")),
    );

    html = html
      .replace("${cssPath}", cssPath.toString())
      .replace("${jsPath}", jsPath.toString())
      .replace("${sqlUtilsJsPath}", sqlUtilsJsPath.toString())
      .replace("${cmCssPath}", cmCssPath.toString())
      .replace("${cmJsPath}", cmJsPath.toString())
      .replace("${cmSqlPath}", cmSqlPath.toString());

    panel.webview.html = html;
  } catch (error) {
    vscode.window.showErrorMessage(`Failed to load webview: ${error}`);
  }
}

function getQueryDrafts(context: vscode.ExtensionContext): Record<string, string> {
  const current = context.globalState.get(QUERY_DRAFTS_STORE_KEY);
  return (current as Record<string, string> | undefined) ?? {};
}

function getQueryLayouts(context: vscode.ExtensionContext): Record<string, number> {
  const current = context.globalState.get(QUERY_LAYOUTS_STORE_KEY);
  return (current as Record<string, number> | undefined) ?? {};
}

function getRecentFiles(context: vscode.ExtensionContext, connectionName: string): string[] {
  const raw = context.globalState.get(RECENT_FILES_STORE_KEY);
  if (Array.isArray(raw) || !raw || typeof raw !== "object") {
    return [];
  }
  const all = raw as Record<string, string[]>;
  const files = all[connectionName];
  return Array.isArray(files) ? files : [];
}

async function addRecentFile(
  context: vscode.ExtensionContext,
  connectionName: string,
  filePath: string,
): Promise<void> {
  const raw = context.globalState.get(RECENT_FILES_STORE_KEY);
  const all: Record<string, string[]> = (raw && typeof raw === "object" && !Array.isArray(raw))
    ? raw as Record<string, string[]>
    : {};
  let files = Array.isArray(all[connectionName]) ? all[connectionName] : [];
  files = files.filter((f) => f !== filePath);
  files.unshift(filePath);
  if (files.length > 10) {
    files = files.slice(0, 10);
  }
  all[connectionName] = files;
  await context.globalState.update(RECENT_FILES_STORE_KEY, all);
}

function getLinkedFile(context: vscode.ExtensionContext, connectionName: string): string | null {
  const raw = context.globalState.get(LINKED_FILES_STORE_KEY);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const all = raw as Record<string, string>;
  return typeof all[connectionName] === "string" ? all[connectionName] : null;
}

async function saveLinkedFile(
  context: vscode.ExtensionContext,
  connectionName: string,
  filePath: string | null,
): Promise<void> {
  const raw = context.globalState.get(LINKED_FILES_STORE_KEY);
  const all: Record<string, string> = (raw && typeof raw === "object" && !Array.isArray(raw))
    ? raw as Record<string, string>
    : {};
  if (filePath) {
    all[connectionName] = filePath;
  } else {
    delete all[connectionName];
  }
  await context.globalState.update(LINKED_FILES_STORE_KEY, all);
}

async function saveQueryDraft(
  context: vscode.ExtensionContext,
  connectionName: string,
  query: string,
): Promise<void> {
  const drafts = getQueryDrafts(context);
  drafts[connectionName] = query;
  await context.globalState.update(QUERY_DRAFTS_STORE_KEY, drafts);
}

async function saveQueryPaneHeight(
  context: vscode.ExtensionContext,
  connectionName: string,
  queryPaneHeight: number,
): Promise<void> {
  const layouts = getQueryLayouts(context);
  layouts[connectionName] = queryPaneHeight;
  await context.globalState.update(QUERY_LAYOUTS_STORE_KEY, layouts);
}

export function killPersistentProcess(connectionName: string): void {
  const proc = persistentProcesses.get(connectionName);
  if (proc) {
    proc.kill();
  }
}

export async function removeConnectionState(
  context: vscode.ExtensionContext,
  connectionName: string,
): Promise<void> {
  const drafts = getQueryDrafts(context);
  if (Object.prototype.hasOwnProperty.call(drafts, connectionName)) {
    delete drafts[connectionName];
    await context.globalState.update(QUERY_DRAFTS_STORE_KEY, drafts);
  }

  const layouts = getQueryLayouts(context);
  if (Object.prototype.hasOwnProperty.call(layouts, connectionName)) {
    delete layouts[connectionName];
    await context.globalState.update(QUERY_LAYOUTS_STORE_KEY, layouts);
  }

  await saveLinkedFile(context, connectionName, null);

  const proc = persistentProcesses.get(connectionName);
  if (proc) {
    proc.kill();
  }
}

async function handleWebviewMessage(
  message: any,
  context: vscode.ExtensionContext,
  panel: vscode.WebviewPanel,
  connectionName: string,
  connection: DbConnection,
  onDirtyChanged: (dirty: boolean) => void,
): Promise<void> {
  switch (message.command) {
    case "contentDirty":
      onDirtyChanged(!!message.dirty);
      break;
    case "ready":
      const drafts = getQueryDrafts(context);
      const layouts = getQueryLayouts(context);
      const recentFiles = getRecentFiles(context, connectionName);
      const savedLinkedFile = getLinkedFile(context, connectionName);
      if (savedLinkedFile) {
        linkedFiles.set(connectionName, savedLinkedFile);
      }
      panel.webview.postMessage({
        command: "initConnection",
        data: {
          name: connectionName,
          host: connection.host,
          port: connection.port,
          database: connection.database,
          lastQuery: drafts[connectionName] || "",
          queryPaneHeight: layouts[connectionName],
          recentFiles,
          linkedFilePath: savedLinkedFile || null,
        },
      });
      break;
    case "updateQueryDraft":
      await saveQueryDraft(
        context,
        connectionName,
        typeof message.query === "string" ? message.query : "",
      );
      break;
    case "executeQuery":
      await executeQuery(
        message.query,
        message.paramsRaw,
        connectionName,
        connection,
        context,
        panel,
      );
      break;
    case "updatePaneLayout":
      if (
        typeof message.queryPaneHeight === "number" &&
        Number.isFinite(message.queryPaneHeight)
      ) {
        await saveQueryPaneHeight(
          context,
          connectionName,
          message.queryPaneHeight,
        );
      }
      break;
    case "cancelQuery":
      cancelRunningQuery(connectionName, panel);
      break;
    case "exportResults":
      exportResults(message.data, message.format);
      break;
    case "openFile":
      await handleOpenFile(connectionName, panel, context);
      break;
    case "openRecentFile":
      await handleOpenRecentFile(connectionName, message.filePath, panel, context);
      break;
    case "saveFile":
      await handleSaveFile(connectionName, message.content, panel, context);
      break;
    case "saveFileAs":
      await handleSaveFileAs(connectionName, message.content, panel, context);
      break;
    case "formatSql":
      handleFormatSql(message.sql, panel);
      break;
  }
}

function cancelRunningQuery(
  connectionName: string,
  panel: vscode.WebviewPanel,
): void {
  const proc = persistentProcesses.get(connectionName);
  if (proc && proc.cancelPending()) {
    // Pending request was rejected; the process stays alive for future queries.
    // The Python side will finish the query and send a response, which will be
    // silently discarded since there is no pending resolve/reject.
    return;
  }
  // Fallback for non-persistent (single-shot) processes
  const child = runningProcesses.get(connectionName);
  if (child) {
    child.kill();
    runningProcesses.delete(connectionName);
  }
  panel.webview.postMessage({
    command: "queryError",
    error: "Execution cancelled by user.",
  });
}

async function executeQuery(
  queryText: string,
  paramsRaw: string | undefined,
  connectionName: string,
  connection: DbConnection,
  context: vscode.ExtensionContext,
  panel: vscode.WebviewPanel,
): Promise<void> {
  try {
    if (!queryText || !queryText.trim()) {
      panel.webview.postMessage({
        command: "queryError",
        error: "Nothing to execute.",
      });
      return;
    }

    // Re-read connection from storage to pick up any edits (e.g. envVars)
    const freshConnection = services.getConnection(connectionName) ?? connection;

    const connectionString = freshConnection.connectionString || "";
    if (!connectionString) {
      panel.webview.postMessage({
        command: "queryError",
        error: "Connection string is not configured. Edit and re-save the connection.",
      });
      return;
    }

    const proc = await getOrCreatePersistentProcess(
      connectionName, context, freshConnection,
    );

    // Track process for cancellation
    const child = proc.getChild();
    if (child) {
      runningProcesses.set(connectionName, child);
    }

    const request: Record<string, string> = {
      action: "query",
      query: queryText,
    };
    if (paramsRaw && paramsRaw.trim()) {
      request.params = paramsRaw;
    }

    const results = await proc.send(request);

    runningProcesses.delete(connectionName);
    services.onConnectionStateChanged(connectionName, true);

    saveQueryToHistory(context, connectionName, queryText, results);

    panel.webview.postMessage({
      command: "queryResults",
      data: results,
    });
  } catch (error: any) {
    runningProcesses.delete(connectionName);
    if (error?.killed) {
      return;
    }
    let errorText = error.message || "Execution failed.";
    try {
      const parsed = JSON.parse(errorText);
      if (parsed && typeof parsed.error === "string") {
        errorText = parsed.error;
      }
    } catch {
      // not JSON, use as-is
    }
    panel.webview.postMessage({
      command: "queryError",
      error: errorText,
    });
  }
}

async function getOrCreatePersistentProcess(
  connectionName: string,
  context: vscode.ExtensionContext,
  connection: DbConnection,
): Promise<PersistentPythonProcess> {
  const existing = persistentProcesses.get(connectionName);
  if (existing && !existing.isDead()) {
    return existing;
  }

  const proc = new PersistentPythonProcess(
    connectionName,
    context,
    connection.connectionString || "",
    connection.envVars,
  );
  persistentProcesses.set(connectionName, proc);
  await proc.start();
  return proc;
}

export function isConnectionActive(connectionName: string): boolean {
  const proc = persistentProcesses.get(connectionName);
  return !!proc && !proc.isDead();
}

function saveQueryToHistory(
  context: vscode.ExtensionContext,
  connectionName: string,
  queryText: string,
  results: any,
): void {
  const history = context.globalState.get("mongodb.queryHistory", []) as any[];
  const resultCount = Array.isArray(results)
    ? results.length
    : Number.isInteger(results?.rowCount)
      ? results.rowCount
      : Array.isArray(results?.rows)
        ? results.rows.length
        : results
          ? 1
          : 0;
  history.push({
    query: queryText,
    connection: connectionName,
    timestamp: new Date().toISOString(),
    resultCount,
  });

  if (history.length > 50) {
    history.shift();
  }

  context.globalState.update("mongodb.queryHistory", history);
}

function exportResults(results: any[], format: string): void {
  vscode.window
    .showOpenDialog({
      canSelectFolders: true,
      canSelectFiles: false,
      canSelectMany: false,
      title: "Select folder to export results",
    })
    .then((uris: vscode.Uri[] | undefined) => {
      if (!uris || uris.length === 0) {
        return;
      }

      const folderPath = uris[0].fsPath;
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      let content = "";
      let filename = "";

      if (format === "csv") {
        filename = `results_${timestamp}.csv`;
        content = convertToCSV(results);
      } else if (format === "json") {
        filename = `results_${timestamp}.json`;
        content = JSON.stringify(results, null, 2);
      }

      const filePath = path.join(folderPath, filename);
      fs.writeFileSync(filePath, content);
      vscode.window.showInformationMessage(`Results exported to ${filePath}`);
    });
}

function convertToCSV(data: any[]): string {
  if (data.length === 0) {
    return "";
  }

  const headers = Object.keys(data[0]);
  const csvHeaders = headers.map((h) => escapeCsvField(h)).join(",");
  const csvRows = data.map((row) => {
    return headers
      .map((header) => {
        const value = row[header];
        if (value === null || value === undefined) {
          return "";
        }
        if (typeof value === "object") {
          return escapeCsvField(JSON.stringify(value));
        }
        return escapeCsvField(String(value));
      })
      .join(",");
  });

  return [csvHeaders, ...csvRows].join("\n");
}

function escapeCsvField(value: string): string {
  if (value.includes(",") || value.includes('"') || value.includes("\n")) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

async function handleOpenFile(
  connectionName: string,
  panel: vscode.WebviewPanel,
  context: vscode.ExtensionContext,
): Promise<void> {
  const uris = await vscode.window.showOpenDialog({
    canSelectFiles: true,
    canSelectFolders: false,
    canSelectMany: false,
    filters: { "SQL Files": ["sql"], "Text Files": ["txt"], "All Files": ["*"] },
    title: "Open SQL File",
  });

  if (!uris || uris.length === 0) {
    return;
  }

  const filePath = uris[0].fsPath;
  const content = fs.readFileSync(filePath, "utf-8");
  linkedFiles.set(connectionName, filePath);
  await saveLinkedFile(context, connectionName, filePath);
  await addRecentFile(context, connectionName, filePath);
  panel.webview.postMessage({ command: "fileOpened", content, filePath });
}

async function handleOpenRecentFile(
  connectionName: string,
  filePath: string,
  panel: vscode.WebviewPanel,
  context: vscode.ExtensionContext,
): Promise<void> {
  if (!fs.existsSync(filePath)) {
    vscode.window.showWarningMessage(`File not found: ${filePath}`);
    return;
  }
  const content = fs.readFileSync(filePath, "utf-8");
  linkedFiles.set(connectionName, filePath);
  await saveLinkedFile(context, connectionName, filePath);
  await addRecentFile(context, connectionName, filePath);
  panel.webview.postMessage({ command: "fileOpened", content, filePath });
}

async function handleSaveFile(
  connectionName: string,
  content: string,
  panel: vscode.WebviewPanel,
  context: vscode.ExtensionContext,
): Promise<void> {
  const linked = linkedFiles.get(connectionName);

  if (linked) {
    fs.writeFileSync(linked, content, "utf-8");
    await addRecentFile(context, connectionName, linked);
    panel.webview.postMessage({ command: "fileLinked", filePath: linked });
    vscode.window.showInformationMessage(`Saved to ${linked}`);
  } else {
    const uri = await vscode.window.showSaveDialog({
      filters: { "SQL Files": ["sql"], "Text Files": ["txt"], "All Files": ["*"] },
      title: "Save SQL File",
    });

    if (!uri) {
      return;
    }

    const filePath = uri.fsPath;
    fs.writeFileSync(filePath, content, "utf-8");
    linkedFiles.set(connectionName, filePath);
    await saveLinkedFile(context, connectionName, filePath);
    await addRecentFile(context, connectionName, filePath);
    panel.webview.postMessage({ command: "fileLinked", filePath });
    vscode.window.showInformationMessage(`Saved to ${filePath}`);
  }
}

async function handleSaveFileAs(
  connectionName: string,
  content: string,
  panel: vscode.WebviewPanel,
  context: vscode.ExtensionContext,
): Promise<void> {
  const uri = await vscode.window.showSaveDialog({
    filters: { "SQL Files": ["sql"], "Text Files": ["txt"], "All Files": ["*"] },
    title: "Save SQL File As",
  });

  if (!uri) {
    return;
  }

  const filePath = uri.fsPath;
  fs.writeFileSync(filePath, content, "utf-8");
  linkedFiles.set(connectionName, filePath);
  await saveLinkedFile(context, connectionName, filePath);
  await addRecentFile(context, connectionName, filePath);
  panel.webview.postMessage({ command: "fileLinked", filePath });
  vscode.window.showInformationMessage(`Saved to ${filePath}`);
}

function handleFormatSql(
  sql: string,
  panel: vscode.WebviewPanel,
): void {
  const formatted = formatSqlBasic(sql);
  panel.webview.postMessage({
    command: "formatSqlResult",
    formatted,
  });
}

function formatSqlBasic(sql: string): string {
  const keywords = [
    "SELECT", "FROM", "WHERE", "AND", "OR", "ORDER BY", "GROUP BY",
    "HAVING", "LIMIT", "OFFSET", "INSERT INTO", "VALUES", "UPDATE",
    "SET", "DELETE FROM", "CREATE TABLE", "ALTER TABLE", "DROP TABLE",
    "JOIN", "INNER JOIN", "LEFT JOIN", "RIGHT JOIN", "FULL JOIN",
    "CROSS JOIN", "ON", "UNION", "UNION ALL", "EXCEPT", "INTERSECT",
    "CASE", "WHEN", "THEN", "ELSE", "END", "AS", "IN", "NOT IN",
    "EXISTS", "NOT EXISTS", "BETWEEN", "LIKE", "IS NULL", "IS NOT NULL",
  ];

  let result = sql.trim();
  // Normalize whitespace
  result = result.replace(/\s+/g, " ");

  // Add newlines before major keywords
  const majorKeywords = [
    "SELECT", "FROM", "WHERE", "ORDER BY", "GROUP BY", "HAVING",
    "LIMIT", "OFFSET", "INSERT INTO", "VALUES", "UPDATE", "SET",
    "DELETE FROM", "JOIN", "INNER JOIN", "LEFT JOIN", "RIGHT JOIN",
    "FULL JOIN", "CROSS JOIN", "ON", "UNION", "UNION ALL", "EXCEPT",
    "INTERSECT",
  ];

  for (const kw of majorKeywords) {
    const regex = new RegExp(`\\b(${kw})\\b`, "gi");
    result = result.replace(regex, "\n$1");
  }

  // Indent sub-keywords
  const indentKeywords = ["AND", "OR"];
  for (const kw of indentKeywords) {
    const regex = new RegExp(`\\n?(\\b${kw}\\b)`, "gi");
    result = result.replace(regex, "\n  $1");
  }

  return result.trim();
}
