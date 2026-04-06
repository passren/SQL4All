const vscode = acquireVsCodeApi();

function maskPasswordInUri(uri) {
  try {
    return uri.replace(
      /(:\/\/[^:/?#]+):([^@]+)@/,
      (_, prefix) => prefix + ":***@",
    );
  } catch {
    return uri;
  }
}

const initial = window.__SQL4ALL_CONNECTION_EDITOR__ || {
  name: "",
  connection: {
    host: "localhost",
    database: "",
    username: "",
    password: "",
    driver: "",
    additionalParameters: {},
  },
};

let driverConfig = initial.driverConfig || {
  databases: {},
};

function findDatabaseTypeByDriver(driverName) {
  const normalizedDriverName = String(driverName || "").trim().toLowerCase();
  if (!normalizedDriverName) {
    return "";
  }

  for (const [dbType, dbConfig] of Object.entries(driverConfig.databases || {})) {
    const configuredDriver = String(dbConfig?.driver || "").trim().toLowerCase();
    if (!configuredDriver) {
      continue;
    }

    if (
      configuredDriver === normalizedDriverName
      || normalizedDriverName.includes(configuredDriver)
      || configuredDriver.includes(normalizedDriverName)
    ) {
      return dbType;
    }
  }

  return "";
}

function getSelectedDialect() {
  const dialectInput = document.getElementById("dialectInput");
  if (dialectInput && !dialectInput.hidden) {
    return dialectInput.value.trim();
  }
  return document.getElementById("dialect")?.value || "";
}

function buildConnectionStringFromTemplate(template, options) {
  const normalizedTemplate = String(template || "");
  const rawDatabase = options.database
    ? String(options.database)
    : "";
  const dialect = options.dialect || "";

  return normalizedTemplate
    .replace("dialect", dialect)
    .replace("[username[:password]@]", options.credentials)
    .replace("host", options.host)
    .replace("[:port]", options.port ? `:${options.port}` : "")
    .replace("/[database]", rawDatabase ? `/${rawDatabase}` : "")
    .replace("/[service_name]", rawDatabase ? `/${rawDatabase}` : "")
    .replace("[database]", rawDatabase)
    .replace("[service_name]", rawDatabase)
    .replace("[?additionalParameters]", "");
}

function populateDialects(dbType) {
  const dialectSelect = document.getElementById("dialect");
  if (!dialectSelect) {
    return;
  }

  dialectSelect.innerHTML = "";

  const dialects = (dbType && driverConfig.databases && driverConfig.databases[dbType])
    ? (driverConfig.databases[dbType].dialects || [])
    : [];

  if (dialects.length === 0) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "-- No dialects available --";
    dialectSelect.appendChild(opt);
    return;
  }

  for (const d of dialects) {
    const opt = document.createElement("option");
    opt.value = d;
    opt.textContent = d;
    dialectSelect.appendChild(opt);
  }

  dialectSelect.value = dialects[0];
}

function populateDatabaseTypes() {
  const list = document.getElementById("dbTypeList");
  if (!list) {
    return;
  }

  list.innerHTML = "";

  // Placeholder entry
  const placeholder = document.createElement("li");
  placeholder.className = "db-type-option db-type-option-placeholder";
  placeholder.setAttribute("role", "option");
  placeholder.setAttribute("aria-selected", "false");
  placeholder.setAttribute("data-value", "");
  placeholder.textContent = "-- Select Database --";
  placeholder.addEventListener("click", () => selectDbType("", null, "-- Select Database --"));
  list.appendChild(placeholder);

  for (const [dbType, dbConfig] of Object.entries(
    driverConfig.databases || {},
  )) {
    const li = document.createElement("li");
    li.className = "db-type-option";
    li.setAttribute("role", "option");
    li.setAttribute("aria-selected", "false");
    li.setAttribute("data-value", dbType);

    if (dbConfig.icon) {
      const img = document.createElement("img");
      img.src = dbConfig.icon;
      img.alt = dbType;
      img.width = 14;
      img.height = 14;
      li.appendChild(img);
    }

    const nameSpan = document.createElement("span");
    nameSpan.textContent = dbType.charAt(0).toUpperCase() + dbType.slice(1);
    li.appendChild(nameSpan);

    li.addEventListener("click", () =>
      selectDbType(
        dbType,
        dbConfig.icon || null,
        nameSpan.textContent,
      ),
    );
    list.appendChild(li);
  }
}

document.getElementById("name").value = initial.name || "";
document.getElementById("host").value = initial.connection.host || "localhost";
document.getElementById("port").value = initial.connection.port
  ? String(initial.connection.port)
  : "";
document.getElementById("database").value = initial.connection.database || "";
document.getElementById("username").value = initial.connection.username || "";
document.getElementById("password").value = initial.connection.password || "";
document.getElementById("driver").value = initial.connection.driver || "";

// Driver installation status
const driverStatusEl = document.getElementById("driverStatus");
const installedDrivers = initial.installedDrivers || {};

function updateDriverStatus(driverName, version) {
  if (!driverName) {
    driverStatusEl.setAttribute("hidden", "");
    driverStatusEl.textContent = "";
    return;
  }
  const key = driverName.trim().toLowerCase();
  const val = version !== undefined ? version : installedDrivers[key];
  if (val) {
    const versionText = typeof val === "string" ? val : "";
    driverStatusEl.textContent = versionText
      ? "\u2714 Installed (v" + versionText + ")"
      : "\u2714 Installed";
    driverStatusEl.removeAttribute("hidden");
  } else {
    driverStatusEl.setAttribute("hidden", "");
    driverStatusEl.textContent = "";
  }
}

updateDriverStatus(initial.connection.driver || "");

document.getElementById("driver").addEventListener("input", function () {
  updateDriverStatus(this.value);
});

const paramsBody = document.getElementById("additionalParamsBody");
const paramsEmpty = document.getElementById("additionalParamsEmpty");

const envVarsBody = document.getElementById("envVarsBody");
const envVarsEmpty = document.getElementById("envVarsEmpty");

// Handle database type selection
const dbTypeWidget = document.getElementById("dbTypeWidget");
const dbTypeHidden = document.getElementById("databaseType");

function selectDbType(dbType, iconSrc, label) {
  const iconEl = document.getElementById("dbTypeIcon");
  const labelEl = document.getElementById("dbTypeLabel");
  const list = document.getElementById("dbTypeList");

  // Update hidden value (used by updateConnectionString)
  dbTypeHidden.value = dbType;

  // Show/hide icon
  if (iconSrc) {
    iconEl.src = iconSrc;
    iconEl.alt = dbType;
    iconEl.removeAttribute("hidden");
  } else {
    iconEl.src = "";
    iconEl.alt = "";
    iconEl.setAttribute("hidden", "");
  }

  // Update button label
  labelEl.textContent = label || "-- Select Database --";

  // Update aria-selected on list items
  if (list) {
    for (const li of list.querySelectorAll("[data-value]")) {
      li.setAttribute(
        "aria-selected",
        li.getAttribute("data-value") === dbType ? "true" : "false",
      );
    }
  }

  closeDbTypeDropdown();

  // Populate dialect dropdown for this database type
  populateDialects(dbType);

  // Toggle dialect input vs select for "other" type
  const dialectSelect = document.getElementById("dialect");
  const dialectInput = document.getElementById("dialectInput");
  if (dbType === "other") {
    dialectSelect.setAttribute("hidden", "");
    dialectInput.removeAttribute("hidden");
  } else {
    dialectInput.setAttribute("hidden", "");
    dialectInput.value = "";
    dialectSelect.removeAttribute("hidden");
  }

  // Apply driver defaults
  if (dbType === "other") {
    // For "other" type, keep the existing driver value so the user can enter their own
  } else if (dbType && driverConfig.databases && driverConfig.databases[dbType]) {
    const dbConfig = driverConfig.databases[dbType];
    document.getElementById("driver").value = dbConfig.driver;
    if (typeof dbConfig.default_port === "number" && dbConfig.default_port > 0) {
      document.getElementById("port").value = String(dbConfig.default_port);
    }
  } else {
    document.getElementById("driver").value = "";
  }

  // Make connection string editable
  const connStringEl = document.getElementById("connectionString");
  connStringEl.removeAttribute("readonly");
  connStringEl.classList.add("editable");

  updateDriverStatus(document.getElementById("driver").value);
  updateConnectionString();
}

function openDbTypeDropdown() {
  dbTypeWidget?.setAttribute("aria-expanded", "true");
}

function closeDbTypeDropdown() {
  dbTypeWidget?.setAttribute("aria-expanded", "false");
}

if (dbTypeWidget) {
  dbTypeWidget.addEventListener("click", (e) => {
    if (!e.target.closest(".db-type-option")) {
      const isOpen = dbTypeWidget.getAttribute("aria-expanded") === "true";
      isOpen ? closeDbTypeDropdown() : openDbTypeDropdown();
    }
  });

  dbTypeWidget.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      const isOpen = dbTypeWidget.getAttribute("aria-expanded") === "true";
      isOpen ? closeDbTypeDropdown() : openDbTypeDropdown();
    } else if (e.key === "Escape") {
      closeDbTypeDropdown();
    }
  });

  document.addEventListener("click", (e) => {
    if (!dbTypeWidget.contains(e.target)) {
      closeDbTypeDropdown();
    }
  });

  populateDatabaseTypes();

  const initialDatabaseType = initial.connection.databaseType || findDatabaseTypeByDriver(initial.connection.driver);
  if (initialDatabaseType && driverConfig.databases?.[initialDatabaseType]) {
    const dbConfig = driverConfig.databases[initialDatabaseType];
    selectDbType(
      initialDatabaseType,
      dbConfig.icon || null,
      initialDatabaseType.charAt(0).toUpperCase() + initialDatabaseType.slice(1),
    );

    // Restore saved dialect selection
    if (initial.connection.dialect) {
      if (initialDatabaseType === "other") {
        document.getElementById("dialectInput").value = initial.connection.dialect;
      } else {
        document.getElementById("dialect").value = initial.connection.dialect;
      }
      updateConnectionString();
    }

    // Restore the saved connection string if it was manually edited
    if (initial.connection.connectionString) {
      const connStringEl = document.getElementById("connectionString");
      const maskedConnectionString = maskPasswordInUri(initial.connection.connectionString);
      if (connStringEl.value !== maskedConnectionString) {
        connStringEl.value = maskedConnectionString;
        connStringEl.dataset.manuallyEdited = "true";
      }
    }
  }
}

