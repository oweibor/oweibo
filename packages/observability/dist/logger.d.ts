/**
 * Structured pino logger factory.
 * PII redaction baked in — never logs credentials, tokens, or email addresses.
 * Sampling policy: 100% errors, 1% successes — applied by the OTel collector,
 * not here (this logger emits all levels; the collector samples on export).
 */
import pino from 'pino';
export type { Logger } from 'pino';
export declare function createLogger(service: string): pino.Logger;
//# sourceMappingURL=logger.d.ts.map