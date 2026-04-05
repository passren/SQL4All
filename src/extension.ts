import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { spawn, ChildProcess } from "child_process";
import {
  DbConnection,
  ConnectionStore,
  normalizeConnection,
  formatConnectionSummary,
  formatConnectionTooltip,
  EXTENSION_NAMESPACE,
  BRAND_NAME,
  CONNECTION_VIEW_ID,
  CONNECTION_ITEM_CONTEXT,
  CONNECTION_STORE_KEY,
  PYTHON_SETTING_KEY,
  READY_MARKER_FILE,
  INSTALLED_DRIVERS_STORE_KEY,
  NEW_CONNECTION,
  TABLE_ITEM_CONTEXT,
} from "./types";
import {
  ConnectionManagerServices,
  addConnection,
  openConnectionEditor,
} from "./connectionManager";
import {
  initSqlExecutor,
  createOrShowPanel,
  removeConnectionState,
} from "./sqlExecutor";

declare const process: any;

const panelsByConnection = new Map<string, vscode.WebviewPanel>();
let connectionTreeView: vscode.TreeView<TreeItem> | undefined;
let connectionTreeProviderRef: ConnectionTreeProvider | undefined;
let pythonEnvPath: string | undefined;
let pythonSetupPromise: Promise<string> | undefined;
let pythonStatusBar: vscode.StatusBarItem | undefined;

type TreeItem = ConnectionItem | TableItem;

class ConnectionItem extends vscode.TreeItem {
  constructor(
    public readonly connectionName: string,
    public readonly connection: DbConnection,
    iconPath?: vscode.ThemeIcon | vscode.Uri,
    summary?: string,
  ) {
    super(
      connectionName,
      vscode.TreeItemCollapsibleState.Collapsed,
    );
    const resolvedSummary = summary ?? formatConnectionSummary(connection);
    this.description = resolvedSummary;
    this.tooltip = formatConnectionTooltip(connectionName, resolvedSummary, connection);
    this.contextValue = CONNECTION_ITEM_CONTEXT;
    this.iconPath = iconPath ?? new vscode.ThemeIcon("database");
  }
}

class TableItem extends vscode.TreeItem {
  constructor(
    public readonly tableName: string,
    public readonly parentConnectionName: string,
  ) {
    super(tableName, vscode.TreeItemCollapsibleState.None);
    this.contextValue = TABLE_ITEM_CONTEXT;
    this.iconPath = new vscode.ThemeIcon("symbol-field");
  }
}