function refreshParamsEmptyState() {
  paramsEmpty.style.display =
    paramsBody.children.length === 0 ? "block" : "none";
}

function createParamRow(key = "", value = "") {
  const row = document.createElement("tr");

  const keyCell = document.createElement("td");
  const keyInput = document.createElement("input");
  keyInput.className = "param-input";
  keyInput.value = key;
  keyInput.addEventListener("input", updateConnectionString);
  keyCell.appendChild(keyInput);

  const valueCell = document.createElement("td");
  const valueInput = document.createElement("input");
  valueInput.className = "param-input";
  valueInput.value = value;
  valueInput.addEventListener("input", updateConnectionString);
  valueCell.appendChild(valueInput);

  const actionCell = document.createElement("td");
  const deleteBtn = document.createElement("button");
  deleteBtn.type = "button";
  deleteBtn.className = "secondary icon-btn";
  deleteBtn.textContent = "x";
  deleteBtn.title = "Delete parameter";
  deleteBtn.setAttribute("aria-label", "Delete parameter");
  deleteBtn.addEventListener("click", () => {
    row.remove();
    refreshParamsEmptyState();
    updateConnectionString();
  });
  actionCell.appendChild(deleteBtn);

  row.appendChild(keyCell);
  row.appendChild(valueCell);
  row.appendChild(actionCell);
  paramsBody.appendChild(row);
  refreshParamsEmptyState();
}

