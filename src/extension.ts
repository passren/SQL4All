import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { spawn } from 'child_process';

declare const process: any;

let globalState: vscode.Memento;

interface DbConnection {
	host: string;
	port: number;
	database: string;
	username: string;
	password: string;
}

type ConnectionStore = Record<string, DbConnection>;

const NEW_CONNECTION = '__NEW_CONNECTION__';
const panelsByConnection = new Map<string, vscode.WebviewPanel>();
let connectionEditorPanel: vscode.WebviewPanel | undefined;
let pythonEnvPath: string | undefined;
let pythonSetupPromise: Promise<string> | undefined;
let pythonStatusBar: vscode.StatusBarItem | undefined;

class ConnectionItem extends vscode.TreeItem {
	constructor(
		public readonly connectionName: string,
		public readonly connection: DbConnection
	) {
		super(connectionName, vscode.TreeItemCollapsibleState.None);
		this.description = `${connection.host}:${connection.port}/${connection.database}`;
		this.tooltip = `${connectionName}\n${connection.host}:${connection.port}\nDB: ${connection.database}`;
		this.contextValue = 'sql4no.connectionItem';
		this.iconPath = new vscode.ThemeIcon('database');
		this.command = {
			command: 'sql4no.connectConnection',
			title: 'Connect',
			arguments: [this]
		};
	}
}

class ConnectionTreeProvider implements vscode.TreeDataProvider<ConnectionItem> {
	private readonly _onDidChangeTreeData = new vscode.EventEmitter<ConnectionItem | undefined | null | void>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	constructor(private readonly context: vscode.ExtensionContext) {}

	refresh(): void {
		this._onDidChangeTreeData.fire();
	}

	getTreeItem(element: ConnectionItem): vscode.TreeItem {
		return element;
	}

	getChildren(): ConnectionItem[] {
		const connections = this.getConnections();
		return Object.keys(connections)
			.sort((a, b) => a.localeCompare(b))
			.map((name) => new ConnectionItem(name, connections[name]));
	}

	getConnections(): ConnectionStore {
		const current = this.context.globalState.get('sql4no.connections');
		if (current) {
			return current as ConnectionStore;
		}

		// Backward compatibility for existing users.
		const legacy = this.context.globalState.get('mongodb.connections', {}) as ConnectionStore;
		return legacy;
	}

	async saveConnections(connections: ConnectionStore): Promise<void> {
		await this.context.globalState.update('sql4no.connections', connections);
		await this.context.globalState.update('mongodb.connections', connections);
		this.refresh();
	}

	getConnection(name: string): DbConnection | undefined {
		return this.getConnections()[name];
	}

	async upsertConnection(name: string, connection: DbConnection): Promise<void> {
		const connections = this.getConnections();
		connections[name] = connection;
		await this.saveConnections(connections);
	}

	async deleteConnection(name: string): Promise<void> {
		const connections = this.getConnections();
		delete connections[name];
		await this.saveConnections(connections);
	}
}

