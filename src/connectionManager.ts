import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { DbConnection, normalizeConnection } from "./types";

export interface ConnectionManagerServices {
  getConnection(name: string): DbConnection | undefined;
  upsertConnection(name: string, connection: DbConnection): Promise<void>;
  deleteConnection(name: string): Promise<void>;
  removeConnectionState(
    context: vscode.ExtensionContext,
    connectionName: string,
  ): Promise<void>;
  panelsByConnection: Map<string, vscode.WebviewPanel>;
  revealInTree(connectionName: string): void;
  ensurePythonEnvironment(
    context: vscode.ExtensionContext,
  ): Promise<string>;
  ensureDriverInstalled(
    context: vscode.ExtensionContext,
    driverName: string,
    progressCallback?: (message: string) => void,
    extras?: string[],
  ): Promise<void>;
  runProcess(command: string, args: string[]): Promise<string>;
  fetchDriverVersion(
    context: vscode.ExtensionContext,
    pipPackage: string,
  ): Promise<string | undefined>;
  markDriverInstalled(
    context: vscode.ExtensionContext,
    pipPackage: string,
    version?: string,
  ): Promise<void>;
  getInstalledDrivers(
    context: vscode.ExtensionContext,
  ): Record<string, string | boolean>;
}

let connectionEditorPanel: vscode.WebviewPanel | undefined;

export async function addConnection(
  context: vscode.ExtensionContext,
  services: ConnectionManagerServices,
): Promise<void> {
  await openConnectionEditor(context, services);
}

export async function openConnectionEditor(
  context: vscode.ExtensionContext,
  services: ConnectionManagerServices,
  editingName?: string,
  editingConnection?: DbConnection,
): Promise<void> {
  if (connectionEditorPanel) {
    connectionEditorPanel.dispose();
  }

  connectionEditorPanel = vscode.window.createWebviewPanel(
    "sql4allConnectionEditor",
    editingName ? `Edit Connection - ${editingName}` : "New Connection",
    vscode.ViewColumn.Active,
    {
      enableScripts: true,
      retainContextWhenHidden: false,
      localResourceRoots: [
        vscode.Uri.file(path.join(context.extensionPath, "media")),
      ],
    },
  );

  const initial: { name: string; connection: DbConnection } = {
    name: editingName ?? "",
    connection: editingConnection
      ? normalizeConnection(editingConnection)
      : {
        host: "localhost",
        port: 0,
        database: "",
        username: "",
        password: "",
        driver: "",
        additionalParameters: {},
      },
  };

  const mediaPath = path.join(context.extensionPath, "media");
  const installedDrivers = services.getInstalledDrivers(context);

  connectionEditorPanel.webview.html = getConnectionEditorHtml(
    mediaPath,
    connectionEditorPanel.webview,
    initial,
    Boolean(editingName),
    installedDrivers,
  );

  if (editingName) {
    const editorPanelRef = connectionEditorPanel;
    editorPanelRef.onDidChangeViewState(() => {
      if (editorPanelRef.active && editingName) {
        services.revealInTree(editingName);
      }
    });
    services.revealInTree(editingName);
  }

  connectionEditorPanel.webview.onDidReceiveMessage(async (message: any) => {
    if (!connectionEditorPanel) {
      return;
    }

    if (message.command === "cancel") {
      connectionEditorPanel.dispose();
      return;
    }

    if (message.command === "reloadDriver") {
      const driverName = (message.driver || "").trim();
      if (!driverName) {
        return;
      }
      try {
        connectionEditorPanel.webview.postMessage({
          command: "setupProgress",
          message: `Upgrading driver: ${driverName}...`,
          inProgress: true,
        });

        const venvPython = await services.ensurePythonEnvironment(context);
        await services.runProcess(venvPython, [
          "-m",
          "pip",
          "install",
          "--upgrade",
          "--quiet",
          driverName,
        ]);
        const version = await services.fetchDriverVersion(context, driverName);
        await services.markDriverInstalled(context, driverName, version);

        connectionEditorPanel.webview.postMessage({
          command: "setupProgress",
          message: "",
          inProgress: false,
        });
        connectionEditorPanel.webview.postMessage({
          command: "driverStatus",
          installed: true,
          version: version || null,
        });
        vscode.window.showInformationMessage(
          `Driver ${driverName} upgraded successfully.`,
        );
      } catch (err: any) {
        connectionEditorPanel.webview.postMessage({
          command: "setupProgress",
          message: "",
          inProgress: false,
        });
        connectionEditorPanel.webview.postMessage({
          command: "saveError",
          error: `Driver upgrade failed: ${err?.message || String(err)}`,
        });
      }
      return;
    }

    if (message.command !== "save") {
      return;
    }

    const payload = message.data as {
      name: string;
      host: string;
      port?: number;
      database: string;
      username: string;
      password: string;
      driver?: string;
      dialect?: string;
      connectionString?: string;
      databaseType?: string;
      additionalParameters?: Record<string, string>;
      envVars?: Record<string, string>;
    };

    const name = payload.name.trim();
    const host = payload.host.trim();
    const database = payload.database.trim();
    const hasPort = typeof payload.port === "number" && Number.isInteger(payload.port);
    const port = hasPort ? payload.port : undefined;
    const invalidPort =
      hasPort && (port === undefined || port <= 0 || port > 65535);

    if (!name || !host || invalidPort || name.length > 20) {
      connectionEditorPanel.webview.postMessage({
        command: "saveError",
        error: !name || !host
          ? "Please provide a valid name and host."
          : name.length > 20
            ? "Connection name must be 20 characters or less."
            : "Port must be between 1 and 65535.",
      });
      return;
    }

    const existingConnection = services.getConnection(name);
    const isDuplicateName =
      Boolean(existingConnection) && (!editingName || editingName !== name);

    if (isDuplicateName) {
      connectionEditorPanel.webview.postMessage({
        command: "saveError",
        error: `Connection "${name}" already exists.`,
      });
      return;
    }

    if (editingName && editingName !== name) {
      await services.deleteConnection(editingName);
      await services.removeConnectionState(context, editingName);
      const existingPanel = services.panelsByConnection.get(editingName);
      if (existingPanel) {
        existingPanel.dispose();
      }
    }

    const driverValue = payload.driver?.trim() || "";

    // Ensure Python venv + driver are installed before saving
    if (driverValue) {
      try {
        // Resolve extras from driver config
        const dbType = payload.databaseType?.trim() || "";
        let driverExtras: string[] | undefined;
        if (dbType) {
          try {
            const driverConfigPath = path.join(context.extensionPath, "media", "driver_config.json");
            const raw = fs.readFileSync(driverConfigPath, "utf8");
            const parsed = JSON.parse(raw);
            if (parsed?.databases?.[dbType] && Array.isArray(parsed.databases[dbType].extras)) {
              driverExtras = parsed.databases[dbType].extras;
            }
          } catch { /* ignore */ }
        }

        await services.ensureDriverInstalled(
          context,
          driverValue,
          (msg: string) => {
            if (connectionEditorPanel) {
              connectionEditorPanel.webview.postMessage({
                command: "setupProgress",
                message: msg,
                inProgress: true,
              });
            }
          },
          driverExtras,
        );

        if (connectionEditorPanel) {
          connectionEditorPanel.webview.postMessage({
            command: "setupProgress",
            message: "",
            inProgress: false,
          });
        }
      } catch (setupError: any) {
        if (connectionEditorPanel) {
          connectionEditorPanel.webview.postMessage({
            command: "setupProgress",
            message: "",
            inProgress: false,
          });
          connectionEditorPanel.webview.postMessage({
            command: "saveError",
            error: `Python setup failed: ${setupError?.message || String(setupError)}`,
          });
        }
        return;
      }
    }

    await services.upsertConnection(name, {
      host,
      port,
      database,
      username: payload.username?.trim() ?? "",
      password: payload.password ?? "",
      driver: driverValue,
      dialect: payload.dialect?.trim() || undefined,
      connectionString: payload.connectionString?.trim() || undefined,
      databaseType: payload.databaseType?.trim() || undefined,
      additionalParameters: payload.additionalParameters ?? {},
      envVars: payload.envVars ?? {},
    });

    vscode.window.showInformationMessage(
      editingName
        ? `Connection "${name}" updated.`
        : `Connection "${name}" created.`,
    );

    connectionEditorPanel.dispose();
  }, undefined);

  connectionEditorPanel.onDidDispose(() => {
    connectionEditorPanel = undefined;
  });
}

