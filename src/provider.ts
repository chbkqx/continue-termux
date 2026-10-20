import * as vscode from 'vscode';
import { CompletionConfig, readConfig } from './config';
import { FimError, requestFimCompletion } from './fimClient';

/** 超长 prefix 的截断标记，固定字符串，保证不同请求之间仍共享文件开头。 */
const TRUNCATION_MARKER = '\n// ... [truncated] ...\n';
const MAX_SUFFIX_CHARS = 2000;
const MIN_OVERLAP = 2;
const REQUEST_TIMEOUT_MS = 15000;
const RESULT_CACHE_MS = 2000;

interface DocumentContext {
	prefix: string;
	suffix: string;
}

function delay(ms: number, token: vscode.CancellationToken): Promise<void> {
	return new Promise<void>(resolve => {
		let subscription: vscode.Disposable | undefined;
		const timer = setTimeout(() => {
			subscription?.dispose();
			resolve();
		}, ms);
		subscription = token.onCancellationRequested(() => {
			clearTimeout(timer);
			subscription?.dispose();
			resolve();
		});
	});
}

function isSupportedDocument(document: vscode.TextDocument, config: CompletionConfig): boolean {
	if (document.uri.scheme !== 'file' && document.uri.scheme !== 'untitled') {
		return false;
	}
	return !config.disabledLanguages.includes(document.languageId);
}

/**
 * prefix 始终从文件第一行取到光标，光标移动时新前缀是旧前缀的超集，
 * 可以命中 DeepSeek 的上下文缓存。超过上限时保留文件开头与光标附近的文本。
 */
export function buildContext(
	document: vscode.TextDocument,
	position: vscode.Position,
	config: CompletionConfig
): DocumentContext | undefined {
	const prefix = document.getText(new vscode.Range(new vscode.Position(0, 0), position));
	if (!prefix.trim()) {
		return undefined;
	}

	let trimmedPrefix = prefix;
	if (prefix.length > config.maxPrefixChars) {
		const headLength = Math.floor(config.maxPrefixChars * 0.6);
		const tailLength = config.maxPrefixChars - headLength;
		trimmedPrefix = prefix.slice(0, headLength) + TRUNCATION_MARKER + prefix.slice(prefix.length - tailLength);
	}

	let suffix = '';
	if (config.suffixLines > 0) {
		const lastLine = document.lineCount - 1;
		const endLine = Math.min(lastLine, position.line + config.suffixLines);
		const end = endLine === lastLine
			? document.lineAt(lastLine).range.end
			: new vscode.Position(endLine, 0);
		suffix = document.getText(new vscode.Range(position, end));
		if (suffix.length > MAX_SUFFIX_CHARS) {
			suffix = suffix.slice(0, MAX_SUFFIX_CHARS);
		}
	}

	return { prefix: trimmedPrefix, suffix };
}

function stripCodeFence(text: string): string {
	const match = text.match(/^\s*```[\w+-]*[ \t]*\n([\s\S]*?)\n```\s*$/);
	return match ? match[1] : text;
}

/**
 * 清理模型输出：去掉特殊 token、代码围栏，裁剪与上下文重复的部分，并限制行数。
 */
export function cleanCompletion(raw: string, context: DocumentContext, maxLines: number): string | undefined {
	let text = raw.replace(/\r\n/g, '\n');
	text = text.replace(/<\|fim_(?:begin|hole|middle|end|suffix)\|>/gi, '');
	text = stripCodeFence(text);

	const prefix = context.prefix.replace(/\r\n/g, '\n');
	const suffix = context.suffix.replace(/\r\n/g, '\n');

	const prefixOverlap = Math.min(prefix.length, text.length, 200);
	for (let length = prefixOverlap; length >= MIN_OVERLAP; length--) {
		if (prefix.endsWith(text.slice(0, length))) {
			text = text.slice(length);
			break;
		}
	}

	// 先处理最常见的整行/换行重复，避免 `}`、`)` 等单字符被漏掉。
	const lastLineStart = text.lastIndexOf('\n') + 1;
	const lastLine = text.slice(lastLineStart);
	const suffixFirstLine = suffix.split('\n', 1)[0];
	if (lastLine.trim() && suffixFirstLine && lastLine.trimEnd() === suffixFirstLine.trimEnd()) {
		text = text.slice(0, lastLineStart);
	} else if (text.endsWith('\n') && suffix.startsWith('\n')) {
		text = text.slice(0, -1);
	} else {
		const suffixOverlap = Math.min(suffix.length, text.length, 200);
		for (let length = suffixOverlap; length >= MIN_OVERLAP; length--) {
			if (suffix.startsWith(text.slice(text.length - length))) {
				text = text.slice(0, text.length - length);
				break;
			}
		}
	}

	const lines = text.split('\n');
	if (lines.length > maxLines) {
		text = lines.slice(0, maxLines).join('\n');
	}

	text = text.trimEnd();
	return text.trim() ? text : undefined;
}

