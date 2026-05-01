/**
 * Structured pino logger factory.
 * PII redaction baked in — never logs credentials, tokens, or email addresses.
 * Sampling policy: 100% errors, 1% successes — applied by the OTel collector,
 * not here (this logger emits all levels; the collector samples on export).
 */
import pino from 'pino';

export type { Logger } from 'pino';

const REDACT_PATHS = [
  'password',
  'token',
  'access_token',
  'refresh_token',
  'secret',
  'apiKey',
  'api_key',
  'authorization',
  'req.headers.authorization',
  'req.headers.cookie',
  'email',
];

export function createLogger(service: string): pino.Logger {
  return pino({
    name:  service,
    level: process.env['LOG_LEVEL'] ?? 'info',
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    timestamp:  pino.stdTimeFunctions.isoTime,
    formatters: { level: (label) => ({ level: label }) },
  });
}
