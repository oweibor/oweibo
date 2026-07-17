# Oweibo

**Agent-as-a-Service (AaaS) platform.** Multi-tenant autonomous software engineering, delivered as a SaaS. Customers submit multi-stage directions — market research, website builds, feature work, bug fixes, codebase Q&A, PR proposals — and the platform acts on them end-to-end, in parallel, per tenant, with full memory across tasks.

On top of the agent runtime sits a **connector fabric**: a permission-aware knowledge plane (think Glean × Claude connectors) that crawls, indexes, and retrieves tenant content from external systems — Google Workspace, Drive, Slack, GitHub, and tenant-registered custom connectors — under per-document ACLs, tenant compliance policy, and a dual-controlled governance model.

Comparable reference points: Manus (autonomous task execution) × Claude Code (CLI-native dev agent) × Glean (permission-aware enterprise search) × a multi-tenant SaaS. The key difference is that every tenant gets their own isolated agent instance with scoped memory, sandbox, trust mode, quota, and connector policy.

---

## Table of contents

1. [Architecture overview](#architecture-overview)
2. [Repository layout](#repository-layout)
3. [Services and ports](#services-and-ports)
4. [Identity and authorization](#identity-and-authorization)
5. [Data plane](#data-plane)
6. [Connector fabric](#connector-fabric)
7. [Fabric governance](#fabric-governance)
8. [Custom connectors](#custom-connectors)
9. [Action safety](#action-safety)
10. [Agentic pipeline](#agentic-pipeline)
11. [Memory tiers](#memory-tiers)
12. [Module factory](#module-factory)
13. [Channel gateway](#channel-gateway)
14. [Browser tool](#browser-tool)
15. [Infrastructure stack](#infrastructure-stack)
16. [Getting started](#getting-started)
17. [Environment variables](#environment-variables)
18. [Development workflow](#development-workflow)
19. [Testing](#testing)
20. [Architectural boundaries](#architectural-boundaries)
21. [Implementation status](#implementation-status)

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
apps/identity    core-engine     kilo-pipeline  apps/admin-web
(port 3110)      API (3100)      (legacy orch.) (port 3120, Next.js)
      │                │             │            │
      └────────────────┴─────────────┴────────────┘
                       │ shared infrastructure (self-hosted)
      ┌────────────────┼────────────────────────────────┐
      ▼                ▼           ▼        ▼           ▼
   Postgres 16      Redis       NATS JS   Qdrant      MinIO
 (betterauth.*   (idempotency, (task bus, (memory +  (artifacts,
  oweibo.* RLS)   RL, JWKS      outbox)   fabric     checkpoints,
                  cache)                  vectors)   audit cold)
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
│   ├── admin-web/         Next.js 15 RSC admin UI (port 3120)
│   │                      Route groups serve /platform/* and /t/<tenantId>/*
│   ├── approval-lifecycle-worker/  SLA timers for pending approvals
│   ├── tenant-bootstrap-worker/    Tenant onboarding step machine
│   └── …                  aggregators (pattern, platform-priors, long-horizon),
│                          gepa-optimizer, seed-catalog-reconciler, identity tools
│
├── packages/
│   ├── core-contracts/    Zero-dependency TypeScript contracts — connector,
│   │                      action, domain, and event types; the only legal
│   │                      import for module-* packages
│   ├── core-engine/       The API + engine (port 3100):
│   │     ├── api/         Express server, JWKS auth, tenant-scoped routers,
│   │     │                OpenAPI spec (self-enforcing drift test)
│   │     ├── fabric/      The connector fabric (see below): scheduler,
│   │     │                discovery, indexing, retrieval, permissions,
│   │     │                semantic cache, live path, knowledge graph,
│   │     │                policy governance, MCP faces, upgrade rollout,
│   │     │                health/SLO, DR classes
│   │     ├── connector/   Platform catalog, install service, certification,
│   │     │                custom connector manifests
│   │     ├── action/      Action trust ladder, dry-run/shadow proposals,
│   │     │                multi-party approvals, grants, quotas, rollback,
│   │     │                forensics, lineage
│   │     └── agentic/     Cognitive engine, swarm coordinator, 4-tier memory
│   ├── connector-sdk/     Connector authoring surface: declareConnector,
│   │                      port contracts (changeFeed/content/acl/principals),
│   │                      certification runner, connector simulator
│   ├── connectors/        First-party connector bundles: Google Workspace IdP,
│   │                      Google Drive, Slack, GitHub (Tier-0)
│   ├── db/                Prisma schema (betterauth.*), raw SQL migrations
│   │                      (oweibo.*), withTenantContext chokepoint, RLS +
│   │                      store-scope conformance tests
│   ├── cli/               oweibo CLI — task, staging, quarantine, scrape, ledger, HITL
│   ├── channel-contracts/ Zero-dependency channel platform types
│   ├── channel-gateway/   Multi-tenant social channel gateway (9 platform adapters)
│   ├── browser-tool/      51 atomic browser actions, multi-backend stealth, vision loop
│   ├── browser-extension/ Standalone Chrome extension (zero server imports)
│   ├── api-middleware/    Shared HTTP auth/authz middleware (JWKS-based)
│   ├── observability/     GenAI OTel conventions, span helpers, pino logger
│   ├── prompt-registry/   Versioned prompt slots + cohort routing
│   ├── gepa-core/         GEPA optimization primitives
│   └── module-*/          Output-app generators (auth, codegen, compliance,
│                          datalayer, export, observability, scaffolding)
│
├── kilo/
│   └── pipeline/          Legacy orchestration service — architect, orchestrate,
│                          gates (G1–G10), recovery, writers (W1–W5), promotion
│                          (set KILO_PIPELINE_PORT if run alongside core-engine)
│
├── infra/                 Sandbox image, Helm/compose, reverse proxy, zitadel (reserved)
├── scripts/               CI gates: assert-tests-exist, verify-contract-tests,
│                          check-rls, check-sole-writer-map, db-setup, seed-admin,
│                          gen-jwt-keys, eslint-rules/no-direct-prisma
├── monitoring/            Prometheus scrape configs, Grafana dashboards
├── docker-compose.dev.yml Dev data plane (Postgres 16 + Redis 7)
├── docker-compose.yml     Agent/execution stack (Ollama, Qdrant, SearXNG, o11y)
├── .dependency-cruiser.js Architectural boundary enforcement
└── pnpm-workspace.yaml    Monorepo workspace definition
```

---

## Services and ports

| Service | Port | Owns |
|---|---|---|
| `apps/identity` | 3110 | BetterAuth sessions, JWKS, JWT mint/verify, platform/tenant management |
| `core-engine` | 3100 | The platform API: tasks, HITL, skills, actions, approvals, domains, connectors (catalog + custom), fabric governance, forensics, lineage, OpenAPI docs at `/api/v1/docs` |
| `kilo-pipeline` | 3100 (default; set `KILO_PIPELINE_PORT` to co-run) | Legacy orchestration: gates, recovery, writers, promotion |
| `apps/admin-web` | 3120 | Next.js RSC platform (`/platform/*`) + tenant (`/t/<id>/*`) UI |
| Caddy/Traefik | 443 | TLS termination, basic rate-limiting, path routing |
| Ollama | 11434 | Local LLM inference |
| Qdrant | 6333/6334 | Vector database (memory tiers + fabric embeddings) |
| Redis | 6379 | Idempotency, rate-limiting, JWKS cache, token revocations |
| NATS JetStream | 4222 | Task bus, audit outbox drain |
| Postgres 16 | 5432 | `betterauth.*` + `oweibo.*` (RLS enforced) |
| Prometheus / Grafana / Tempo / Loki / Alertmanager / OTel | 9090 / 3000 / 3200 / — / 9093 / 4317 | Observability stack |
| Langfuse | — | LLM call tracing and prompt management (external) |

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

Tenant-scoped API routes are mounted at `/api/v1/tenants/:tenantId/*`. Every router cross-checks the URL tenant against the JWT tenant claim (`tenant_mismatch` 403 on divergence) — a token issued for tenant A is unusable against tenant B's surface even with the wrong URL pasted.

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
- **`oweibo.*`** — all tenant tables have `ENABLE ROW LEVEL SECURITY` + `FORCE ROW LEVEL SECURITY`. Access only via `withTenantContext()` (Prisma path) or per-service transactional `set_config('app.tenant_id', …, true)` (fabric services).

### Row-level security

Every `oweibo.*` table with tenant data carries two policies:

```sql
CREATE POLICY tenant_isolation ON oweibo.<table>
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);

CREATE POLICY platform_admin_bypass ON oweibo.<table>
  USING (current_setting('app.is_platform_admin', true) = 'true');
```

`audit_log` has no `INSERT`/`UPDATE`/`DELETE` policy — all writes go through the `oweibo.append_audit()` `SECURITY DEFINER` function; direct mutations are rejected at the DB layer.

A living **store-scope registry** ([`packages/db/src/__tests__/kf-store-scope.test.ts`](packages/db/src/__tests__/kf-store-scope.test.ts)) declares every fabric table tenant-scoped or platform-scoped and asserts via `pg_tables`/`pg_policies` introspection that every tenant-scoped table actually has RLS forced with a `tenant_isolation` policy. Adding a fabric table without classifying it fails CI.

### `withTenantContext` chokepoint

All Prisma queries flow through [`packages/db/src/withTenantContext.ts`](packages/db/src/withTenantContext.ts). `SET LOCAL` scopes the tenant parameter to the current transaction, so it does not leak across connections in PgBouncer transaction-pool mode. An ESLint rule (`scripts/eslint-rules/no-direct-prisma.js`) fails the build if any file outside `packages/db/src/` imports `@prisma/client` directly.

### BetterAuth ↔ oweibo.users sync

A Postgres trigger on `betterauth.users` keeps `oweibo.users` in sync (INSERT → mirrored active row; UPDATE → email; DELETE → soft-delete). `betterauth.users.id` is the authoritative user ID.

---

## Connector fabric

The fabric (`packages/core-engine/src/fabric/`) is the permission-aware knowledge plane. It was built as a conformance-first system: every subsystem ships with pure contract predicates plus a live integration battery against real Postgres, and a set of structural invariants (INV-1 … INV-17) that are enforced by construction wherever possible — not by convention.

### The pipeline

```text
  ChangeFeedPort ──► DiscoveryService ──► kf_jobs (scheduler) ──► IndexingService
   (connector)        outbox events        priority classes         │
                                           blue/green tags          ├─ CompliancePolicyGate (INV-4)
                                                                    ├─ kf_knowledge_objects / kf_chunks
                                                                    ├─ kf_revision_vectors (monotonic merge)
                                                                    └─ kf_acl_snapshots (§6.2 grant hash)
                                                                            │
  Query ──► ExecutionPlanner ──► RetrievalService ── ACL filter BEFORE ranking (INV-2)
             (index vs live)        │                 semantic cache (identity+policy-versioned key)
                                    └─► LivePathService — field-level freshness, fail-closed
```

### Subsystems

| Area | What it does |
|---|---|
| `scheduler/` | Durable job queue (`kf_jobs`) with priority classes (permission-correctness jobs are never shed), fencing-token worker leases (`kf_leases`), checkpointed resume, full-jitter retry, dead-lettering |
| `discovery/` | Drains a connector's change feed into outbox events + indexing jobs (idempotent by `(document, revision)`); mints the blue/green `connector_version` tag |
| `indexing/` | Sole writer of the knowledge stores: revision-vector comparison (out-of-order and duplicate events are no-ops), chunk-diff (only changed chunks re-embed), ACL snapshot versioning, tombstone-preserving deletes; every write traverses the compliance gate |
| `permissions/` | Group-closure ACL evaluation; withholding semantics — a denied document is indistinguishable from a nonexistent one |
| `retrieval/` | Permission-filtered retrieval: ACL check **before** ranking; hybrid rank (lexical + vector + graph proximity); revision re-check for transactional/critical documents |
| `semantic/` | Full-content embeddings, permission-aware semantic cache — the cache key includes canonical identity **and** tenant policy version, so a policy change structurally invalidates the namespace |
| `live/` | Live-path reads with per-field freshness classes; Critical fields are never cached and **withhold on failure** rather than stale-serve |
| `graph/` | Knowledge graph + identity resolution: confidence = MAX of signal weights (never sum), provisional identities hedge responses and never grant access, rejected merges retract asynchronously |
| `policy/` | Tenant policy system — see [Fabric governance](#fabric-governance) |
| `mcp/` | Outbound MCP server face (mount Oweibo as ONE connector: `oweibo.search/fetch/act`, authored-constant tool descriptions, tenant always from the token, no existence oracle, credential-leak deep scan) and inbound gating (manifest is authority; server-advertised-but-undeclared tools are dropped and flagged) |
| `upgrade/` | Connector software rollout: blue/green job tagging (a version-tagged job is claimable only by a matching worker — enforced in the claim SQL), cohort canary, rollback that re-tags queued work and never touches leased work |
| `health/` | 0–100 composite health score (auth + ACL-refresh weighted heaviest); below 60 the planner biases fan-out to the index path before the lifecycle machine ever degrades |
| `dr/` | Backup-class registry: re-derivable stores (index, embeddings, graph, ACL cache) vs must-backup (policy, config, identity merges, **crawl checkpoints** — losing checkpoints turns an hours-scale delta resume into a days-scale cold crawl) |

### Connector SDK and first-party connectors

`packages/connector-sdk` is the authoring surface: `declareConnector` + typed port contracts (`changeFeed`, `content`, `acl`, `principals`), a certification runner, and a connector-agnostic **simulator** that drives crawl → index → ACL snapshot → mutation → delta-resume end-to-end. `packages/connectors` ships the Tier-0 bundles: Google Workspace IdP (identity ground truth), Google Drive, Slack, GitHub — each roughly 380 lines of connector-specific translation over the SDK.

Install order is enforced: content/action connectors refuse to install until an identity connector is active (identity is the substrate ACL evaluation depends on).

---

## Fabric governance

Governance is structural, not procedural — the mechanisms make violations unrepresentable rather than merely detectable.

### Tenant policy (eight dimensions, two categories)

| Dimension | Category | Enforced by |
|---|---|---|
| `data_persistence`, `indexing_scope`, `connector_enablement`, `operation_permissions`, `data_residency`, `classification_exclusions` | **compliance** | Storage-layer gate — block, log, alert; never pass-through |
| `freshness_sla`, `retrieval_preference` | operational | Planner input — soft |

The category is a property of the *dimension*, CHECKed in the schema — an admin cannot re-declare residency as "operational" to demote it to a planner hint. `CompliancePolicyGate` is a pure function of `(policy, write, region)` with **no planner parameter**: the planner cannot influence a compliance verdict even in principle.

`connector_enablement` reads an absent key as **disabled**: no connector writes to the knowledge stores until it is explicitly policy-enabled, and every index write is gated.

### The relaxation lattice and dual control

A policy change is classified against a per-dimension restrictiveness order:

- provably **tighter** → applies immediately (single admin) with a *mandatory* backfill over affected indexed content;
- anything else — looser or **incomparable** — is a **relaxation** and requires a second authorized approver. Incomparable is deliberately fail-closed: swapping excluded tags `{HR}` → `{Legal}` is neither tighter nor looser, and it unprotects HR.

Relaxations flow through a real ballot: the proposal is a durable `governance.policy_relaxation` action proposal, votes go through the multi-party approval ledger (one vote per authenticated principal — no delegation, no body-supplied voter identity, no HTTP path that applies a relaxation directly), and quorum is evaluated against a **platform floor** (quorum ≥ 2, grants prohibited, delegation prohibited) that the tenant cannot weaken — the control exists to defend against a tenant admin, so its adversary must not configure it. Every applied change bumps a tenant-monotonic `policy_version` in the same transaction, which invalidates the semantic-cache namespace by construction.

The admin UI (`/t/<tenantId>/fabric`) drives all of it: effective policy with category badges, dry-run simulation, propose, pending ballots with approve/veto, and connector rollout controls (canary / promote / rollback).

---

## Custom connectors

Tenants are not limited to the platform catalog. A tenant admin can register a **custom connector manifest** — via the Connectors admin page or `POST /api/v1/tenants/:tenantId/connectors/custom` — and install it through the same flow as a catalog entry.

```jsonc
// POST /api/v1/tenants/:tenantId/connectors/custom
{
  "connectorId": "custom.acme-tracker",      // 'custom.' prefix is mandatory
  "displayName": "Acme Tracker",
  "category": "custom",                       // closed ConnectorCategory enum
  "description": "Internal issue tracker.",
  "catalogVersion": "1.0.0",
  "credentialSchema": { "type": "object", "required": ["api_key"],
                        "properties": { "api_key": { "type": "string" } } },
  "capabilities": [
    { "capabilityId": "create_ticket", "summary": "Create a ticket",
      "actionClass": "write.external_api.nonprod" }
  ],
  "mcpServerUrl": "https://mcp.acme.internal/tracker",   // optional
  "declaredTools": ["tracker.search", "tracker.create"]  // authority set
}
```

**What a manifest may not claim** (validated as a pure contract, violations returned field-by-field):

- ids without the `custom.` prefix — a tenant manifest can never collide with or shadow a platform catalog id, and the prefix marks tenant provenance on every downstream row (jobs, deployments, policy keys);
- a category outside the closed enum;
- a capability without an `actionClass` (an ungateable action), or one in the reserved `governance.*` plane;
- a certification tier — custom connectors are pinned `experimental`; `verified`/`enterprise` are earned through platform certification, never asserted;
- MCP tools without a server URL, or a server URL without declared tools — the **manifest** is the authority for what an MCP server may expose; advertised-but-undeclared tools are dropped at discovery and flagged as a truthfulness divergence.

**Governance is unchanged downstream — that is the point.** A custom connector still waits for an active identity connector to install, still cannot write to the knowledge stores until `connector_enablement` policy explicitly enables it (a dual-controlled relaxation), still participates in blue/green deployment, and its credentials live only behind a Vault path. Disabling a custom connector is soft: new installs are refused, existing instances remain visible for audit.

---

## Action safety

Every side-effecting action a connector or agent proposes flows through the **action trust ladder** (`packages/core-engine/src/action/`):

- **Trust modes per (tenant, action class)**: `execute` / `dry_run` / `shadow` / `require_approval` / `forbidden`, resolved from calibration (account age, per-class success scores) or an operator pin. Floor classes (`financial.payment`, `personnel.*`, `irreversible.*`) can never be pinned to `execute`.
- **Content is never a gate input** (injection safety is structural): the action class comes from the connector capability's declaration, not from payload or retrieved content; content inspectors can only *tighten* a verdict, never loosen it.
- **Multi-party approvals**: N-of-M vote ledger with dissent veto, time-windowed grants (scope-filtered, capped), delegation — all floor-checked so tenants cannot weaken below platform minimums.
- **Quotas, rate limits, budget insurance, rollback orchestration, forensic packets, and action lineage** complete the surface, each with its own tenant-scoped admin pages.

The outbound MCP face routes external tool calls through this same ladder — an external MCP client gets trust-ladder verdicts, never raw source responses.

---

## Agentic pipeline

The legacy orchestration pipeline runs inside `kilo/pipeline`. Each task traverses a fixed stage sequence:

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

| Stage | Description |
|---|---|
| `memory_retrieval` | 4-tier recall — semantic search (Qdrant) + project/STM context |
| `architect` | LLM generates a structured plan; sandboxed via kilo-proxy |
| `orchestrate` | Executes the plan; produces `changedFiles`; routes to `gates`, `error_recovery`, or `convergence` |
| `gates G1–G7` | Static invariant checks (format, lint, type safety) |
| `gate G8A/G8B` | Deterministic + semantic invariant evaluation |
| `gate G9/G10` | ADR compliance + context consistency |
| `error_recovery` | Canonicalize → ledger lookup → 4× wall check → classify → search route |
| `convergence` | Convergence ladder: advance strategy index or quarantine |
| `writers W1–W5` | Extract ADRs, invariants, reasoning, summary, context into memory |
| `promotion` | Evaluate staging thresholds; auto-promote or flag for human review |

### Sandbox security profile

Agent processes run in a purpose-built Docker image (`infra/sandbox/Dockerfile`): `CapDrop: ALL`, `ReadonlyRootfs: true`, `User: node`, `no-new-privileges`. Agent tokens (not static secrets) are injected via env. Egress is filtered by an outbound HTTP proxy allowlist.

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

Qdrant access is wrapped by `TenantSafeQdrant`, which injects a mandatory `tenant_id` filter on every query.

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

`packages/browser-tool` provides 51 atomic browser actions including multi-backend stealth (Playwright + Puppeteer + CDP), a vision loop (screenshot + LLM perception), persistent per-tenant browser profiles, and a Chrome extension bridge. It depends only on `core-contracts`.

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
| Metrics / logs / traces | Prometheus + Grafana / Loki / Tempo |
| Alerting | Alertmanager → email / matrix / webhook |
| Web discovery / crawling | SearXNG + Crawl4AI |
| TLS | Caddy / Traefik with Let's Encrypt |

### Cost ceiling (v1, single node)

Single beefy host (e.g. Hetzner AX52: 8c/16t, 64 GiB RAM, 2× 1 TiB NVMe) costs ~$80/mo. A 3-node small cluster runs ~$240/mo. LLM-API egress is the dominant variable cost and drops to near-zero if Ollama covers the workload.

---

## Getting started

### Prerequisites

- Docker + Docker Compose (for the dev data plane)
- Node.js >= 20 (22 recommended), pnpm >= 9
- OpenSSL on `PATH` (to generate the JWT keypair)

### Quick start — the web UI

This brings the platform up far enough to **log into the admin UI at
http://localhost:3120**. It needs three long-running processes — Postgres/Redis
(Docker), the identity service, and admin-web — plus a one-time database, key,
and admin-user setup. Every step below is a root `package.json` script.

```bash
# 1. Install, generate the Prisma client, build the workspace packages
pnpm install
pnpm --filter @oweibo/db exec prisma generate
pnpm build

# 2. Start the dev data plane (Postgres 16 + Redis 7)
pnpm dev:up

# 3. Create the local env file, then generate an RS256 JWT keypair into it
cp .env.dev.example .env.dev
pnpm gen:keys

# 4. Create the schema:
#      - betterauth.* tables via a scoped `prisma db push`
#      - every oweibo.* SQL migration, in order, tracked in schema_migrations
pnpm db:setup

# 5. Start the identity service (port 3110) — leave it running
pnpm dev:identity

# 6. In a second terminal, seed the first platform_admin
#    (defaults: admin@oweibo.local / ChangeMe-12345! — override via .env.dev)
pnpm seed:admin

# 7. In a third terminal, start the admin UI (port 3120)
pnpm dev:web
```

Open http://localhost:3120, sign in with the seeded admin, and you land on the
platform **Tenants** page (`/platform/tenants`).

> **Note:** the legacy `docker-compose.yml` (Ollama, Qdrant, SearXNG,
> observability) is the agent/execution stack and is **not** required to reach
> the web UI. The platform data plane lives in `docker-compose.dev.yml`, and
> `.env.dev` is loaded per-service via Node's `--env-file` (see the `dev:*`
> scripts). `.env.dev` is git-ignored — never commit real secrets.

### The core-engine API (tenant pages, fabric, CLI, REST)

The tenant-scoped pages (tasks, actions, connectors, domains, **fabric**) and
the CLI/REST surfaces call the **core-engine API** on port 3100
(`packages/core-engine/src/main.ts`). It uses the same `.env.dev`
(`DATABASE_URL`, `REDIS_URL`, and the `IDENTITY_URL` / `JWT_ISSUER` /
`JWT_AUDIENCE` / `JWT_KEY_ID` used to verify RS256 tokens against identity's
JWKS). Start it as a fourth process:

```bash
# 4th terminal — identity must be up (core-engine fetches its JWKS)
pnpm dev:engine
```

Then use the tenant switcher in the admin UI. Notable tenant pages:

| Page | What you can drive |
|---|---|
| `/t/<id>/connectors` | Installed instances, **register/disable custom connectors**, install (catalog or custom id) |
| `/t/<id>/fabric` | Effective tenant policy + version, simulate/propose policy changes, **pending relaxation ballots (approve/veto)**, connector rollout (canary/promote/rollback) |
| `/t/<id>/actions/*` | Pending proposals, trust matrix, quotas, history |
| `/t/<id>/approvals/*` | Grants, multi-party policies |
| `/t/<id>/domains/*` | Domain bindings, SME review, depth, compliance |
| `/t/<id>/forensics`, `/lineage` | Forensic packets + replay, action lineage |

The CLI and REST API use the same tokens:

```bash
# CLI — stores credentials in ~/.oweibo/credentials
oweibo login --email admin@oweibo.local
oweibo task submit "Add a /healthz endpoint to the Express app" --wait

# …or the REST API directly (RS256 Bearer minted by identity)
curl -X POST http://localhost:3100/api/v1/tasks \
  -H "Authorization: Bearer $OWEIBO_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"instruction": "Add a /healthz endpoint to the Express app"}'
```

Interactive OpenAPI docs are served at `http://localhost:3100/api/v1/docs`; the
spec is drift-checked against the mounted Express routes in CI.

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
| `TEST_DATABASE_URL` | Postgres for the live test batteries (RLS, fabric, governance) | — (suites skip cleanly) |
| `KILO_API_TOKEN` | Legacy single-tenant bearer token | — |
| `TENANT_TOKENS` | JSON map `{ "<token>": "<tenantId>" }` for multi-tenant | — |
| `CHECKPOINT_DIR` | Base directory for task state checkpoints | — |
| `TRUST_MODE` | Default trust mode | `supervised` |
| `MULTI_PARTY_APPROVAL_ENABLED` | Enables time-windowed grant consumption in the trust ladder (votes work regardless; policy-relaxation grants are refused at the platform floor either way) | `false` |

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

### Admin web (`apps/admin-web`)

| Variable | Description | Default |
|---|---|---|
| `IDENTITY_URL` | Identity service base URL | `http://localhost:3110` |
| `PIPELINE_URL` | core-engine API base URL | `http://localhost:3100/api/v1` |
| `NODE_ENV` | `production` sets `Secure` flag on session cookies | `development` |

Session cookies: `oweibo_session` (access token, 15 min, httpOnly + sameSite=strict) and `oweibo_refresh` (30 days).

### CLI

| Variable | Description | Default |
|---|---|---|
| `OWEIBO_API_URL` | core-engine API base URL | `http://localhost:3100/api/v1` |
| `OWEIBO_IDENTITY_URL` | Identity service base URL | `http://localhost:3110` |
| `OWEIBO_API_KEY` | Bearer token (overrides credentials file) | — |
| `OWEIBO_TENANT_ID` | Default tenant ID | — |

Credentials are stored in `~/.oweibo/credentials` (mode 0600). `login` stores both the access token (15 min) and the refresh token (30 days); the client refreshes transparently before each expired request.

### Message bus, internal, observability

| Variable | Description | Default |
|---|---|---|
| `NATS_URL` | NATS JetStream server URL | `nats://localhost:4222` |
| `AGENT_TOKEN_ENDPOINT` | Identity internal agent-token mint URL | `http://localhost:3110/internal/agent-token` |
| `INTERNAL_SERVICE_KEY` | Shared secret for machine-to-machine calls (≥32 chars) | — |
| `OWEIBO_INTERNAL_API_TOKEN` | Bearer for `/_internal/*` worker routes | — |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | OTel collector gRPC endpoint | `http://otelcol:4317` |
| `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT` | Set `false` in production (PII policy) | `false` |
| `LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY` / `LANGFUSE_BASE_URL` | Langfuse tracing | — |
| `METRICS_TOKEN` | Bearer token protecting `/metrics` | — |

---

## Development workflow

```bash
# Type-check all packages
pnpm type-check

# Run all tests
pnpm test

# Check architectural boundaries (dep-cruiser)
pnpm check-boundaries

# Check RLS migration coverage
pnpm check-rls

# INV-16: the ADR-000 sole-writer map must agree with the architecture doc
pnpm exec tsx scripts/check-sole-writer-map.ts

# Full CI pipeline (build + type-check + assert-tests + check-rls + test)
pnpm ci
```

### Database migrations (dev)

`pnpm db:setup` applies every `packages/db/migrations/*.sql` in order. To apply
a single new migration to the running dev container (DDL requires the postgres
superuser; the `oweibo_app` runtime role deliberately has none):

```bash
docker exec -i oweibo-dev-postgres psql -U postgres -d oweibo \
  -v ON_ERROR_STOP=1 < packages/db/migrations/<file>.sql
```

### Pre-commit hooks (Husky)

Every commit runs automatically:

1. **ESLint** — all packages with a `lint` script
2. **TypeScript type-check** — all packages
3. **Test presence** — every source file must have a corresponding test file
4. **dep-cruiser** — architectural boundary rules; zero violations required
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
| **Fabric conformance** | pure predicate suites per fabric subsystem (consistency, permissions, planner, policy lattice, rollout, health, DR, MCP surface) | `pnpm --filter @oweibo/core-engine test` |
| **Fabric live batteries** | `k0…k9-battery.integration.test.ts` + governance batteries (relaxation flow, custom connectors, policy version) — real Postgres, real RLS, non-superuser role | require `TEST_DATABASE_URL` |
| Connector certification | SDK certification runner + simulator, per bundle | `pnpm --filter @oweibo/connectors test` |
| RLS belt-and-suspenders | `packages/db/src/__tests__/rls.test.ts` + `kf-store-scope.test.ts` (living registry of every fabric table's scope) | require `TEST_DATABASE_URL` |
| JWT round-trip | `apps/identity/src/__tests__/jwt.test.ts` | `pnpm --filter @oweibo/identity test` |
| Admin-web | vitest unit + Playwright e2e | `pnpm --filter @oweibo/admin-web test` / `test:e2e` |

### Live batteries against the dev database

The fabric and governance suites run against real Postgres **as the
non-superuser `oweibo_app` role** — RLS is exercised, not bypassed. With the
dev data plane up (`pnpm dev:up`, `pnpm db:setup`):

```bash
# password: whatever your docker-compose.dev.yml / .env.dev sets for oweibo_app
TEST_DATABASE_URL=postgresql://oweibo_app:PASSWORD@localhost:5432/oweibo \
  pnpm --filter @oweibo/core-engine test
```

Suites skip cleanly when `TEST_DATABASE_URL` is unset, so `pnpm test` stays
runnable without Docker.

---

## Architectural boundaries

Enforced by dep-cruiser (`.dependency-cruiser.js`). The build fails on any violation.

| Rule | Enforces |
|---|---|
| `module-cannot-import-core-engine` | `module-*` packages depend only on `core-contracts` |
| `module-cannot-import-other-module` | Modules are boundary-isolated; inter-module comms via typed events only |
| `core-engine-cannot-import-modules` | Factory Core Independence |
| `core-engine-cannot-import-connectors` | The engine never depends on a concrete connector — connectors are data, discovered at the composition root; engine batteries use fixtures (INV-17) |
| `connectors-only-import-sdk` | Connector bundles depend only on `connector-sdk` (+ contracts) |
| `core-contracts-cannot-import-core-engine` | `core-contracts` is zero-dependency |
| `event-types-must-come-from-contracts` | Event types defined only in `core-contracts/src/events/` |
| `channel-gateway-cannot-import-core-engine-internals` | Gateway consumes only three public ingestion interfaces |
| `browser-extension-cannot-import-core-engine` | Extension is a standalone Chrome package with zero server imports |
| `no-direct-prisma-outside-db-package` | All Prisma access flows through `withTenantContext()` |
| `identity-service-cannot-import-core-engine` | `apps/identity` is auth-only |
| `api-middleware-cannot-import-identity` | JWT verification via JWKS endpoint — no direct service coupling |
| _(+ more)_ | doc-generator isolation, specialist-agent isolation, browser-tool boundaries, db↔identity acyclicity |

Beyond dep-cruiser, two conformance scripts guard the data plane: `check-rls`
(every tenant Prisma model has an RLS migration) and `check-sole-writer-map`
(every persisted entity has exactly one writing subsystem, in agreement with
the architecture document — INV-16).

---

## Implementation status

| Phase | Description | Status |
|---|---|---|
| **Phase 0–7** | Security hardening, identity foundation, unified auth middleware, NATS event bus, CLI, admin web UI, audit + observability, CI hardening | **Done** |
| **Action safety (T/S/F series)** | Action trust ladder (dry-run/shadow/approval modes, calibration, pins + floors), multi-party approvals + grants + delegation, quotas + budget insurance, rate limits, rollback orchestration, forensic packets + replay, action lineage, HITL SLA lifecycle, injection-safe content-trust boundary | **Done** |
| **Connector fabric (K series)** | Scheduler + `kf_*` schema; connector SDK + certification + simulator; Google Workspace IdP, Drive, Slack, GitHub connectors; discovery → indexing → retrieval with ACL-before-ranking; consistency contracts; query planner; full-content embeddings + hybrid rank + permission-aware semantic cache; live path with field freshness (fail-closed); knowledge graph + identity resolution; tenant policy system with relaxation lattice + dual-control ballots; outbound/inbound MCP faces; blue/green connector rollout; health/SLO; DR backup classes | **Done** |
| **Fabric web surface** | `/tenants/:id/fabric` + `/connectors` HTTP routes, admin pages (policy governance, relaxation ballots, rollout controls, custom connector registration), enforcement wired into the write path | **Done** |
| **Custom connectors** | Tenant-authored manifests (`custom.*` ids, experimental tier, validation-gated), installable alongside the catalog with unchanged downstream governance | **Done** |
| Fabric runtime residuals | Worker daemon loops (crawl→index automation), real MCP JSON-RPC transport, production Redis token buckets, real Slack/GitHub API clients (in-memory fixtures today), search UI over RetrievalService | In progress |
| Phase 8 | Legacy `TENANT_TOKENS` sunset: 60-day migration window, import as real `api_keys` rows | Pending |
| Phase 10+ | Firecracker microVMs, Postgres hash-partitioning, multi-region, self-hosted edge tier | Deferred |

Scale-out phases (10+) are triggered by measured load signals, not calendar dates.