function loadInitialParams() {
  const safeDecode = (value) => {
    try {
      return decodeURIComponent(value || "");
    } catch {
      return String(value || "");
    }
  };

  let initialParams = initial.connection.additionalParameters || {};
  if (Object.keys(initialParams).length === 0) {
    const existingConnectionString = String(
      initial.connection.connectionString || "",
    );
    const queryIndex = existingConnectionString.indexOf("?");
    if (queryIndex >= 0) {
      const queryString = existingConnectionString.slice(queryIndex + 1);
      const parsedFallback = {};
      for (const chunk of queryString.split("&")) {
        if (!chunk) {
          continue;
        }

        const [rawKey, rawValue = ""] = chunk.split("=");
        const key = safeDecode(rawKey).trim();
        if (!key) {
          continue;
        }

        parsedFallback[key] = safeDecode(rawValue);
      }

      initialParams = parsedFallback;
    }
  }

  Object.entries(initialParams).forEach(([key, value]) => {
    createParamRow(String(key || ""), String(value || ""));
  });
  refreshParamsEmptyState();
}

function collectAdditionalParameters() {
  const result = {};
  const rows = Array.from(paramsBody.querySelectorAll("tr"));
  for (const row of rows) {
    const inputs = row.querySelectorAll("input");
    if (inputs.length < 2) {
      continue;
    }

    const key = inputs[0].value.trim();
    if (!key) {
      continue;
    }

    result[key] = inputs[1].value;
  }

  return result;
}

