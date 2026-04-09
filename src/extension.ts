import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { spawn, ChildProcess } from "child_process";
import {
  DbConnection,
  ConnectionStore,
  normalizeConnection,
  formatConnectionSummary,
  maskPasswordInUri,
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
  CATEGORY_ITEM_CONTEXT,
  FOLDER_ITEM_CONTEXT,
  FOLDER_STORE_KEY,
  FOLDER_ASSIGNMENTS_KEY,
  DEFAULT_FOLDER_NAME,
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
  killPersistentProcess,
  sendToPersistentProcess,
} from "./sqlExecutor";
import {
  TOOLBOX_VIEW_ID,
  ToolboxTreeProvider,
  registerToolboxCommands,
} from "./toolbox";

declare const process: any;

const panelsByConnection = new Map<string, vscode.WebviewPanel>();
let connectionTreeView: vscode.TreeView<TreeItem> | undefined;
let connectionTreeProviderRef: ConnectionTreeProvider | undefined;
let pythonEnvPath: string | undefined;
let pythonSetupPromise: Promise<string> | undefined;
let pythonStatusBar: vscode.StatusBarItem | undefined;

type TreeItem = FolderItem | ConnectionItem | EntityCategoryItem | EntityItem | TableSubCategoryItem | ColumnItem | IndexItem;

const CONNECTION_DRAG_MIME = `application/vnd.code.tree.${CONNECTION_VIEW_ID}`;

type EntityCategory = "tables" | "views" | "materialized-views" | "sequences" | "temp-tables" | "temp-views";

const ENTITY_CATEGORIES: { type: EntityCategory; label: string; icon: string; action: string }[] = [
  { type: "tables", label: "Tables", icon: "symbol-class", action: "list-tables" },
  { type: "views", label: "Views", icon: "eye", action: "list-views" },
  { type: "materialized-views", label: "Materialized Views", icon: "symbol-interface", action: "list-materialized-views" },
  { type: "sequences", label: "Sequences", icon: "list-ordered", action: "list-sequences" },
  { type: "temp-tables", label: "Temp Tables", icon: "symbol-event", action: "list-temp-tables" },
  { type: "temp-views", label: "Temp Views", icon: "symbol-event", action: "list-temp-views" },
];

class FolderItem extends vscode.TreeItem {
  constructor(
    public readonly folderName: string,
  ) {
    super(folderName, vscode.TreeItemCollapsibleState.Expanded);
    this.contextValue = FOLDER_ITEM_CONTEXT;
    this.iconPath = new vscode.ThemeIcon("folder-opened", new vscode.ThemeColor("symbolIcon.folderForeground"));
  }
}

class ConnectionItem extends vscode.TreeItem {
  public parentFolderName: string;
  public readonly _summary: string;

  constructor(
    public readonly connectionName: string,
    public readonly connection: DbConnection,
    folderName: string,
    iconPath?: vscode.ThemeIcon | vscode.Uri,
    summary?: string,
  ) {
    super(
      connectionName,
      vscode.TreeItemCollapsibleState.Collapsed,
    );
    this.parentFolderName = folderName;
    this._summary = summary ?? formatConnectionSummary(connection);
    this.description = "";
    this.contextValue = CONNECTION_ITEM_CONTEXT;
    this.iconPath = iconPath ?? new vscode.ThemeIcon("database");
  }

  updateContextValue(connected: boolean): void {
    this.contextValue = connected
      ? `${CONNECTION_ITEM_CONTEXT}.connected`
      : CONNECTION_ITEM_CONTEXT;
  }
}

class EntityCategoryItem extends vscode.TreeItem {
  constructor(
    public readonly categoryType: EntityCategory,
    public readonly parentConnectionName: string,
    public readonly parentConnection: DbConnection,
    label: string,
    icon: string,
    public readonly action: string,
  ) {
    super(label, vscode.TreeItemCollapsibleState.Collapsed);
    this.contextValue = CATEGORY_ITEM_CONTEXT;
    this.iconPath = new vscode.ThemeIcon(icon);
  }
}

const EXPANDABLE_CATEGORIES = new Set<EntityCategory>(["tables", "views", "materialized-views", "temp-tables", "temp-views"]);

class EntityItem extends vscode.TreeItem {
  constructor(
    public readonly entityName: string,
    public readonly parentConnectionName: string,
    public readonly categoryType: EntityCategory,
  ) {
    super(
      entityName,
      EXPANDABLE_CATEGORIES.has(categoryType)
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None,
    );
    this.contextValue = TABLE_ITEM_CONTEXT;
    this.iconPath = new vscode.ThemeIcon("symbol-field");
  }
}

type TableSubCategory = "columns" | "indexes";

class TableSubCategoryItem extends vscode.TreeItem {
  constructor(
    public readonly subType: TableSubCategory,
    public readonly parentEntityName: string,
    public readonly parentConnectionName: string,
  ) {
    super(
      subType === "columns" ? "Columns" : "Indexes",
      vscode.TreeItemCollapsibleState.Collapsed,
    );
    this.contextValue = CATEGORY_ITEM_CONTEXT;
    this.iconPath = new vscode.ThemeIcon(
      subType === "columns" ? "symbol-constant" : "symbol-key",
    );
  }
}

class ColumnItem extends vscode.TreeItem {
  constructor(
    public readonly columnName: string,
    public readonly parentEntityName: string,
    public readonly parentConnectionName: string,
    columnType: string,
    nullable: boolean,
    primaryKey: boolean,
  ) {
    super(columnName, vscode.TreeItemCollapsibleState.None);
    const tags: string[] = [];
    if (primaryKey) { tags.push("PK"); }
    if (!nullable) { tags.push("NOT NULL"); }
    this.description = `${columnType}${tags.length > 0 ? "  " + tags.join(", ") : ""}`;
    this.contextValue = TABLE_ITEM_CONTEXT;
    this.iconPath = new vscode.ThemeIcon(
      primaryKey ? "symbol-key" : "symbol-constant",
    );
  }
}