class ConnectionTreeProvider implements vscode.TreeDataProvider<TreeItem> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<
    TreeItem | undefined | null | void
  >();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private readonly driverIconsByDriver = new Map<string, vscode.Uri>();
  private cachedItems: ConnectionItem[] = [];
  private tableCache = new Map<string, TableItem[]>();

  constructor(private readonly context: vscode.ExtensionContext) {
    this.loadDriverIconMap();
  }

  refresh(): void {
    this.cachedItems = [];
    this.tableCache.clear();
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: TreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: TreeItem): Promise<TreeItem[]> {
    if (!element) {
      if (this.cachedItems.length > 0) {
        return this.cachedItems;
      }

      const connections = this.getConnections();
      this.cachedItems = Object.keys(connections)
        .sort((a, b) => a.localeCompare(b))
        .map((name) => {
          const connection = connections[name];
          return new ConnectionItem(
            name,
            connection,
            this.resolveConnectionIcon(connection),
            this.resolveConnectionSummary(connection),
          );
        });
      return this.cachedItems;
    }

    if (element instanceof ConnectionItem) {
      return this.fetchTableItems(element);
    }

    return [];
  }

  getParent(element: TreeItem): vscode.ProviderResult<TreeItem> {
    if (element instanceof TableItem) {
      return this.cachedItems.find(
        (item) => item.connectionName === element.parentConnectionName,
      );
    }
    return undefined;
  }

  findItem(connectionName: string): ConnectionItem | undefined {
    return this.cachedItems.find((item) => item.connectionName === connectionName);
  }

  hasTablesCached(connectionName: string): boolean {
    return this.tableCache.has(connectionName);
  }

  refreshConnectionTables(connectionName: string): void {
    this.tableCache.delete(connectionName);
    const target = this.findItem(connectionName);
    this._onDidChangeTreeData.fire(target);
  }

  private loadDriverIconMap(): void {
    const mediaPath = path.join(this.context.extensionPath, "media");
    const driverConfigPath = path.join(mediaPath, "driver_config.json");

    try {
      const raw = fs.readFileSync(driverConfigPath, "utf8");
      const parsed = JSON.parse(raw) as {
        databases?: Record<
          string,
          { driver?: string; icon?: string; uri_template?: string }
        >;
      };

      for (const dbConfig of Object.values(parsed.databases ?? {})) {
        const driver = String(dbConfig.driver || "").trim().toLowerCase();
        const iconRelativePath = String(dbConfig.icon || "").trim();
        if (!driver) {
          continue;
        }

        if (!iconRelativePath) {
          continue;
        }

        const iconAbsolutePath = path.join(mediaPath, iconRelativePath);
        if (!fs.existsSync(iconAbsolutePath)) {
          continue;
        }

        this.driverIconsByDriver.set(driver, vscode.Uri.file(iconAbsolutePath));
      }
    } catch {
      // Keep default theme icon when driver config cannot be loaded.
    }
  }

  private resolveConnectionIcon(
    connection: DbConnection,
  ): vscode.ThemeIcon | vscode.Uri {
    const driver = String(connection.driver || "").trim().toLowerCase();
    if (!driver) {
      return new vscode.ThemeIcon("database");
    }

    return this.driverIconsByDriver.get(driver) ?? new vscode.ThemeIcon("database");
  }

  getDriverIcon(connection: DbConnection): vscode.Uri | undefined {
    const driver = String(connection.driver || "").trim().toLowerCase();
    if (!driver) {
      return undefined;
    }

    return this.driverIconsByDriver.get(driver);
  }

  private resolveConnectionSummary(connection: DbConnection): string {
    return formatConnectionSummary(connection);
  }

  private async fetchTableItems(parent: ConnectionItem): Promise<TableItem[]> {
    const cached = this.tableCache.get(parent.connectionName);
    if (cached) {
      return cached;
    }

    try {
      const pythonScript = path.join(this.context.extensionPath, "python", "query_executor.py");
      const args = [
        pythonScript,
        `--connection-string=${parent.connection.connectionString || ""}`,
        `--action=list-tables`,
      ];

      const result = await runPythonScript(this.context, args);
      const parsed = JSON.parse(result);

      const rows: any[] = Array.isArray(parsed) ? parsed : parsed?.rows ?? parsed?.data ?? [];
      const tableNames: string[] = rows
        .map((row: any) => {
          if (typeof row === "string") {
            return row;
          }
          if (typeof row === "object" && row !== null) {
            const vals = Object.values(row);
            return vals.length > 0 ? String(vals[0]) : "";
          }
          return String(row);
        })
        .filter((name: string) => name.length > 0);

      const items = tableNames.map(
        (name) => new TableItem(name, parent.connectionName),
      );
      this.tableCache.set(parent.connectionName, items);
      return items;
    } catch (err: any) {
      vscode.window.showErrorMessage(
        `Failed to list tables for "${parent.connectionName}": ${err?.message || String(err)}`,
      );
      return [];
    }
  }

  getConnections(): ConnectionStore {
    const current = this.context.globalState.get(CONNECTION_STORE_KEY);
    const rawConnections = (current as Record<string, unknown> | undefined) ?? {};

    const normalizedConnections: ConnectionStore = {};
    for (const [name, rawConnection] of Object.entries(rawConnections)) {
      normalizedConnections[name] = normalizeConnection(rawConnection);
    }

    return normalizedConnections;
  }

  async saveConnections(connections: ConnectionStore): Promise<void> {
    await this.context.globalState.update(CONNECTION_STORE_KEY, connections);
    this.refresh();
  }

  getConnection(name: string): DbConnection | undefined {
    return this.getConnections()[name];
  }

  async upsertConnection(
    name: string,
    connection: DbConnection,
  ): Promise<void> {
    const connections = this.getConnections();
    connections[name] = normalizeConnection(connection);
    await this.saveConnections(connections);
  }

  async deleteConnection(name: string): Promise<void> {
    const connections = this.getConnections();
    delete connections[name];
    await this.saveConnections(connections);
  }
}

