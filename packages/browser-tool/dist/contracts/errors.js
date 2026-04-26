"use strict";
/**
 * Custom error classes for @oweibo/browser-tool.
 * All errors extend Error and set a descriptive name property.
 * (v9.5.3 C6 — all 8 custom error classes)
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.BrowserSessionLimitError = exports.BrowserSkillParseError = exports.BrowserVisionError = exports.BrowserMemoryError = exports.BrowserLastTabError = exports.BrowserSessionNotFoundError = exports.BrowserPolicyViolationError = exports.BrowserTenantViolationError = void 0;
class BrowserTenantViolationError extends Error {
    tenantIdFromContext;
    tenantIdFromSession;
    sessionId;
    constructor(tenantIdFromContext, tenantIdFromSession, sessionId) {
        super(`Tenant violation: context has tenantId "${tenantIdFromContext}" ` +
            `but session "${sessionId}" belongs to tenant "${tenantIdFromSession}".`);
        this.tenantIdFromContext = tenantIdFromContext;
        this.tenantIdFromSession = tenantIdFromSession;
        this.sessionId = sessionId;
        this.name = 'BrowserTenantViolationError';
    }
}
exports.BrowserTenantViolationError = BrowserTenantViolationError;
class BrowserPolicyViolationError extends Error {
    reason;
    url;
    constructor(reason, url) {
        super(`Browser policy violation${url ? ` for URL "${url}"` : ''}: ${reason}`);
        this.reason = reason;
        this.url = url;
        this.name = 'BrowserPolicyViolationError';
    }
}
exports.BrowserPolicyViolationError = BrowserPolicyViolationError;
class BrowserSessionNotFoundError extends Error {
    sessionId;
    constructor(sessionId) {
        super(`Browser session "${sessionId}" not found.`);
        this.sessionId = sessionId;
        this.name = 'BrowserSessionNotFoundError';
    }
}
exports.BrowserSessionNotFoundError = BrowserSessionNotFoundError;
class BrowserLastTabError extends Error {
    sessionId;
    constructor(sessionId) {
        super(`Cannot close the last tab in session "${sessionId}". Use destroySession() instead.`);
        this.sessionId = sessionId;
        this.name = 'BrowserLastTabError';
    }
}
exports.BrowserLastTabError = BrowserLastTabError;
class BrowserMemoryError extends Error {
    constructor(message) {
        super(message);
        this.name = 'BrowserMemoryError';
    }
}
exports.BrowserMemoryError = BrowserMemoryError;
class BrowserVisionError extends Error {
    constructor(message) {
        super(message);
        this.name = 'BrowserVisionError';
    }
}
exports.BrowserVisionError = BrowserVisionError;
class BrowserSkillParseError extends Error {
    skillId;
    constructor(skillId, message) {
        super(`Skill "${skillId}": ${message}`);
        this.skillId = skillId;
        this.name = 'BrowserSkillParseError';
    }
}
exports.BrowserSkillParseError = BrowserSkillParseError;
class BrowserSessionLimitError extends Error {
    constructor(message) {
        super(message);
        this.name = 'BrowserSessionLimitError';
    }
}
exports.BrowserSessionLimitError = BrowserSessionLimitError;
//# sourceMappingURL=errors.js.map