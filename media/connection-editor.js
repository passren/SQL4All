const vscode = acquireVsCodeApi();
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
    if (String(dbConfig?.driver || "").trim().toLowerCase() === normalizedDriverName) {
      return dbType;
    }
  }

  return "";
}

function buildConnectionStringFromTemplate(template, options) {
  const normalizedTemplate = String(template || "");
  const encodedDatabase = options.database
    ? encodeURIComponent(options.database)
    : "";

  return normalizedTemplate
    .replace("[username[:password]@]", options.credentials)
    .replace("host", options.host)
    .replace("[:port]", options.port ? `:${options.port}` : "")
    .replace("/[database]", encodedDatabase ? `/${encodedDatabase}` : "")
    .replace("/[service_name]", encodedDatabase ? `/${encodedDatabase}` : "")
    .replace("[database]", encodedDatabase)
    .replace("[service_name]", encodedDatabase)
    .replace("[?additionalParameters]", "");
}

function populateDatabaseTypes() {
  const select = document.getElementById("databaseType");
  if (!select) {
    return;
  }

  // Preserve the placeholder and repopulate from current config.
  select.innerHTML = '<option value="">-- Select Database --</option>';
  for (const [dbType, dbConfig] of Object.entries(
    driverConfig.databases || {},
  )) {
    const option = document.createElement("option");
    option.value = dbType;
    option.textContent = dbType.charAt(0).toUpperCase() + dbType.slice(1);
    select.appendChild(option);
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

// Handle database type selection
const databaseTypeSelect = document.getElementById("databaseType");
if (databaseTypeSelect) {
  databaseTypeSelect.addEventListener("change", () => {
    const selectedDb = databaseTypeSelect.value;
    if (
      selectedDb &&
      driverConfig.databases &&
      driverConfig.databases[selectedDb]
    ) {
      const dbConfig = driverConfig.databases[selectedDb];
      const defaultDriver = dbConfig.driver;
      document.getElementById("driver").value = defaultDriver;
      if (typeof dbConfig.default_port === "number") {
        document.getElementById("port").value = String(dbConfig.default_port);
      }
    } else {
      document.getElementById("driver").value = "";
    }
    updateConnectionString();
  });
  populateDatabaseTypes();

  const initialDatabaseType = findDatabaseTypeByDriver(initial.connection.driver);
  if (initialDatabaseType) {
    databaseTypeSelect.value = initialDatabaseType;
  }
}

const paramsBody = document.getElementById("additionalParamsBody");
const paramsEmpty = document.getElementById("additionalParamsEmpty");

function refreshParamsEmptyState() {
  paramsEmpty.style.display =
    paramsBody.children.length === 0 ? "block" : "none";
}

function createParamRow(key = "", value = "") {
  const row = document.createElement("tr");

  const keyCell = document.createElement("td");
  const keyInput = document.createElement("input");
  keyInput.className = "param-input";
  keyInput.placeholder = "e.g. authSource";
  keyInput.value = key;
  keyInput.addEventListener("input", updateConnectionString);
  keyCell.appendChild(keyInput);

  const valueCell = document.createElement("td");
  const valueInput = document.createElement("input");
  valueInput.className = "param-input";
  valueInput.placeholder = "e.g. admin";
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
  const initialParams = initial.connection.additionalParameters || {};
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

function updateConnectionString() {
  const host = document.getElementById("host").value.trim() || "localhost";
  const port = document.getElementById("port").value.trim();
  const database = document.getElementById("database").value.trim();
  const username = document.getElementById("username").value.trim();
  const password = document.getElementById("password").value;
  const additionalParameters = collectAdditionalParameters();
  const selectedDb = document.getElementById("databaseType")?.value;

  const encodedUser = encodeURIComponent(username);
  const encodedPass = encodeURIComponent(password);
  let credentials = "";
  if (username) {
    credentials = encodedUser + (password ? ":" + encodedPass : "") + "@";
  }

  let connectionString = "";

  // Use template-based generation if database type is selected
  if (
    selectedDb &&
    driverConfig.databases &&
    driverConfig.databases[selectedDb]
  ) {
    const template = driverConfig.databases[selectedDb].uri_template;
    connectionString = buildConnectionStringFromTemplate(template, {
      credentials,
      host,
      port,
      database,
    });
  }

  // Append additional parameters
  const query = Object.entries(additionalParameters)
    .map(
      ([key, value]) =>
        encodeURIComponent(key) + "=" + encodeURIComponent(String(value)),
    )
    .join("&");

  if (connectionString && query) {
    connectionString += connectionString.includes("?")
      ? "&" + query
      : "?" + query;
  }

  document.getElementById("connectionString").value = connectionString;
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
updateConnectionString();

document.getElementById("addParam").addEventListener("click", () => {
  createParamRow("", "");
  updateConnectionString();
});

document
  .getElementById("copyConnectionString")
  .addEventListener("click", () => {
    copyConnectionString();
  });

["host", "port", "database", "username", "password", "driver"].forEach((id) => {
  document.getElementById(id).addEventListener("input", updateConnectionString);
});

document.getElementById("save").addEventListener("click", () => {
  const rawPort = document.getElementById("port").value.trim();
  const data = {
    name: document.getElementById("name").value,
    host: document.getElementById("host").value,
    port: rawPort ? Number(rawPort) : undefined,
    database: document.getElementById("database").value,
    username: document.getElementById("username").value,
    password: document.getElementById("password").value,
    driver: document.getElementById("driver").value,
    additionalParameters: collectAdditionalParameters(),
  };

  vscode.postMessage({ command: "save", data });
});

document.getElementById("cancel").addEventListener("click", () => {
  vscode.postMessage({ command: "cancel" });
});

window.addEventListener("message", (event) => {
  const message = event.data;
  if (message.command === "saveError") {
    document.getElementById("error").textContent =
      message.error || "Save failed.";
  }
});