export function activate(context: vscode.ExtensionContext) {
  const venvDir = path.join(context.globalStorageUri.fsPath, "python-env");
  console.log(`[SQL4All] venv path: ${venvDir}`);
  const connectionTreeProvider = new ConnectionTreeProvider(context);
  connectionTreeProviderRef = connectionTreeProvider;

  connectionTreeView = vscode.window.createTreeView(CONNECTION_VIEW_ID, {
    treeDataProvider: connectionTreeProvider,
  });
  context.subscriptions.push(connectionTreeView);

  initSqlExecutor({
    panelsByConnection,
    getDriverIcon: (conn) => connectionTreeProviderRef?.getDriverIcon(conn),
    revealConnection: (name) => revealConnection(name),
    runPythonScript,
  });

  const editorServices: ConnectionManagerServices = {
    getConnection: (name) => connectionTreeProvider.getConnection(name),
    upsertConnection: (name, conn) => connectionTreeProvider.upsertConnection(name, conn),
    deleteConnection: (name) => connectionTreeProvider.deleteConnection(name),
    removeConnectionState: (ctx, name) => removeConnectionState(ctx, name),
    panelsByConnection,
    revealInTree: (name) => revealConnectionInTree(connectionTreeProvider, name),
    ensurePythonEnvironment,
    ensureDriverInstalled,
    runProcess,
    fetchDriverVersion,
    markDriverInstalled,
    getInstalledDrivers,
  };

  const openPanelDisposable = vscode.commands.registerCommand(
    `${EXTENSION_NAMESPACE}.openQueryPanel`,
    async () => {
      const selected = await pickConnection(connectionTreeProvider);
      if (!selected) {
        return;
      }

      if (selected === NEW_CONNECTION) {
        await addConnection(context, editorServices);
        return;
      }

      const connection = connectionTreeProvider.getConnection(selected);
      if (!connection) {
        vscode.window.showErrorMessage(
          `Connection "${selected}" was not found.`,
        );
        return;
      }

      createOrShowPanel(context, selected, connection);
    },
  );

  const addConnectionDisposable = vscode.commands.registerCommand(
    `${EXTENSION_NAMESPACE}.addConnection`,
    () => addConnection(context, editorServices),
  );

  const connectConnectionDisposable = vscode.commands.registerCommand(
    `${EXTENSION_NAMESPACE}.connectConnection`,
    async (item?: ConnectionItem) => {
      if (!item) {
        void vscode.commands.executeCommand(
          `${EXTENSION_NAMESPACE}.openQueryPanel`,
        );
        return;
      }

      // Ensure tables are listed (expand tree node) before opening executor
      if (!connectionTreeProvider.hasTablesCached(item.connectionName) && connectionTreeView) {
        await connectionTreeView.reveal(item, { expand: true, select: false, focus: false });
      }

      createOrShowPanel(context, item.connectionName, item.connection);
    },
  );

  const editConnectionDisposable = vscode.commands.registerCommand(
    `${EXTENSION_NAMESPACE}.editConnection`,
    (item?: ConnectionItem) => {
      if (!item) {
        return;
      }

      void openConnectionEditor(
        context,
        editorServices,
        item.connectionName,
        item.connection,
      );
    },
  );

  const deleteConnectionDisposable = vscode.commands.registerCommand(
    `${EXTENSION_NAMESPACE}.deleteConnection`,
    async (item?: ConnectionItem) => {
      if (!item) {
        return;
      }

      const answer = await vscode.window.showWarningMessage(
        `Delete connection "${item.connectionName}"?`,
        { modal: true },
        "Delete",
      );

      if (answer !== "Delete") {
        return;
      }

      await connectionTreeProvider.deleteConnection(item.connectionName);
      await removeConnectionState(context, item.connectionName);
      const panel = panelsByConnection.get(item.connectionName);
      if (panel) {
        panel.dispose();
      }
    },
  );

  const refreshConnectionsDisposable = vscode.commands.registerCommand(
    `${EXTENSION_NAMESPACE}.refreshConnections`,
    () => connectionTreeProvider.refresh(),
  );

  const copyTableNameDisposable = vscode.commands.registerCommand(
    `${EXTENSION_NAMESPACE}.copyTableName`,
    async (item?: TableItem) => {
      if (!item?.tableName) {
        return;
      }
      await vscode.env.clipboard.writeText(item.tableName);
      vscode.window.setStatusBarMessage(
        `Copied table name: ${item.tableName}`,
        2000,
      );
    },
  );

  const connectDatabaseDisposable = vscode.commands.registerCommand(
    `${EXTENSION_NAMESPACE}.connectDatabase`,
    async (item?: ConnectionItem) => {
      if (!item || !connectionTreeView) {
        return;
      }

      connectionTreeProvider.refreshConnectionTables(item.connectionName);
      await connectionTreeView.reveal(item, { expand: true, select: true, focus: true });
    },
  );

  const reloadDriverDisposable = vscode.commands.registerCommand(
    `${EXTENSION_NAMESPACE}.reloadDriver`,
    async (item?: ConnectionItem) => {
      if (!item?.connection?.driver) {
        return;
      }
      const driverName = item.connection.driver.trim();
      if (!driverName) {
        return;
      }

      // Resolve extras from driver_config.json
      let extras: string[] = [];
      try {
        const driverConfigPath = path.join(context.extensionPath, "media", "driver_config.json");
        const raw = fs.readFileSync(driverConfigPath, "utf8");
        const parsed = JSON.parse(raw) as { databases?: Record<string, { driver?: string; extras?: string[] }> };
        for (const dbConf of Object.values(parsed.databases ?? {})) {
          if (String(dbConf.driver || "").trim().toLowerCase() === driverName.toLowerCase() && Array.isArray(dbConf.extras)) {
            extras = dbConf.extras;
            break;
          }
        }
      } catch { /* ignore */ }

      try {
        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: `Upgrading driver: ${driverName}`,
            cancellable: false,
          },
          async () => {
            const venvPython = await ensurePythonEnvironment(context);
            await runProcess(venvPython, [
              "-m",
              "pip",
              "install",
              "--upgrade",
              "--quiet",
              driverName,
              ...extras,
            ]);
            const version = await fetchDriverVersion(context, driverName);
            await markDriverInstalled(context, driverName, version);
          },
        );
        vscode.window.showInformationMessage(
          `Driver ${driverName} upgraded successfully.`,
        );
      } catch (err: any) {
        vscode.window.showErrorMessage(
          `Driver upgrade failed: ${err?.message || String(err)}`,
        );
      }
    },
  );

  const selectPythonExecutableDisposable = vscode.commands.registerCommand(
    `${EXTENSION_NAMESPACE}.selectPythonExecutable`,
    () => selectPythonExecutable(context),
  );

  const statusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100,
  );
  statusBar.command = `${EXTENSION_NAMESPACE}.selectPythonExecutable`;
  pythonStatusBar = statusBar;
  updatePythonStatusBar();

  context.subscriptions.push(
    openPanelDisposable,
    addConnectionDisposable,
    connectConnectionDisposable,
    editConnectionDisposable,
    deleteConnectionDisposable,
    refreshConnectionsDisposable,
    copyTableNameDisposable,
    connectDatabaseDisposable,
    reloadDriverDisposable,
    selectPythonExecutableDisposable,
    statusBar,
  );

  console.log(`${BRAND_NAME} extension activated`);

  // Check Python availability on first activation
  checkPythonSetup(context);
}

