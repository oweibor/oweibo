# Changelog

All notable changes to Oweibo are documented here.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning: [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

### Added — local platform bring-up kit (web-UI-first MVP)

The platform (identity + core-engine + admin-web + Postgres) had no automated,
correct way to be stood up from scratch — the documented flow applied only
`001` and relied on `prisma migrate deploy` (which reads a non-existent
`prisma/migrations/`). This adds a reproducible bring-up path to the login
screen at http://localhost:3120.

- `docker-compose.dev.yml` (new): minimal dev data plane — Postgres 16 + Redis 7 — separate from the legacy agent stack in `docker-compose.yml`
- `.env.dev.example` (new): canonical dev env (git-ignored `.env.dev`), loaded per-service via Node `--env-file`
- `scripts/gen-jwt-keys.sh` (new): generates an RS256 keypair into `.env.dev` (identity requires `JWT_PRIVATE_KEY`/`JWT_PUBLIC_KEY`; nothing generated them before)
- `scripts/db-setup.ts` (new): creates `betterauth.*` tables via a scoped `prisma db push`, then applies every `packages/db/migrations/*.sql` in order, tracked in `public.schema_migrations` (idempotent, re-runnable). Wraps only migrations that do not self-manage a transaction or use `CREATE INDEX CONCURRENTLY`
- `packages/db/prisma/betterauth.prisma` (new): betterauth-only schema used by `db-setup` step 1, so those tables get the exact columns BetterAuth queries without a full `prisma db push` (which cannot express the oweibo RLS/partitioned tables)
- `scripts/seed-admin.ts` (new): signs up the first user via BetterAuth and grants `platform_admin` in `oweibo.users` (previously required manual SQL, or login was impossible)
- Root `package.json` scripts: `dev:up`, `dev:down`, `gen:keys`, `db:setup`, `seed:admin`, `dev:identity`, `dev:engine`, `dev:web`
- `packages/core-engine` `dev`/`start` scripts
- `README.md`: replaced the stale "Getting started" (apply-only-`001` + `prisma migrate deploy`) with the working web-UI quick start, plus the core-engine bring-up

### Fixed

- `packages/db/migrations/001_initial_schema.sql`: `oweibo.tenants.created_by` referenced `oweibo.users(id)` inline, but `oweibo.users` is created later in the same migration — `001` failed on a fresh database. The FK is now added after `oweibo.users` exists (idempotently)
- `apps/identity/src/services/betterAuth.ts`: force UUID primary keys (`advanced.database.generateId: 'uuid'`). The `betterauth_user_sync` trigger casts `NEW.id::uuid`; BetterAuth's default non-UUID ids would have made every sign-up fail
- **core-engine could never boot as a service** (`packages/core-engine/src/main.ts`, `@ts-nocheck`, so none of this was caught):
  - imported `dotenv/config` (not a dependency) — removed; env is loaded via `--env-file`
  - called `createServer(...)` (builds the app but never binds a port) instead of `startServer(...)` — the API never listened
  - `hitlHandoff`, `forensicStorage`, `lineageRecorder`, `rollbackOrchestrator`, `domainRegistry`, and ~11 other services were declared with block scope inside `if (DATABASE_URL)` but referenced unconditionally at the `startServer` call → `ReferenceError` on boot; hoisted to function scope
- `packages/core-engine/src/api/server.ts`: `getInfraCredentials('jwt')` returns `null` under the dev NullVaultClient — guarded so boot doesn't crash on deref
- `packages/core-engine/src/api/middleware/authenticate.ts`: replaced the legacy **HS256 shared-secret** verifier with **RS256 JWKS** verification against identity's `/.well-known/jwks.json` (kid-allowlisted, iss/aud/exp checked; tenant read from `ctx.tenantId`). identity mints RS256 tokens, so the old verifier rejected every one of them. Output shape (`req.userId/tenantId/scopes`) unchanged — no route edits. Uses node:crypto + global `fetch` (no new dependency)
- core-engine per-route authorization: added `packages/core-engine/src/api/middleware/authorize.ts` (`requireScopes`, method-aware — read methods checked against `read` scopes, mutating methods against `write`) and applied it at every `/api/v1` mount in `server.ts`, so scope enforcement is even across `tasks`, `hitl`, `skills`, `actions`, the `/tenants/:tenantId/*` surfaces, and `/platform`. Previously most routes only authenticated; the one existing scope check (`platform.routes.ts`) tested `'platform:admin'` — not a scope in the catalog — so it rejected every real token; now checks `platform:config:write`. `platform_admin`/`tenant_admin` tokens carry the full scope set, so admin flows are unaffected; `tenant_developer`/`tenant_viewer` are limited per role

### Security

- **Closed the action-trust-ladder "pin floor" bypass.** High-risk classes (`financial.payment`, `personnel.access_grant`/`access_revoke`, `irreversible.delete_resource`/`public_publish`) are meant to always require human approval, but the invariant was only enforced on the gate's defaults + auto-promotion — the operator "pin" write path (`DryRunRegistry.pin`, reachable via `POST /actions/trust-matrix/pin`) had no floor check, so a tenant could pin `financial.payment → execute` and grant the agent standing, unattended authority to move money. New `packages/core-engine/src/action/ActionClassFloor.ts` centralises the floor (`isFloorClass` / `pinViolatesFloor` / `PinFloorViolationError`); `DryRunRegistry.pin` now rejects any pin of a floor class to `execute` (→ 403 `pin_below_action_class_floor`), and `ActionTrustLadder` consumes the same module. The floor is extensible via `ACTION_PIN_FLOOR_CLASSES` (add-only). Pin/unpin routes were also raised from `tasks:write` to `tenant:settings:write` (tenant-admin), since pinning changes how autonomously the agent may act. Covered by `ActionClassFloor.test.ts` (6 cases)

### Pending (Phase 7–8)

- Launch hardening: k6 load test (500 RPS sustained), chaos testing, DR rehearsal, external pentest
- Legacy `TENANT_TOKENS` sunset: 60-day migration window, import as real `api_keys` rows

---

## [0.7.0] — 2026-05-16

### Phase 7: CI/test hardening — reliable test pipeline across all packages

**CI workflow (`.github/workflows/oweibo.yml`)**

- Build dependency chain before tests: `core-contracts` → `@oweibo/db` (prisma generate + build) → `@oweibo/api-middleware`; previously only `core-contracts` was built, causing import resolution failures in downstream package tests
- `OWEIBO_DISABLE_PYTHON_SUBPROCESS=1` env var injected into the test run to force `PythonAnalyzer` into regex-fallback mode; avoids flaky 30s subprocess timeouts in sandboxed CI runners
- `QUARANTINE_BASE` set to `${{ runner.temp }}/kilo-quarantine`; makes the quarantine directory env-overridable so tests do not need write access to the repository root
- Removed explicit `pnpm` version pin from the workflow — `pnpm/action-setup@v4` defaults to v9 when no version is specified; eliminated version-drift divergence between local and CI
- `core-engine` jest `testTimeout` bumped to 30 s to accommodate Python subprocess integration tests on slower CI hosts

**`packages/api-middleware`**

- `src/__stubs__/db.ts` (new): in-process stub of `@oweibo/db` exports (`appendAudit`, `prisma`, `withTenantContext`, `Principal`) used by test consumers to avoid triggering `prisma generate` as a side-effect of import
- `vitest.config.ts` (new): moduleNameMapper aliases `@oweibo/db` → the stub; replaces the previous implicit resolution that broke when `@oweibo/db` was not pre-built
- `src/index.ts`: moved `RedisLike` re-export from `types.js` to `idempotent.js` where the type is actually defined; fixes downstream packages that imported it transitively

**`packages/cli`** — jest infrastructure

- `jest.config.js` (new): ts-jest preset wired with `tsconfig.json`; `moduleNameMapper` resolves `.js` ESM extensions to their `.ts` sources so tests can run without a prior build step
- `src/__tests__/commands.test.ts`, `parity.test.ts`: switched `jest.fn()` mock patterns to match updated fetch-client internals

**`packages/core-engine`**

- `jest.config.js`: added `testTimeout: 30000` override; prevents Python subprocess tests from failing on timeout in CI
- `src/doc-generator/analysis/analyzers/PythonAnalyzer.ts`: reads `OWEIBO_DISABLE_PYTHON_SUBPROCESS` env var; when set, skips the subprocess and returns regex-based analysis results directly — eliminates the only non-deterministic CI timeout source

**`packages/module-{auth,codegen,compliance,datalayer,export,observability,scaffolding}`**

- `jest.config.js` (new in each): ts-jest preset; `moduleNameMapper` for `.js` → `.ts` resolution; contract test files discovered via `testMatch: ['**/__tests__/**/*.contract.test.ts']`
- `src/__tests__/*.contract.test.ts`: import paths updated to use the package's own entry point rather than relative internal paths; fixes resolution under ts-jest without a prior build

**`apps/identity`**

- `src/__tests__/jwt.test.ts`: updated mock assertions to match current `mintAccessToken` / `verifyAccessToken` signatures; adds missing `act_as` claim assertions for agent token round-trips

**`kilo/pipeline`**

- `src/services/gates/invariantSemantic.ts`, `routing.ts`, `recovery/convergence.ts`: import path fixes resolving ambiguous `.js` extension references that ts-jest couldn't resolve without a build step
- `tests/test_p2_task_clear_penalise.ts` (new): integration test for the P2 task-clear-penalise path; stubs `@oweibo/api-middleware` to avoid circular build-time dependency

---

## [0.6.0] — 2026-04-29

### Phase 6: Audit, GDPR, OTel GenAI semantic conventions, self-hosted observability stack

**`packages/observability`** — new package

- `genai.ts` — GENAI, OWEIBO, OPERATION constant maps pinned to OTel GenAI semantic conventions v1.29.0 (`CONVENTIONS_VERSION` file)
- `agent-span.ts` — `withAgentSpan(agentId, taskCtx, fn)` opens an `invoke_agent` CLIENT span with all `gen_ai.*` + `oweibo.*` attributes
- `llm-span.ts` — `withLLMSpan(opts, taskCtx, fn, getResult?)` wraps `chat`/`embeddings` calls; `getResult` extractor records token counts, response model, finish reasons post-call
- `tool-span.ts` — `withToolSpan(opts, taskCtx, fn)` wraps tool execution in `execute_tool` INTERNAL spans
- `sdk.ts` — `initOtel(serviceName)` using NodeSDK + OTLPTraceExporter (gRPC) + PrometheusExporter; sets `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=false` in production; `resetSdk()` for test teardown
- `logger.ts` — `createLogger(service)` pino factory; redacts `password`, `token`, `access_token`, `refresh_token`, `email`, `authorization`, and all `req.headers.*` fields
- `buckets.ts` — TOKEN_BUCKETS `[0,100,500,1000,5000,10000,50000,Inf]`, DURATION_BUCKETS, TTFT_BUCKETS, TPOT_BUCKETS for histogram recording

**Instrumentation chokepoints**

- `kilo/pipeline/src/services/llm/BaseLLMClient.ts` — `generate()` now accepts optional `taskCtx`; wraps private `_generate()` in `withLLMSpan`; span `system` derived from class name
- `packages/core-engine/src/tools/ToolRegistry.ts` — `invoke(name, args, taskCtx?)` wraps execution in `withToolSpan({ toolName, toolType: 'function' }, spanCtx, fn)`

**GDPR erasure endpoint**

- `apps/identity/src/routes/gdpr.ts` — `DELETE /api/v1/users/:id/personal-data`; requires `platform:users:delete` scope or `isSelf`; anonymises `betterauth.users` via `$executeRaw`; soft-deletes `oweibo.users`; deletes Qdrant vectors by `user_id` filter across 3 collections; fire-and-forget MinIO prefix purge
- Mounted in `apps/identity/src/index.ts`

**Audit middleware wired to 16 privileged routes**

- `kilo/pipeline/src/routes/task.ts` — `task.create`, `task.clear`
- `kilo/pipeline/src/routes/staging.ts` — `staging.approve`, `staging.reject`
- `kilo/pipeline/src/routes/quarantine.ts` — `quarantine.override`
- `apps/identity/src/routes/platform.ts` — `platform.tenant.create`, `platform.tenant.update`, `platform.tenant.suspend`, `platform.user.roles`
- `apps/identity/src/routes/tenant.ts` — `tenant.member.invite`, `tenant.member.roles`, `tenant.member.remove`, `tenant.apikey.create`, `tenant.apikey.revoke`, `tenant.settings.update`
- `apps/identity/src/routes/gdpr.ts` — `gdpr.user.erase`

**Self-hosted observability stack (`infra/observability/` + `docker-compose.yml`)**

- **OTel Collector** (`otelcol-config.yaml`): OTLP/gRPC :4317 receiver; tail-based sampling (100% ERROR spans, 1% success); `attributes/strip-content` processor deletes `gen_ai.prompt` + `gen_ai.completion` (PII policy §15.6.1.4); fans out to Tempo (traces), Prometheus remote write (metrics), Loki (logs)
- **Tempo** (`tempo.yaml`): OTLP/gRPC ingest from otelcol; local storage; 30-day block retention; service-graphs + span-metrics metrics generators
- **Loki** (`loki.yaml`): TSDB v13 schema; local filesystem chunks; 30-day retention; alertmanager integration
- **Prometheus** (`prometheus.yml`): remote write receiver enabled; scrapes `otelcol:8888` (collector internal metrics); alertmanager at `:9093`
- **Grafana** (`grafana/provisioning/datasources/oweibo.yaml`): auto-provisions all three datasources on startup; Tempo configured with `tracesToLogsV2` (Loki, `oweibo.tenant.id` tag), `tracesToMetrics` (Prometheus), node graph, TraceQL editor
- **Alertmanager** (`alertmanager.yml`): P0 → Matrix webhook + on-call webhook (both `continue: true`); P2+ → email; group by `alertname + oweibo_tenant_id + severity`; `critical` inhibits `warning` for the same alert

**ESLint and dep-cruiser**

- `scripts/eslint-rules/no-direct-llm-call.js` — blocks `import`/`require` of any LLM provider client (Ollama, OpenAI, Anthropic, DeepSeek, OpenRouter) outside `BaseLLMClient` and test files
- `.dependency-cruiser.js` — two new rules: `observability-cannot-import-business-logic`, `no-direct-llm-provider-outside-base-client`

**CI conformance gates**

- `e2e/observability/genai-conformance.test.ts` — static file-system test: CONVENTIONS_VERSION semver, all required `gen_ai.*` attribute keys present, otelcol strips PII content, tail-sampling covers ERROR spans, ESLint rule covers all providers, dep-cruiser rules registered, Grafana trace→log correlation wired
- `packages/api-middleware/src/__tests__/audit-coverage.test.ts` — unit tests for outcome derivation (allow/deny/error), action string correctness, no-op on unauthenticated requests; documents complete 16-action privileged action space

**Package dependency updates**

- `kilo/pipeline/package.json` — added `@oweibo/observability: workspace:*`
- `packages/core-engine/package.json` — added `@oweibo/observability: workspace:*`
- `apps/identity/package.json` — added `@oweibo/api-middleware: workspace:*`
- `pnpm-workspace.yaml` — added `e2e` package

---

## [0.5.0] — 2026-04-29

### Phase 5: Web admin UI — Next.js 15 RSC, RBAC middleware, tenant switcher, Playwright e2e

**`apps/admin-web`** — new package (port 3120)

- Next.js 15 App Router, React 19, `jose ^5.9.6`; standalone output for container deployment
- `IDENTITY_URL` + `PIPELINE_URL` env vars control upstream service addresses

**`apps/admin-web/middleware.ts`** — edge-runtime RBAC route guard

- JWT payload decoded with `atob()` (no `Buffer`; Edge Runtime safe); no signature verification at the edge — API layer is the security boundary
- Public routes: `/login`, `/logout`, `/unauthorized`, `/api/*`; all others require a valid, non-expired session cookie
- Expired token: clears `oweibo_session` cookie and redirects to `/login?reason=expired`
- `/platform/*` — requires `platform:tenants:read` scope; 403 → `/unauthorized`
- `/t/*` — requires `tasks:read` or `platform:tenants:read` scope

**`apps/admin-web/lib/auth.ts`** — server-side session helpers

- `SessionUser` interface: `{ user_id, email, tenant_id, scopes, trust }`
- `getSessionToken()` — reads `oweibo_session` cookie (async; Next.js 15)
- `requireAuth()` — redirects to `/login` if no valid token; returns `SessionUser`
- `requireScope(scope)` — redirects to `/unauthorized` if scope is missing
- `setSessionCookies(accessToken, refreshToken)` — writes `oweibo_session` (httpOnly, sameSite=strict, 15 min) and `oweibo_refresh` (30 days)
- `clearSessionCookies()` — deletes both cookies

**`apps/admin-web/lib/api.ts`** — server-side HTTP clients

- `identityApi` — base URL from `IDENTITY_URL`; reads session token from cookies on each call
- `pipelineApi` — base URL from `PIPELINE_URL`; same auth injection
- Both clients: `get`, `post`, `patch`, `delete` with typed generics

**Auth routes**

- `app/(auth)/login/page.tsx` — server component; `loginAction` server action calls `POST /api/v1/auth/token` on the identity service, sets cookies via `setSessionCookies()`, and redirects platform admins to `/platform/tenants` and tenant admins to `/t/<tenantId>`
- `app/(auth)/logout/route.ts` — GET + POST handler; calls identity logout endpoint, clears cookies, redirects to `/login`

**Platform route group** (`/platform/*`)

- `app/(platform)/layout.tsx` — calls `requireScope('platform:tenants:read')`; renders top NavBar
- `app/(platform)/tenants/page.tsx` — RSC; `identityApi.get('/api/v1/platform/tenants')` → table with name / slug / status / created-at + "Open →" link
- `app/(platform)/tenants/new/page.tsx` — form + `createTenantAction` → `POST /api/v1/platform/tenants`; redirects to tenant detail on success
- `app/(platform)/tenants/[id]/page.tsx` — tenant `<dl>` with `suspendAction` server action; "Manage tenant →" link to `/t/<id>`
- `app/(platform)/users/page.tsx` — RSC; `identityApi.get('/api/v1/platform/users')` → table

**Tenant route group** (`/t/:tenantId/*`)

- `app/(tenant)/[tenantId]/layout.tsx` — sidebar nav; renders `<TenantSwitcher />`; links to all tenant sub-pages
- `app/(tenant)/[tenantId]/page.tsx` — dashboard with recent task summary
- `app/(tenant)/[tenantId]/members/page.tsx` — member list; `inviteAction` server action
- `app/(tenant)/[tenantId]/keys/page.tsx` — API key list; `createKeyAction` + `revokeKeyAction` server actions; raw secret shown once on creation
- `app/(tenant)/[tenantId]/settings/page.tsx` — trust mode select + `updateSettingsAction` → `PATCH /api/v1/tenants/:id/settings`
- `app/(tenant)/[tenantId]/tasks/page.tsx` — task list table; status badges
- `app/(tenant)/[tenantId]/staging/page.tsx` — staging queue; `approveAction` / `rejectAction` → `POST /staging/:id/approve|reject`
- `app/(tenant)/[tenantId]/quarantine/page.tsx` — quarantine list; `overrideAction` → `POST /quarantine/:id/override`

**Shared components**

- `components/NavBar.tsx` — top bar with sign-out link
- `components/TenantSwitcher.tsx` — `'use client'`; dropdown of user's tenants; calls `POST /api/switch-tenant` then navigates to the new tenant route
- `components/PageHeader.tsx` — consistent `<h1>` + breadcrumb wrapper

**`apps/admin-web/app/api/switch-tenant/route.ts`** — tenant switching API route

- `POST` handler; reads current `oweibo_session` cookie; forwards to `POST /api/v1/auth/switch-tenant` on identity service; re-writes `oweibo_session` cookie with the new scoped token

**`apps/identity/src/routes/authToken.ts`** — added `switch-tenant` endpoint

- `POST /api/v1/auth/switch-tenant` — verifies existing access JWT; calls `buildPrincipal(userId, tenantId)`; returns 403 `not_a_member` if the user has no active membership; mints and returns a new access token scoped to the requested tenant

**Tests**

- `apps/admin-web/__tests__/middleware.test.ts` — 10 Vitest tests for `decodePayload`, `isExpired`, `hasScope`; RBAC scenarios for `platform_admin`, `tenant_viewer`, and expired tokens
- `apps/admin-web/__tests__/session.test.ts` — 7 Vitest tests for `parseJwtPayload`, `payloadToSessionUser`, round-trip losslessness
- `apps/admin-web/e2e/journeys.spec.ts` — 14 Playwright tests covering: login page renders, unauthenticated redirect, wrong-password error, platform admin journey (tenant list / new tenant / users / sign-out / RBAC), tenant admin journey (dashboard / members / API keys / settings / tasks / staging / quarantine / RBAC)

---

## [0.4.0] — 2026-04-29

### Phase 4: Robust CLI — resource-family commands, auth, credentials, parity gate

**`packages/cli/src/credentials.ts`** — new credentials helper

- `readCredentials()` / `writeCredentials()` / `clearCredentials()` — read and write `~/.oweibo/credentials` as JSON with mode `0600`
- `isTokenExpired()` — returns `true` if the access token expires within 60 s (triggers pre-emptive refresh)
- `Credentials` interface: `access_token`, `refresh_token`, `expires_at`, `user_id`, `tenant_id`, `email`, `scopes`

**`packages/cli/src/client.ts`** — extended HTTP client

- Two named clients: `api` (pipeline, default `:3100`) and `identityApi` (identity service, default `:3110`)
- `OWEIBO_IDENTITY_URL` env var controls the identity base URL
- `getBearerToken()` reads `OWEIBO_API_KEY` → credentials file → transparent refresh on near-expiry
- Added `PATCH` and `DELETE` methods to both clients

**`apps/identity/src/routes/authToken.ts`** — new CLI auth endpoints

- `POST /api/v1/auth/token` — email + password → `{ access_token, refresh_token, expires_at, user_id, tenant_id, email, scopes }`; uses BetterAuth programmatic API to verify credentials; builds `Principal` from DB memberships; mints RS256 access + refresh tokens
- `POST /api/v1/auth/refresh` — verifies refresh JWT; re-derives scopes from DB (role changes take effect on next refresh); mints new access token
- `GET /api/v1/auth/me` — verifies JWT and returns `{ user_id, email, tenant_id, scopes, trust }`
- `POST /api/v1/auth/logout` — stateless (204); signals client to clear local credentials

**New CLI commands**

Auth:
- `oweibo login [--email <e>] [--tenant <id>]` — prompts for password; stores credentials in `~/.oweibo/credentials`
- `oweibo logout` — clears credentials and calls logout endpoint
- `oweibo whoami` — calls `/api/v1/auth/me`

Platform (require `platform:tenants:write`):
- `oweibo platform tenant list / create / get / update / suspend`
- `oweibo platform user list / role <userId> <roles>`

Tenant:
- `oweibo tenant member list / invite / role / remove [--tenant <id>]`
- `oweibo tenant key list / create / revoke [--tenant <id>]`
- `oweibo tenant settings get / set [--tenant <id>]`

Task:
- `oweibo task submit <instruction> [--wait] [--file <path>]`
- `oweibo task list [--status <s>] [--limit <n>]`
- `oweibo task status / pause / cancel / clear`

Resource families:
- `oweibo staging list / approve / reject`
- `oweibo quarantine list / override`
- `oweibo scrape start / list / status / stop / results`
- `oweibo ledger list [--date <YYYY-MM-DD>]`
- `oweibo hitl list / approve / reject`

**`packages/cli/src/operationIds.ts`** — bidirectional parity map

- 35 entries mapping every API `operationId` to a CLI command path
- Covers all resource families: platform, tenant, task, staging, quarantine, scrape, ledger, hitl, auth

**Tests**

- `packages/cli/src/__tests__/parity.test.ts` — 4 jest tests; verifies: every operationId has a CLI path, ≥30 entries, no duplicate paths, all families covered
- `packages/cli/src/__tests__/commands.test.ts` — 25 integration tests; mocks `global.fetch`; verifies HTTP method + URL for every command family

---

## [0.3.0] — 2026-04-29

### Phase 3: NATS event bus, agent JWT, quota service, scope middleware

**`kilo/pipeline/src/services/nats.ts`** — new NATS JetStream client

- Connects to NATS server at `NATS_URL` (default `nats://localhost:4222`)
- `ensureStream()` creates the `tasks` stream (`subjects: tasks.>`) on first connect if it does not exist
- `publish(subject, payload)` — publishes JSON payload to JetStream; degrades to a no-op warn when disconnected
- `drainNats()` — flushes pending messages and closes the connection on graceful shutdown
- Wrapped with `initNats()` which is called in `main()` with a non-fatal catch (fails open so NATS being down does not block startup)

**`kilo/pipeline/src/services/outboxPublisher.ts`** — new file-based outbox publisher

- `writeOutboxEvent(subject, payload)` — writes a JSON outbox record to `OUTBOX_DIR` synchronously with the in-memory state change (atomic within the process)
- `startOutboxPublisher()` — polls OUTBOX_DIR every 1 s; publishes pending records to NATS via `publish()`, then unlinks the file on success
- Survives process crash: records written before the crash are replayed on the next startup — at-least-once delivery to NATS; consumers use `jti` / subject key for deduplication
- `services/queue.ts` now calls `writeOutboxEvent` on enqueue, complete, and fail transitions

**`kilo/pipeline/src/services/quota.ts`** — new Redis-backed quota service

- Exposes `consume(tenantId, kind, amount)`, `isAllowed(tenantId, kind, cap)`, `checkAndConsume(tenantId, kind, amount, cap)`, `getUsage(tenantId)`
- Quota kinds: `tasks_day` (50), `tokens_day` (1 M), `scrapes_day` (10), `agent_min_day` (60)
- Daily rolling window keyed by `quota:<tenantId>:<kind>:<YYYY-MM-DD>`; 25-hour TTL on every key
- Fails open when Redis is unavailable — quota enforcement is best-effort in v1
- `initQuota(redisClient)` called at startup with the shared ioredis instance
- `POST /task` enforces `tasks_day` quota; returns 429 `quota_exceeded` on breach

**`packages/api-middleware/src/ssrfGuard.ts`** — new shared SSRF guard

- Exported from `@oweibo/api-middleware` as `assertSafeTarget(url)` and `SafeTarget` type
- Rejects non-HTTP(S) schemes, userinfo in URLs, literal private/loopback/link-local IPs, and hostnames that resolve to any private IP
- DNS resolved once with both A and AAAA lookups; any private result blocks the request (defeats DNS rebinding)
- Block ranges: `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `127.0.0.0/8`, `169.254.0.0/16`, `::1`, `fc00::/7`, `fe80::/10`, IPv4-mapped IPv6

**`apps/identity/src/routes/agentToken.ts`** — new internal agent-token mint endpoint

- `POST /internal/agent-token` — guarded by `x-internal-service-key` header (shared secret in `INTERNAL_SERVICE_KEY` env)
- Calls `mintAgentToken(opts)` with: `taskId`, `runId`, `userId`, `tenantId`, `parentScopes`, profile-derived `agentScopes`, `taskBudgetRemainingMs`
- `agentScopesForProfile(profile)` maps `architect | orchestrate | writer-* | reflection | recovery` to their permitted scope sets
- Returns `{ token: string }` — the caller passes the JWT as `OWEIBO_AGENT_TOKEN` env var in the sandbox container
- Not routed via Caddy/Traefik; the `INTERNAL_SERVICE_KEY` check is the application-layer guard

**`kilo/pipeline/src/services/sandbox.ts`** — agent JWT wiring

- `fetchAgentToken(opts)` — calls `AGENT_TOKEN_ENDPOINT` with `x-internal-service-key`; 5 s timeout; falls back to empty string (dev/degraded mode)
- `spawnSandbox()` accepts `taskContext` parameter `{ userId, tenantId, scopes, agentProfile, budgetMs }`; mints an agent JWT before creating the container
- `OWEIBO_AGENT_TOKEN` env var injected into sandbox; replaces static `KILO_API_TOKEN` for credential-passing
- `RUN_ID` env var added (`<taskId>-<timestamp>`); used in agent audit attribution

**Route scope guards (`requireScopes` on every mutating route)**

- `POST /task` — requires `tasks:write`; daily quota check via quota service
- `POST /task/clear` — requires `tasks:write`
- `GET  /staging` — requires `staging:read`
- `POST /staging/:id/approve` — requires `staging:approve`
- `POST /staging/:id/reject` — requires `staging:reject`
- `GET  /quarantine` — requires `quarantine:read`
- `POST /quarantine/:id/override` — requires `quarantine:override`
- All routes use `authenticate(jwksCfg, legacyTokenMap)` from `@oweibo/api-middleware`; tenant ID sourced from `principal.ctx.tenantId`

**Config additions**

- `kilo/pipeline/src/config.ts`: `NATS_URL`, `REDIS_URL`, `AGENT_TOKEN_ENDPOINT`, `INTERNAL_SERVICE_KEY`
- `apps/identity/src/config.ts`: `INTERNAL_SERVICE_KEY` (optional, min 32 chars)
- `kilo/pipeline/package.json`: added `nats ^2.28.0`, `ioredis ^5.3.2`

**dep-cruiser boundary rules (Phase 2, added same commit)**

- `api-middleware-cannot-import-core-engine` — middleware package is HTTP-layer only
- `api-middleware-cannot-import-identity` — JWT verified via JWKS endpoint, no direct coupling
- `kilo-pipeline-cannot-import-identity` — auth delegated to `packages/api-middleware`

**Tests**

- `kilo/pipeline/src/services/__tests__/quota.test.ts` — in-memory Redis mock; tests consume, isAllowed, checkAndConsume, and fail-open behaviour
- `kilo/pipeline/src/services/__tests__/nats.test.ts` — smoke tests; publish is a no-op when disconnected
- `packages/api-middleware/src/__tests__/ssrfGuard.test.ts` — 9 cases covering all rejection codes and the happy path

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

[Unreleased]: https://github.com/oweibor/oweibo/compare/v0.7.0...HEAD
[0.7.0]: https://github.com/oweibor/oweibo/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/oweibor/oweibo/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/oweibor/oweibo/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/oweibor/oweibo/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/oweibor/oweibo/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/oweibor/oweibo/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/oweibor/oweibo/releases/tag/v0.1.0