// --- Environment Variables ---
function refreshEnvVarsEmptyState() {
  envVarsEmpty.style.display =
    envVarsBody.children.length === 0 ? "block" : "none";
}

function createEnvVarRow(key = "", value = "") {
  const row = document.createElement("tr");

  const keyCell = document.createElement("td");
  const keyInput = document.createElement("input");
  keyInput.className = "param-input";
  keyInput.value = key;
  keyCell.appendChild(keyInput);

  const valueCell = document.createElement("td");
  const valueInput = document.createElement("input");
  valueInput.className = "param-input";
  valueInput.value = value;
  valueCell.appendChild(valueInput);

  const actionCell = document.createElement("td");
  const deleteBtn = document.createElement("button");
  deleteBtn.type = "button";
  deleteBtn.className = "secondary icon-btn";
  deleteBtn.textContent = "x";
  deleteBtn.title = "Delete environment variable";
  deleteBtn.setAttribute("aria-label", "Delete environment variable");
  deleteBtn.addEventListener("click", () => {
    row.remove();
    refreshEnvVarsEmptyState();
  });
  actionCell.appendChild(deleteBtn);

  row.appendChild(keyCell);
  row.appendChild(valueCell);
  row.appendChild(actionCell);
  envVarsBody.appendChild(row);
  refreshEnvVarsEmptyState();
}

function loadInitialEnvVars() {
  const initialEnvVars = initial.connection.envVars || {};
  Object.entries(initialEnvVars).forEach(([key, value]) => {
    createEnvVarRow(String(key || ""), String(value || ""));
  });
  refreshEnvVarsEmptyState();
}

function collectEnvVars() {
  const result = {};
  const rows = Array.from(envVarsBody.querySelectorAll("tr"));
  for (const row of rows) {
    const inputs = row.querySelectorAll("input");
    if (inputs.length < 2) {
      continue;
    }

    const key = inputs[0].value.trim();
    if (!key) {
      continue;
    }

    result[key] = inputs[1].value;
  }

  return result;
}