async function checkPythonSetup(context: vscode.ExtensionContext): Promise<void> {
  const venvDir = path.join(context.globalStorageUri.fsPath, "python-env");
  const venvPython =
    process.platform === "win32"
      ? path.join(venvDir, "Scripts", "python.exe")
      : path.join(venvDir, "bin", "python");

  // Skip if venv already exists
  if (fs.existsSync(venvPython)) {
    return;
  }

  // Try to resolve system Python silently
  try {
    await resolveSystemPython();
  } catch {
    // No Python found — prompt user
    const action = await vscode.window.showWarningMessage(
      `${BRAND_NAME} requires Python 3.9+ to run queries. No Python installation was detected.`,
      "Select Python Executable",
      "Dismiss",
    );
    if (action === "Select Python Executable") {
      await selectPythonExecutable(context);
    }
  }
}

function revealConnectionInTree(
  treeProvider: ConnectionTreeProvider,
  connectionName: string,
): void {
  if (!connectionTreeView) {
    return;
  }

  // Ensure items are populated
  treeProvider.getChildren();
  const target = treeProvider.findItem(connectionName);
  if (target) {
    connectionTreeView.reveal(target, { select: true, focus: false });
  }
}

function revealConnection(connectionName: string): void {
  if (connectionTreeProviderRef) {
    revealConnectionInTree(connectionTreeProviderRef, connectionName);
  }
}