export function activate(context: vscode.ExtensionContext) {
	globalState = context.globalState;
	const connectionTreeProvider = new ConnectionTreeProvider(context);

	// Migrate legacy key to new key if needed.
	const hasNewStore = context.globalState.get('sql4no.connections') !== undefined;
	if (!hasNewStore) {
		const legacy = context.globalState.get('mongodb.connections');
		if (legacy) {
			void context.globalState.update('sql4no.connections', legacy);
		}
	}

	context.subscriptions.push(
		vscode.window.registerTreeDataProvider('sql4no.connections', connectionTreeProvider)
	);

	const openPanelDisposable = vscode.commands.registerCommand(
		'sql4no.openQueryPanel',
		async () => {
			const selected = await pickConnection(connectionTreeProvider);
			if (!selected) {
				return;
			}

			if (selected === NEW_CONNECTION) {
				await addConnection(connectionTreeProvider);
				return;
			}

			const connection = connectionTreeProvider.getConnection(selected);
			if (!connection) {
				vscode.window.showErrorMessage(`Connection "${selected}" was not found.`);
				return;
			}

			createOrShowPanel(context, selected, connection);
		}
	);

	const addConnectionDisposable = vscode.commands.registerCommand(
		'sql4no.addConnection',
		() => addConnection(connectionTreeProvider)
	);

	const connectConnectionDisposable = vscode.commands.registerCommand(
		'sql4no.connectConnection',
		(item?: ConnectionItem) => {
			if (!item) {
				void vscode.commands.executeCommand('sql4no.openQueryPanel');
				return;
			}

			createOrShowPanel(context, item.connectionName, item.connection);
		}
	);

	const editConnectionDisposable = vscode.commands.registerCommand(
		'sql4no.editConnection',
		(item?: ConnectionItem) => {
			if (!item) {
				return;
			}

			void openConnectionEditor(connectionTreeProvider, item.connectionName, item.connection);
		}
	);

	const deleteConnectionDisposable = vscode.commands.registerCommand(
		'sql4no.deleteConnection',
		async (item?: ConnectionItem) => {
			if (!item) {
				return;
			}

			const answer = await vscode.window.showWarningMessage(
				`Delete connection "${item.connectionName}"?`,
				{ modal: true },
				'Delete'
			);

			if (answer !== 'Delete') {
				return;
			}

			await connectionTreeProvider.deleteConnection(item.connectionName);
			const panel = panelsByConnection.get(item.connectionName);
			if (panel) {
				panel.dispose();
			}
		}
	);

	const refreshConnectionsDisposable = vscode.commands.registerCommand(
		'sql4no.refreshConnections',
		() => connectionTreeProvider.refresh()
	);

	const selectPythonExecutableDisposable = vscode.commands.registerCommand(
		'sql4no.selectPythonExecutable',
		() => selectPythonExecutable(context)
	);

	const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
	statusBar.command = 'sql4no.selectPythonExecutable';
	pythonStatusBar = statusBar;
	updatePythonStatusBar();

	context.subscriptions.push(
		openPanelDisposable,
		addConnectionDisposable,
		connectConnectionDisposable,
		editConnectionDisposable,
		deleteConnectionDisposable,
		refreshConnectionsDisposable,
		selectPythonExecutableDisposable,
		statusBar
	);

	console.log('SQL4No extension activated');
}

function createOrShowPanel(
	context: vscode.ExtensionContext,
	connectionName: string,
	connection: DbConnection
) {
	const existingPanel = panelsByConnection.get(connectionName);
	if (existingPanel) {
		existingPanel.reveal(vscode.ViewColumn.Active);
		return;
	}

	const panel = vscode.window.createWebviewPanel(
		'sql4noQuery',
		`SQL4No - ${connectionName}`,
		vscode.ViewColumn.Beside,
		{
			enableScripts: true,
			retainContextWhenHidden: true,
			localResourceRoots: [
				vscode.Uri.file(path.join(context.extensionPath, 'media'))
			]
		}
	);

	panelsByConnection.set(connectionName, panel);

	panel.webview.onDidReceiveMessage(
		(message: any) => handleWebviewMessage(message, context, panel, connectionName, connection),
		undefined
	);

	panel.onDidDispose(
		() => {
			panelsByConnection.delete(connectionName);
		},
		undefined
	);

	updateWebviewContent(context, panel, connectionName, connection);
}

function updateWebviewContent(
	context: vscode.ExtensionContext,
	panel: vscode.WebviewPanel,
	connectionName: string,
	connection: DbConnection
) {
	const htmlPath = path.join(
		context.extensionPath,
		'media',
		'webview.html'
	);
	
	try {
		let html = fs.readFileSync(htmlPath, 'utf8');
		
		// Replace paths for resources
		const cssPath = panel.webview.asWebviewUri(
			vscode.Uri.file(path.join(context.extensionPath, 'media', 'style.css'))
		);
		const jsPath = panel.webview.asWebviewUri(
			vscode.Uri.file(path.join(context.extensionPath, 'media', 'script.js'))
		);

		html = html
			.replace('${cssPath}', cssPath.toString())
			.replace('${jsPath}', jsPath.toString())
			.replace('${connectionName}', escapeHtml(connectionName))
			.replace('${connectionHost}', escapeHtml(connection.host))
			.replace('${connectionPort}', String(connection.port))
			.replace('${databaseName}', escapeHtml(connection.database));

		panel.webview.html = html;
	} catch (error) {
		vscode.window.showErrorMessage(`Failed to load webview: ${error}`);
	}
}

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#039;');
}

