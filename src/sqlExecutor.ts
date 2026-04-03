import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { ChildProcess } from "child_process";
import {
  DbConnection,
  BRAND_NAME,
  QUERY_DRAFTS_STORE_KEY,
  QUERY_LAYOUTS_STORE_KEY,
} from "./types";

export interface SqlExecutorServices {
  panelsByConnection: Map<string, vscode.WebviewPanel>;
  getDriverIcon(connection: DbConnection): vscode.Uri | undefined;
  revealConnection(connectionName: string): void;
  runPythonScript(
    context: vscode.ExtensionContext,
    scriptArgs: string[],
    onSpawn?: (child: ChildProcess) => void,
  ): Promise<string>;
}

let services: SqlExecutorServices;
const runningProcesses = new Map<string, ChildProcess>();

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
      handleWebviewMessage(message, context, panel, connectionName, connection),
    undefined,
  );

  panel.onDidDispose(() => {
    services.panelsByConnection.delete(connectionName);
  }, undefined);

  updateWebviewContent(context, panel, connectionName, connection);
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
}

async function handleWebviewMessage(
  message: any,
  context: vscode.ExtensionContext,
  panel: vscode.WebviewPanel,
  connectionName: string,
  connection: DbConnection,
): Promise<void> {
  switch (message.command) {
    case "ready":
      const drafts = getQueryDrafts(context);
      const layouts = getQueryLayouts(context);
      panel.webview.postMessage({
        command: "initConnection",
        data: {
          name: connectionName,
          host: connection.host,
          port: connection.port,
          database: connection.database,
          lastQuery: drafts[connectionName] || "",
          queryPaneHeight: layouts[connectionName],
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
      await saveQueryDraft(
        context,
        connectionName,
        typeof message.query === "string" ? message.query : "",
      );
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
  }
}

function cancelRunningQuery(
  connectionName: string,
  panel: vscode.WebviewPanel,
): void {
  const child = runningProcesses.get(connectionName);
  if (child) {
    child.kill();
    runningProcesses.delete(connectionName);
    panel.webview.postMessage({
      command: "queryError",
      error: "Query cancelled by user.",
    });
  }
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
        error: "Query is empty.",
      });
      return;
    }

    const pythonScript = path.join(
      context.extensionPath,
      "python",
      "query_executor.py",
    );

    const connectionString = connection.connectionString || "";
    if (!connectionString) {
      panel.webview.postMessage({
        command: "queryError",
        error: "Connection string is not configured. Edit and re-save the connection.",
      });
      return;
    }

    const args = [
      pythonScript,
      `--connection-string=${connectionString}`,
      `--query=${queryText}`,
    ];

    if (paramsRaw && paramsRaw.trim()) {
      args.push(`--params=${paramsRaw}`);
    }

    const result = await services.runPythonScript(context, args, (child) => {
      runningProcesses.set(connectionName, child);
    });

    runningProcesses.delete(connectionName);

    const results = JSON.parse(result);

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
    vscode.window.showErrorMessage(`Query execution failed: ${error.message}`);
    panel.webview.postMessage({
      command: "queryError",
      error: error.message,
    });
  }
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
  const csvHeaders = headers.join(",");
  const csvRows = data.map((row) => {
    return headers
      .map((header) => {
        const value = row[header];
        if (typeof value === "string" && value.includes(",")) {
          return `"${value.replace(/"/g, '""')}"`;
        }
        return value === null || value === undefined ? "" : value;
      })
      .join(",");
  });

  return [csvHeaders, ...csvRows].join("\n");
}
