/**
 * OpenAI-compatible provider clients.
 *
 * OpenAIClient     — api.openai.com
 * OpenRouterClient — openrouter.ai (same wire, extra headers)
 * DeepSeekClient   — api.deepseek.com (same wire, different base URL)
 *
 * All three share the /v1/chat/completions schema so subclasses only
 * override headers or base URL, not request structure.
 *
 * @module services/llm/OpenAIClient
 */

const { BaseLLMClient } = require('./BaseLLMClient');

import { GenerateOptions, FetchRequest, LLMClientConfig } from './BaseLLMClient';

interface OpenAIMessage {
    role: 'user' | 'assistant' | 'system';
    content: string;
}

interface OpenAIResponse {
    choices?: Array<{ message?: { content?: string } }>;
}

class OpenAIClient extends (BaseLLMClient as any) {
    constructor(cfg: LLMClientConfig) {
        super(cfg);
    }

    protected buildRequest(prompt: string, opts: GenerateOptions): FetchRequest {
        const messages: OpenAIMessage[] = [{ role: 'user', content: prompt }];
        return {
            url: `${this.cfg.baseUrl}/v1/chat/completions`,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${this.cfg.apiKey}`,
                ...this.extraHeaders(),
            },
            body: JSON.stringify({
                model: opts.model ?? this.cfg.model,
                messages,
                temperature: 0.1,
                max_tokens: 2000,
            }),
        };
    }

    protected parseResponse(raw: OpenAIResponse): string {
        return raw?.choices?.[0]?.message?.content ?? '';
    }

    // Subclasses override to inject provider-specific headers
    protected extraHeaders(): Record<string, string> {
        return {};
    }
}

class OpenRouterClient extends OpenAIClient {
    protected extraHeaders(): Record<string, string> {
        return {
            'HTTP-Referer': process.env.OPENROUTER_REFERER ?? 'https://kilo.local',
            'X-Title': 'kilo-pipeline',
        };
    }
}

// DeepSeek speaks the same OpenAI wire format; only base URL differs (set in registry)
class DeepSeekClient extends OpenAIClient {}

module.exports = { OpenAIClient, OpenRouterClient, DeepSeekClient };

export {};