async function handleWebviewMessage(
	message: any,
	context: vscode.ExtensionContext,
	panel: vscode.WebviewPanel,
	connectionName: string,
	connection: DbConnection
) {
	switch (message.command) {
		case 'ready':
			panel.webview.postMessage({
				command: 'initConnection',
				data: {
					name: connectionName,
					host: connection.host,
					port: connection.port,
					database: connection.database
				}
			});
			break;
		case 'executeQuery':
			await executeQuery(
				message.query,
				message.paramsRaw,
				connectionName,
				connection,
				context,
				panel
			);
			break;
		case 'exportResults':
			exportResults(message.data, message.format);
			break;
	}
}

async function addConnection(treeProvider: ConnectionTreeProvider): Promise<void> {
	await openConnectionEditor(treeProvider);
}

async function openConnectionEditor(
	treeProvider: ConnectionTreeProvider,
	editingName?: string,
	editingConnection?: DbConnection
): Promise<void> {
	if (connectionEditorPanel) {
		connectionEditorPanel.dispose();
	}

	connectionEditorPanel = vscode.window.createWebviewPanel(
		'sql4noConnectionEditor',
		editingName ? `Edit Connection - ${editingName}` : 'New Connection',
		vscode.ViewColumn.Active,
		{
			enableScripts: true,
			retainContextWhenHidden: false
		}
	);

	const initial: { name: string; connection: DbConnection } = {
		name: editingName ?? '',
		connection: editingConnection ?? {
			host: 'localhost',
			port: 27017,
			database: '',
			username: '',
			password: ''
		}
	};

	connectionEditorPanel.webview.html = getConnectionEditorHtml(initial, Boolean(editingName));

	connectionEditorPanel.webview.onDidReceiveMessage(
		async (message: any) => {
			if (!connectionEditorPanel) {
				return;
			}

			if (message.command === 'cancel') {
				connectionEditorPanel.dispose();
				return;
			}

			if (message.command !== 'save') {
				return;
			}

			const payload = message.data as {
				name: string;
				host: string;
				port: number;
				database: string;
				username: string;
				password: string;
			};

			const name = payload.name.trim();
			const host = payload.host.trim();
			const database = payload.database.trim();
			const port = Number(payload.port);

			if (!name || !host || !database || !Number.isInteger(port) || port <= 0 || port > 65535) {
				connectionEditorPanel.webview.postMessage({
					command: 'saveError',
					error: 'Please provide valid name, host, port (1-65535), and database.'
				});
				return;
			}

			if (editingName && editingName !== name && treeProvider.getConnection(name)) {
				connectionEditorPanel.webview.postMessage({
					command: 'saveError',
					error: `Connection "${name}" already exists.`
				});
				return;
			}

			if (editingName && editingName !== name) {
				await treeProvider.deleteConnection(editingName);
				const existingPanel = panelsByConnection.get(editingName);
				if (existingPanel) {
					existingPanel.dispose();
				}
			}

			await treeProvider.upsertConnection(name, {
				host,
				port,
				database,
				username: payload.username?.trim() ?? '',
				password: payload.password ?? ''
			});

			vscode.window.showInformationMessage(
				editingName ? `Connection "${name}" updated.` : `Connection "${name}" created.`
			);

			connectionEditorPanel.dispose();
		},
		undefined
	);

	connectionEditorPanel.onDidDispose(() => {
		connectionEditorPanel = undefined;
	});
}

function getConnectionEditorHtml(
	initial: { name: string; connection: DbConnection },
	isEdit: boolean
): string {
	const initialJson = JSON.stringify(initial).replace(/</g, '\\u003c');

	return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${isEdit ? 'Edit Connection' : 'New Connection'}</title>
  <style>
    body { font-family: Segoe UI, sans-serif; padding: 16px; color: var(--vscode-foreground); }
    .form { display: grid; gap: 10px; }
    label { font-size: 12px; color: var(--vscode-descriptionForeground); }
    input { width: 100%; padding: 8px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); border-radius: 4px; }
    .actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 8px; }
    button { padding: 7px 12px; border: 1px solid var(--vscode-button-border, transparent); border-radius: 4px; cursor: pointer; }
    .primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
    .secondary { background: var(--vscode-input-background); color: var(--vscode-foreground); }
    .error { color: var(--vscode-errorForeground); min-height: 18px; font-size: 12px; }
  </style>
