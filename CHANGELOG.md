# Changelog

All notable changes to Oweibo are documented here.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning: [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

### Pending (Phase 2–8)

- `packages/api-middleware` — shared `authenticate`, `requireScopes`, `requireTenantMatch`, `audit`, `idempotent`, `rateLimit` middleware consumed by both gateways
- NATS JetStream replaces in-memory `queue.ts`; outbox-publisher process for saga atomicity
- Agent JWT wiring: sandbox processes receive short-lived scoped tokens at task launch
- Quota service: Redis-backed per-tenant token and agent-run counters
- Robust CLI (`packages/cli` expansion): all operationIds, device-code login, credentials file
- `apps/admin-web`: Next.js 15 RSC platform + tenant management UI
- Audit middleware on all privileged routes; GDPR erasure endpoint
- OpenTelemetry GenAI semantic conventions across all LLM/agent/tool spans
- Self-hosted observability: OTel collector → Tempo + Loki + Prometheus; Grafana dashboards
- Launch hardening: k6 load test (500 RPS), chaos testing, DR rehearsal, external pentest
- Legacy `TENANT_TOKENS` sunset: 60-day migration window

---

## [0.2.0] — 2026-04-27

### Phase 1: Identity foundation

**`packages/db`** — new package

- Prisma schema covering both `betterauth.*` (BetterAuth-managed) and `oweibo.*` (RLS-enforced) schemas
- `001_initial_schema.sql` migration: full table definitions and RLS policies for `tenants`, `users`, `tenant_memberships`, `api_keys`, `audit_log` (range-partitioned by month), and `outbox`
- `oweibo.append_audit()` `SECURITY DEFINER` function — the only legal path to insert audit rows; `UPDATE`/`DELETE` on `audit_log` denied at the DB layer
- Postgres trigger `betterauth_user_sync` keeps `oweibo.users` in sync with `betterauth.users` (insert → mirror, update → email sync, delete → soft-delete)
- `withTenantContext(principal, fn)` — sets `SET LOCAL app.tenant_id`, `app.is_platform_admin`, and `app.user_id` inside a transaction before running the callback; all application queries must flow through this function
- `appendAudit()` helper — calls the SECURITY DEFINER function via raw SQL
- RLS belt-and-suspenders test suite (`src/__tests__/rls.test.ts`): verifies cross-tenant SELECT is blocked, platform_admin_bypass works, `audit_log` mutations are rejected, and `SET LOCAL` does not leak across transaction boundaries

**`apps/identity`** — new service (port 3110)

- BetterAuth with `multiOrganization` plugin on `betterauth.*` schema; email+password auth, 30-day refresh tokens
- RS256 keypair loaded from env (Vault-injected in production); `initKeys()` called at startup
- `GET /.well-known/jwks.json` — public JWKS endpoint with 10-min `Cache-Control`; downstream gateways verify tokens here
- `mintAccessToken(principal)` — signs RS256 JWTs with `iss`, `aud`, `sub`, `ctx.tenantId`, `scopes[]`, `trust`, `jti`, `kid`
- `verifyAccessToken(token)` — verifies signature, issuer, audience, and algorithm
- `mintAgentToken(opts)` — server-only (no HTTP route); scopes = `parentScopes ∩ agentScopes`; TTL capped at `min(taskBudgetRemaining, 60 min)`
- `ROLE_SCOPES` matrix in `policy.ts` — single source of truth for role-to-scope expansion across six roles (`platform_admin`, `platform_operator`, `platform_billing`, `tenant_admin`, `tenant_developer`, `tenant_viewer`)
- Platform management routes (`/api/v1/platform/*`): tenant CRUD, tenant suspend, platform user role management; all require `platform:tenants:write`
- Tenant management routes (`/api/v1/tenants/:tenantId/*`): member invite/roles/remove, API key create/revoke (raw secret returned once; only SHA-256 hash stored), tenant settings get/patch
- `authenticate` middleware: resolves BetterAuth session cookies, RS256 JWTs, and `oweibo_ak_` API keys; populates `req.principal`
- `requireScopes(...needed)` middleware: 403 with `{ missing: Scope[] }` on insufficient scope
- JWT round-trip test suite (`src/__tests__/jwt.test.ts`): mint/verify round-trip, trust mode derivation, `act_as` claim on agent tokens, forged-key rejection, agent scope intersection, agent TTL cap

**`scripts/check-rls.ts`** — new pre-commit / CI gate

- Parses `packages/db/prisma/schema.prisma` for models declaring `tenantId` or `tenant_id`
- Verifies each such model has a corresponding `ENABLE ROW LEVEL SECURITY` + `CREATE POLICY` in the SQL migrations
- Exits 1 with a named list if any model is missing coverage; exits 0 with count on success

**`scripts/eslint-rules/no-direct-prisma.js`** — new ESLint rule

- Flags `prisma.<model>.*()` calls in any file outside `packages/db/src/client.ts` and `packages/db/src/withTenantContext.ts`
- Detects both `import { prisma } from '@oweibo/db'` and `const { prisma } = require(...)` patterns
- Error message directs to `withTenantContext()` and explains the RLS consequence of bypass

**Workspace and CI**

- `pnpm-workspace.yaml`: added `apps/*` glob to include `apps/identity` and future `apps/admin-web`
- `package.json`: added `check-rls` script; added `check-rls` step to `pnpm ci` pipeline
- `.husky/pre-commit`: added `tsx scripts/check-rls.ts` as the final pre-commit check
- `.dependency-cruiser.js`: four new boundary rules — `no-direct-prisma-outside-db-package`, `identity-service-cannot-import-core-engine`, `identity-service-cannot-import-kilo-pipeline`, `db-package-cannot-import-identity`

---

## [0.1.0] — 2026-04-25

### Phase 0: P0 security hardening

**Path traversal defence**

- `kilo/pipeline/src/services/safePath.ts` (new): `safeJoin()` resolves and checks that the final path stays inside the allowed root; `sanitizeSegment()` strips `..`, null bytes, and path separators from untrusted ID parameters
- Applied to all `CHECKPOINT_DIR` writes in `sandbox.ts`, `executor.ts`, `routes/task.ts`, `routes/status.ts`, `index.ts`, and `recovery/workspaceDiff.ts`

**Input validation**

- `kilo/pipeline/src/middleware/validate.ts` (new): Zod-based schema validator middleware applied to task submission, task-clear, and scrape routes

**Prompt injection defence**

- `kilo/pipeline/src/services/llm/promptSanitize.ts` (new): `wrapUntrusted()` wraps user-supplied content in fenced delimiter blocks with a `SYSTEM_PREAMBLE` that instructs the model to treat wrapped content as data; applied to all five gate/writer/reflection LLM call sites

**Shell injection in executor**

- `services/executor.ts`: replaced `sh -c '...'` shell invocations with direct argv arrays; no shell interpreter involved in task execution

**Rate limiting**

- `kilo/pipeline/src/middleware/rateLimiter.ts` (new): IP-based global limiter (applied pre-auth) + per-tenant limiter (30 req/min on `/task`); mounted in `index.ts` and `routes/task.ts`

**Constant-time auth**

- `kilo/pipeline/src/middleware/auth.ts`: tokens are SHA-256 hashed at startup; lookup compares digests rather than raw secrets, eliminating timing-oracle risk from `Map.get()` early returns

**Sandbox hardening**

- `kilo/pipeline/src/services/sandbox.ts`: added `User: 'node'`, `CapDrop: ['ALL']`, `ReadonlyRootfs: true`, `SecurityOpt: ['no-new-privileges:true']` to all container spawn calls
- `infra/sandbox/Dockerfile` (new): purpose-built sandbox image with `@kilocode/cli` pre-installed, `/tmp` writable, all runtime execution as `node` user

**Qdrant circuit breaker**

- `kilo/pipeline/src/services/qdrant.ts`: `CircuitBreaker` wrapping `withRetry`; breaker state exposed via `getBreakerState()` and surfaced in the `/health` response

**`/metrics` protection**

- `kilo/pipeline/src/index.ts`: `/metrics` endpoint checks `Authorization: Bearer $METRICS_TOKEN` when `METRICS_TOKEN` is set; `/livez` liveness endpoint added (always 200 if process is up)

**Docker Compose**

- `docker-compose.yml`: sandbox image env var wired; `CHECKPOINT_MASTER_KEY` placeholder documented; kilo-proxy `EXEC=1` documented as accepted risk with blast-radius mitigation note

**Monorepo quality gates**

- `.secretlintrc.json` (new): secretlint config with `@secretlint/secretlint-rule-preset-recommend`
- `.husky/pre-commit`: switched `npx secretlint` to `pnpm exec secretlint` to use the locally installed binary; added `node scripts/verify-contract-tests.js`
- `scripts/verify-contract-tests.js` (new): compiled JS version of the contract-test gate (the `.ts` source cannot be called directly by `node` in the hook)
- `packages/module-*/src/__tests__/module-*.contract.test.ts` (7 new files): minimal contract stubs verifying each `IModuleGenerator` exports `manifest`, `generate()`, and `validate()`
- `.dependency-cruiser.js`: added `pathNot: '/__tests__/'` to `module-cannot-import-core-engine` and `module-cannot-import-other-module` so test files importing their own module's source are not flagged as cross-module violations; added Phase 7 doc-generator isolation rules and Phase 0 `no-agentic-prompt-budget-enforcer-reintroduction` guard
- `packages/core-engine/src/doc-generator/DocGeneratorPipeline.ts`: re-routed `PromptBudgetEnforcer` type import through `adapters/PromptBudgetEnforcerAdapter.ts` to satisfy the `doc-generator-llm-via-adapters-only` dep-cruiser rule
- `packages/core-engine/src/doc-generator/adapters/PromptBudgetEnforcerAdapter.ts`: added `export type { PromptBudgetEnforcer }` re-export
- `packages/core-engine/src/doc-generator/__tests__/fixtures/with-secrets/config.ts`: replaced valid-format fake Stripe key (`sk_live_51ABC…`) with `sk_live_FAKE_KEY_FIXTURE_TEST_ONLY_00` (underscores in body break Stripe key validation; GitHub Push Protection no longer flags it)

### Initial commit

- `README.md` (placeholder)
- Full monorepo scaffold: `packages/core-contracts`, `packages/core-engine`, `packages/cli`, `packages/channel-contracts`, `packages/channel-gateway`, `packages/browser-tool`, `packages/browser-extension`, `packages/module-{auth,codegen,compliance,datalayer,export,observability,scaffolding}`, `kilo/pipeline`
- `docker-compose.yml`: Ollama, Qdrant, Redis, SearXNG, docker-socket-proxy, Watchtower
- `pnpm-workspace.yaml`, `tsconfig.base.json`, root `package.json` with Husky, dep-cruiser, secretlint
- `infra/`, `monitoring/prometheus/`, `monitoring/grafana/` scaffolds

---

[Unreleased]: https://github.com/oweibor/oweibo/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/oweibor/oweibo/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/oweibor/oweibo/releases/tag/v0.1.0
