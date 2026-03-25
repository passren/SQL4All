import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { spawn } from 'child_process';

let globalState: vscode.Memento;
let mongoPanel: vscode.WebviewPanel | undefined;

export function activate(context: vscode.ExtensionContext) {
	globalState = context.globalState;

	// Register command to open the MongoDB query panel
	const disposable = vscode.commands.registerCommand(
		'mongodb-pymongosql.openQueryPanel',
		() => createOrShowPanel(context)
	);

	context.subscriptions.push(disposable);

	// Register webview serializer for persistence
	if (vscode.window.registerWebviewPanelSerializer) {
		vscode.window.registerWebviewPanelSerializer('mongoQuery', {
			async deserializeWebviewPanel(
				webviewPanel: vscode.WebviewPanel,
				state: any
			) {
				mongoPanel = webviewPanel;
				updateWebviewContent(context);
			}
		});
	}

	console.log('MongoDB+SQL+VSCode extension activated');
}

function createOrShowPanel(context: vscode.ExtensionContext) {
	if (mongoPanel) {
		mongoPanel.reveal(vscode.ViewColumn.One);
	} else {
		mongoPanel = vscode.window.createWebviewPanel(
			'mongoQuery',
			'MongoDB PyMongoSQL Query',
			vscode.ViewColumn.One,
			{
				enableScripts: true,
				retainContextWhenHidden: true,
				localResourceRoots: [
					vscode.Uri.file(path.join(context.extensionPath, 'media'))
				]
			}
		);

		mongoPanel.webview.onDidReceiveMessage(
			(message) => handleWebviewMessage(message, context),
			undefined
		);

		mongoPanel.onDidDispose(
			() => {
				mongoPanel = undefined;
			},
			undefined
		);

		updateWebviewContent(context);
	}
}

function updateWebviewContent(context: vscode.ExtensionContext) {
	if (!mongoPanel) return;

	const htmlPath = path.join(
		context.extensionPath,
		'media',
		'webview.html'
	);
	
	try {
		let html = fs.readFileSync(htmlPath, 'utf8');
		
		// Replace paths for resources
		const cssPath = mongoPanel.webview.asWebviewUri(
			vscode.Uri.file(path.join(context.extensionPath, 'media', 'style.css'))
		);
		const jsPath = mongoPanel.webview.asWebviewUri(
			vscode.Uri.file(path.join(context.extensionPath, 'media', 'script.js'))
		);

		html = html
			.replace('${cssPath}', cssPath.toString())
			.replace('${jsPath}', jsPath.toString());

		mongoPanel.webview.html = html;
	} catch (error) {
		vscode.window.showErrorMessage(`Failed to load webview: ${error}`);
	}
}

async function handleWebviewMessage(message: any, context: vscode.ExtensionContext) {
	switch (message.command) {
		case 'saveConnection':
			saveConnection(context, message.data);
			break;
		case 'executeQuery':
			await executeQuery(message.data, context);
			break;
		case 'deleteConnection':
			deleteConnection(context, message.name);
			break;
		case 'exportResults':
			exportResults(message.data, message.format);
			break;
		case 'loadConnections':
			loadConnections(context);
			break;
		case 'loadHistory':
			loadQueryHistory(context);
			break;
	}
}

function saveConnection(context: vscode.ExtensionContext, connection: any) {
	const connections = context.globalState.get('mongodb.connections', {}) as any;
	connections[connection.name] = {
		host: connection.host,
		port: connection.port,
		database: connection.database,
		username: connection.username,
		password: connection.password
	};
	context.globalState.update('mongodb.connections', connections);
	mongoPanel?.webview.postMessage({ command: 'connectionSaved' });
	loadConnections(context);
}

function deleteConnection(context: vscode.ExtensionContext, name: string) {
	const connections = context.globalState.get('mongodb.connections', {}) as any;
	delete connections[name];
	context.globalState.update('mongodb.connections', connections);
	loadConnections(context);
}

function loadConnections(context: vscode.ExtensionContext) {
	const connections = context.globalState.get('mongodb.connections', {}) as any;
	mongoPanel?.webview.postMessage({
		command: 'connectionsLoaded',
		data: connections
	});
}

async function executeQuery(query: any, context: vscode.ExtensionContext) {
	try {
		const pythonScript = path.join(
			context.extensionPath,
			'python',
			'query_executor.py'
		);

		// Prepare Python command arguments
		const args = [
			pythonScript,
			`--host=${query.host}`,
			`--port=${query.port}`,
			`--database=${query.database}`,
			`--username=${query.username}`,
			`--password=${query.password}`,
			`--query=${query.query}`
		];

		// Execute Python script
		const result = await new Promise<string>((resolve, reject) => {
			const process = spawn('python', args);
			let output = '';
			let errorOutput = '';

			process.stdout.on('data', (data) => {
				output += data.toString();
			});

			process.stderr.on('data', (data) => {
				errorOutput += data.toString();
			});

			process.on('close', (code) => {
				if (code !== 0) {
					reject(new Error(errorOutput || 'Query execution failed'));
				} else {
					resolve(output);
				}
			});
		});

		// Parse and send results
		const results = JSON.parse(result);
		
		// Save to history
		saveQueryToHistory(context, query, results);

		mongoPanel?.webview.postMessage({
			command: 'queryResults',
			data: results
		});
	} catch (error: any) {
		vscode.window.showErrorMessage(`Query execution failed: ${error.message}`);
		mongoPanel?.webview.postMessage({
			command: 'queryError',
			error: error.message
		});
	}
}

function saveQueryToHistory(context: vscode.ExtensionContext, query: any, results: any) {
	const history = context.globalState.get('mongodb.queryHistory', []) as any[];
	history.push({
		query: query.query,
		connection: query.connection,
		timestamp: new Date().toISOString(),
		resultCount: Array.isArray(results) ? results.length : (results ? 1 : 0)
	});
	
	// Keep only last 50 queries
	if (history.length > 50) {
		history.shift();
	}
	
	context.globalState.update('mongodb.queryHistory', history);
}

function loadQueryHistory(context: vscode.ExtensionContext) {
	const history = context.globalState.get('mongodb.queryHistory', []);
	mongoPanel?.webview.postMessage({
		command: 'historyLoaded',
		data: history
	});
}

function exportResults(results: any[], format: string) {
	vscode.window.showOpenDialog({
		canSelectFolders: true,
		canSelectFiles: false,
		canSelectMany: false,
		title: 'Select folder to export results'
	}).then(uris => {
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
