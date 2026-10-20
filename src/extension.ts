import * as vscode from 'vscode';
import { readConfig } from './config';
import { DeepSeekInlineProvider } from './provider';

const OUTPUT_NAME = 'DeepSeek FIM';

export function activate(context: vscode.ExtensionContext) {
	const output = vscode.window.createOutputChannel(OUTPUT_NAME);
	const provider = new DeepSeekInlineProvider(output);

	const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
	statusBar.show();

	const updateStatusBar = () => {
		const config = readConfig();
		if (!config.apiKey) {
			statusBar.text = '$(warning) DeepSeek';
			statusBar.tooltip = 'DeepSeek 补全：未配置 API Key，点击打开设置';
			statusBar.command = 'continue-termux.openSettings';
			return;
		}
		statusBar.text = config.enabled ? '$(sparkle) DeepSeek' : '$(circle-slash) DeepSeek';
		statusBar.tooltip = config.enabled
			? `DeepSeek 补全已启用（${config.model}），点击禁用`
			: `DeepSeek 补全已禁用（${config.model}），点击启用`;
		statusBar.command = 'continue-termux.toggle';
	};

	const openSettings = () => vscode.commands.executeCommand('workbench.action.openSettings', 'continue-termux.apiKey');

	const enabledTarget = (): vscode.ConfigurationTarget => {
		const inspection = vscode.workspace.getConfiguration('continue-termux').inspect<boolean>('enabled');
		if (inspection?.workspaceFolderValue !== undefined) {
			return vscode.ConfigurationTarget.WorkspaceFolder;
		}
		if (inspection?.workspaceValue !== undefined) {
			return vscode.ConfigurationTarget.Workspace;
		}
		return vscode.ConfigurationTarget.Global;
	};

	const toggle = vscode.commands.registerCommand('continue-termux.toggle', async () => {
		const config = readConfig();
		if (!config.apiKey) {
			await openSettings();
			return;
		}
		await vscode.workspace
			.getConfiguration('continue-termux')
			.update('enabled', !config.enabled, enabledTarget());
	});

	const openSettingsCommand = vscode.commands.registerCommand('continue-termux.openSettings', openSettings);

	context.subscriptions.push(
		output,
		statusBar,
		toggle,
		openSettingsCommand,
		vscode.languages.registerInlineCompletionItemProvider(
			[{ scheme: 'file' }, { scheme: 'untitled' }],
			provider
		),
		vscode.workspace.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration('continue-termux')) {
				updateStatusBar();
				output.appendLine(`[${new Date().toISOString()}] 配置已更新，模型 ${readConfig().model}`);
			}
		})
	);

	updateStatusBar();

	const config = readConfig();
	output.appendLine(`[${new Date().toISOString()}] DeepSeek FIM 已激活，模型 ${config.model}`);
	if (!config.apiKey) {
		output.appendLine('尚未配置 continue-termux.apiKey，补全不会发起请求。');
	}
}

export function deactivate() {}
