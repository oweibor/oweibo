/**
 * Ollama client facade.
 *
 * Delegates to the active LLM provider from the registry so the module path
 * `require('../ollama/client')` remains stable for all existing callers while
 * the underlying provider (Ollama, OpenAI, Anthropic, etc.) is configured via
 * the LLM_PROVIDER environment variable.
 *
 * The singleton is lazy-initialised so env vars and config are fully loaded
 * before the provider client is constructed.
 *
 * @module services/ollama/client
 */

const { buildClient } = require('../llm/registry');

import { LlmCallType, GenerateOptions, GenerateResult } from '../llm/BaseLLMClient';

let _client: { generate: (p: string, t: LlmCallType, c: string, o: GenerateOptions) => Promise<GenerateResult> } | null = null;

function getClient() {
    if (!_client) _client = buildClient();
    return _client;
}

module.exports = {
    generate(
        prompt: string,
        callType: LlmCallType,
        context = '',
        opts: GenerateOptions = {}
    ): Promise<GenerateResult> {
        return getClient().generate(prompt, callType, context, opts);
    },
};

export {};
