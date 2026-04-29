# Oweibo

**Agent-as-a-Service (AaaS) platform.** Multi-tenant autonomous software engineering, delivered as a SaaS. Customers submit multi-stage directions — market research, website builds, feature work, bug fixes, codebase Q&A, PR proposals — and the platform acts on them end-to-end, in parallel, per tenant, with full memory across tasks.

Comparable reference points: Manus (autonomous task execution) × Claude Code (CLI-native dev agent) × a multi-tenant SaaS. The key difference is that every tenant gets their own isolated agent instance with scoped memory, sandbox, trust mode, and quota.

---

## Table of contents

1. [Architecture overview](#architecture-overview)
2. [Repository layout](#repository-layout)
3. [Services and ports](#services-and-ports)
4. [Identity and authorization](#identity-and-authorization)
5. [Data plane](#data-plane)
6. [Agentic pipeline](#agentic-pipeline)
7. [Memory tiers](#memory-tiers)
8. [Module factory](#module-factory)
9. [Channel gateway](#channel-gateway)
10. [Browser tool](#browser-tool)
11. [Infrastructure stack](#infrastructure-stack)
12. [Getting started](#getting-started)
13. [Environment variables](#environment-variables)
14. [Development workflow](#development-workflow)
15. [Testing](#testing)
16. [Architectural boundaries](#architectural-boundaries)
17. [Implementation status](#implementation-status)

---

## Architecture overview

```text
                ┌──── Caddy / Traefik (TLS, rate-limit) ──────────┐
                │                                                  │
                │   api.oweibo.io         admin.oweibo.io          │
                └──────┬──────────────────────────┬───────────────┘
                       │                          │
      ┌────────────────┼──────────────┐           │
      ▼                ▼             ▼            ▼
apps/identity    kilo-pipeline   core-engine   apps/admin-web
(port 3110)      API (3100)      API (3101)    (port 3120, Next.js)
      │                │             │            │
      └────────────────┴─────────────┴────────────┘
                       │ shared infrastructure (self-hosted)
      ┌────────────────┼────────────────────────────────┐
      ▼                ▼           ▼        ▼           ▼
   Postgres 16      Redis       NATS JS   Qdrant      MinIO
 (betterauth.*   (idempotency, (task bus, (4-tier    (artifacts,
  oweibo.* RLS)   RL, JWKS      outbox)   memory)   checkpoints,
                  cache)                            audit cold)
                       │
              Ollama / OpenAI / Anthropic / DeepSeek / OpenRouter
                  Langfuse (LLM tracing)   Vault OSS (secrets, KMS)
```

**Infrastructure stance: no cloud-subscription services.** Every component runs on self-hosted infrastructure. The schema and APIs are designed so cloud equivalents (RDS, S3, managed Redis) can slot in without code changes.

---

## Repository layout

```text
oweibo/
├── apps/
│   ├── identity/          BetterAuth IdP, RS256 JWKS, JWT mint/verify
│   │                      Platform and tenant management REST endpoints (port 3110)
│   └── admin-web/         Next.js 15 RSC admin UI (port 3120) — Phase 5
│
├── packages/
│   ├── core-contracts/    Zero-dependency TypeScript contracts — the only legal
│   │                      import for module-* packages (IModuleGenerator, events, types)
│   ├── core-engine/       Agentic pipeline, swarm coordinator, general-coding
│   │                      intelligence, skill registry, doc-generator, ingestion
│   ├── db/                Prisma schema (betterauth.* + oweibo.*), withTenantContext
│   │                      chokepoint, RLS migrations, appendAudit helper
│   ├── cli/               oweibo CLI — task, staging, quarantine, scrape, ledger, HITL
│   ├── channel-contracts/ Zero-dependency channel platform types (Telegram, Discord, …)
│   ├── channel-gateway/   Multi-tenant social channel gateway (9 platform adapters)
│   ├── browser-tool/      51 atomic browser actions, multi-backend stealth, vision loop
│   ├── browser-extension/ Standalone Chrome extension (zero server imports)
│   ├── module-auth/       Output-app generator: BetterAuth / Auth.js / Zitadel-native
│   ├── module-codegen/    Output-app generator: code generation
│   ├── module-compliance/ Output-app generator: compliance layer
│   ├── module-datalayer/  Output-app generator: data layer (Prisma + migrations)
│   ├── module-export/     Output-app generator: export pipeline
│   ├── module-observability/ Output-app generator: observability stack
│   └── module-scaffolding/  Output-app generator: project scaffolding
│
├── kilo/
│   └── pipeline/          Core orchestration service (port 3100) — architect, orchestrate,
│                          gates (G1–G10), recovery, writers (W1–W5), promotion engine,
│                          curriculum learning, idle reflection, memory decay
│
├── infra/
│   ├── sandbox/           Hardened Docker image for agent task execution
│   │                      (CapDrop=ALL, ReadonlyRootfs=true, User=node)
│   ├── deploy/            Helm charts and compose files
│   ├── nginx/             Reverse proxy config
│   └── zitadel/           Reserved (not deleted) — future OIDC option
│
├── scripts/
│   ├── assert-tests-exist.ts    CI gate: every src file has a test file
│   ├── verify-contract-tests.ts Gate: every module-* has a *.contract.test.ts
│   ├── check-rls.ts             Gate: every tenantId Prisma model has RLS migration
│   └── eslint-rules/
│       └── no-direct-prisma.js  ESLint rule: bans prisma.* outside packages/db
│
├── monitoring/
│   ├── prometheus/        Scrape configs
│   └── grafana/           Dashboard definitions
│
├── docker-compose.yml     Single-command dev stack
├── .dependency-cruiser.js Architectural boundary enforcement (19 rules)
├── .secretlintrc.json     Secret-pattern scanning config
└── pnpm-workspace.yaml    Monorepo workspace definition
```

---

## Services and ports

| Service | Port | Owns |
|---|---|---|
| `apps/identity` | 3110 | BetterAuth sessions, JWKS, JWT mint/verify, platform/tenant management |
| `kilo-pipeline` | 3100 | Tasks, staging, quarantine, scrape, ledger, status, health |
| `core-engine` | 3101 | Tasks, HITL, skills, SSE events |
| `apps/admin-web` | 3120 | Next.js RSC platform + tenant management UI |
| Caddy/Traefik | 443 | TLS termination, basic rate-limiting, path routing |
| Ollama | 11434 | Local LLM inference |
| Qdrant | 6333/6334 | Vector database (4-tier memory) |
| Redis | 6379 | Idempotency, rate-limiting, JWKS cache, token revocations |
| NATS JetStream | 4222 | Task bus, audit outbox drain |
| Postgres 16 | 5432 | `betterauth.*` + `oweibo.*` (RLS enforced) |
| Langfuse | 3000 | LLM call tracing and prompt management |

Internal ports (5432, 6379, 4222, 6333, 9100) are bound to localhost or the internal network only. Only Caddy/Traefik is exposed on 443.

---

## Identity and authorization

### Principal types

Three principal types flow through every JWT:

```text
USER      sub = "<betterauth-user-uuid>"
API_KEY   sub = "apikey:<id>"
AGENT     sub = "agent:<runId>",  act_as = { sub: <userId>, tenantId }
```

Agent tokens are minted server-side only when a task spawns an agent process. No public HTTP route can mint them. Their scopes are the intersection of the parent task's scopes and the agent profile's scopes, and their TTL is capped at `min(remaining task budget, 60 min)`.

### Token shape (RS256, 15 min access TTL)

```json
{
  "iss": "https://identity.oweibo.io",
  "aud": "oweibo-api",
  "sub": "<principal id>",
  "ctx": { "tenantId": "<uuid>" },
  "scopes": ["tasks:write", "..."],
  "trust": "supervised | graduated | autonomous",
  "act_as": { "sub": "<userId>", "tenantId": "<uuid>" },
  "jti": "<uuid>", "iat": 0, "exp": 0, "kid": "<keyid>"
}
```

`act_as` is present only on agent tokens. Audit rows attribute `actor=sub, on_behalf_of=act_as.sub`.

### Roles and scopes

All role-to-scope expansion lives in [`apps/identity/src/policy.ts`](apps/identity/src/policy.ts). Gateways compare resolved scope sets at runtime — no glob matching.

| Role | Key scopes |
|---|---|
| `platform_admin` | All platform + all tenant scopes |
| `platform_operator` | `platform:tenants:read`, `platform:metrics:read`, `platform:audit:read` |
| `platform_billing` | `platform:tenants:read`, `platform:metrics:read` |
| `tenant_admin` | All tenant scopes including `trust:graduated`, `trust:autonomous` |
| `tenant_developer` | `tasks:*`, `staging:read`, `scrape:read/write`, `memory:read` |
| `tenant_viewer` | Read-only across tasks, staging, scrape, memory |

### Trust modes

Trust mode is scope-gated, not a free-form client override:

| Mode | Required scopes | Sandbox permissions | HITL behaviour |
|---|---|---|---|
| `supervised` | `tasks:write` | `repo:read` only | Every gate failure escalates |
| `graduated` | `tasks:write` + `trust:graduated` | `repo:write` to workspace | HITL on cross-tenant ops |
| `autonomous` | `tasks:write` + `trust:autonomous` + tenant feature flag | `repo:write` + `tools:execute` | HITL on hard violations only |

`trust:autonomous` is grantable only by a `tenant_admin` and only when `tenants.features ->> 'autonomous' = 'true'`.

### JWKS rotation

- Identity service holds the private key (loaded from Vault via env injection in production).
- Gateways fetch `GET /.well-known/jwks.json`; `jose.createRemoteJWKSet()` caches by `kid` for 10 min.
- Rotation: publish new `kid`; retain old `kid` for 30 min before removal.

---

## Data plane

### Postgres topology

One Postgres 16 instance; two schemas:

- **`betterauth.*`** — managed exclusively by the BetterAuth library. The `oweibo_app` role may read `betterauth.users.id` for FK joins but not write directly.
- **`oweibo.*`** — all tables have `ENABLE ROW LEVEL SECURITY` + `FORCE ROW LEVEL SECURITY`. Access only via `withTenantContext()`.

### Row-level security

Every `oweibo.*` table with tenant data carries two policies:

```sql
CREATE POLICY tenant_isolation ON oweibo.<table>
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);

CREATE POLICY platform_admin_bypass ON oweibo.<table>
  USING (current_setting('app.is_platform_admin', true) = 'true');
```

`audit_log` has no `INSERT`/`UPDATE`/`DELETE` policy — all writes go through the `oweibo.append_audit()` `SECURITY DEFINER` function; direct mutations are rejected at the DB layer.

### `withTenantContext` chokepoint

All application queries must flow through [`packages/db/src/withTenantContext.ts`](packages/db/src/withTenantContext.ts):

```ts
await withTenantContext(principal, async tx => {
  // SET LOCAL app.tenant_id = '...' runs before your query
  return tx.task.findMany({ ... });
});
```

`SET LOCAL` scopes the session parameters to the current transaction, so they do not leak across connections in PgBouncer transaction-pool mode.

An ESLint rule (`scripts/eslint-rules/no-direct-prisma.js`) fails the build if any file outside `packages/db/src/` imports `@prisma/client` directly.

### BetterAuth ↔ oweibo.users sync

A Postgres trigger on `betterauth.users` keeps `oweibo.users` in sync:

- `INSERT` → creates a mirrored row with status `active`
- `UPDATE` → updates email
- `DELETE` → sets status to `deleted` (soft delete)

Single source of truth: `betterauth.users.id` is the authoritative user ID.

---

## Agentic pipeline

The pipeline runs inside `kilo/pipeline` (port 3100). Each task traverses a fixed stage sequence:

```text
memory_retrieval → architect → orchestrate
                                    │
                     ┌─────────────┬┴──────────────┐
                     ▼             ▼                ▼
                   gates      error_recovery    convergence
                  (G1–G10)                    (ladder check)
                     │
              writers (W1–W5)
              promotion engine
```

### Stages

| Stage | Description |
|---|---|
| `memory_retrieval` | 4-tier recall — semantic search (Qdrant) + project/STM context |
| `architect` | LLM generates a structured plan; sandboxed via kilo-proxy |
| `orchestrate` | Executes the plan; produces `changedFiles`; routes to `gates`, `error_recovery`, or `convergence` |
| `gates G1–G7` | Static invariant checks (format, lint, type safety) |
| `gate G8A` | Deterministic invariant evaluation against project invariants |
| `gate G8B` | Semantic invariant evaluation (LLM-scored) |
| `gate G9` | ADR (Architecture Decision Record) compliance check |
| `gate G10` | Context consistency check |
| `error_recovery` | Canonicalize → ledger lookup → 4× wall check → classify → search route |
| `convergence` | Convergence ladder: advance strategy index or quarantine |
| `writers W1–W5` | Extract ADRs, invariants, reasoning, summary, context into memory |
| `promotion` | Evaluate staging thresholds; auto-promote or flag for human review |

### Sandbox security profile

Agent processes run in a purpose-built Docker image (`infra/sandbox/Dockerfile`):

```text
CapDrop: ['ALL']
ReadonlyRootfs: true
User: node (uid 1000, never root)
SecurityOpt: ['no-new-privileges:true']
```

Agent tokens (not static secrets) are injected via env. Egress is filtered by an outbound HTTP proxy allowlist.

### Recovery pipeline

Failed tasks enter a structured recovery pipeline:

1. **Canonicalize** — normalise error to a deterministic hash
2. **Ledger** — look up failure history; apply 4× wall (quarantine after repeated identical failures)
3. **Classify** — `SIMPLE` | `COMPLEX` | `DEPENDENCY` | `ENVIRONMENT`
4. **Route** — select search strategy (web, documentation, source)
5. **Convergence ladder** — advance strategy index per iteration; halt or quarantine at ceiling

### Self-improvement loops

| Loop | Schedule | What it does |
|---|---|---|
| Memory decay | Weekly | Demotes stale / high-false-positive invariants in Qdrant |
| Idle reflection | Hourly (when queue empty) | Analyses quarantine patterns; proposes curriculum updates |
| Curriculum learning | Weekly | Scrapes dependency changelogs; updates knowledge graph |

---

## Memory tiers

Four-tier memory architecture, scoped by `(tenantId, taskId)` or `(tenantId, sessionId, userId)`:

| Tier | Class | Store | Keying | Lifetime |
|---|---|---|---|---|
| 1 — Working | `WorkingMemoryRegistry` | In-process Map | `(tenantId, taskId)` | Task duration |
| 2 — Short-term | `ShortTermMemoryStore` | Redis sliding window | `(tenantId, sessionId, userId)` | Session |
| 3 — Project | `ProjectRegistry` | Redis | `(tenantId)` | Project lifetime |
| 4 — Semantic | `KiloSemanticAdapter` via `TenantSafeQdrant` | Qdrant | `(tenantId)` + vector similarity | Permanent (decay-managed) |

Qdrant access is wrapped by `TenantSafeQdrant`, which injects a mandatory `tenant_id` filter on every query. Direct `QdrantClient` imports outside `packages/qdrant-tenant` fail the ESLint build.

---

## Module factory

The `packages/module-*` packages are **output-app generators** — they produce code artifacts for customer projects, not for the platform itself. Each implements `IModuleGenerator` from `@oweibo/core-contracts`:

| Package | What it generates |
|---|---|
| `module-auth` | Auth layer: BetterAuth / Auth.js / Zitadel-native / custom |
| `module-codegen` | Code generation pipeline |
| `module-compliance` | Compliance layer (audit, GDPR hooks) |
| `module-datalayer` | Prisma schema + migrations |
| `module-export` | Data export pipeline |
| `module-observability` | OTel + Langfuse instrumentation |
| `module-scaffolding` | Project scaffolding, folder structure, CI config |

Modules communicate only via typed events on `DomainEventBus` (from `core-contracts`). Direct cross-module imports are blocked by dep-cruiser.

---

## Channel gateway

`packages/channel-gateway` routes inbound messages from nine social platforms to the agentic pipeline:

Telegram · Discord · Slack · WhatsApp · Signal · iMessage · Google Chat · IRC · WebChat

The gateway is a fan-in layer only. It may import from `core-contracts` and may call three ingestion interfaces on `core-engine` (`IntentPipeline`, `TaskEventBus`, `TaskInterventionGateway`). All other `core-engine` internals are forbidden by dep-cruiser.

---

## Browser tool

`packages/browser-tool` provides 51 atomic browser actions including:

- Multi-backend stealth (Playwright + Puppeteer + CDP)
- Vision loop (screenshot + LLM perception)
- Persistent browser profiles per tenant
- Chrome extension bridge (`packages/browser-extension`)

`browser-tool` depends only on `core-contracts`. It is blocked from importing `core-engine` or `channel-gateway`.

---

## Infrastructure stack

All components are self-hosted. No cloud-subscription services.

| Need | Component |
|---|---|
| Identity | BetterAuth in `apps/identity` |
| JWT | RS256 keypair via Vault Transit; JWKS rotation |
| Database | Postgres 16 (`betterauth.*` + `oweibo.*`) |
| Cache / idempotency | Redis |
| Message bus | NATS JetStream (single-node v1) |
| Vector store | Qdrant |
| Object storage | MinIO (S3-compatible) |
| Secrets / KMS | Vault OSS (Transit engine for per-tenant encryption keys) |
| LLM inference | Ollama (local) + OpenAI / Anthropic / DeepSeek / OpenRouter |
| LLM tracing | Langfuse |
| Metrics | Prometheus + Grafana |
| Logs | Loki (Phase 6) |
| Traces | Tempo (Phase 6) |
| Alerting | Alertmanager → email / matrix / webhook |
| Web discovery | SearXNG (privacy-preserving metasearch) |
| Crawler | Crawl4AI |
| TLS | Caddy / Traefik with Let's Encrypt |

### Cost ceiling (v1, single node)

Single beefy host (e.g. Hetzner AX52: 8c/16t, 64 GiB RAM, 2× 1 TiB NVMe) costs ~$80/mo. A 3-node small cluster runs ~$240/mo. LLM-API egress is the dominant variable cost and drops to near-zero if Ollama covers the workload.

---

## Getting started

### Prerequisites

- Docker and Docker Compose
- Node.js >= 20, pnpm >= 9
- A running Postgres 16 instance (or use the compose stack)

### 1. Clone and install

```bash
git clone git@github.com:oweibor/oweibo.git
cd oweibo
pnpm install
```

### 2. Configure

```bash
cp config.env.template config.env
# Edit config.env — see Environment variables section below
```

### 3. Start the infrastructure stack

```bash
docker compose up -d
```

This starts Ollama, Qdrant, Redis, SearXNG, and a Docker socket proxy. Postgres and NATS are added in v1 compose updates.

### 4. Run database migrations

```bash
# Apply the initial oweibo schema and RLS policies
psql $DATABASE_URL -f packages/db/migrations/001_initial_schema.sql

# Generate the Prisma client
pnpm --filter @oweibo/db db:generate
```

### 5. Start the services

```bash
# Identity service (port 3110)
pnpm --filter @oweibo/identity dev

# Orchestration pipeline (port 3100)
pnpm --filter kilo-pipeline dev
```

### 6. Log in and submit a task

```bash
# Authenticate — stores credentials in ~/.oweibo/credentials
oweibo login --email you@example.com

# Submit a task and stream events
oweibo task submit "Add a /healthz endpoint to the Express app" --wait

# Or use the REST API directly
curl -X POST http://localhost:3100/task \
  -H "Authorization: Bearer $OWEIBO_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"instruction": "Add a /healthz endpoint to the Express app in workspace/my-project"}'
```

### CLI quick-reference

```text
# Auth
oweibo login             # email + password → ~/.oweibo/credentials
oweibo logout            # clear credentials
oweibo whoami            # show current user

# Platform admin (requires platform_admin role)
oweibo platform tenant list
oweibo platform tenant create --name Acme --slug acme
oweibo platform tenant suspend <tenantId>
oweibo platform user list
oweibo platform user role <userId> platform_admin

# Tenant admin
oweibo tenant member list [--tenant <id>]
oweibo tenant member invite --email alice@acme.com --roles tenant_developer
oweibo tenant key create --name ci-key --scopes tasks:write,staging:read
oweibo tenant settings set --trust graduated

# Tasks
oweibo task submit "build me a Next.js app" --wait
oweibo task list [--status running]
oweibo task status <taskId>
oweibo task pause  <taskId>
oweibo task cancel <taskId>

# Staging, quarantine, HITL
oweibo staging list
oweibo staging approve <id>
oweibo quarantine list
oweibo quarantine override <id> --reason "reviewed safe"
oweibo hitl list
oweibo hitl approve <requestId> --task <taskId>

# Scraping
oweibo scrape start https://example.com --type general
oweibo scrape list
oweibo scrape results <jobId>

# Usage
oweibo ledger list [--date 2026-04-29]
```

---

## Environment variables

### Core

| Variable | Description | Default |
|---|---|---|
| `DATABASE_URL` | Postgres connection string | — |
| `REDIS_URL` | Redis connection string | `redis://localhost:6379` |
| `KILO_API_TOKEN` | Legacy single-tenant bearer token | — |
| `TENANT_TOKENS` | JSON map `{ "<token>": "<tenantId>" }` for multi-tenant | — |
| `CHECKPOINT_DIR` | Base directory for task state checkpoints | — |
| `TRUST_MODE` | Default trust mode | `supervised` |

### Identity service

| Variable | Description |
|---|---|
| `JWT_PRIVATE_KEY` | RS256 private key PEM (from Vault in production) |
| `JWT_PUBLIC_KEY` | RS256 public key PEM |
| `JWT_KEY_ID` | Key ID for JWKS `kid` field |
| `BETTER_AUTH_SECRET` | BetterAuth session secret (>= 32 chars) |
| `BETTER_AUTH_BASE_URL` | Identity service base URL |

### LLM providers

| Variable | Description |
|---|---|
| `OLLAMA_BASE_URL` | Ollama API base URL |
| `OLLAMA_DEFAULT_MODEL` | Model for architect/orchestrator roles |
| `OLLAMA_GENERAL_MODEL` | Model for planning/reasoning |
| `OLLAMA_QUICK_MODEL` | Model for fast/delegation tasks |
| `OPENAI_API_KEY` | Optional OpenAI API key |
| `ANTHROPIC_API_KEY` | Optional Anthropic API key |

### CLI (Phase 4)

| Variable | Description | Default |
|---|---|---|
| `OWEIBO_API_URL` | Pipeline API base URL | `http://localhost:3100/api/v1` |
| `OWEIBO_IDENTITY_URL` | Identity service base URL | `http://localhost:3110` |
| `OWEIBO_API_KEY` | Bearer token (overrides credentials file) | — |
| `OWEIBO_TENANT_ID` | Default tenant ID | — |

Credentials are stored in `~/.oweibo/credentials` (mode 0600). `login` stores both the access token (15 min) and the refresh token (30 days); the client refreshes transparently before each expired request.

### Message bus and cache (Phase 3)

| Variable | Description | Default |
|---|---|---|
| `NATS_URL` | NATS JetStream server URL | `nats://localhost:4222` |
| `REDIS_URL` | Redis connection URL (idempotency, RL, quotas) | `redis://localhost:6379` |
| `AGENT_TOKEN_ENDPOINT` | Identity service internal agent-token mint URL | `http://localhost:3110/internal/agent-token` |
| `INTERNAL_SERVICE_KEY` | Shared secret for machine-to-machine calls (≥32 chars) | — |

### Observability

| Variable | Description |
|---|---|
| `LANGFUSE_PUBLIC_KEY` | Langfuse project public key |
| `LANGFUSE_SECRET_KEY` | Langfuse project secret key |
| `LANGFUSE_BASE_URL` | Langfuse host URL |
| `METRICS_TOKEN` | Bearer token protecting the `/metrics` endpoint |

---

## Development workflow

```bash
# Type-check all packages
pnpm type-check

# Run all tests
pnpm test

# Check architectural boundaries (dep-cruiser, 19 rules)
pnpm check-boundaries

# Check RLS migration coverage
pnpm check-rls

# Full CI pipeline (build + type-check + assert-tests + check-rls + test)
pnpm ci
```

### Pre-commit hooks (Husky)

Every commit runs automatically:

1. **ESLint** — all packages with a `lint` script
2. **TypeScript type-check** — all packages
3. **Test presence** — every source file must have a corresponding test file
4. **dep-cruiser** — 19 architectural boundary rules; zero violations required
5. **secretlint** — blocks real API keys, PEM blocks, and other credential patterns
6. **Contract tests** — every `packages/module-*` must have a `*.contract.test.ts`
7. **RLS coverage** — every Prisma model with `tenantId` must have an RLS migration

---

## Testing

### Test types

| Type | Location | Run |
|---|---|---|
| Unit / integration | `src/__tests__/*.test.ts` per package | `pnpm test` |
| Contract tests | `module-*/src/__tests__/*.contract.test.ts` | `pnpm test` |
| RLS belt-and-suspenders | `packages/db/src/__tests__/rls.test.ts` | Requires `TEST_DATABASE_URL` |
| JWT round-trip | `apps/identity/src/__tests__/jwt.test.ts` | `pnpm --filter @oweibo/identity test` |

### RLS tests

Set `TEST_DATABASE_URL` to a Postgres instance with migrations applied:

```bash
TEST_DATABASE_URL=postgresql://oweibo_app:pass@localhost:5432/oweibo_test \
  pnpm --filter @oweibo/db test
```

The suite verifies that RLS alone (application-layer checks bypassed) correctly blocks cross-tenant reads, rejects `UPDATE`/`DELETE` on `audit_log`, and does not leak `SET LOCAL` values across transaction boundaries.

---

## Architectural boundaries

Enforced by dep-cruiser (`.dependency-cruiser.js`). The build fails on any violation.

| Rule | Enforces |
|---|---|
| `module-cannot-import-core-engine` | `module-*` packages depend only on `core-contracts` |
| `module-cannot-import-other-module` | Modules are boundary-isolated; inter-module comms via typed events only |
| `core-engine-cannot-import-modules` | Factory Core Independence (Principle #1) |
| `core-contracts-cannot-import-core-engine` | `core-contracts` is zero-dependency |
| `event-types-must-come-from-contracts` | Event types defined only in `core-contracts/src/events/` |
| `channel-gateway-cannot-import-core-engine-internals` | Gateway consumes only three public ingestion interfaces |
| `browser-extension-cannot-import-core-engine` | Extension is a standalone Chrome package with zero server imports |
| `doc-generator-no-agentic-swarm-import` | `doc-generator` is isolated; LLM access via `ILLMClient` |
| `doc-generator-llm-via-adapters-only` | Only `adapters/` may import `PromptBudgetEnforcer` directly |
| `no-direct-prisma-outside-db-package` | All DB access flows through `withTenantContext()` in `packages/db` |
| `identity-service-cannot-import-core-engine` | `apps/identity` is auth-only; no engine internals |
| `db-package-cannot-import-identity` | No circular identity↔db dependency |
| `api-middleware-cannot-import-core-engine` | `packages/api-middleware` is HTTP-layer only |
| `api-middleware-cannot-import-identity` | JWT verification via JWKS endpoint — no direct service coupling |
| `kilo-pipeline-cannot-import-identity` | Auth delegated to `packages/api-middleware`; no direct identity import |
| _(+ 7 more)_ | Specialist agent isolation, SynthesisAgent isolation, browser-tool boundaries |

---

## Implementation status

| Phase | Description | Status |
|---|---|---|
| **Phase 0** | P0 security hardening: path traversal defence, SSRF guard, rate limiting, sandbox hardening (CapDrop/ReadonlyRootfs), constant-time auth, Qdrant circuit breaker | **Done** |
| **Phase 1** | Identity foundation: BetterAuth IdP, RS256 JWKS, Postgres RLS schema, `withTenantContext` chokepoint, platform/tenant management API, `check-rls` lint gate | **Done** |
| **Phase 2** | Unified auth/authz middleware (`packages/api-middleware`); both gateways migrated; legacy token bridge; `requestId` + `traceparent` propagation | **Done** |
| **Phase 3** | NATS JetStream event bus + file-based outbox publisher; agent JWT wiring in sandbox; Redis-backed quota service; `requireScopes` on every route; `assertSafeTarget` SSRF guard in shared middleware; internal agent-token mint endpoint | **Done** |
| **Phase 4** | Robust CLI: all resource-family subcommands; `login`/`logout`/`whoami`; `~/.oweibo/credentials` refresh-token cache; bidirectional parity CI gate; 40+ integration tests | **Done** |
| Phase 5 | Web admin UI: `apps/admin-web` Next.js 15 RSC, RBAC route groups, tenant switcher, Playwright e2e | Pending |
| Phase 6 | Audit middleware on all privileged routes; GDPR erasure; OTel GenAI semantic conventions; Langfuse/Tempo/Loki/Prometheus | Pending |
| Phase 7 | Launch hardening: k6 load test (500 RPS sustained), chaos testing, DR rehearsal, external pentest | Pending |
| Phase 8 | Legacy `TENANT_TOKENS` sunset: 60-day migration window, import as real `api_keys` rows | Pending |
| Phase 10+ | Firecracker microVMs, Postgres hash-partitioning, multi-region, self-hosted edge tier | Deferred |

Scale-out phases (10+) are triggered by measured load signals, not calendar dates.
