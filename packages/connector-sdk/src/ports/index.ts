/**
 * K.1 (ADR-012 §3.2) — the six source-adapter ports. A connector
 * implements the subset its source supports; each is a narrow interface
 * the platform runtime calls, so the author writes only source-specific
 * translation (P9).
 *
 * Ports live in the SDK package deliberately: importing a port is
 * importing the SDK, so INV-17 ("connectors import only the SDK") holds
 * by construction (ADR-000 owns the dependency-cruiser enforcement).
 */
export * from './types.js';
export * from './changeFeed.js';
export * from './content.js';
export * from './acl.js';
export * from './principals.js';
export * from './activity.js';
export * from './action.js';

import type { ChangeFeedPort } from './changeFeed.js';
import type { ContentPort } from './content.js';
import type { AclPort } from './acl.js';
import type { PrincipalsPort } from './principals.js';
import type { ActivityPort } from './activity.js';

/**
 * The source-adapter implementations a connector binds (ADR-012 §3.1
 * `ports:` field). Five keys, not six: the Action port is the existing
 * `capabilities[]` on the spec (see ./action.ts) and needs no binding
 * here. Composition behind a binding is private authored code — one
 * ChangeFeedPort may wrap several source APIs; the platform contract is
 * the interface.
 */
export interface PortBindings {
  readonly changeFeed?: ChangeFeedPort;
  readonly content?: ContentPort;
  readonly acl?: AclPort;
  readonly principals?: PrincipalsPort;
  readonly activity?: ActivityPort;
}