class IndexItem extends vscode.TreeItem {
  constructor(
    public readonly indexName: string,
    public readonly parentEntityName: string,
    public readonly parentConnectionName: string,
    columns: string,
    unique: boolean,
    primaryKey: boolean,
  ) {
    super(indexName, vscode.TreeItemCollapsibleState.None);
    const tags: string[] = [];
    if (primaryKey) { tags.push("PK"); }
    if (unique && !primaryKey) { tags.push("UNIQUE"); }
    this.description = `(${columns})${tags.length > 0 ? "  " + tags.join(", ") : ""}`;
    this.contextValue = TABLE_ITEM_CONTEXT;
    this.iconPath = new vscode.ThemeIcon(
      primaryKey ? "symbol-key" : "symbol-ruler",
    );
  }
}

class ConnectionTreeProvider
  implements vscode.TreeDataProvider<TreeItem>, vscode.TreeDragAndDropController<TreeItem> {

  dropMimeTypes = [CONNECTION_DRAG_MIME];
  dragMimeTypes = [CONNECTION_DRAG_MIME];

  private readonly _onDidChangeTreeData = new vscode.EventEmitter<
    TreeItem | undefined | null | void
  >();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private readonly driverIconsByDriver = new Map<string, vscode.Uri>();
  private readonly disconnectedIconsByDriver = new Map<string, vscode.Uri>();
  private readonly iconsByDbType = new Map<string, vscode.Uri>();
  private readonly disconnectedIconsByDbType = new Map<string, vscode.Uri>();
  private readonly connectedConnections = new Set<string>();
  private readonly expandedFolders = new Set<string>();
  private cachedFolders: FolderItem[] = [];
  private cachedItemsByFolder = new Map<string, ConnectionItem[]>();
  private entityCache = new Map<string, EntityItem[]>();
  private tableDetailCache = new Map<string, (ColumnItem | IndexItem)[]>();
  private categoriesByConnection = new Map<string, EntityCategoryItem[]>();
  private cachedConnections: ConnectionStore | undefined;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.loadDriverIconMap();
  }

  refresh(): void {
    this.cachedFolders = [];
    this.cachedItemsByFolder.clear();
    this.entityCache.clear();
    this.tableDetailCache.clear();
    this.categoriesByConnection.clear();
    this.cachedConnections = undefined;
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: TreeItem): vscode.TreeItem {
    if (element instanceof FolderItem) {
      const expanded = this.expandedFolders.has(element.folderName);
      element.iconPath = new vscode.ThemeIcon(
        expanded ? "folder-opened" : "folder",
        new vscode.ThemeColor("symbolIcon.folderForeground"),
      );
    }
    return element;
  }

  onDidExpand(element: TreeItem): void {
    if (element instanceof FolderItem) {
      this.expandedFolders.add(element.folderName);
      this._onDidChangeTreeData.fire(element);
    }
  }

  onDidCollapse(element: TreeItem): void {
    if (element instanceof FolderItem) {
      this.expandedFolders.delete(element.folderName);
      this._onDidChangeTreeData.fire(element);
    }
  }

  resolveTreeItem(
    item: vscode.TreeItem,
    element: TreeItem,
  ): vscode.ProviderResult<vscode.TreeItem> {
    if (element instanceof ConnectionItem && !item.tooltip) {
      const md = new vscode.MarkdownString();
      md.supportHtml = true;
      const safeName = element.connectionName.replace(/([*_\\`])/g, "\\$1");
      const tick = (s: string) => s.replace(/`/g, "'");
      md.appendMarkdown(`**${safeName}**\n\n`);
      md.appendMarkdown(`<span style="color:#4EC9B0;">\`${tick(element._summary)}\`</span>\n\n`);
      const envVars = element.connection.envVars;
      if (envVars && Object.keys(envVars).length > 0) {
        md.appendMarkdown(`***Environment Variables:***\n\n`);
        for (const [key, value] of Object.entries(envVars)) {
          md.appendMarkdown(`- \`${tick(key)}\` = \`${tick(value)}\`\n`);
        }
      }
      item.tooltip = md;
    }
    return item;
  }

  async getChildren(element?: TreeItem): Promise<TreeItem[]> {
    if (!element) {
      if (this.cachedFolders.length > 0) {
        return this.cachedFolders;
      }

      const folders = this.getFolders();
      const folderSet = new Set(folders);
      const assignments = this.getFolderAssignments();
      const connections = this.getConnections();

      // Group connections by folder in a single pass
      const groups = new Map<string, string[]>();
      for (const folderName of folders) {
        groups.set(folderName, []);
      }

      for (const name of Object.keys(connections)) {
        let folder = assignments[name];
        if (!folder || !folderSet.has(folder)) {
          folder = DEFAULT_FOLDER_NAME;
          assignments[name] = folder;
        }
        groups.get(folder)!.push(name);
      }

      this.cachedFolders = folders.map((f) => {
        this.expandedFolders.add(f);
        return new FolderItem(f);
      });

      for (const folderName of folders) {
        const connNames = groups.get(folderName)!;
        connNames.sort((a, b) => a.localeCompare(b));

        const items = connNames.map((name) => {
          const connection = connections[name];
          const connected = this.connectedConnections.has(name);
          const item = new ConnectionItem(
            name,
            connection,
            folderName,
            this.resolveConnectionIcon(connection, name),
            this.resolveConnectionSummary(connection),
          );
          if (connected) {
            item.collapsibleState = vscode.TreeItemCollapsibleState.Expanded;
            item.updateContextValue(true);
          }
          return item;
        });
        this.cachedItemsByFolder.set(folderName, items);
      }

      return this.cachedFolders;
    }

    if (element instanceof FolderItem) {
      return this.cachedItemsByFolder.get(element.folderName) ?? [];
    }

    if (element instanceof ConnectionItem) {
      if (!this.connectedConnections.has(element.connectionName)) {
        return [];
      }
      return this.getEntityCategories(element);
    }

    if (element instanceof EntityCategoryItem) {
      return this.fetchEntityItems(element);
    }

    if (element instanceof EntityItem) {
      return this.getTableSubCategories(element);
    }

    if (element instanceof TableSubCategoryItem) {
      return this.fetchTableDetails(element);
    }

    return [];
  }

  getParent(element: TreeItem): vscode.ProviderResult<TreeItem> {
    if (element instanceof ColumnItem || element instanceof IndexItem) {
      return undefined; // sub-category parent lookup not needed for reveal
    }
    if (element instanceof TableSubCategoryItem) {
      const cacheKey = `${element.parentConnectionName}:tables`;
      const entities = this.entityCache.get(cacheKey);
      return entities?.find((e) => e.entityName === element.parentEntityName);
    }
    if (element instanceof EntityItem) {
      const categories = this.categoriesByConnection.get(element.parentConnectionName);
      return categories?.find(
        (c) => c.categoryType === element.categoryType,
      );
    }
    if (element instanceof EntityCategoryItem) {
      return this.findItem(element.parentConnectionName);
    }
    if (element instanceof ConnectionItem) {
      return this.cachedFolders.find(
        (f) => f.folderName === element.parentFolderName,
      );
    }
    return undefined;
  }

  findItem(connectionName: string): ConnectionItem | undefined {
    for (const items of this.cachedItemsByFolder.values()) {
      const found = items.find((item) => item.connectionName === connectionName);
      if (found) { return found; }
    }
    return undefined;
  }

  hasTablesCached(connectionName: string): boolean {
    return ENTITY_CATEGORIES.some(
      (cat) => this.entityCache.has(`${connectionName}:${cat.type}`),
    );
  }

  isConnected(connectionName: string): boolean {
    return this.connectedConnections.has(connectionName);
  }

  refreshConnectionTables(connectionName: string): void {
    this.clearEntityCache(connectionName);
    const target = this.findItem(connectionName);
    this._onDidChangeTreeData.fire(target);
  }

  clearTableCache(connectionName: string): void {
    this.clearEntityCache(connectionName);
  }

  disconnectAndRefresh(connectionName: string): void {
    this.clearEntityCache(connectionName);
    this.setConnectionState(connectionName, false);
  }

  private clearEntityCache(connectionName: string): void {
    for (const cat of ENTITY_CATEGORIES) {
      this.entityCache.delete(`${connectionName}:${cat.type}`);
    }
    // Clear all table detail caches (columns/indexes) for this connection
    for (const key of this.tableDetailCache.keys()) {
      if (key.startsWith(`${connectionName}:`)) {
        this.tableDetailCache.delete(key);
      }
    }
    this.categoriesByConnection.delete(connectionName);
  }

  private loadDriverIconMap(): void {
    const mediaPath = path.join(this.context.extensionPath, "media");
    const driverConfigPath = path.join(mediaPath, "driver_config.json");
    const disconnectedDir = path.join(
      this.context.globalStorageUri.fsPath, "disconnected-icons",
    );

    try {
      if (!fs.existsSync(disconnectedDir)) {
        fs.mkdirSync(disconnectedDir, { recursive: true });
      }
    } catch { /* ignore */ }

    try {
      const raw = fs.readFileSync(driverConfigPath, "utf8");
      const parsed = JSON.parse(raw) as {
        databases?: Record<
          string,
          { driver?: string; icon?: string; uri_template?: string }
        >;
      };

      for (const [dbType, dbConfig] of Object.entries(parsed.databases ?? {})) {
        const driver = String(dbConfig.driver || "").trim().toLowerCase();
        const iconRelativePath = String(dbConfig.icon || "").trim();
        if (!iconRelativePath) {
          continue;
        }

        const iconAbsolutePath = path.join(mediaPath, iconRelativePath);
        if (!fs.existsSync(iconAbsolutePath)) {
          continue;
        }

        const iconUri = vscode.Uri.file(iconAbsolutePath);
        if (driver) {
          this.driverIconsByDriver.set(driver, iconUri);
        }
        this.iconsByDbType.set(dbType.toLowerCase(), iconUri);

        // Generate greyscale disconnected variant
        try {
          const iconFileName = path.basename(iconRelativePath);
          const disconnectedPath = path.join(disconnectedDir, iconFileName);
          if (!fs.existsSync(disconnectedPath)) {
            const svgContent = fs.readFileSync(iconAbsolutePath, "utf8");
            const greySvg = this.generateDisconnectedSvg(svgContent);
            fs.writeFileSync(disconnectedPath, greySvg, "utf8");
          }
          const disconnectedUri = vscode.Uri.file(disconnectedPath);
          if (driver) {
            this.disconnectedIconsByDriver.set(driver, disconnectedUri);
          }
          this.disconnectedIconsByDbType.set(dbType.toLowerCase(), disconnectedUri);
        } catch { /* skip disconnected icon on error */ }
      }
    } catch {
      // Keep default theme icon when driver config cannot be loaded.
    }
  }

  private generateDisconnectedSvg(originalSvg: string): string {
    // Extract viewBox or default to 0 0 128 128
    const viewBoxMatch = originalSvg.match(/viewBox="([^"]+)"/);
    const viewBox = viewBoxMatch ? viewBoxMatch[1] : "0 0 128 128";
    const parts = viewBox.split(/\s+/).map(Number);
    const vbWidth = parts[2] || 128;
    const vbHeight = parts[3] || 128;

    // Extract inner content (everything between <svg ...> and </svg>)
    const innerMatch = originalSvg.match(/<svg[^>]*>([\s\S]*)<\/svg>/i);
    const innerContent = innerMatch ? innerMatch[1] : "";

    // Badge position: bottom-right corner
    const badgeR = Math.round(vbWidth * 0.16);
    const badgeCx = vbWidth - badgeR - 2;
    const badgeCy = vbHeight - badgeR - 2;
    const lineOffset = Math.round(badgeR * 0.6);
    const strokeW = Math.max(2, Math.round(badgeR * 0.25));

    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}">
<defs>
<filter id="grey"><feColorMatrix type="saturate" values="0"/></filter>
</defs>
<g filter="url(#grey)" opacity="1">
${innerContent}
</g>
<circle cx="${badgeCx}" cy="${badgeCy}" r="${badgeR}" fill="#e74c3c"/>
<line x1="${badgeCx - lineOffset}" y1="${badgeCy - lineOffset}" x2="${badgeCx + lineOffset}" y2="${badgeCy + lineOffset}" stroke="#fff" stroke-width="${strokeW}" stroke-linecap="round"/>
</svg>`;
  }

  private resolveConnectionIcon(
    connection: DbConnection,
    connectionName?: string,
  ): vscode.ThemeIcon | vscode.Uri {
    const driver = String(connection.driver || "").trim().toLowerCase();
    const dbType = String(connection.databaseType || "").trim().toLowerCase();

    const isConnected = connectionName ? this.connectedConnections.has(connectionName) : false;
    if (isConnected) {
      return (driver ? this.driverIconsByDriver.get(driver) : undefined)
        ?? this.iconsByDbType.get(dbType)
        ?? new vscode.ThemeIcon("database");
    }

    return (driver ? this.disconnectedIconsByDriver.get(driver) : undefined)
      ?? this.disconnectedIconsByDbType.get(dbType)
      ?? (driver ? this.driverIconsByDriver.get(driver) : undefined)
      ?? this.iconsByDbType.get(dbType)
      ?? new vscode.ThemeIcon("database");
  }

  getDriverIcon(connection: DbConnection): vscode.Uri | undefined {
    const driver = String(connection.driver || "").trim().toLowerCase();
    const dbType = String(connection.databaseType || "").trim().toLowerCase();

    return (driver ? this.driverIconsByDriver.get(driver) : undefined)
      ?? this.iconsByDbType.get(dbType)
      ?? undefined;
  }

  private resolveConnectionSummary(connection: DbConnection): string {
    return formatConnectionSummary(connection);
  }

  setConnectionState(connectionName: string, connected: boolean): void {
    const changed = connected
      ? !this.connectedConnections.has(connectionName)
      : this.connectedConnections.has(connectionName);

    if (!changed) {
      return;
    }

    if (connected) {
      this.connectedConnections.add(connectionName);
    } else {
      this.connectedConnections.delete(connectionName);
    }

    // Rebuild the affected item's icon and context value
    const item = this.findItem(connectionName);
    if (item) {
      item.iconPath = this.resolveConnectionIcon(item.connection, connectionName);
      item.updateContextValue(connected);
      if (connected) {
        item.collapsibleState = vscode.TreeItemCollapsibleState.Expanded;
      }
      this._onDidChangeTreeData.fire(item);
    }
  }

  /**
   * Explicitly connect: fetch tables, and only on success update icon/state/expand.
   * Returns true if tables were listed successfully.
   */
  async connectAndListTables(connectionName: string): Promise<boolean> {
    const connection = this.getConnection(connectionName);
    if (!connection) {
      return false;
    }

    // Show loading spinner on the tree item
    const item = this.findItem(connectionName);
    const previousIcon = item?.iconPath;
    if (item) {
      item.iconPath = new vscode.ThemeIcon("loading~spin");
      this._onDidChangeTreeData.fire(item);
    }

    return vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Connecting to "${connectionName}"...`,
        cancellable: false,
      },
      async () => {
        try {
          const result = await sendToPersistentProcess(
            connectionName, this.context, connection,
            { action: "list-tables" },
          );

          const rows: any[] = Array.isArray(result) ? result : result?.rows ?? result?.data ?? [];
          const tableNames: string[] = rows
            .map((row: any) => {
              if (typeof row === "string") { return row; }
              if (typeof row === "object" && row !== null) {
                const vals = Object.values(row);
                return vals.length > 0 ? String(vals[0]) : "";
              }
              return String(row);
            })
            .filter((name: string) => name.length > 0);

          // Cache tables eagerly, clear lazy caches
          this.clearEntityCache(connectionName);
          const tablesKey = `${connectionName}:tables`;
          const tableItems = tableNames.map(
            (name) => new EntityItem(name, connectionName, "tables"),
          );
          this.entityCache.set(tablesKey, tableItems);

          // Always refresh the tree item (icon + children) even if already connected
          this.connectedConnections.add(connectionName);
          const currentItem = this.findItem(connectionName);
          if (currentItem) {
            currentItem.iconPath = this.resolveConnectionIcon(connection, connectionName);
            currentItem.collapsibleState = vscode.TreeItemCollapsibleState.Expanded;
            currentItem.updateContextValue(true);
          }
          this._onDidChangeTreeData.fire(currentItem);
          return true;
        } catch (err: any) {
          // Restore previous icon on failure
          if (item) {
            item.iconPath = previousIcon ?? this.resolveConnectionIcon(connection, connectionName);
            this._onDidChangeTreeData.fire(item);
          }
          vscode.window.showErrorMessage(
            `Failed to connect "${connectionName}": ${err?.message || String(err)}`,
          );
          return false;
        }
      },
    );
  }

  private getEntityCategories(parent: ConnectionItem): EntityCategoryItem[] {
    const cached = this.categoriesByConnection.get(parent.connectionName);
    if (cached) {
      return cached;
    }

    const categories = ENTITY_CATEGORIES.map(
      (cat) =>
        new EntityCategoryItem(
          cat.type,
          parent.connectionName,
          parent.connection,
          cat.label,
          cat.icon,
          cat.action,
        ),
    );

    this.categoriesByConnection.set(parent.connectionName, categories);
    return categories;
  }

  private async fetchEntityItems(category: EntityCategoryItem): Promise<EntityItem[]> {
    const cacheKey = `${category.parentConnectionName}:${category.categoryType}`;
    const cached = this.entityCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    try {
      const connection = this.getConnection(category.parentConnectionName);
      if (!connection) { return []; }

      const result = await sendToPersistentProcess(
        category.parentConnectionName, this.context, connection,
        { action: category.action },
      );

      const rows: any[] = Array.isArray(result) ? result : result?.rows ?? result?.data ?? [];
      const names: string[] = rows
        .map((row: any) => {
          if (typeof row === "string") { return row; }
          if (typeof row === "object" && row !== null) {
            const vals = Object.values(row);
            return vals.length > 0 ? String(vals[0]) : "";
          }
          return String(row);
        })
        .filter((name: string) => name.length > 0);

      const items = names.map(
        (name) => new EntityItem(name, category.parentConnectionName, category.categoryType),
      );
      this.entityCache.set(cacheKey, items);

      // Update category description with count
      category.description = `${items.length}`;

      return items;
    } catch {
      return [];
    }
  }

  private getTableSubCategories(parent: EntityItem): TableSubCategoryItem[] {
    if (!EXPANDABLE_CATEGORIES.has(parent.categoryType)) {
      return [];
    }
    return [
      new TableSubCategoryItem("columns", parent.entityName, parent.parentConnectionName),
      new TableSubCategoryItem("indexes", parent.entityName, parent.parentConnectionName),
    ];
  }

  private async fetchTableDetails(sub: TableSubCategoryItem): Promise<(ColumnItem | IndexItem)[]> {
    const cacheKey = `${sub.parentConnectionName}:${sub.parentEntityName}:${sub.subType}`;
    const cached = this.tableDetailCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    try {
      const connection = this.getConnection(sub.parentConnectionName);
      if (!connection) { return []; }

      const action = sub.subType === "columns" ? "list-columns" : "list-indexes";

      const result = await sendToPersistentProcess(
        sub.parentConnectionName, this.context, connection,
        { action, query: sub.parentEntityName },
      );

      const rows: any[] = Array.isArray(result) ? result : result?.rows ?? result?.data ?? [];

      let items: (ColumnItem | IndexItem)[];
      if (sub.subType === "columns") {
        items = rows.map(
          (row: any) => new ColumnItem(
            row.column_name ?? row.name ?? "",
            sub.parentEntityName,
            sub.parentConnectionName,
            row.type ?? "",
            row.nullable ?? true,
            row.primary_key ?? false,
          ),
        );
      } else {
        items = rows.map(
          (row: any) => new IndexItem(
            row.index_name ?? row.name ?? "",
            sub.parentEntityName,
            sub.parentConnectionName,
            row.columns ?? "",
            row.unique ?? false,
            row.primary_key ?? false,
          ),
        );
      }

      this.tableDetailCache.set(cacheKey, items);
      sub.description = `${items.length}`;
      return items;
    } catch {
      return [];
    }
  }

  getConnections(): ConnectionStore {
    if (this.cachedConnections) {
      return this.cachedConnections;
    }

    const current = this.context.globalState.get(CONNECTION_STORE_KEY);
    const rawConnections = (current as Record<string, unknown> | undefined) ?? {};

    const normalizedConnections: ConnectionStore = {};
    for (const [name, rawConnection] of Object.entries(rawConnections)) {
      normalizedConnections[name] = normalizeConnection(rawConnection);
    }

    this.cachedConnections = normalizedConnections;
    return normalizedConnections;
  }

  async saveConnections(connections: ConnectionStore): Promise<void> {
    this.cachedConnections = undefined;
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
    const isNew = !connections[name];
    connections[name] = normalizeConnection(connection);
    await this.saveConnections(connections);
    // Auto-assign new connections to Default folder
    if (isNew) {
      const assignments = this.getFolderAssignments();
      if (!assignments[name]) {
        assignments[name] = DEFAULT_FOLDER_NAME;
        await this.saveFolderAssignments(assignments);
      }
    }
  }

  async deleteConnection(name: string): Promise<void> {
    const connections = this.getConnections();
    delete connections[name];
    await this.saveConnections(connections);
    // Clean up folder assignment
    const assignments = this.getFolderAssignments();
    delete assignments[name];
    await this.saveFolderAssignments(assignments);
  }

  // ── Folder storage ──

  getFolders(): string[] {
    const stored = this.context.globalState.get<string[]>(FOLDER_STORE_KEY);
    if (!stored || stored.length === 0) {
      return [DEFAULT_FOLDER_NAME];
    }
    return stored;
  }

  async saveFolders(folders: string[]): Promise<void> {
    await this.context.globalState.update(FOLDER_STORE_KEY, folders);
  }

  getFolderAssignments(): Record<string, string> {
    const stored = this.context.globalState.get<Record<string, string>>(FOLDER_ASSIGNMENTS_KEY);
    return stored ?? {};
  }

  async saveFolderAssignments(assignments: Record<string, string>): Promise<void> {
    await this.context.globalState.update(FOLDER_ASSIGNMENTS_KEY, assignments);
  }

  async createFolder(folderName: string): Promise<void> {
    const folders = this.getFolders();
    if (folders.includes(folderName)) {
      return;
    }
    folders.push(folderName);
    await this.saveFolders(folders);
    this.refresh();
  }

  async renameFolder(oldName: string, newName: string): Promise<void> {
    const folders = this.getFolders();
    const idx = folders.indexOf(oldName);
    if (idx < 0) { return; }
    folders[idx] = newName;
    await this.saveFolders(folders);
    // Re-assign connections
    const assignments = this.getFolderAssignments();
    for (const [connName, folder] of Object.entries(assignments)) {
      if (folder === oldName) {
        assignments[connName] = newName;
      }
    }
    await this.saveFolderAssignments(assignments);
    this.refresh();
  }

  async deleteFolder(folderName: string): Promise<void> {
    if (folderName === DEFAULT_FOLDER_NAME) { return; }
    const folders = this.getFolders();
    const idx = folders.indexOf(folderName);
    if (idx < 0) { return; }
    folders.splice(idx, 1);
    await this.saveFolders(folders);
    // Move connections in this folder to Default
    const assignments = this.getFolderAssignments();
    for (const [connName, folder] of Object.entries(assignments)) {
      if (folder === folderName) {
        assignments[connName] = DEFAULT_FOLDER_NAME;
      }
    }
    await this.saveFolderAssignments(assignments);
    this.refresh();
  }

  async moveConnectionToFolder(connectionName: string, folderName: string): Promise<void> {
    const assignments = this.getFolderAssignments();
    assignments[connectionName] = folderName;
    await this.saveFolderAssignments(assignments);
    this.refresh();
  }

  findFolder(folderName: string): FolderItem | undefined {
    return this.cachedFolders.find((f) => f.folderName === folderName);
  }

  // ── Drag and Drop ──

  handleDrag(
    source: readonly TreeItem[],
    dataTransfer: vscode.DataTransfer,
    _token: vscode.CancellationToken,
  ): void {
    const connectionItems = source.filter(
      (item): item is ConnectionItem => item instanceof ConnectionItem,
    );
    if (connectionItems.length === 0) { return; }
    dataTransfer.set(
      CONNECTION_DRAG_MIME,
      new vscode.DataTransferItem(connectionItems.map((c) => c.connectionName)),
    );
  }

  async handleDrop(
    target: TreeItem | undefined,
    dataTransfer: vscode.DataTransfer,
    _token: vscode.CancellationToken,
  ): Promise<void> {
    const transferItem = dataTransfer.get(CONNECTION_DRAG_MIME);
    if (!transferItem) { return; }

    const connectionNames = transferItem.value as string[];
    if (!Array.isArray(connectionNames) || connectionNames.length === 0) { return; }

    let targetFolder: string | undefined;
    if (target instanceof FolderItem) {
      targetFolder = target.folderName;
    } else if (target instanceof ConnectionItem) {
      targetFolder = target.parentFolderName;
    }
    if (!targetFolder) { return; }

    const assignments = this.getFolderAssignments();
    for (const name of connectionNames) {
      assignments[name] = targetFolder;
    }
    await this.saveFolderAssignments(assignments);
    this.refresh();
  }
}