function updateConnectionString() {
  const host = document.getElementById("host").value.trim() || "localhost";
  const port = document.getElementById("port").value.trim();
  const database = document.getElementById("database").value.trim();
  const username = document.getElementById("username").value.trim();
  const password = document.getElementById("password").value;
  const additionalParameters = collectAdditionalParameters();
  const selectedDb = document.getElementById("databaseType")?.value;
  const currentDriver = document.getElementById("driver").value;
  const selectedDialect = getSelectedDialect();

  const maskedPass = password ? "*".repeat(password.length) : "";
  let credentials = "";
  if (username) {
    credentials = username + (password ? ":" + maskedPass : "") + "@";
  }

  let connectionString = "";

  // Use template-based generation if database type is selected,
  // otherwise resolve by driver field to keep edit mode in sync.
  const resolvedDbType = selectedDb || findDatabaseTypeByDriver(currentDriver);
  if (
    resolvedDbType &&
    driverConfig.databases &&
    driverConfig.databases[resolvedDbType]
  ) {
    const template = driverConfig.databases[resolvedDbType].uri_template;
    connectionString = buildConnectionStringFromTemplate(template, {
      dialect: selectedDialect,
      credentials,
      host,
      port,
      database,
    });
  }

  // Append additional parameters
  const query = Object.entries(additionalParameters)
    .map(([key, value]) => encodeURIComponent(key) + "=" + encodeURIComponent(String(value)))
    .join("&");

  if (connectionString && query) {
    connectionString += connectionString.includes("?")
      ? "&" + query
      : "?" + query;
  }

  const connStringEl = document.getElementById("connectionString");
  if (connStringEl.dataset.manuallyEdited === "true") {
    return;
  }
  connStringEl.value = connectionString;
  document.getElementById("copyStatus").textContent = "";
  document.getElementById("copyStatus").classList.remove("error");
}

async function copyConnectionString() {
  const connectionString = document.getElementById("connectionString").value;
  const copyStatus = document.getElementById("copyStatus");

  if (!connectionString) {
    copyStatus.textContent = "Nothing to copy.";
    copyStatus.classList.add("error");
    return;
  }

  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(connectionString);
    } else {
      const tempInput = document.createElement("textarea");
      tempInput.value = connectionString;
      tempInput.setAttribute("readonly", "");
      tempInput.style.position = "absolute";
      tempInput.style.left = "-9999px";
      document.body.appendChild(tempInput);
      tempInput.select();
      document.execCommand("copy");
      document.body.removeChild(tempInput);
    }

    copyStatus.textContent = "Copied to clipboard.";
    copyStatus.classList.remove("error");
  } catch {
    copyStatus.textContent = "Copy failed. Please copy manually.";
    copyStatus.classList.add("error");
  }
}

loadInitialParams();
loadInitialEnvVars();
updateConnectionString();

// When user directly edits connection string, mark it to preserve the value
document.getElementById("connectionString").addEventListener("input", function () {
  this.dataset.manuallyEdited = "true";
});

document.getElementById("addParam").addEventListener("click", () => {
  createParamRow("", "");
  updateConnectionString();
});

document.getElementById("addEnvVar").addEventListener("click", () => {
  createEnvVarRow("", "");
});

document
  .getElementById("copyConnectionString")
  .addEventListener("click", () => {
    copyConnectionString();
  });

function clearManualEdit() {
  document.getElementById("connectionString").dataset.manuallyEdited = "";
  updateConnectionString();
}

["host", "port", "database", "username", "password", "driver"].forEach((id) => {
  document.getElementById(id).addEventListener("input", clearManualEdit);
});

document.getElementById("dialect").addEventListener("change", clearManualEdit);
document.getElementById("dialectInput").addEventListener("input", clearManualEdit);

const saveBtn = document.getElementById("save");
saveBtn.dataset.originalLabel = saveBtn.textContent;