export class DeepSeekInlineProvider implements vscode.InlineCompletionItemProvider {
	private pendingKey: string | undefined;
	private recentResult: { key: string; text: string; at: number } | undefined;
	private authErrorShown = false;
	private quotaErrorShown = false;

	constructor(private readonly output: vscode.OutputChannel) {}

	public async provideInlineCompletionItems(
		document: vscode.TextDocument,
		position: vscode.Position,
		context: vscode.InlineCompletionContext,
		token: vscode.CancellationToken
	): Promise<vscode.InlineCompletionItem[] | undefined> {
		const config = readConfig();
		if (!config.enabled || !isSupportedDocument(document, config)) {
			return undefined;
		}
		if (!config.apiKey) {
			return undefined;
		}

		const key = `${document.uri.toString()}#${position.line}:${position.character}#${document.version}`;
		const now = Date.now();
		if (this.recentResult && this.recentResult.key === key && now - this.recentResult.at < RESULT_CACHE_MS) {
			return this.toItems(this.recentResult.text, position);
		}
		if (this.pendingKey === key) {
			return undefined;
		}

		// 自动触发时等待用户停止输入，旧调用会随 cancellation token 被丢弃。
		if (context.triggerKind === vscode.InlineCompletionTriggerKind.Automatic && config.debounceMs > 0) {
			await delay(config.debounceMs, token);
			if (token.isCancellationRequested) {
				return undefined;
			}
		}

		const documentContext = buildContext(document, position, config);
		if (!documentContext) {
			return undefined;
		}

		const startedAt = Date.now();
		const controller = new AbortController();
		const cancellation = token.onCancellationRequested(() => controller.abort());
		const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

		this.pendingKey = key;
		try {
			const result = await requestFimCompletion(documentContext.prefix, documentContext.suffix, config, controller.signal);
			const text = cleanCompletion(result.text, documentContext, config.maxLines);
			const usage = result.usage;
			this.output.appendLine(
				`[${new Date().toISOString()}] ${config.model} ${Date.now() - startedAt}ms ` +
				`prefix=${documentContext.prefix.length} suffix=${documentContext.suffix.length} ` +
				`cache_hit=${usage?.promptCacheHitTokens ?? 0} cache_miss=${usage?.promptCacheMissTokens ?? 0} ` +
				`lines=${text ? text.split('\n').length : 0}`
			);
			if (!text) {
				return undefined;
			}
			this.recentResult = { key, text, at: Date.now() };
			return this.toItems(text, position);
		} catch (error) {
			if (token.isCancellationRequested) {
				// 用户继续输入或移动了光标，丢弃这次结果。
			} else if (controller.signal.aborted) {
				this.output.appendLine(`[${new Date().toISOString()}] 请求超时（${REQUEST_TIMEOUT_MS}ms）`);
			} else {
				this.reportError(error);
			}
			return undefined;
		} finally {
			clearTimeout(timeout);
			cancellation.dispose();
			if (this.pendingKey === key) {
				this.pendingKey = undefined;
			}
		}
	}

	private toItems(text: string, position: vscode.Position): vscode.InlineCompletionItem[] {
		return [new vscode.InlineCompletionItem(text, new vscode.Range(position, position))];
	}

	private reportError(error: unknown): void {
		if (error instanceof FimError) {
			this.output.appendLine(`[${new Date().toISOString()}] 请求失败 ${error.status ?? ''} ${error.message}`);
			if ((error.status === 401 || error.status === 403) && !this.authErrorShown) {
				this.authErrorShown = true;
				void vscode.window
					.showWarningMessage('DeepSeek 补全：API Key 无效或已过期，请在设置中重新填写。', '打开设置')
					.then(choice => {
						if (choice) {
							void vscode.commands.executeCommand('continue-termux.openSettings');
						}
					});
			} else if (error.status === 402 && !this.quotaErrorShown) {
				this.quotaErrorShown = true;
				void vscode.window.showWarningMessage('DeepSeek 补全：账户余额不足，请充值后再试。');
			}
			return;
		}
		const message = error instanceof Error ? error.message : String(error);
		this.output.appendLine(`[${new Date().toISOString()}] 请求失败 ${message}`);
	}
}
