/**
 * legacyBridge
 *
 * Converts the static TENANT_TOKENS / KILO_API_TOKEN environment variables
 * (the pre-Phase 1 auth scheme) into the LegacyToken hash map consumed by
 * the authenticate middleware.
 *
 * Legacy tokens are prefixed with "oweibo_legacy_" at runtime so the
 * authenticate middleware can dispatch them to the correct resolver without
 * an extra DB round-trip.
 *
 * Migration path (Phase 8): import each entry as a real oweibo.api_keys row,
 * then delete this file. The Sunset + Deprecation headers below signal that
 * timeline to callers.
 */
import { createHash } from 'crypto';
import type { LegacyToken } from './types.js';

// Scopes granted to legacy tokens — equivalent to tenant_developer
const LEGACY_SCOPES = [
  'tasks:read', 'tasks:write', 'tasks:cancel',
  'staging:read', 'quarantine:read',
  'scrape:read', 'scrape:write',
  'hitl:read', 'memory:read',
  'tenant:settings:read',
];

/**
 * Build the legacy token hash map from environment variables.
 *
 * The returned Map keys are SHA-256 digests of the raw token values.
 * authenticate() hashes incoming tokens before lookup — Map.get() never
 * operates on raw secret material.
 */
export function buildLegacyTokenMap(): Map<string, LegacyToken> {
  const map = new Map<string, LegacyToken>();

  // TENANT_TOKENS: JSON map of { "<token>": "<tenantId>" }
  const tenantTokensEnv = process.env['TENANT_TOKENS'];
  if (tenantTokensEnv) {
    try {
      const parsed = JSON.parse(tenantTokensEnv) as Record<string, string>;
      for (const [token, tenantId] of Object.entries(parsed)) {
        if (typeof token === 'string' && typeof tenantId === 'string' && token && tenantId) {
          const hashed = createHash('sha256').update(token).digest('hex');
          map.set(hashed, { hashedSecret: hashed, tenantId, scopes: LEGACY_SCOPES });
        }
      }
    } catch {
      console.warn('[api-middleware] TENANT_TOKENS is not valid JSON — ignoring');
    }
  }

  // KILO_API_TOKEN: single legacy token → "default" tenant
  const kiloToken = process.env['KILO_API_TOKEN'];
  if (kiloToken) {
    const hashed = createHash('sha256').update(kiloToken).digest('hex');
    if (!map.has(hashed)) {
      map.set(hashed, { hashedSecret: hashed, tenantId: 'default', scopes: LEGACY_SCOPES });
    }
  }

  return map;
}

/**
 * Express middleware that adds deprecation headers to any response served
 * with a legacy token. Callers that inspect these headers can plan migration.
 */
export function legacyDeprecationHeaders(req: any, res: any, next: () => void): void {
  const principal = req.principal;
  if (principal?.sub?.startsWith('apikey:legacy:')) {
    res.setHeader('Deprecation', 'true');
    res.setHeader(
      'Sunset',
      new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toUTCString(), // ~60 days
    );
    res.setHeader(
      'Link',
      '</api/v1/tenants/{tenantId}/apikeys>; rel="successor-version"',
    );
  }
  next();
}