saveBtn.addEventListener("click", () => {
  const selectedDbType = document.getElementById("databaseType").value;
  if (!selectedDbType) {
    document.getElementById("error").textContent = "Please select a database type.";
    return;
  }

  const rawPort = document.getElementById("port").value.trim();
  const username = document.getElementById("username").value;
  const password = document.getElementById("password").value;
  const driver = document.getElementById("driver").value;
  const selectedDialect = getSelectedDialect();
  const additionalParameters = collectAdditionalParameters();

  // Build real connection string with actual password for backend
  const connStringEl = document.getElementById("connectionString");
  let realConnectionString = "";
  if (connStringEl.dataset.manuallyEdited === "true") {
    // User manually edited the connection string — use it as-is
    realConnectionString = connStringEl.value;
  } else {
    const resolvedDbType = selectedDbType || findDatabaseTypeByDriver(driver);
    if (resolvedDbType && driverConfig.databases && driverConfig.databases[resolvedDbType]) {
      const template = driverConfig.databases[resolvedDbType].uri_template;
      let creds = "";
      if (username) {
        const encodedUser = encodeURIComponent(username);
        const encodedPass = password ? encodeURIComponent(password) : "";
        creds = encodedUser + (password ? ":" + encodedPass : "") + "@";
      }
      realConnectionString = buildConnectionStringFromTemplate(template, {
        dialect: selectedDialect,
        credentials: creds,
        host: document.getElementById("host").value.trim() || "localhost",
        port: rawPort,
        database: document.getElementById("database").value.trim(),
      });
      const query = Object.entries(additionalParameters)
        .map(([key, value]) => encodeURIComponent(key) + "=" + encodeURIComponent(String(value)))
        .join("&");
      if (realConnectionString && query) {
        realConnectionString += realConnectionString.includes("?") ? "&" + query : "?" + query;
      }
    }
  }

  const data = {
    name: document.getElementById("name").value,
    host: document.getElementById("host").value,
    port: rawPort ? Number(rawPort) : undefined,
    database: document.getElementById("database").value,
    username,
    password,
    driver,
    dialect: selectedDialect || undefined,
    connectionString: realConnectionString,
    databaseType: selectedDbType || undefined,
    additionalParameters,
    envVars: collectEnvVars(),
  };

  vscode.postMessage({ command: "save", data });
});

document.getElementById("cancel").addEventListener("click", () => {
  vscode.postMessage({ command: "cancel" });
});

// Show reload driver button only in edit mode
const reloadDriverBtn = document.getElementById("reloadDriver");
if (initial.name) {
  reloadDriverBtn.removeAttribute("hidden");
}

reloadDriverBtn.addEventListener("click", () => {
  const driverValue = document.getElementById("driver").value.trim();
  if (!driverValue) {
    document.getElementById("error").textContent = "No driver specified.";
    return;
  }
  document.getElementById("error").textContent = "";
  vscode.postMessage({ command: "reloadDriver", driver: driverValue });
});

window.addEventListener("message", (event) => {
  const message = event.data;
  if (message.command === "saveError") {
    document.getElementById("error").textContent =
      message.error || "Save failed.";
  }

  if (message.command === "setupProgress") {
    const progressEl = document.getElementById("setupProgress");
    const progressText = document.getElementById("setupProgressText");
    const saveBtn = document.getElementById("save");
    const cancelBtn = document.getElementById("cancel");

    if (message.inProgress) {
      progressEl.removeAttribute("hidden");
      progressText.textContent = message.message || "Setting up...";
      saveBtn.disabled = true;
      cancelBtn.disabled = true;
      saveBtn.textContent = "Setting up...";
    } else {
      progressEl.setAttribute("hidden", "");
      progressText.textContent = "";
      saveBtn.disabled = false;
      cancelBtn.disabled = false;
      saveBtn.textContent = saveBtn.dataset.originalLabel || "Save";
    }
  }

  if (message.command === "driverStatus") {
    const version = message.version || (message.installed ? true : null);
    if (version) {
      const driverValue = document.getElementById("driver").value.trim();
      installedDrivers[driverValue.toLowerCase()] = version;
      updateDriverStatus(driverValue, version);
    }
  }
});