async function pickConnection(
  treeProvider: ConnectionTreeProvider,
): Promise<string | undefined> {
  const connections = treeProvider.getConnections();
  const items: vscode.QuickPickItem[] = [
    {
      label: "$(add) Add New Connection",
      description: "Create and save a connection profile",
    },
  ];

  for (const name of Object.keys(connections).sort((a, b) =>
    a.localeCompare(b),
  )) {
    const conn = connections[name];
    items.push({
      label: name,
      description: formatConnectionSummary(conn),
    });
  }

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: "Choose a connection",
    ignoreFocusOut: true,
  });

  if (!picked) {
    return undefined;
  }

  if (picked.label.includes("Add New Connection")) {
    return NEW_CONNECTION;
  }

  return picked.label;
}

async function runPythonScript(
  context: vscode.ExtensionContext,
  scriptArgs: string[],
  onSpawn?: (child: ChildProcess) => void,
): Promise<string> {
  const pythonExecutable = await ensurePythonEnvironment(context);
  return runProcess(pythonExecutable, scriptArgs, onSpawn);
}

async function ensurePythonEnvironment(
  context: vscode.ExtensionContext,
): Promise<string> {
  if (pythonEnvPath) {
    return pythonEnvPath;
  }

  if (pythonSetupPromise) {
    return pythonSetupPromise;
  }

  pythonSetupPromise = (async () => {
    const storageDir = context.globalStorageUri.fsPath;
    const venvDir = path.join(storageDir, "python-env");
    const venvPython =
      process.platform === "win32"
        ? path.join(venvDir, "Scripts", "python.exe")
        : path.join(venvDir, "bin", "python");
    const readyMarker = path.join(venvDir, READY_MARKER_FILE);

    fs.mkdirSync(storageDir, { recursive: true });

    if (!fs.existsSync(venvPython)) {
      const bootstrap = await resolveSystemPython();
      await validatePythonVersion(bootstrap);
      await runProcess(bootstrap.command, [
        ...bootstrap.args,
        "-m",
        "venv",
        venvDir,
      ]);
    }

    if (!fs.existsSync(readyMarker)) {
      await runProcess(venvPython, [
        "-m",
        "pip",
        "install",
        "--upgrade",
        "pip",
      ]);
      fs.writeFileSync(readyMarker, new Date().toISOString(), "utf8");
    }

    pythonEnvPath = venvPython;
    updatePythonStatusBar();
    return venvPython;
  })().finally(() => {
    pythonSetupPromise = undefined;
  });

  return pythonSetupPromise;
}

async function validatePythonVersion(
  python: { command: string; args: string[] },
): Promise<void> {
  const output = await runProcess(python.command, [
    ...python.args,
    "-c",
    "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')",
  ]);
  const versionStr = output.trim();
  const [major, minor] = versionStr.split(".").map(Number);
  if (major < 3 || (major === 3 && minor < 9)) {
    throw new Error(
      `Python 3.9 or later is required, but found ${versionStr}. Please select a compatible Python.`,
    );
  }
}

function getInstalledDrivers(
  context: vscode.ExtensionContext,
): Record<string, string | boolean> {
  const stored = context.globalState.get(INSTALLED_DRIVERS_STORE_KEY);
  return (stored as Record<string, string | boolean> | undefined) ?? {};
}

async function markDriverInstalled(
  context: vscode.ExtensionContext,
  pipPackage: string,
  version?: string,
): Promise<void> {
  const installed = getInstalledDrivers(context);
  installed[pipPackage.toLowerCase()] = version || true;
  await context.globalState.update(INSTALLED_DRIVERS_STORE_KEY, installed);
}

function isDriverInstalled(
  context: vscode.ExtensionContext,
  pipPackage: string,
): boolean {
  const installed = getInstalledDrivers(context);
  return !!installed[pipPackage.toLowerCase()];
}

