import { CompletionConfig } from './config';

export interface CacheUsage {
	promptCacheHitTokens?: number;
	promptCacheMissTokens?: number;
	completionTokens?: number;
}

export interface FimResult {
	text: string;
	usage?: CacheUsage;
}

interface CompletionResponse {
	choices?: Array<{ text?: string }>;
	usage?: {
		prompt_cache_hit_tokens?: number;
		prompt_cache_miss_tokens?: number;
		completion_tokens?: number;
	};
	error?: { message?: string };
}

export class FimError extends Error {
	constructor(message: string, readonly status?: number) {
		super(message);
		this.name = 'FimError';
	}
}

function parseErrorMessage(body: string, status: number): string {
	try {
		const parsed = JSON.parse(body) as CompletionResponse;
		if (parsed.error?.message) {
			return `HTTP ${status}: ${parsed.error.message}`;
		}
	} catch {
		// 非 JSON 响应，退回原始文本
	}
	const detail = body.trim().slice(0, 300);
	return detail ? `HTTP ${status}: ${detail}` : `HTTP ${status}`;
}

/**
 * 调用 DeepSeek FIM 补全接口。
 * prefix 必须是从文件开头到光标的文本，以复用服务端上下文缓存。
 */
export async function requestFimCompletion(
	prefix: string,
	suffix: string,
	config: CompletionConfig,
	signal: AbortSignal
): Promise<FimResult> {
	const url = `${config.baseUrl}/completions`;

	let response: Response;
	try {
		response = await fetch(url, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${config.apiKey}`
			},
			body: JSON.stringify({
				model: config.model,
				prompt: prefix,
				suffix,
				max_tokens: config.maxTokens,
				temperature: config.temperature,
				stream: false
			}),
			signal
		});
	} catch (error) {
		if (signal.aborted) {
			throw error;
		}
		const message = error instanceof Error ? error.message : String(error);
		throw new FimError(`网络请求失败: ${message}`);
	}

	const body = await response.text();
	if (!response.ok) {
		throw new FimError(parseErrorMessage(body, response.status), response.status);
	}

	let data: CompletionResponse;
	try {
		data = JSON.parse(body) as CompletionResponse;
	} catch {
		throw new FimError('接口返回了无法解析的内容');
	}

	return {
		text: data.choices?.[0]?.text ?? '',
		usage: data.usage
			? {
				promptCacheHitTokens: data.usage.prompt_cache_hit_tokens,
				promptCacheMissTokens: data.usage.prompt_cache_miss_tokens,
				completionTokens: data.usage.completion_tokens
			}
			: undefined
	};
}
