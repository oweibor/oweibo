/**
 * LLM provider registry.
 *
 * Reads LLM_PROVIDER (default: 'ollama') and constructs the appropriate
 * BaseLLMClient with hardware-aware or cloud-tuned circuit breaker config.
 *
 * Cloud circuit breaker defaults are deliberately more lenient on window size
 * (more data before tripping) but stricter on reset timeout (cloud recovers fast).
 *
 * @module services/llm/registry
 */

const config = require('../../config');
const { OllamaClient } = require('./OllamaClient');
const { OpenAIClient, OpenRouterClient, DeepSeekClient } = require('./OpenAIClient');
const { AnthropicClient } = require('./AnthropicClient');

import { LLMClientConfig } from './BaseLLMClient';
import { CircuitBreakerConfig } from './CircuitBreaker';

// Hardware-aware circuit breaker configs for the local Ollama provider.
// Matches the thresholds already used in services/ollama/circuitBreaker.ts.
const OLLAMA_BREAKER_BY_PROFILE: Record<string, CircuitBreakerConfig> = {
    n100_like:      { windowSize: 10, failureThreshold: 0.15, resetTimeoutMs: 300_000 },
    celeron:        { windowSize: 10, failureThreshold: 0.20, resetTimeoutMs: 300_000 },
    core_i3:        { windowSize: 15, failureThreshold: 0.25, resetTimeoutMs: 180_000 },
    core_i5:        { windowSize: 20, failureThreshold: 0.30, resetTimeoutMs: 120_000 },
    core_i7:        { windowSize: 20, failureThreshold: 0.35, resetTimeoutMs: 120_000 },
    amd_low:        { windowSize: 10, failureThreshold: 0.15, resetTimeoutMs: 300_000 },
    amd_mid:        { windowSize: 15, failureThreshold: 0.25, resetTimeoutMs: 180_000 },
    amd_high:       { windowSize: 20, failureThreshold: 0.35, resetTimeoutMs: 120_000 },
    arm64_rpi5:     { windowSize: 10, failureThreshold: 0.20, resetTimeoutMs: 300_000 },
    arm64_server:   { windowSize: 15, failureThreshold: 0.25, resetTimeoutMs: 180_000 },
    nvidia_small:   { windowSize: 15, failureThreshold: 0.30, resetTimeoutMs: 180_000 },
    nvidia_medium:  { windowSize: 20, failureThreshold: 0.35, resetTimeoutMs: 120_000 },
    nvidia_large:   { windowSize: 20, failureThreshold: 0.40, resetTimeoutMs:  60_000 },
    nvidia_rtx:     { windowSize: 20, failureThreshold: 0.40, resetTimeoutMs:  60_000 },
    apple_silicon:  { windowSize: 20, failureThreshold: 0.35, resetTimeoutMs: 120_000 },
};

// Conservative fallback
const OLLAMA_BREAKER_DEFAULT: CircuitBreakerConfig = { windowSize: 10, failureThreshold: 0.15, resetTimeoutMs: 300_000 };

// Cloud providers recover fast — short reset, wider window before tripping
const CLOUD_BREAKER: CircuitBreakerConfig = { windowSize: 20, failureThreshold: 0.50, resetTimeoutMs: 30_000 };

function ollamaBreakerConfig(): CircuitBreakerConfig {
    const profile = config.HARDWARE_PROFILE ?? 'n100_like';
    return OLLAMA_BREAKER_BY_PROFILE[profile] ?? OLLAMA_BREAKER_DEFAULT;
}

function requireKey(name: string): string {
    const val = process.env[name] || config[name];
    if (!val) throw new Error(`LLM provider requires ${name} — set it in your environment`);
    return val;
}

type ProviderName = 'ollama' | 'openai' | 'anthropic' | 'openrouter' | 'deepseek';

function buildClient(providerOverride?: string) {
    const provider = (providerOverride ?? config.LLM_PROVIDER ?? 'ollama') as ProviderName;
    const timeoutMs: number = config.LLM_TIMEOUT_MS ?? 120_000;
    const model: string = config.LLM_MODEL ?? '';

    switch (provider) {
        case 'ollama': {
            const cfg: LLMClientConfig = {
                baseUrl: config.OLLAMA_HOST ?? 'http://ollama:11434',
                model: model || process.env.OLLAMA_DEFAULT_MODEL || process.env.MODEL_CODING || 'qwen2.5-coder:3b',
                timeoutMs,
                breakerConfig: ollamaBreakerConfig(),
            };
            return new OllamaClient(cfg);
        }

        case 'openai': {
            const cfg: LLMClientConfig = {
                baseUrl: config.OPENAI_BASE_URL ?? 'https://api.openai.com',
                apiKey: requireKey('OPENAI_API_KEY'),
                model: model || 'gpt-4o-mini',
                timeoutMs,
                breakerConfig: CLOUD_BREAKER,
            };
            return new OpenAIClient(cfg);
        }

        case 'anthropic': {
            const cfg: LLMClientConfig = {
                baseUrl: config.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com',
                apiKey: requireKey('ANTHROPIC_API_KEY'),
                model: model || 'claude-haiku-4-5-20251001',
                timeoutMs,
                breakerConfig: CLOUD_BREAKER,
            };
            return new AnthropicClient(cfg);
        }

        case 'openrouter': {
            const cfg: LLMClientConfig = {
                baseUrl: config.OPENROUTER_BASE_URL ?? 'https://openrouter.ai/api',
                apiKey: requireKey('OPENROUTER_API_KEY'),
                model: model || 'mistralai/mistral-7b-instruct',
                timeoutMs,
                breakerConfig: CLOUD_BREAKER,
            };
            return new OpenRouterClient(cfg);
        }

        case 'deepseek': {
            const cfg: LLMClientConfig = {
                baseUrl: config.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com',
                apiKey: requireKey('DEEPSEEK_API_KEY'),
                model: model || 'deepseek-chat',
                timeoutMs,
                breakerConfig: CLOUD_BREAKER,
            };
            return new DeepSeekClient(cfg);
        }

        default:
            throw new Error(`Unknown LLM_PROVIDER="${provider}". Valid values: ollama, openai, anthropic, openrouter, deepseek`);
    }
}

module.exports = { buildClient };

export {};