async function fetchDriverVersion(
  context: vscode.ExtensionContext,
  pipPackage: string,
): Promise<string | undefined> {
  try {
    const venvPython = await ensurePythonEnvironment(context);
    const output = await runProcess(venvPython, [
      "-m",
      "pip",
      "show",
      pipPackage,
    ]);
    const match = output.match(/^Version:\s*(.+)$/m);
    return match ? match[1].trim() : undefined;
  } catch {
    return undefined;
  }
}

async function ensureDriverInstalled(
  context: vscode.ExtensionContext,
  driverName: string,
  progressCallback?: (message: string) => void,
  extras?: string[],
): Promise<void> {
  const pipPackage = driverName.trim();
  if (!pipPackage) {
    return;
  }

  if (isDriverInstalled(context, pipPackage)) {
    return;
  }

  progressCallback?.(`Setting up Python environment...`);
  const venvPython = await ensurePythonEnvironment(context);

  const packages = [
    "--quiet",
    "sqlalchemy>=2.0,<3",
    pipPackage,
    ...(extras || []),
  ];

  progressCallback?.(`Installing driver: ${pipPackage}...`);
  await runProcess(venvPython, [
    "-m",
    "pip",
    "install",
    ...packages,
  ]);

  const version = await fetchDriverVersion(context, pipPackage);
  await markDriverInstalled(context, pipPackage, version);
  progressCallback?.(`Driver ${pipPackage} installed successfully.`);
}

async function resolveSystemPython(): Promise<{
  command: string;
  args: string[];
}> {
  const configuredPython = getConfiguredPythonPath();

  if (configuredPython) {
    await runProcess(configuredPython, ["--version"]);
    return { command: configuredPython, args: [] };
  }

  // Try VS Code Python extension's selected interpreter
  const pythonExtConfig = vscode.workspace.getConfiguration("python");
  const vscodePythonPath = pythonExtConfig.get<string>("defaultInterpreterPath", "").trim();
  if (vscodePythonPath && vscodePythonPath !== "python") {
    try {
      await runProcess(vscodePythonPath, ["--version"]);
      return { command: vscodePythonPath, args: [] };
    } catch {
      // Fall through to other candidates.
    }
  }

  if (process.platform === "win32") {
    for (const candidatePath of getWindowsCandidatePythonPaths()) {
      if (!fs.existsSync(candidatePath)) {
        continue;
      }

      try {
        await runProcess(candidatePath, ["--version"]);
        return { command: candidatePath, args: [] };
      } catch {
        // Continue trying remaining candidates.
      }
    }
  }

  const pythonCommands =
    process.platform === "win32"
      ? [
          { command: "python", args: [] as string[] },
          { command: "py", args: ["-3"] },
          { command: "py", args: [] as string[] },
        ]
      : [
          { command: "python3", args: [] as string[] },
          { command: "python", args: [] as string[] },
        ];

  let lastError = "Python launcher not found.";

  for (const candidate of pythonCommands) {
    try {
      await runProcess(candidate.command, [...candidate.args, "--version"]);
      return candidate;
    } catch (error: any) {
      lastError = error?.message || String(error);
    }
  }

  if (process.platform === "win32") {
    throw new Error(
      `Cannot find Python. Tried: python, py -3, py. Last error: ${lastError}`,
    );
  }

  throw new Error(
    `Cannot find Python. Tried: python3, python. Last error: ${lastError}`,
  );
}

function updatePythonStatusBar(): void {
  if (!pythonStatusBar) {
    return;
  }

  const configured = getConfiguredPythonPath();
  if (pythonEnvPath) {
    pythonStatusBar.text = `$(symbol-namespace) ${BRAND_NAME}: venv`;
    pythonStatusBar.tooltip = `${BRAND_NAME} Python environment: ${pythonEnvPath}`;
  } else if (configured) {
    pythonStatusBar.text = `$(symbol-namespace) ${BRAND_NAME}: Python`;
    pythonStatusBar.tooltip = `${BRAND_NAME} Python: ${configured}`;
  } else {
    pythonStatusBar.text = `$(symbol-namespace) ${BRAND_NAME}: Python (auto)`;
    pythonStatusBar.tooltip = `${BRAND_NAME} Python: auto-detected (click to configure)`;
  }
  pythonStatusBar.show();
}

