/**
 * K.7 — DelegatedTokenService (arch §12.3, §12.5): short-lived, action-scoped
 * impersonation tokens for Delegated mode. Greenfield (§12.3 "must be built").
 *
 * Custody guarantee (INV-10): the raw token is NEVER returned to the agent /
 * planner / tool I/O. `issue` hands back an OPAQUE HANDLE; the token itself is
 * held write-only and resolved ONLY at egress via `redeem` (the egress
 * resolver, never the model). Tokens are:
 *   - short-lived (TTL, default 5 min),
 *   - scoped to one (tenant, user, action_class),
 *   - single-use (redeem consumes; a second redeem fails),
 *   - never cached (each action issues its own),
 *   - audited at issuance / use / expiry.
 */

import { randomUUID } from 'crypto';

export type TokenAuditEvent =
  | { readonly kind: 'issued'; readonly handle: string; readonly tenantId: string; readonly userId: string; readonly actionClass: string; readonly expiresAtMs: number }
  | { readonly kind: 'used'; readonly handle: string; readonly tenantId: string; readonly actionClass: string }
  | { readonly kind: 'expired'; readonly handle: string; readonly tenantId: string; readonly actionClass: string };

export type TokenAuditor = (event: TokenAuditEvent) => void | Promise<void>;

export interface IssueInput {
  readonly tenantId: string;
  readonly userId: string;
  readonly actionClass: string;
  /** TTL in ms; default 5 min. */
  readonly ttlMs?: number;
  /**
   * The raw scoped token minted by the auth layer (short-lived OAuth /
   * service token). Held write-only; NEVER echoed to the agent.
   */
  readonly rawToken: string;
}

/** The opaque handle the agent/planner sees — carries NO secret. */
export interface DelegatedTokenHandle {
  readonly handle: string;
  readonly tenantId: string;
  readonly actionClass: string;
  readonly expiresAtMs: number;
}

interface StoredToken {
  readonly rawToken: string;
  readonly tenantId: string;
  readonly userId: string;
  readonly actionClass: string;
  readonly expiresAtMs: number;
  used: boolean;
}

const DEFAULT_TTL_MS = 5 * 60 * 1000;

export class DelegatedTokenService {
  private readonly store = new Map<string, StoredToken>();

  constructor(
    private readonly audit: TokenAuditor = () => undefined,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Issue a scoped token; returns an OPAQUE handle (no secret). Audited. */
  async issue(input: IssueInput): Promise<DelegatedTokenHandle> {
    const handle = randomUUID();
    const expiresAtMs = this.now() + (input.ttlMs ?? DEFAULT_TTL_MS);
    this.store.set(handle, {
      rawToken: input.rawToken,
      tenantId: input.tenantId,
      userId: input.userId,
      actionClass: input.actionClass,
      expiresAtMs,
      used: false,
    });
    await this.audit({
      kind: 'issued', handle, tenantId: input.tenantId, userId: input.userId,
      actionClass: input.actionClass, expiresAtMs,
    });
    return { handle, tenantId: input.tenantId, actionClass: input.actionClass, expiresAtMs };
  }

  /**
   * Redeem a handle at EGRESS ONLY — returns the raw token for injection into
   * the outbound request. Single-use and TTL-checked; a used/expired/unknown
   * handle throws. Audited at use. This is the ONLY path that yields the
   * secret, and it is never called from agent/planner code.
   */
  async redeem(handle: string): Promise<string> {
    const t = this.store.get(handle);
    if (!t) throw new DelegatedTokenError('unknown', handle);
    if (t.used) throw new DelegatedTokenError('already_used', handle);
    if (this.now() >= t.expiresAtMs) {
      this.store.delete(handle);
      await this.audit({ kind: 'expired', handle, tenantId: t.tenantId, actionClass: t.actionClass });
      throw new DelegatedTokenError('expired', handle);
    }
    t.used = true;
    this.store.delete(handle); // never cached — consumed on use
    await this.audit({ kind: 'used', handle, tenantId: t.tenantId, actionClass: t.actionClass });
    return t.rawToken;
  }

  /** Explicitly expire an unredeemed handle (e.g. action aborted). Audited. */
  async expire(handle: string): Promise<void> {
    const t = this.store.get(handle);
    if (!t) return;
    this.store.delete(handle);
    await this.audit({ kind: 'expired', handle, tenantId: t.tenantId, actionClass: t.actionClass });
  }
}

export class DelegatedTokenError extends Error {
  constructor(public readonly reason: 'unknown' | 'already_used' | 'expired', handle: string) {
    super(`DelegatedTokenService: token ${reason} (handle ${handle})`);
    this.name = 'DelegatedTokenError';
  }
}
