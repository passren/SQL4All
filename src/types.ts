export interface DbConnection {
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
}

export type ConnectionStore = Record<string, DbConnection>;

export function normalizeAdditionalParameters(
  value: unknown,
): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  const normalized: Record<string, string> = {};
  for (const [key, rawValue] of Object.entries(value as Record<string, unknown>)) {
    const normalizedKey = String(key || "").trim();
    if (!normalizedKey) {
      continue;
    }

    normalized[normalizedKey] = String(rawValue ?? "");
  }

  return normalized;
}

export function normalizeConnection(raw: unknown): DbConnection {
  const source = (raw && typeof raw === "object")
    ? (raw as Record<string, unknown>)
    : {};

  const rawAdditionalParameters =
    source.additionalParameters
    ?? source.additional_parameters
    ?? source.params
    ?? source.parameters;

  const normalizedPort = Number(source.port);

  return {
    host: String(source.host ?? "localhost"),
    port: Number.isInteger(normalizedPort) && normalizedPort > 0
      ? normalizedPort
      : undefined,
    database: String(source.database ?? ""),
    username: String(source.username ?? ""),
    password: String(source.password ?? ""),
    driver: String(source.driver ?? source.dbDriver ?? "").trim(),
    dialect: String(source.dialect ?? "").trim() || undefined,
    connectionString: String(source.connectionString ?? "").trim() || undefined,
    databaseType: String(source.databaseType ?? "").trim() || undefined,
    additionalParameters: normalizeAdditionalParameters(rawAdditionalParameters),
    envVars: normalizeAdditionalParameters(source.envVars),
  };
}

export function formatConnectionSummary(
  connection: DbConnection,
): string {
  if (connection.connectionString) {
    return connection.connectionString;
  }

  const host = connection.host || "";
  const portSegment = Number.isInteger(connection.port)
    ? `:${connection.port}`
    : "";
  const databaseSegment = connection.database?.trim()
    ? `/${connection.database.trim()}`
    : "";

  return `${host}${portSegment}${databaseSegment}`;
}

export function formatConnectionTooltip(
  connectionName: string,
  summary: string,
  connection: DbConnection,
): string {
  const lines = [connectionName, summary];
  if (connection.database?.trim()) {
    lines.push(`DB: ${connection.database.trim()}`);
  }

  return lines.filter(Boolean).join("\n");
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

export const EXTENSION_NAMESPACE = "sql4all";
export const BRAND_NAME = "SQL4ALL";
export const CONNECTION_VIEW_ID = `${EXTENSION_NAMESPACE}.connections`;
export const CONNECTION_ITEM_CONTEXT = `${EXTENSION_NAMESPACE}.connectionItem`;
export const CONNECTION_STORE_KEY = `${EXTENSION_NAMESPACE}.connections`;
export const QUERY_DRAFTS_STORE_KEY = `${EXTENSION_NAMESPACE}.queryDrafts`;
export const QUERY_LAYOUTS_STORE_KEY = `${EXTENSION_NAMESPACE}.queryLayouts`;
export const PYTHON_SETTING_KEY = "pythonPath";
export const READY_MARKER_FILE = ".sql4all-ready";
export const INSTALLED_DRIVERS_STORE_KEY = `${EXTENSION_NAMESPACE}.installedDrivers`;
export const RECENT_FILES_STORE_KEY = `${EXTENSION_NAMESPACE}.recentFiles`;
export const LINKED_FILES_STORE_KEY = `${EXTENSION_NAMESPACE}.linkedFiles`;
export const NEW_CONNECTION = "__NEW_CONNECTION__";
export const TABLE_ITEM_CONTEXT = `${EXTENSION_NAMESPACE}.tableItem`;
