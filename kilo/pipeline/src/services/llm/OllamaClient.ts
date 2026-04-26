/**
 * Ollama provider — local inference, no auth.
 * Talks to /api/generate (non-streaming).
 *
 * @module services/llm/OllamaClient
 */

const { BaseLLMClient } = require('./BaseLLMClient');

import { GenerateOptions, FetchRequest, LLMClientConfig } from './BaseLLMClient';

class OllamaClient extends (BaseLLMClient as any) {
    constructor(cfg: LLMClientConfig) {
        super(cfg);
    }

    protected buildRequest(prompt: string, opts: GenerateOptions): FetchRequest {
        return {
            url: `${this.cfg.baseUrl}/api/generate`,
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: opts.model ?? this.cfg.model,
                prompt,
                stream: false,
                options: {
                    temperature: 0.1,
                    num_predict: 2000,
                },
            }),
        };
    }

    protected parseResponse(raw: any): string {
        return raw?.response ?? '';
    }
}

module.exports = { OllamaClient };

export {};