function getConnectionEditorHtml(
  mediaPath: string,
  webview: vscode.Webview,
  initial: { name: string; connection: DbConnection },
  isEdit: boolean,
  installedDrivers: Record<string, string | boolean>,
): string {
  const htmlPath = path.join(mediaPath, "connection-editor.html");
  const cssPath = webview.asWebviewUri(
    vscode.Uri.file(path.join(mediaPath, "connection-editor.css")),
  );
  const jsPath = webview.asWebviewUri(
    vscode.Uri.file(path.join(mediaPath, "connection-editor.js")),
  );
  const initialPayload: {
    name: string;
    connection: DbConnection;
    driverConfig?: {
      databases: Record<
        string,
        { icon?: string; driver: string; default_port?: number; uri_template: string }
      >;
    };
    installedDrivers?: Record<string, string | boolean>;
  } = {
    ...initial,
  };
  const defaultDriverConfig = {
    databases: {} as Record<string, { icon?: string; driver: string; default_port?: number; uri_template: string }>,
  };

  let driverConfig = defaultDriverConfig;
  try {
    const driverConfigPath = path.join(mediaPath, "driver_config.json");
    const raw = fs.readFileSync(driverConfigPath, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && parsed.databases) {
      driverConfig = parsed;
    }
  } catch {
    // Keep default config when file is missing or invalid.
  }

  // Inline icon SVG files as base64 data URIs so they load without CSP issues.
  for (const dbConfig of Object.values(
    driverConfig.databases as Record<string, { icon?: string }>,
  )) {
    if (dbConfig.icon) {
      try {
        const iconPath = path.join(mediaPath, dbConfig.icon);
        const svgContent = fs.readFileSync(iconPath);
        dbConfig.icon = `data:image/svg+xml;base64,${svgContent.toString("base64")}`;
      } catch {
        dbConfig.icon = undefined;
      }
    }
  }

  initialPayload.driverConfig = driverConfig;
  initialPayload.installedDrivers = installedDrivers;
  const initialJson = JSON.stringify(initialPayload).replace(/</g, "\\u003c");

  let html = fs.readFileSync(htmlPath, "utf8");
  html = html
    .replace("${title}", isEdit ? "Edit Connection" : "New Connection")
    .replace("${heading}", isEdit ? "Update Connection" : "Create Connection")
    .replace("${saveLabel}", isEdit ? "Update" : "Create")
    .replace("${cssPath}", cssPath.toString())
    .replace("${jsPath}", jsPath.toString())
    .replace("${initialJson}", initialJson);

  return html;
}
