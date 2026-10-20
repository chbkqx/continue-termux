import * as vscode from 'vscode';

export interface CompletionConfig {
	enabled: boolean;
	apiKey: string;
	baseUrl: string;
	model: string;
	maxTokens: number;
	temperature: number;
	debounceMs: number;
	maxPrefixChars: number;
	suffixLines: number;
	maxLines: number;
	disabledLanguages: string[];
}

const SECTION = 'continue-termux';

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
	if (typeof value !== 'number' || !Number.isFinite(value)) {
		return fallback;
	}
	return Math.min(max, Math.max(min, value));
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
	return Math.round(clampNumber(value, min, max, fallback));
}

export function readConfig(): CompletionConfig {
	const config = vscode.workspace.getConfiguration(SECTION);

	return {
		enabled: config.get<boolean>('enabled', true),
		apiKey: (config.get<string>('apiKey', '') ?? '').trim(),
		baseUrl: (config.get<string>('baseUrl', 'https://api.deepseek.com/beta') ?? '').trim().replace(/\/+$/, ''),
		model: (config.get<string>('model', 'deepseek-flash') ?? '').trim() || 'deepseek-flash',
		maxTokens: clampInt(config.get<number>('maxTokens', 128), 1, 4096, 128),
		temperature: clampNumber(config.get<number>('temperature', 0.2), 0, 2, 0.2),
		debounceMs: clampInt(config.get<number>('debounceMs', 300), 0, 5000, 300),
		maxPrefixChars: clampInt(config.get<number>('maxPrefixChars', 20000), 1000, 128000, 20000),
		suffixLines: clampInt(config.get<number>('suffixLines', 30), 0, 200, 30),
		maxLines: clampInt(config.get<number>('maxLines', 3), 1, 20, 3),
		disabledLanguages: config.get<string[]>('disabledLanguages', []) ?? []
	};
}