export function activate(context: vscode.ExtensionContext) {
  const venvDir = path.join(context.globalStorageUri.fsPath, "python-env");
  console.log(`[SQL4All] venv path: ${venvDir}`);
  const connectionTreeProvider = new ConnectionTreeProvider(context);
  connectionTreeProviderRef = connectionTreeProvider;

  connectionTreeView = vscode.window.createTreeView(CONNECTION_VIEW_ID, {
    treeDataProvider: connectionTreeProvider,
    dragAndDropController: connectionTreeProvider,
  });
  connectionTreeView.onDidExpandElement(e => connectionTreeProvider.onDidExpand(e.element));
  connectionTreeView.onDidCollapseElement(e => connectionTreeProvider.onDidCollapse(e.element));
  context.subscriptions.push(connectionTreeView);

  // Toolbox tree view
  const toolboxProvider = new ToolboxTreeProvider();
  const toolboxTreeView = vscode.window.createTreeView(TOOLBOX_VIEW_ID, {
    treeDataProvider: toolboxProvider,
  });
  context.subscriptions.push(toolboxTreeView);
  registerToolboxCommands(context, toolboxProvider);

  initSqlExecutor({
    panelsByConnection,
    getDriverIcon: (conn) => connectionTreeProviderRef?.getDriverIcon(conn),
    revealConnection: (name) => revealConnection(name),
    getConnection: (name) => connectionTreeProvider.getConnection(name),
    onConnectionStateChanged: (name, connected) =>
      connectionTreeProvider.setConnectionState(name, connected),
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
      if (!(await checkPythonSetup(context))) { return; }
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
    async () => {
      if (!(await checkPythonSetup(context))) { return; }
      await addConnection(context, editorServices);
    },
  );

  const connectConnectionDisposable = vscode.commands.registerCommand(
    `${EXTENSION_NAMESPACE}.connectConnection`,
    async (item?: ConnectionItem) => {
      if (!(await checkPythonSetup(context))) { return; }
      if (!item) {
        void vscode.commands.executeCommand(
          `${EXTENSION_NAMESPACE}.openQueryPanel`,
        );
        return;
      }

      // If not connected, run the connect flow first
      if (!connectionTreeProvider.isConnected(item.connectionName)) {
        const ok = await connectionTreeProvider.connectAndListTables(item.connectionName);
        if (!ok) {
          return;
        }
      }

      createOrShowPanel(context, item.connectionName, item.connection);
    },
  );

  const editConnectionDisposable = vscode.commands.registerCommand(
    `${EXTENSION_NAMESPACE}.editConnection`,
    async (item?: ConnectionItem) => {
      if (!(await checkPythonSetup(context))) { return; }
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

  const cloneConnectionDisposable = vscode.commands.registerCommand(
    `${EXTENSION_NAMESPACE}.cloneConnection`,
    async (item?: ConnectionItem) => {
      if (!item) {
        return;
      }

      const connections = connectionTreeProvider.getConnections();
      const baseName = item.connectionName;
      let clonedName: string;
      do {
        clonedName = `${baseName}_${generateRandomSuffix()}`;
      } while (connections[clonedName]);

      await connectionTreeProvider.upsertConnection(
        clonedName,
        normalizeConnection(item.connection),
      );

      // Place clone in the same folder as source
      await connectionTreeProvider.moveConnectionToFolder(
        clonedName,
        item.parentFolderName,
      );

      revealConnectionInTree(connectionTreeProvider, clonedName);
      vscode.window.showInformationMessage(
        `Connection cloned as "${clonedName}".`,
      );
    },
  );

  const copyTableNameDisposable = vscode.commands.registerCommand(
    `${EXTENSION_NAMESPACE}.copyTableName`,
    async (item?: EntityItem | ColumnItem | IndexItem) => {
      let name: string | undefined;
      if (item instanceof EntityItem) {
        name = item.entityName;
      } else if (item instanceof ColumnItem) {
        name = item.columnName;
      } else if (item instanceof IndexItem) {
        name = item.indexName;
      }
      if (!name) {
        return;
      }
      await vscode.env.clipboard.writeText(name);
      vscode.window.setStatusBarMessage(
        `Copied: ${name}`,
        2000,
      );
    },
  );

  const connectDatabaseDisposable = vscode.commands.registerCommand(
    `${EXTENSION_NAMESPACE}.connectDatabase`,
    async (item?: ConnectionItem) => {
      if (!item) {
        return;
      }

      await connectionTreeProvider.connectAndListTables(item.connectionName);
    },
  );

  const disconnectDatabaseDisposable = vscode.commands.registerCommand(
    `${EXTENSION_NAMESPACE}.disconnectDatabase`,
    async (item?: ConnectionItem) => {
      if (!item) {
        return;
      }

      const name = item.connectionName;

      const answer = await vscode.window.showWarningMessage(
        `Disconnect from "${name}"? This will close the SQL editor and release the connection.`,
        { modal: true },
        "Disconnect",
      );

      if (answer !== "Disconnect") {
        return;
      }

      // Close the SQL editor panel
      const panel = panelsByConnection.get(name);
      if (panel) {
        panel.dispose();
      }

      // Kill persistent Python subprocess (keep saved state)
      killPersistentProcess(name);

      // Reset icon, clear tables, full tree rebuild
      connectionTreeProvider.disconnectAndRefresh(name);
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

  const refreshConnectionDisposable = vscode.commands.registerCommand(
    `${EXTENSION_NAMESPACE}.refreshConnection`,
    async (item?: ConnectionItem) => {
      if (!item) {
        return;
      }

      await connectionTreeProvider.connectAndListTables(item.connectionName);
    },
  );

  const selectPythonExecutableDisposable = vscode.commands.registerCommand(
    `${EXTENSION_NAMESPACE}.selectPythonExecutable`,
    () => selectPythonExecutable(context),
  );

  const exportConnectionsDisposable = vscode.commands.registerCommand(
    `${EXTENSION_NAMESPACE}.exportConnections`,
    () => exportConnections(connectionTreeProvider),
  );

  const importConnectionsDisposable = vscode.commands.registerCommand(
    `${EXTENSION_NAMESPACE}.importConnections`,
    () => importConnections(connectionTreeProvider),
  );

  const createFolderDisposable = vscode.commands.registerCommand(
    `${EXTENSION_NAMESPACE}.createFolder`,
    async () => {
      const name = await vscode.window.showInputBox({
        prompt: "Enter folder name",
        placeHolder: "Folder name",
        validateInput: (value) => {
          const trimmed = value.trim();
          if (!trimmed) { return "Folder name cannot be empty."; }
          if (connectionTreeProvider.getFolders().includes(trimmed)) {
            return `Folder "${trimmed}" already exists.`;
          }
          return undefined;
        },
      });
      if (!name) { return; }
      await connectionTreeProvider.createFolder(name.trim());
    },
  );

  const renameFolderDisposable = vscode.commands.registerCommand(
    `${EXTENSION_NAMESPACE}.renameFolder`,
    async (item?: FolderItem) => {
      if (!item) { return; }
      const newName = await vscode.window.showInputBox({
        prompt: `Rename folder "${item.folderName}"`,
        value: item.folderName,
        validateInput: (value) => {
          const trimmed = value.trim();
          if (!trimmed) { return "Folder name cannot be empty."; }
          if (trimmed !== item.folderName && connectionTreeProvider.getFolders().includes(trimmed)) {
            return `Folder "${trimmed}" already exists.`;
          }
          return undefined;
        },
      });
      if (!newName || newName.trim() === item.folderName) { return; }
      await connectionTreeProvider.renameFolder(item.folderName, newName.trim());
    },
  );

  const deleteFolderDisposable = vscode.commands.registerCommand(
    `${EXTENSION_NAMESPACE}.deleteFolder`,
    async (item?: FolderItem) => {
      if (!item) { return; }
      if (item.folderName === DEFAULT_FOLDER_NAME) {
        vscode.window.showWarningMessage("The Default folder cannot be deleted.");
        return;
      }
      const answer = await vscode.window.showWarningMessage(
        `Delete folder "${item.folderName}"? Connections will be moved to "${DEFAULT_FOLDER_NAME}".`,
        { modal: true },
        "Delete",
      );
      if (answer !== "Delete") { return; }
      await connectionTreeProvider.deleteFolder(item.folderName);
    },
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
    cloneConnectionDisposable,
    copyTableNameDisposable,
    connectDatabaseDisposable,
    disconnectDatabaseDisposable,
    reloadDriverDisposable,
    refreshConnectionDisposable,
    selectPythonExecutableDisposable,
    exportConnectionsDisposable,
    importConnectionsDisposable,
    createFolderDisposable,
    renameFolderDisposable,
    deleteFolderDisposable,
    statusBar,
  );

  console.log(`${BRAND_NAME} extension activated`);

  // Check Python availability on first activation
  checkPythonSetup(context);
}

async function exportConnections(provider: ConnectionTreeProvider): Promise<void> {
  const connections = provider.getConnections();
  const names = Object.keys(connections).sort((a, b) => a.localeCompare(b));

  if (names.length === 0) {
    vscode.window.showInformationMessage("No connections to export.");
    return;
  }

  const assignments = provider.getFolderAssignments();
  const folders = provider.getFolders();

  const picks = names
    .map((name) => ({
      label: `${assignments[name] || DEFAULT_FOLDER_NAME} \\ ${name}`,
      picked: true,
      connectionName: name,
      folderIndex: folders.indexOf(assignments[name] || DEFAULT_FOLDER_NAME),
    }))
    .sort((a, b) => {
      if (a.folderIndex !== b.folderIndex) { return a.folderIndex - b.folderIndex; }
      return a.connectionName.localeCompare(b.connectionName);
    });

  const selected = await vscode.window.showQuickPick(picks, {
    canPickMany: true,
    placeHolder: "Select connections to export",
    title: "Export Connections",
  });

  if (!selected || selected.length === 0) {
    return;
  }

  const proceed = await vscode.window.showWarningMessage(
    "Passwords will not be included in the exported file. You will need to re-enter them after importing.",
    { modal: true },
    "Continue",
  );

  if (proceed !== "Continue") {
    return;
  }

  const uri = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.file("sql4all-connections.json"),
    filters: { "JSON Files": ["json"] },
    title: "Save Connections",
  });

  if (!uri) {
    return;
  }

  const exportData: Record<string, unknown> = {};
  const folderAssignments: Record<string, string> = {};
  for (const item of selected) {
    const name = (item as any).connectionName as string;
    const conn = { ...connections[name] };
    // Remove password from exported data
    conn.password = "";
    if (conn.connectionString) {
      conn.connectionString = maskPasswordInUri(conn.connectionString);
    }
    exportData[name] = conn;
    if (assignments[name]) {
      folderAssignments[name] = assignments[name];
    }
  }
  exportData.__folderAssignments__ = folderAssignments;

  const content = JSON.stringify(exportData, null, 2);
  await vscode.workspace.fs.writeFile(uri, Buffer.from(content, "utf-8"));
  vscode.window.showInformationMessage(
    `Exported ${selected.length} connection(s) successfully.`,
  );
}

function generateRandomSuffix(length: number = 6): string {
  return Math.random().toString(36).substring(2, 2 + length);
}

async function importConnections(provider: ConnectionTreeProvider): Promise<void> {
  const uris = await vscode.window.showOpenDialog({
    canSelectMany: false,
    filters: { "JSON Files": ["json"] },
    title: "Import Connections",
  });

  if (!uris || uris.length === 0) {
    return;
  }

  let rawData: Record<string, unknown>;
  try {
    const bytes = await vscode.workspace.fs.readFile(uris[0]);
    rawData = JSON.parse(Buffer.from(bytes).toString("utf-8"));
  } catch (err: any) {
    vscode.window.showErrorMessage(
      `Failed to read import file: ${err?.message || String(err)}`,
    );
    return;
  }

  if (!rawData || typeof rawData !== "object" || Array.isArray(rawData)) {
    vscode.window.showErrorMessage("Invalid connection file format.");
    return;
  }

  const existingConnections = provider.getConnections();
  const importedFolderAssignments: Record<string, string> =
    (rawData.__folderAssignments__ && typeof rawData.__folderAssignments__ === "object"
      && !Array.isArray(rawData.__folderAssignments__))
      ? rawData.__folderAssignments__ as Record<string, string>
      : {};
  let importedCount = 0;

  for (const [name, rawConn] of Object.entries(rawData)) {
    if (name === "__folderAssignments__") { continue; }
    const connection = normalizeConnection(rawConn);
    let finalName = name;

    if (existingConnections[name]) {
      const choice = await vscode.window.showWarningMessage(
        `Connection "${name}" already exists.`,
        { modal: true },
        "Overwrite",
        "Rename",
        "Skip",
      );

      if (choice === "Skip" || !choice) {
        continue;
      }

      if (choice === "Rename") {
        finalName = `${name}_${generateRandomSuffix()}`;
      }
    }

    existingConnections[finalName] = connection;
    importedCount++;
  }

  if (importedCount > 0) {
    await provider.saveConnections(existingConnections);
    // Restore folder assignments from export data, or default
    const assignments = provider.getFolderAssignments();
    const folders = provider.getFolders();
    for (const name of Object.keys(existingConnections)) {
      if (!assignments[name]) {
        const exportedFolder = importedFolderAssignments[name];
        if (exportedFolder) {
          // Ensure the folder exists
          if (!folders.includes(exportedFolder)) {
            folders.push(exportedFolder);
          }
          assignments[name] = exportedFolder;
        } else {
          assignments[name] = DEFAULT_FOLDER_NAME;
        }
      }
    }
    await provider.saveFolders(folders);
    await provider.saveFolderAssignments(assignments);
    vscode.window.showInformationMessage(
      `Imported ${importedCount} connection(s) successfully.`,
    );
  }
}

async function checkPythonSetup(context: vscode.ExtensionContext): Promise<boolean> {
  const venvDir = path.join(context.globalStorageUri.fsPath, "python-env");
  const venvPython =
    process.platform === "win32"
      ? path.join(venvDir, "Scripts", "python.exe")
      : path.join(venvDir, "bin", "python");

  // Skip if venv already exists
  if (fs.existsSync(venvPython)) {
    return true;
  }

  // Check if configured path exists
  if (getConfiguredPythonPath()) {
    return true;
  }

  // Try to resolve system Python silently
  try {
    await resolveSystemPython();
    return true;
  } catch {
    // No Python found — prompt user
    const action = await vscode.window.showWarningMessage(
      `${BRAND_NAME} requires Python 3.9+ to run queries. No Python installation was detected.`,
      "Select Python Executable",
    );
    if (action === "Select Python Executable") {
      await selectPythonExecutable(context);
      // Re-check after selection
      return !!(getConfiguredPythonPath());
    }
    return false;
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
  envVars?: Record<string, string>,
): Promise<string> {
  const pythonExecutable = await ensurePythonEnvironment(context);
  return runProcess(pythonExecutable, scriptArgs, onSpawn, envVars);
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

async function runProcess(command: string, args: string[], onSpawn?: (child: ChildProcess) => void, envVars?: Record<string, string>): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const spawnOptions: any = {};
    const mergedEnv = { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1", ...envVars };
    spawnOptions.env = mergedEnv;
    const child = spawn(command, args, spawnOptions);
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
