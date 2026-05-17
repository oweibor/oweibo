export interface ILogger {
    info(...args: unknown[]): void;
    warn(...args: unknown[]): void;
    error(...args: unknown[]): void;
    debug(...args: unknown[]): void;
}
/**
 * Validates user-supplied glob patterns against ReDoS and length constraints (C12, v10.5).
 * Returns only valid patterns; drops the rest with a GLOB_PATTERN_INVALID warn log.
 */
export declare function validateGlobPatterns(patterns: readonly string[], logger: ILogger): readonly string[];
//# sourceMappingURL=validateGlobPatterns.d.ts.map