</head>
<body>
  <h2>${isEdit ? 'Update Connection' : 'Create Connection'}</h2>
  <div class="form">
    <div><label>Name</label><input id="name" /></div>
    <div><label>Host</label><input id="host" /></div>
    <div><label>Port</label><input id="port" type="number" min="1" max="65535" /></div>
    <div><label>Database</label><input id="database" /></div>
    <div><label>Username (optional)</label><input id="username" /></div>
    <div><label>Password (optional)</label><input id="password" type="password" /></div>
  </div>
  <div id="error" class="error"></div>
  <div class="actions">
    <button id="cancel" class="secondary">Cancel</button>
    <button id="save" class="primary">${isEdit ? 'Update' : 'Create'}</button>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    const initial = ${initialJson};

    document.getElementById('name').value = initial.name || '';
    document.getElementById('host').value = initial.connection.host || 'localhost';
    document.getElementById('port').value = String(initial.connection.port || 27017);
    document.getElementById('database').value = initial.connection.database || '';
    document.getElementById('username').value = initial.connection.username || '';
    document.getElementById('password').value = initial.connection.password || '';

    document.getElementById('save').addEventListener('click', () => {
      const data = {
        name: document.getElementById('name').value,
        host: document.getElementById('host').value,
        port: Number(document.getElementById('port').value),
        database: document.getElementById('database').value,
        username: document.getElementById('username').value,
        password: document.getElementById('password').value,
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
  </script>
</body>
</html>`;
}

async function pickConnection(treeProvider: ConnectionTreeProvider): Promise<string | undefined> {
	const connections = treeProvider.getConnections();
	const items: vscode.QuickPickItem[] = [
		{ label: '$(add) Add New Connection', description: 'Create and save a connection profile' }
	];

	for (const name of Object.keys(connections).sort((a, b) => a.localeCompare(b))) {
		const conn = connections[name];
		items.push({
			label: name,
			description: `${conn.host}:${conn.port}/${conn.database}`
		});
	}

	const picked = await vscode.window.showQuickPick(items, {
		placeHolder: 'Choose a connection',
		ignoreFocusOut: true
	});

	if (!picked) {
		return undefined;
	}

	if (picked.label.includes('Add New Connection')) {
		return NEW_CONNECTION;
	}

	return picked.label;
}

async function executeQuery(
	queryText: string,
	paramsRaw: string | undefined,
	connectionName: string,
	connection: DbConnection,
	context: vscode.ExtensionContext,
	panel: vscode.WebviewPanel
) {
	try {
		if (!queryText || !queryText.trim()) {
			panel.webview.postMessage({
				command: 'queryError',
				error: 'Query is empty.'
			});
			return;
		}

		const pythonScript = path.join(
			context.extensionPath,
			'python',
			'query_executor.py'
		);

		// Prepare Python command arguments
		const args = [
			pythonScript,
			`--host=${connection.host}`,
			`--port=${connection.port}`,
			`--database=${connection.database}`,
			`--username=${connection.username}`,
			`--password=${connection.password}`,
			`--query=${queryText}`
		];

		if (paramsRaw && paramsRaw.trim()) {
			args.push(`--params=${paramsRaw}`);
		}

		const result = await runPythonScript(context, args);

		// Parse and send results
		const results = JSON.parse(result);
		
		// Save to history
		saveQueryToHistory(context, connectionName, queryText, results);

		panel.webview.postMessage({
			command: 'queryResults',
			data: results
		});
	} catch (error: any) {
		vscode.window.showErrorMessage(`Query execution failed: ${error.message}`);
		panel.webview.postMessage({
			command: 'queryError',
			error: error.message
		});
	}
}

async function runPythonScript(
	context: vscode.ExtensionContext,
	scriptArgs: string[]
): Promise<string> {
	const pythonExecutable = await ensurePythonEnvironment(context);
	return runProcess(pythonExecutable, scriptArgs);
}

async function ensurePythonEnvironment(context: vscode.ExtensionContext): Promise<string> {
	if (pythonEnvPath) {
		return pythonEnvPath;
	}

	if (pythonSetupPromise) {
		return pythonSetupPromise;
	}

	pythonSetupPromise = (async () => {
		const storageDir = context.globalStorageUri.fsPath;
		const venvDir = path.join(storageDir, 'python-env');
		const venvPython = process.platform === 'win32'
			? path.join(venvDir, 'Scripts', 'python.exe')
			: path.join(venvDir, 'bin', 'python');
		const readyMarker = path.join(venvDir, '.sql4no-ready');

		fs.mkdirSync(storageDir, { recursive: true });

		if (!fs.existsSync(venvPython)) {
			const bootstrap = await resolveSystemPython();
			await runProcess(bootstrap.command, [...bootstrap.args, '-m', 'venv', venvDir]);
		}

		if (!fs.existsSync(readyMarker)) {
			await vscode.window.withProgress(
				{
					location: vscode.ProgressLocation.Notification,
					title: 'SQL4No: preparing Python environment',
					cancellable: false
				},
				async () => {
					await runProcess(venvPython, ['-m', 'pip', 'install', '--upgrade', 'pip']);
					await runProcess(venvPython, ['-m', 'pip', 'install', 'pymongo', 'pymongosql']);
				}
			);

			fs.writeFileSync(readyMarker, new Date().toISOString(), 'utf8');
		}

		pythonEnvPath = venvPython;
		updatePythonStatusBar();
		return venvPython;
	})().finally(() => {
		pythonSetupPromise = undefined;
	});

	return pythonSetupPromise;
}

async function resolveSystemPython(): Promise<{ command: string; args: string[] }> {
	const configuredPython = vscode.workspace
		.getConfiguration('sql4no')
		.get<string>('pythonPath', '')
		.trim();

	if (configuredPython) {
		await runProcess(configuredPython, ['--version']);
		return { command: configuredPython, args: [] };
	}

	if (process.platform === 'win32') {
		for (const candidatePath of getWindowsCandidatePythonPaths()) {
			if (!fs.existsSync(candidatePath)) {
				continue;
			}

			try {
				await runProcess(candidatePath, ['--version']);
				return { command: candidatePath, args: [] };
			} catch {
				// Continue trying remaining candidates.
			}
		}
	}

	const pythonCommands = process.platform === 'win32'
		? [
			{ command: 'python', args: [] as string[] },
			{ command: 'py', args: ['-3'] },
			{ command: 'py', args: [] as string[] }
		]
		: [
			{ command: 'python3', args: [] as string[] },
			{ command: 'python', args: [] as string[] }
		];

	let lastError = 'Python launcher not found.';

	for (const candidate of pythonCommands) {
		try {
			await runProcess(candidate.command, [...candidate.args, '--version']);
			return candidate;
		} catch (error: any) {
			lastError = error?.message || String(error);
		}
	}

	if (process.platform === 'win32') {
		throw new Error(
			`Cannot find Python. Tried: python, py -3, py. Last error: ${lastError}`
		);
	}

	throw new Error(`Cannot find Python. Tried: python3, python. Last error: ${lastError}`);
}

function updatePythonStatusBar(): void {
	if (!pythonStatusBar) {
		return;
	}

	const configured = vscode.workspace.getConfiguration('sql4no').get<string>('pythonPath', '').trim();
	if (pythonEnvPath) {
		pythonStatusBar.text = '$(symbol-namespace) SQL4No: venv';
		pythonStatusBar.tooltip = `SQL4No Python environment: ${pythonEnvPath}`;
	} else if (configured) {
		pythonStatusBar.text = '$(symbol-namespace) SQL4No: Python';
		pythonStatusBar.tooltip = `SQL4No Python: ${configured}`;
	} else {
		pythonStatusBar.text = '$(symbol-namespace) SQL4No: Python (auto)';
		pythonStatusBar.tooltip = 'SQL4No Python: auto-detected (click to configure)';
	}
	pythonStatusBar.show();
}

async function selectPythonExecutable(context: vscode.ExtensionContext): Promise<void> {
	const detected = process.platform === 'win32' ? getWindowsCandidatePythonPaths() : [];
	const existing = detected.filter((candidate) => fs.existsSync(candidate));
	const current = vscode.workspace
		.getConfiguration('sql4no')
		.get<string>('pythonPath', '')
		.trim();

	const items: Array<vscode.QuickPickItem & { value: string }> = [];

	if (current) {
		items.push({
			label: `$(check) Current: ${current}`,
			description: 'Configured sql4no.pythonPath',
			value: current
		});
	}

	for (const candidate of existing) {
		items.push({
			label: candidate,
			description: 'Detected Python executable',
			value: candidate
		});
	}

	items.push({
		label: '$(folder-opened) Browse...',
		description: 'Pick python.exe manually',
		value: '__BROWSE__'
	});

	const picked = await vscode.window.showQuickPick(items, {
		placeHolder: 'Select Python executable for SQL4No'
	});

	if (!picked) {
		return;
	}

	let selectedPath = picked.value;
	if (selectedPath === '__BROWSE__') {
		const filePick = await vscode.window.showOpenDialog({
			canSelectFiles: true,
			canSelectFolders: false,
			canSelectMany: false,
			title: 'Select Python executable',
			filters: process.platform === 'win32' ? { Executable: ['exe'] } : undefined
		});

		if (!filePick || filePick.length === 0) {
			return;
		}

		selectedPath = filePick[0].fsPath;
	}

	try {
		await runProcess(selectedPath, ['--version']);
		await vscode.workspace
			.getConfiguration('sql4no')
			.update('pythonPath', selectedPath, vscode.ConfigurationTarget.Global);

		pythonEnvPath = undefined;
		pythonSetupPromise = undefined;
		updatePythonStatusBar();
		vscode.window.showInformationMessage(`SQL4No Python path set to: ${selectedPath}`);
	} catch (error: any) {
		vscode.window.showErrorMessage(
			`Selected Python executable is invalid: ${error?.message || String(error)}`
		);
	}
}

function getWindowsCandidatePythonPaths(): string[] {
	const userProfile = process.env.USERPROFILE || '';
	const localAppData = process.env.LOCALAPPDATA || '';
	const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
	const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';

	const baseDirs = [
		path.join(localAppData, 'Programs', 'Python'),
		path.join(userProfile, 'AppData', 'Local', 'Programs', 'Python')
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

			candidates.push(path.join(baseDir, entry.name, 'python.exe'));
		}
	}

	candidates.push(
		path.join(programFiles, 'Python311', 'python.exe'),
		path.join(programFiles, 'Python310', 'python.exe'),
		path.join(programFilesX86, 'Python311', 'python.exe'),
		path.join(programFilesX86, 'Python310', 'python.exe')
	);

	return Array.from(new Set(candidates));
}

async function runProcess(command: string, args: string[]): Promise<string> {
	return new Promise<string>((resolve, reject) => {
		const child = spawn(command, args);
		let stdout = '';
		let stderr = '';

		child.stdout.on('data', (data: any) => {
			stdout += data.toString();
		});

		child.stderr.on('data', (data: any) => {
			stderr += data.toString();
		});

		child.on('error', (error: any) => {
			reject(error);
		});

		child.on('close', (code: number | null) => {
			if (code !== 0) {
				reject(new Error(stderr || `${command} exited with code ${code}`));
				return;
			}

			resolve(stdout);
		});
	});
}

function saveQueryToHistory(
	context: vscode.ExtensionContext,
	connectionName: string,
	queryText: string,
	results: any
) {
	const history = context.globalState.get('mongodb.queryHistory', []) as any[];
	const resultCount = Array.isArray(results)
		? results.length
		: Number.isInteger(results?.rowCount)
			? results.rowCount
			: (Array.isArray(results?.rows) ? results.rows.length : (results ? 1 : 0));
	history.push({
		query: queryText,
		connection: connectionName,
		timestamp: new Date().toISOString(),
		resultCount
	});
	
	// Keep only last 50 queries
	if (history.length > 50) {
		history.shift();
	}
	
	context.globalState.update('mongodb.queryHistory', history);
}

function exportResults(results: any[], format: string) {
	vscode.window.showOpenDialog({
		canSelectFolders: true,
		canSelectFiles: false,
		canSelectMany: false,
		title: 'Select folder to export results'
	}).then((uris: vscode.Uri[] | undefined) => {
		if (!uris || uris.length === 0) return;

		const folderPath = uris[0].fsPath;
		const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
		let content = '';
		let filename = '';

		if (format === 'csv') {
			filename = `results_${timestamp}.csv`;
			content = convertToCSV(results);
		} else if (format === 'json') {
			filename = `results_${timestamp}.json`;
			content = JSON.stringify(results, null, 2);
		}

		const filePath = path.join(folderPath, filename);
		fs.writeFileSync(filePath, content);
		vscode.window.showInformationMessage(`Results exported to ${filePath}`);
	});
}

function convertToCSV(data: any[]): string {
	if (data.length === 0) return '';

	const headers = Object.keys(data[0]);
	const csvHeaders = headers.join(',');
	const csvRows = data.map(row => {
		return headers.map(header => {
			const value = row[header];
			if (typeof value === 'string' && value.includes(',')) {
				return `"${value.replace(/"/g, '""')}"`;
			}
			return value === null || value === undefined ? '' : value;
		}).join(',');
	});

	return [csvHeaders, ...csvRows].join('\n');
}

export function deactivate() {}