async function selectPythonExecutable(
  context: vscode.ExtensionContext,
): Promise<void> {
  const detected =
    process.platform === "win32" ? getWindowsCandidatePythonPaths() : [];
  const existing = detected.filter((candidate) => fs.existsSync(candidate));
  const current = getConfiguredPythonPath();

  const items: Array<vscode.QuickPickItem & { value: string }> = [];

  if (current) {
    items.push({
      label: `$(check) Current: ${current}`,
      description: `Configured ${EXTENSION_NAMESPACE}.pythonPath`,
      value: current,
    });
  }

  for (const candidate of existing) {
    items.push({
      label: candidate,
      description: "Detected Python executable",
      value: candidate,
    });
  }

  items.push({
    label: "$(folder-opened) Browse...",
    description: "Pick python.exe manually",
    value: "__BROWSE__",
  });

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: `Select Python executable for ${BRAND_NAME}`,
  });

  if (!picked) {
    return;
  }

  let selectedPath = picked.value;
  if (selectedPath === "__BROWSE__") {
    const filePick = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      title: "Select Python executable",
      filters:
        process.platform === "win32" ? { Executable: ["exe"] } : undefined,
    });

    if (!filePick || filePick.length === 0) {
      return;
    }

    selectedPath = filePick[0].fsPath;
  }

  try {
    await runProcess(selectedPath, ["--version"]);
    await validatePythonVersion({ command: selectedPath, args: [] });
    await vscode.workspace
      .getConfiguration(EXTENSION_NAMESPACE)
      .update(
        PYTHON_SETTING_KEY,
        selectedPath,
        vscode.ConfigurationTarget.Global,
      );

    pythonEnvPath = undefined;
    pythonSetupPromise = undefined;
    updatePythonStatusBar();
    vscode.window.showInformationMessage(
      `${BRAND_NAME} Python path set to: ${selectedPath}`,
    );
  } catch (error: any) {
    vscode.window.showErrorMessage(
      `Selected Python executable is invalid: ${error?.message || String(error)}`,
    );
  }
}

function getConfiguredPythonPath(): string {
  return vscode.workspace
    .getConfiguration(EXTENSION_NAMESPACE)
    .get<string>(PYTHON_SETTING_KEY, "")
    .trim();
}

function getWindowsCandidatePythonPaths(): string[] {
  const userProfile = process.env.USERPROFILE || "";
  const localAppData = process.env.LOCALAPPDATA || "";
  const programFiles = process.env.ProgramFiles || "C:\\Program Files";
  const programFilesX86 =
    process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";

  const baseDirs = [
    path.join(localAppData, "Programs", "Python"),
    path.join(userProfile, "AppData", "Local", "Programs", "Python"),
  ].filter(Boolean);

  const candidates: string[] = [];
  for (const baseDir of baseDirs) {
    if (!fs.existsSync(baseDir)) {
      continue;
    }

    for (const entry of fs.readdirSync(baseDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }

      if (!/^Python\d+/i.test(entry.name)) {
        continue;
      }

      candidates.push(path.join(baseDir, entry.name, "python.exe"));
    }
  }

  candidates.push(
    path.join(programFiles, "Python311", "python.exe"),
    path.join(programFiles, "Python310", "python.exe"),
    path.join(programFilesX86, "Python311", "python.exe"),
    path.join(programFilesX86, "Python310", "python.exe"),
  );

  return Array.from(new Set(candidates));
}

async function runProcess(command: string, args: string[], onSpawn?: (child: ChildProcess) => void): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(command, args);
    if (onSpawn) {
      onSpawn(child);
    }
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (data: any) => {
      stdout += data.toString();
    });

    child.stderr.on("data", (data: any) => {
      stderr += data.toString();
    });

    child.on("error", (error: any) => {
      reject(error);
    });

    child.on("close", (code: number | null, signal: string | null) => {
      if (signal) {
        const err: any = new Error(`Process killed by signal ${signal}`);
        err.killed = true;
        reject(err);
        return;
      }
      if (code !== 0) {
        reject(new Error(stderr || `${command} exited with code ${code}`));
        return;
      }

      resolve(stdout);
    });
  });
}

export function deactivate() {}
