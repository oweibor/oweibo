/**
 * Custom error classes for @oweibo/browser-tool.
 * All errors extend Error and set a descriptive name property.
 * (v9.5.3 C6 — all 8 custom error classes)
 */
export declare class BrowserTenantViolationError extends Error {
    readonly tenantIdFromContext: string;
    readonly tenantIdFromSession: string;
    readonly sessionId: string;
    constructor(tenantIdFromContext: string, tenantIdFromSession: string, sessionId: string);
}
export declare class BrowserPolicyViolationError extends Error {
    readonly reason: string;
    readonly url?: string | undefined;
    constructor(reason: string, url?: string | undefined);
}
export declare class BrowserSessionNotFoundError extends Error {
    readonly sessionId: string;
    constructor(sessionId: string);
}
export declare class BrowserLastTabError extends Error {
    readonly sessionId: string;
    constructor(sessionId: string);
}
export declare class BrowserMemoryError extends Error {
    constructor(message: string);
}
export declare class BrowserVisionError extends Error {
    constructor(message: string);
}
export declare class BrowserSkillParseError extends Error {
    readonly skillId: string;
    constructor(skillId: string, message: string);
}
export declare class BrowserSessionLimitError extends Error {
    constructor(message: string);
}
//# sourceMappingURL=errors.d.ts.map