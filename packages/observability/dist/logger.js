"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createLogger = createLogger;
/**
 * Structured pino logger factory.
 * PII redaction baked in — never logs credentials, tokens, or email addresses.
 * Sampling policy: 100% errors, 1% successes — applied by the OTel collector,
 * not here (this logger emits all levels; the collector samples on export).
 */
const pino_1 = __importDefault(require("pino"));
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
function createLogger(service) {
    return (0, pino_1.default)({
        name: service,
        level: process.env['LOG_LEVEL'] ?? 'info',
        redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
        timestamp: pino_1.default.stdTimeFunctions.isoTime,
        formatters: { level: (label) => ({ level: label }) },
    });
}
//# sourceMappingURL=logger.js.map