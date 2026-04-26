/**
 * Abstract base for all LLM provider clients.
 *
 * Owns the parts that MUST be identical across providers:
 *   - AbortController timeout composition
 *   - Caller-signal propagation
 *   - Circuit breaker interaction (record success / failure)
 *   - Hallucination scan
 *   - Typed error classification
 *
 * Subclasses implement only wire-format details: buildRequest + parseResponse.
 *
 * @module services/llm/BaseLLMClient
 */

const logger = require('../logger');
const scanner = require('../ollama/scanner');
const { CircuitBreaker } = require('./CircuitBreaker');

import { CircuitBreakerConfig } from './CircuitBreaker';

export type LlmCallType = 'adr_extraction' | 'semantic_check' | 'summarize';
export type LlmError = 'timeout' | 'cancelled' | 'http' | 'network' | 'hallucination' | 'tripped';

export interface GenerateOptions {
    signal?: AbortSignal;
    timeoutMs?: number;
    model?: string;
}

export interface GenerateResult {
    text: string;
    tripped: boolean;
    error?: LlmError;
}

export interface LLMClientConfig {
    baseUrl: string;
    apiKey?: string;
    model: string;
    timeoutMs: number;
    breakerConfig: CircuitBreakerConfig;
}

export type FetchRequest = {
    url: string;
    method: string;
    headers: Record<string, string>;
    body?: string;
};

/**
 * Merge two AbortSignals into one that fires when either source fires.
 * Uses AbortSignal.any() when available (Node ≥ 20.3), falls back to manual compose.
 */
function mergeSignals(a: AbortSignal, b: AbortSignal): AbortSignal {
    if (typeof (AbortSignal as any).any === 'function') {
        return (AbortSignal as any).any([a, b]) as AbortSignal;
    }
    const ctrl = new AbortController();
    const forward = (sig: AbortSignal) => {
        if (sig.aborted) { ctrl.abort(sig.reason); return; }
        sig.addEventListener('abort', () => { if (!ctrl.signal.aborted) ctrl.abort(sig.reason); }, { once: true });
    };
    forward(a);
    forward(b);
    return ctrl.signal;
}

abstract class BaseLLMClient {
    protected readonly breaker: InstanceType<typeof CircuitBreaker>;

    constructor(protected readonly cfg: LLMClientConfig) {
        this.breaker = new CircuitBreaker(cfg.breakerConfig);
    }

    async generate(
        prompt: string,
        callType: LlmCallType,
        context = '',
        opts: GenerateOptions = {}
    ): Promise<GenerateResult> {
        if (!this.breaker.isCallAllowed()) {
            return { text: '', tripped: true, error: 'tripped' };
        }

        const timeoutMs = opts.timeoutMs ?? this.cfg.timeoutMs;
        const timeoutSignal = AbortSignal.timeout(timeoutMs);
        const signal = opts.signal ? mergeSignals(opts.signal, timeoutSignal) : timeoutSignal;

        logger.debug('LLM call initiating', {
            provider: this.constructor.name,
            callType,
            model: opts.model ?? this.cfg.model,
            timeoutMs,
        });

        try {
            const req = this.buildRequest(prompt, opts);
            const res = await fetch(req.url, {
                method: req.method,
                headers: req.headers,
                body: req.body,
                signal,
            });

            if (!res.ok) {
                const err: any = new Error(`HTTP ${res.status}`);
                err.httpStatus = res.status;
                throw err;
            }

            const raw = await res.json();
            const text = this.parseResponse(raw);
            const scan = scanner.scanResponse(text, callType, context);

            if (!scan.valid) {
                logger.error('Hallucination detected', {
                    reason: scan.reason,
                    provider: this.constructor.name,
                });
                this.breaker.recordFailure();
                return { text: '', tripped: true, error: 'hallucination' };
            }

            this.breaker.recordSuccess();
            return { text, tripped: false };

        } catch (err: any) {
            return this.handleError(err, timeoutSignal);
        }
    }

    private handleError(err: any, timeoutSignal: AbortSignal): GenerateResult {
        if (err?.name === 'AbortError') {
            if (timeoutSignal.aborted) {
                logger.warn('LLM call timed out', {
                    provider: this.constructor.name,
                    timeoutMs: this.cfg.timeoutMs,
                });
                this.breaker.recordFailure();
                return { text: '', tripped: true, error: 'timeout' };
            }
            // Caller-initiated cancellation — never penalise the breaker
            logger.info('LLM call cancelled by caller', { provider: this.constructor.name });
            return { text: '', tripped: false, error: 'cancelled' };
        }

        logger.error('LLM call failed', { error: err.message, provider: this.constructor.name });
        this.breaker.recordFailure();
        return { text: '', tripped: true, error: err.httpStatus ? 'http' : 'network' };
    }

    protected abstract buildRequest(prompt: string, opts: GenerateOptions): FetchRequest;
    protected abstract parseResponse(raw: unknown): string;
}

module.exports = { BaseLLMClient };

export {};
