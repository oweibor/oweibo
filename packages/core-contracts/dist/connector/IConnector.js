"use strict";
/**
 * T.2.f: connector + capability contracts.
 *
 * A Connector is a typed integration (Slack, Postgres, GitHub, …). Each
 * connector exposes one or more Capabilities — discrete actions the
 * connector can perform. Each capability declares its ActionClass so the
 * T.−1 trust ladder gates execution centrally.
 *
 * Catalog entries are platform-curated JSON files; this contract describes
 * their shape. Tenants install instances of catalog entries — a tenant may
 * have multiple instances of the same connector (e.g. postgres-prod and
 * postgres-dev) each with its own credential set in Vault.
 */
Object.defineProperty(exports, "__esModule", { value: true });
//# sourceMappingURL=IConnector.js.map