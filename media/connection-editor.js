const vscode = acquireVsCodeApi();
const initial = window.__SQL4NO_CONNECTION_EDITOR__ || {
  name: '',
  connection: {
    host: 'localhost',
    port: 27017,
    database: '',
    username: '',
    password: '',
    additionalParameters: {}
  }
};

document.getElementById('name').value = initial.name || '';
document.getElementById('host').value = initial.connection.host || 'localhost';
document.getElementById('port').value = String(initial.connection.port || 27017);
document.getElementById('database').value = initial.connection.database || '';
document.getElementById('username').value = initial.connection.username || '';
document.getElementById('password').value = initial.connection.password || '';

const paramsBody = document.getElementById('additionalParamsBody');
const paramsEmpty = document.getElementById('additionalParamsEmpty');

function refreshParamsEmptyState() {
  paramsEmpty.style.display = paramsBody.children.length === 0 ? 'block' : 'none';
}

function createParamRow(key = '', value = '') {
  const row = document.createElement('tr');

  const keyCell = document.createElement('td');
  const keyInput = document.createElement('input');
  keyInput.className = 'param-input';
  keyInput.placeholder = 'e.g. authSource';
  keyInput.value = key;
  keyInput.addEventListener('input', updateConnectionString);
  keyCell.appendChild(keyInput);

  const valueCell = document.createElement('td');
  const valueInput = document.createElement('input');
  valueInput.className = 'param-input';
  valueInput.placeholder = 'e.g. admin';
  valueInput.value = value;
  valueInput.addEventListener('input', updateConnectionString);
  valueCell.appendChild(valueInput);

  const actionCell = document.createElement('td');
  const deleteBtn = document.createElement('button');
  deleteBtn.type = 'button';
  deleteBtn.className = 'secondary icon-btn';
  deleteBtn.textContent = 'x';
  deleteBtn.title = 'Delete parameter';
  deleteBtn.setAttribute('aria-label', 'Delete parameter');
  deleteBtn.addEventListener('click', () => {
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
    createParamRow(String(key || ''), String(value || ''));
  });
  refreshParamsEmptyState();
}

function collectAdditionalParameters() {
  const result = {};
  const rows = Array.from(paramsBody.querySelectorAll('tr'));
  for (const row of rows) {
    const inputs = row.querySelectorAll('input');
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
  const host = document.getElementById('host').value.trim() || 'localhost';
  const port = document.getElementById('port').value.trim() || '27017';
  const database = document.getElementById('database').value.trim();
  const username = document.getElementById('username').value.trim();
  const password = document.getElementById('password').value;
  const additionalParameters = collectAdditionalParameters();

  const encodedUser = encodeURIComponent(username);
  const encodedPass = encodeURIComponent(password);
  let credentials = '';
  if (username) {
    credentials = encodedUser + (password ? ':' + encodedPass : '') + '@';
  }

  const base = 'mongodb://' + credentials + host + ':' + port + '/' + encodeURIComponent(database);
  const query = Object.entries(additionalParameters)
    .map(([key, value]) => encodeURIComponent(key) + '=' + encodeURIComponent(String(value)))
    .join('&');

  document.getElementById('connectionString').value = query ? base + '?' + query : base;
  document.getElementById('copyStatus').textContent = '';
  document.getElementById('copyStatus').classList.remove('error');
}

async function copyConnectionString() {
  const connectionString = document.getElementById('connectionString').value;
  const copyStatus = document.getElementById('copyStatus');

  if (!connectionString) {
    copyStatus.textContent = 'Nothing to copy.';
    copyStatus.classList.add('error');
    return;
  }

  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(connectionString);
    } else {
      const tempInput = document.createElement('textarea');
      tempInput.value = connectionString;
      tempInput.setAttribute('readonly', '');
      tempInput.style.position = 'absolute';
      tempInput.style.left = '-9999px';
      document.body.appendChild(tempInput);
      tempInput.select();
      document.execCommand('copy');
      document.body.removeChild(tempInput);
    }

    copyStatus.textContent = 'Copied to clipboard.';
    copyStatus.classList.remove('error');
  } catch {
    copyStatus.textContent = 'Copy failed. Please copy manually.';
    copyStatus.classList.add('error');
  }
}

loadInitialParams();
updateConnectionString();

document.getElementById('addParam').addEventListener('click', () => {
  createParamRow('', '');
  updateConnectionString();
});

document.getElementById('copyConnectionString').addEventListener('click', () => {
  copyConnectionString();
});

['host', 'port', 'database', 'username', 'password'].forEach((id) => {
  document.getElementById(id).addEventListener('input', updateConnectionString);
});

document.getElementById('save').addEventListener('click', () => {
  const data = {
    name: document.getElementById('name').value,
    host: document.getElementById('host').value,
    port: Number(document.getElementById('port').value),
    database: document.getElementById('database').value,
    username: document.getElementById('username').value,
    password: document.getElementById('password').value,
    additionalParameters: collectAdditionalParameters()
  };

  vscode.postMessage({ command: 'save', data });
});

document.getElementById('cancel').addEventListener('click', () => {
  vscode.postMessage({ command: 'cancel' });
});

window.addEventListener('message', (event) => {
  const message = event.data;
  if (message.command === 'saveError') {
    document.getElementById('error').textContent = message.error || 'Save failed.';
  }
});
