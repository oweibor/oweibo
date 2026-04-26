/**
 * Anthropic/Claude provider client.
 * Uses the /v1/messages API (different schema from OpenAI).
 *
 * @module services/llm/AnthropicClient
 */

const { BaseLLMClient } = require('./BaseLLMClient');

import { GenerateOptions, FetchRequest, LLMClientConfig } from './BaseLLMClient';

interface AnthropicContentBlock {
    type: string;
    text?: string;
}

interface AnthropicResponse {
    content?: AnthropicContentBlock[];
}

class AnthropicClient extends (BaseLLMClient as any) {
    constructor(cfg: LLMClientConfig) {
        super(cfg);
    }

    protected buildRequest(prompt: string, opts: GenerateOptions): FetchRequest {
        return {
            url: `${this.cfg.baseUrl}/v1/messages`,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': this.cfg.apiKey ?? '',
                'anthropic-version': '2023-06-01',
            },
            body: JSON.stringify({
                model: opts.model ?? this.cfg.model,
                max_tokens: 2000,
                temperature: 0.1,
                messages: [{ role: 'user', content: prompt }],
            }),
        };
    }

    protected parseResponse(raw: AnthropicResponse): string {
        return raw?.content?.map((b: AnthropicContentBlock) => b.text ?? '').join('') ?? '';
    }
}

module.exports = { AnthropicClient };

export {};
