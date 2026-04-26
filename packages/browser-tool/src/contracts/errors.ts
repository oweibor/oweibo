/**
 * Custom error classes for @oweibo/browser-tool.
 * All errors extend Error and set a descriptive name property.
 * (v9.5.3 C6 — all 8 custom error classes)
 */

export class BrowserTenantViolationError extends Error {
  constructor(
    public readonly tenantIdFromContext: string,
    public readonly tenantIdFromSession: string,
    public readonly sessionId: string,
  ) {
    super(
      `Tenant violation: context has tenantId "${tenantIdFromContext}" ` +
      `but session "${sessionId}" belongs to tenant "${tenantIdFromSession}".`,
    );
    this.name = 'BrowserTenantViolationError';
  }
}

export class BrowserPolicyViolationError extends Error {
  constructor(public readonly reason: string, public readonly url?: string) {
    super(`Browser policy violation${url ? ` for URL "${url}"` : ''}: ${reason}`);
    this.name = 'BrowserPolicyViolationError';
  }
}

export class BrowserSessionNotFoundError extends Error {
  constructor(public readonly sessionId: string) {
    super(`Browser session "${sessionId}" not found.`);
    this.name = 'BrowserSessionNotFoundError';
  }
}

export class BrowserLastTabError extends Error {
  constructor(public readonly sessionId: string) {
    super(`Cannot close the last tab in session "${sessionId}". Use destroySession() instead.`);
    this.name = 'BrowserLastTabError';
  }
}

export class BrowserMemoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BrowserMemoryError';
  }
}

export class BrowserVisionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BrowserVisionError';
  }
}

export class BrowserSkillParseError extends Error {
  constructor(public readonly skillId: string, message: string) {
    super(`Skill "${skillId}": ${message}`);
    this.name = 'BrowserSkillParseError';
  }
}

export class BrowserSessionLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BrowserSessionLimitError';
  }
}
