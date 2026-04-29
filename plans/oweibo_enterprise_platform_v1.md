# Oweibo Enterprise Platform — v1 Implementation Plan

**Status:** committed, 2026-04-26
**Scope:** turn the existing oweibo orchestration stack (kilo-pipeline + core-engine + 4-tier memory + sandboxed agents) into a multi-tenant, multi-user, **multi-agent** autonomous software-engineering platform with a CLI and a web admin UI, deployable on a single node, with a documented scale-out path. **All infrastructure is self-hosted; no cloud-subscription services.**

---

## 1. Executive summary

### 1.1 Product positioning

Oweibo is an **agent-as-a-service (AaaS) platform** — a self-learning multi-tenant SaaS where the product itself is the autonomous agent, consumed by customers via API, CLI, and web UI. Unlike chatbot-style assistants, oweibo **acts** on multi-stage directions end-to-end — from market research to building a website to writing features, fixing bugs, answering codebase questions, and proposing pull requests for review. It runs many tasks in parallel per tenant, learns across tasks via the existing 4-tier memory + Qdrant invariant/decision/history collections, and exposes the same operations through every surface (API/CLI/UI parity is a CI gate).

The closest reference points are the union of Manus (autonomous task execution), Nous Hermes (agentic framework), Claude Code (CLI-native dev agent), and Cowork (virtual-teammate model) — but as a multi-tenant SaaS platform, not a single-user tool.

**AaaS implications shaping every section of this plan:**

- The API and CLI are *customer-facing*, not internal admin tools. Every tenant gets their own isolated agent instance with its own memory, sandbox, and trust-mode posture.
- Usage is the unit of value: token counts, task duration, and agent-run minutes (captured via OTel GenAI metrics — §15.6.1) feed tenant quotas today and metered billing later.
- Trust modes, memory tiers, sandbox isolation, and quotas are all per-tenant precisely because each customer's agent runs are isolated runs of the SaaS.
- API keys are how programmatic customers consume; web UI for humans; CLI for both.

### 1.2 What this plan does

Oweibo today is a tenant-aware orchestration engine with serious enforcement gaps (see prior audit) and no user/role/agent identity model. This plan builds the platform layer around it: identity, authorization, audit, web admin, full-parity CLI, and the data-plane changes required for safe multi-tenancy under the parallel-task, self-learning workload. v1 ships on a **single node** so the team can launch fast and learn; the scale-out plan (Firecracker microVMs, partitioning, multi-region) is sequenced as Phase 10+ and triggered by measured load.

### 1.3 Infrastructure stance

**No cloud-subscription services.** Every component runs on self-hosted infrastructure — bare metal, VPS, or Kubernetes cluster the team operates. The reference stack uses Langfuse (already a core dependency), self-hosted Postgres, Redis, NATS JetStream, Qdrant, MinIO, Caddy, and Vault. Cloud SaaS (managed databases, Datadog/Honeycomb, Cloudflare, PagerDuty) is explicitly out of scope.

The five hard requirements from the user brief are addressed as follows:

| Requirement | Mechanism |
|---|---|
| 1. Multi-tenancy & identity isolation | BetterAuth user → oweibo tenant via `multiOrganization` plugin; Postgres RLS as the floor; `db.withTenantContext` chokepoint as the ceiling. |
| 2. Granular RBAC | Static `ROLE_SCOPES` matrix; JWT carries pre-resolved `scopes[]`; declarative `requireScopes(...)` middleware per route. |
| 3. CLI ↔ API parity | Bidirectional CI gate: every operationId has exactly one CLI command and vice versa. |
| 4. Dual-layer (Platform / Tenant) management | `/api/v1/platform/*` and `/api/v1/tenants/:tenantId/*` URL split; corresponding Web UI route groups. |
| 5. Audit logging | Outbox-backed, append-only `oweibo.audit_log`, RLS-protected, surfaced to both CLI and Web UI under same operationIds. |

Plus a sixth axis added during planning:

| Requirement | Mechanism |
|---|---|
| 6. Multi-agent identity | New principal type `agent` with act-as JWT minted only by the platform; scope ⊆ parent task; tracked end-to-end in audit. |

---

## 2. Goals and non-goals

### Goals

- Eliminate every P0 / P1 finding from the prior endpoint audit by construction (not by patching).
- One source of truth for who-can-do-what: `ROLE_SCOPES` + Zod schemas + OpenAPI spec.
- Single-node deployment that survives launch (target: 500 RPS sustained, 250k users, p99 < 500 ms read paths).
- Forward-compatible schema and API surface so scale-out additions don't require rewrites.
- Preserve all existing Phase 1 security work and trust-mode semantics.

### Non-goals (v1)

- Multi-region active-active.
- Firecracker microVMs / per-tenant Kubernetes namespaces.
- Edge tier in front of Caddy/Traefik (no CDN/WAF SaaS; self-hosted edge added later if traffic warrants).
- Hash-partitioning hot tables (schema designed for it; ship as live migration when triggered).
- Cross-region DR (single-region snapshot + WAL is acceptable for v1).
- gRPC interface (REST + SSE only; gRPC reconsidered after v1).
- Any cloud-subscription service (managed DB, hosted observability, hosted alerting, hosted CDN/WAF). Self-hosted equivalents listed throughout.

---

## 3. Architecture overview (single-node v1)

```text
                    ┌──── Caddy / Traefik (TLS, basic rate limit) ────┐
                    │                                                  │
                    │      api.oweibo.io       admin.oweibo.io         │
                    └──────┬─────────────────────────┬─────────────────┘
                           │ path-based routing      │
        ┌──────────────────┼─────────────────┐       │
        ▼                  ▼                 ▼       ▼
   apps/identity   kilo-pipeline       core-engine  apps/admin-web
   (3110)          API (3100)          API (3101)   (3120, Next.js)
        │                  │                 │       │
        │ shared dependencies (single instance each, all self-hosted):
        ├──────────► Postgres   (betterauth.* + oweibo.*)
        ├──────────► Redis      (idempotency, RL, JWKS cache, revocations)
        ├──────────► NATS JS    (tasks subjects, audit subject, outbox drain)
        ├──────────► Qdrant     (4-tier semantic memory)
        ├──────────► MinIO      (S3-compatible: artifacts, checkpoints, audit cold tier)
        ├──────────► Langfuse   (LLM call tracing, prompt management — already wired)
        ├──────────► Prometheus (metrics scrape; Loki for logs in Phase 6)
        └──────────► Vault OSS  (secrets, JWT keypair, per-tenant KMS via Transit engine)

   Sandbox:
        kilo-pipeline → kilo-proxy → Docker engine
        Containers run with CapDrop=ALL, ReadonlyRootfs=true,
        User=node, no-new-privileges (Phase 1 hardening preserved).
```

All services run on one host (or one small K8s cluster, single AZ) operated by the team. No managed-service dependencies. Ports listed above are internal; only Caddy/Traefik is on 443.

---

## 4. Identity model

### 4.1 Three principal types

```text
USER     — BetterAuth-managed; JWT sub = BetterAuth user id (UUID).
API_KEY  — oweibo-native; JWT sub = "apikey:<id>"; scoped to one tenant + one user.
AGENT    — server-minted only when a task spawns an agent;
           sub = "agent:<runId>";
           act_as = { sub: <userId>, tenantId };
           scopes ⊆ parent_task.scopes ∩ agent_profile.scopes;
           ttl ≤ remaining task budget, max 60 min.
```

### 4.2 Token shape (RS256, 15-min access)

```json
{
  "iss": "https://identity.oweibo.io",
  "aud": "oweibo-api",
  "sub": "<principal id>",
  "act_as": { "sub": "<userId>", "tenantId": "<tenantId>" },
  "ctx":    { "tenantId": "<tenantId>" },
  "scopes": ["tasks:write", "..."],
  "trust":  "supervised | graduated | autonomous",
  "iat": 0, "exp": 0, "nbf": 0, "jti": "<uuid>", "kid": "<keyid>"
}
```

`act_as` is present only on agent tokens. Audit rows attribute `actor=sub, on_behalf_of=act_as.sub`.

### 4.3 JWKS rotation

- Identity service holds the private key; gateways fetch JWKS from `GET /.well-known/jwks.json`.
- `jose.createRemoteJWKSet(...)` caches by `kid` for 10 min.
- Rotation: new `kid` published; old `kid` retained for `2 × accessTtl` (30 min) before removal.

### 4.4 Login flows

- **Web UI:** standard BetterAuth session cookie.
- **CLI interactive:** `oweibo login` runs OAuth2 device-code against `apps/identity`; refresh token (30 d) cached at `~/.oweibo/credentials` (mode 0600).
- **CLI / CI non-interactive:** API key via `--api-key` flag, `OWEIBO_API_KEY` env, or config file (in priority order).
- **Service-to-service:** machine API key with narrow scope set, rotated quarterly.

### 4.5 Agent token mint

```ts
// apps/identity/src/agent-token.ts (server-only; no public route)
export async function mintAgentToken(opts: {
  taskId: string;
  runId: string;
  parentScopes: Scope[];
  agentProfile: 'architect' | 'orchestrate' | 'writer-1' | ...;
  taskBudgetRemainingMs: number;
}): Promise<string>
```

Called by the task-worker process when launching an agent inside the sandbox. The agent receives the token via env var; uses it for callbacks to `core-engine` (memory, gates, audit). External callers cannot reach this function — no HTTP route mounts it.

---

## 5. Authorization model

### 5.1 Roles

```text
Platform roles: platform_admin, platform_operator, platform_billing
Tenant roles:   tenant_admin,    tenant_developer,  tenant_viewer
```

A `users` row carries 0..n platform roles. `tenant_memberships` row carries 1..n tenant roles per (user, tenant) pair.

### 5.2 Scopes (single source of truth)

```ts
type Scope =
  | 'tasks:read' | 'tasks:write' | 'tasks:cancel'
  | 'staging:read' | 'staging:approve' | 'staging:reject'
  | 'quarantine:read' | 'quarantine:override'
  | 'scrape:read' | 'scrape:write' | 'scrape:delete'
  | 'hitl:read' | 'hitl:decide'
  | 'ledger:read' | 'ledger:write'
  | 'memory:read' | 'memory:write'
  | 'tenant:settings:read' | 'tenant:settings:write'
  | 'tenant:users:read' | 'tenant:users:write'
  | 'tenant:apikeys:read' | 'tenant:apikeys:write'
  | 'tenant:audit:read'
  | 'trust:graduated' | 'trust:autonomous'
  // platform-only
  | 'platform:tenants:read' | 'platform:tenants:write'
  | 'platform:users:read' | 'platform:users:write'
  | 'platform:metrics:read' | 'platform:audit:read'
  | 'platform:config:write';
```

### 5.3 Role → scope expansion (`packages/identity/src/policy.ts`)

```ts
export const ROLE_SCOPES = {
  platform_admin:    [...PLATFORM_SCOPES, ...TENANT_ADMIN_SCOPES],
  platform_operator: ['platform:tenants:read', 'platform:metrics:read', 'platform:audit:read'],
  platform_billing:  ['platform:tenants:read', 'platform:metrics:read'],

  tenant_admin:      [...TENANT_ADMIN_SCOPES],
  tenant_developer:  ['tasks:read','tasks:write','tasks:cancel',
                      'staging:read','quarantine:read',
                      'scrape:read','scrape:write',
                      'hitl:read','memory:read',
                      'tenant:settings:read'],
  tenant_viewer:     ['tasks:read','staging:read','quarantine:read',
                      'scrape:read','hitl:read','memory:read',
                      'tenant:settings:read'],
};
```

Wildcards expand at module load; runtime checks compare resolved scope sets — no glob matching in middleware.

### 5.4 Trust mode binding

Trust mode is a **scope-gated** field on `POST /tasks`, not a free-form override:

| Override request | Required scopes |
|---|---|
| `supervised` | `tasks:write` |
| `graduated`  | `tasks:write` + `trust:graduated` |
| `autonomous` | `tasks:write` + `trust:autonomous` (and `tenant.features.autonomous = true`) |

`trust:autonomous` is grantable only by `tenant_admin`. This makes trust mode enforceable instead of "trust the client".

### 5.5 Middleware

```ts
authenticate(opts)              // verify JWT or API key, populate req.principal
requireScopes(...needed)        // 403 with { missing: Scope[] }
requireTenantMatch('tenantId')  // 404 if URL tenantId ≠ principal.ctx.tenantId
                                // (platform admins bypass)
audit(action: string)           // outbox row before next handler runs
idempotent({ store, ttl })      // Redis-backed Idempotency-Key
```

---

## 6. Data plane

### 6.1 Postgres topology

One Postgres 16 instance. Two schemas in one database:

- `betterauth.*` — managed by BetterAuth library; **not** under oweibo RLS. Access pattern: `auth.api.*` server-side calls only.
- `oweibo.*` — RLS enforced.

### 6.2 RLS pattern

Every `oweibo.*` table that holds tenant data:

```sql
ALTER TABLE oweibo.<table> ENABLE ROW LEVEL SECURITY;
ALTER TABLE oweibo.<table> FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON oweibo.<table>
  FOR ALL
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);

CREATE POLICY platform_admin_bypass ON oweibo.<table>
  FOR ALL
  USING (current_setting('app.is_platform_admin', true) = 'true');
```

Cross-tenant tables (`oweibo.tenants`, `oweibo.users` mirror, `oweibo.audit_log`): policies keyed off `app.is_platform_admin` + per-row owner predicates. No `tenant_id` column.

### 6.3 Connection helper (the only entry point for queries)

```ts
// packages/db/src/withTenantContext.ts
export async function withTenantContext<T>(
  principal: Principal,
  fn: (tx: PrismaTx) => Promise<T>,
): Promise<T> {
  const isPlatformAdmin = principal.scopes.includes('platform:tenants:write');
  return prisma.$transaction(async tx => {
    if (principal.ctx.tenantId) {
      // tenantId guaranteed UUID by upstream zod validation
      await tx.$executeRawUnsafe(`SET LOCAL app.tenant_id = '${principal.ctx.tenantId}'`);
    }
    if (isPlatformAdmin) {
      await tx.$executeRawUnsafe(`SET LOCAL app.is_platform_admin = 'true'`);
    }
    return fn(tx);
  });
}
```

ESLint rule (`scripts/eslint-rules/no-direct-prisma.js`): `prisma.*` access outside this file fails the build.

PgBouncer must run in **transaction-pool mode** (verified by CI smoke test). Statement-pool mode breaks `SET LOCAL`.

### 6.4 Schema (illustrative subset)

```sql
-- Cross-tenant tables (no tenant_id; RLS keyed off platform_admin)
CREATE TABLE oweibo.tenants (
  id UUID PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active','suspended','deleted')),
  trust_mode_default TEXT NOT NULL DEFAULT 'supervised',
  features JSONB NOT NULL DEFAULT '{}'::jsonb,
  quotas JSONB NOT NULL,
  home_region TEXT NOT NULL DEFAULT 'us-east-1',  -- forward-compat
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID REFERENCES oweibo.users(id)
);

CREATE TABLE oweibo.users (
  id UUID PRIMARY KEY,                  -- mirrors betterauth.users.id
  email TEXT UNIQUE NOT NULL,
  status TEXT NOT NULL,
  platform_roles TEXT[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Postgres trigger keeps oweibo.users in sync with betterauth.users.
-- See §6.5.

CREATE TABLE oweibo.tenant_memberships (
  user_id UUID REFERENCES oweibo.users(id),
  tenant_id UUID REFERENCES oweibo.tenants(id),
  roles TEXT[] NOT NULL,
  invited_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  invited_by UUID REFERENCES oweibo.users(id),
  PRIMARY KEY (user_id, tenant_id)
);
ALTER TABLE oweibo.tenant_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE oweibo.tenant_memberships FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON oweibo.tenant_memberships
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
CREATE POLICY platform_admin_bypass ON oweibo.tenant_memberships
  USING (current_setting('app.is_platform_admin', true) = 'true');

-- Tenant-scoped tables (tenant_id NOT NULL, RLS enforced)
CREATE TABLE oweibo.api_keys (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES oweibo.tenants(id),
  created_by_user_id UUID NOT NULL REFERENCES oweibo.users(id),
  name TEXT NOT NULL,
  prefix TEXT NOT NULL,         -- visible
  hashed_secret TEXT NOT NULL,  -- sha256 of full key
  scopes TEXT[] NOT NULL,
  expires_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  last_used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE oweibo.api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE oweibo.api_keys FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON oweibo.api_keys
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
CREATE POLICY platform_admin_bypass ON oweibo.api_keys
  USING (current_setting('app.is_platform_admin', true) = 'true');

-- Tasks, scrapes, staging-items, ledger entries follow the same pattern.

-- Audit log: append-only, partitioned by month for forward-compat
CREATE TABLE oweibo.audit_log (
  id UUID NOT NULL,
  ts TIMESTAMPTZ NOT NULL,
  actor_principal TEXT NOT NULL,        -- userId | apikey:<id> | agent:<runId>
  on_behalf_of_user_id UUID,
  source TEXT NOT NULL,                  -- 'cli' | 'web' | 'api' | 'system'
  request_id TEXT,
  ip INET,
  tenant_id UUID,
  scope_used TEXT[] NOT NULL,
  action TEXT NOT NULL,
  resource_type TEXT, resource_id TEXT,
  before_hash TEXT, after_hash TEXT,
  outcome TEXT NOT NULL CHECK (outcome IN ('allow','deny','error')),
  details JSONB,
  PRIMARY KEY (id, ts)
) PARTITION BY RANGE (ts);

CREATE TABLE oweibo.audit_log_2026_05 PARTITION OF oweibo.audit_log
  FOR VALUES FROM ('2026-05-01') TO ('2026-06-01');
-- Partition created monthly by a cron job; old partitions detached and archived to S3.

-- Audit RLS: tenant members see their own tenant's rows; platform_admin sees all.
ALTER TABLE oweibo.audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE oweibo.audit_log FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON oweibo.audit_log
  FOR SELECT
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
CREATE POLICY platform_admin_bypass ON oweibo.audit_log
  FOR SELECT
  USING (current_setting('app.is_platform_admin', true) = 'true');
-- No INSERT/UPDATE/DELETE policy → defaults to deny for non-superuser.
-- Inserts go through SECURITY DEFINER function only.

-- Outbox for atomic state-mutation + bus publish
CREATE TABLE oweibo.outbox (
  id UUID PRIMARY KEY,
  ts TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  subject TEXT NOT NULL,
  payload JSONB NOT NULL,
  published_at TIMESTAMPTZ
);
```

### 6.5 BetterAuth ↔ oweibo.users mirror

A Postgres trigger on `betterauth.users` keeps `oweibo.users` in sync:

```sql
CREATE FUNCTION oweibo.sync_user_from_betterauth() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO oweibo.users (id, email, status)
    VALUES (NEW.id, NEW.email, 'active');
  ELSIF TG_OP = 'UPDATE' THEN
    UPDATE oweibo.users SET email = NEW.email WHERE id = NEW.id;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE oweibo.users SET status = 'deleted' WHERE id = OLD.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER betterauth_user_sync
AFTER INSERT OR UPDATE OR DELETE ON betterauth.users
FOR EACH ROW EXECUTE FUNCTION oweibo.sync_user_from_betterauth();
```

Single source of truth: `betterauth.users.id` is the authoritative user id. `oweibo.users` is a denormalized mirror for FK joins under RLS.

### 6.6 Vector store (Qdrant) tenant safety

```ts
// packages/qdrant-tenant/src/client.ts
export class TenantSafeQdrant {
  constructor(private raw: QdrantClient) {}

  async scroll(collection: string, opts: ScrollOpts, ctx: TenantContext) {
    const filter = mergeFilter(opts.filter, {
      must: [{ key: 'tenant_id', match: { value: ctx.tenantId } }]
    });
    return this.raw.scroll(collection, { ...opts, filter });
  }
  // search, upsert, delete: same wrapping
}
```

`packages/qdrant-tenant` is the only export of qdrant client functionality; raw qdrant client import is banned outside this package via ESLint.

### 6.7 Object storage

**MinIO** (S3-compatible, self-hosted) — single instance in v1, per-tenant prefix:

```text
s3://oweibo-prod/{tenantId}/checkpoints/{taskId}/...
s3://oweibo-prod/{tenantId}/artifacts/{taskId}/...
s3://oweibo-prod/{tenantId}/audit-cold/{yyyy-mm}/...
```

Per-tenant encryption key managed via **Vault Transit engine** — closes the Phase 2 checkpoint-encryption gap. MinIO IAM policies pin reader/writer roles to the tenant prefix; signed URLs for client downloads. Schema is identical to AWS S3 so swap-in works either direction without code changes if the team ever reverses the no-cloud stance.

---

## 7. Control plane

### 7.1 Service map

| Service | Port | Owns |
|---|---|---|
| `apps/identity` | 3110 | BetterAuth, JWKS, JWT mint, platform/tenant admin endpoints |
| `kilo-pipeline` API | 3100 | tasks, staging, quarantine, scrape, ledger, status |
| `core-engine` API | 3101 | tasks, hitl, skills, sse events |
| `apps/admin-web` | 3120 | Next.js RSC web UI |
| Caddy/Traefik | 443 | TLS termination, basic rate limit, path-based routing |

Internal-only ports: 9100 (Prometheus metrics), 4222 (NATS), 5432 (Postgres), 6379 (Redis), 6333 (Qdrant). All bound to localhost or the internal network.

### 7.2 Hot-path queue (NATS JetStream)

Single-node NATS JetStream replaces the in-memory `kilo/pipeline/services/queue.ts`:

```text
Stream: tasks
  Subjects: tasks.*.submit, tasks.*.events.*, tasks.*.intervene.*
  Storage: file (single replica in v1)
  Retention: WorkQueue for submit, Limits for events
  Max age: 24h events, ∞ for unconsumed submits

Consumer per task-worker replica:
  Filter: tasks.*.submit
  Ack policy: explicit
  Max in-flight: tenantQuota.maxConcurrentTasks
  Max deliver: 3 (then DLQ subject)
```

Even at single-node, this is strictly better than in-memory: tasks survive restart, backpressure is explicit, multiple worker replicas can pull concurrently.

### 7.3 Outbox pattern (closes saga gap)

Every state mutation writes both the row and an outbox record in the same Postgres transaction. A leader-elected `outbox-publisher` process drains rows → NATS, marks `published_at`. At-least-once delivery; idempotency keys on consumer side prevent duplicate effects.

```ts
await withTenantContext(principal, async tx => {
  await tx.task.update({ where:{id}, data:{ status:'completed' } });
  await tx.outbox.create({ data:{
    subject: `tasks.${tenantId}.events.${id}`,
    payload: { type:'task-complete', taskId:id }
  }});
});
// outbox-publisher worker drains rows asynchronously, publishes to NATS.
```

This solves the existing race condition between `queue.update`, `storeStageOutput`, and checkpoint write.

### 7.4 Sandbox (v1 — Docker-hardened, current architecture)

v1 keeps the existing Docker-via-`kilo-proxy` sandbox with all Phase 1 hardening:

- `User: 'node'`
- `CapDrop: ['ALL']`
- `ReadonlyRootfs: true`
- `SecurityOpt: ['no-new-privileges:true']`
- `infra/sandbox/Dockerfile` (purpose-built sandbox image)

What changes for v1:

- Sandbox process receives an **agent JWT** (not a static token) in env. Token is scope-bounded (parent ⊇ agent) and short-lived (≤ task budget).
- Sandbox egress: hardcoded allowlist (npm registry, pypi, github.com, configured tenant remotes) via outbound HTTP proxy. Closes SSRF at network layer in addition to app layer.
- `kilo-proxy EXEC=1` remains an accepted risk in v1, **but** mitigated because the agent token now caps blast radius even if exec is abused.

Phase 10 replaces this with Firecracker microVMs on Kubernetes; see §17.

### 7.5 Edge / rate-limiting

Three tiers:

| Tier | Where | What |
|---|---|---|
| 1 | Caddy/Traefik | Per-IP: 100 req/min for `/api/*`, 10 req/min for `/api/v1/auth/*`. Block on Caddy's built-in abuse heuristics. |
| 2 | Gateway | Redis token bucket: per-tenant (configurable from `tenant.quotas.rpsCap`), per-user-in-tenant (60/min), per-API-key (scope-derived). |
| 3 | Backend | Per-handler concurrency caps: `/tasks` 30/min/tenant, `/scrape` 10/min/tenant + concurrency 3, SSE 5 streams/user. |

This wires `scrapeLimiter` (already exported, never wired) at tier 3. The hand-rolled `Map<ip, …>` in core-engine is deleted.

---

## 8. CLI design

### 8.1 Surface (every operationId has a CLI command)

```text
oweibo {login | logout | whoami}

# Platform layer (requires platform_* role)
oweibo platform tenant {list | create | get | update | suspend | delete}
oweibo platform user   {list | create | update-roles}
oweibo platform audit  tail [--tenant id]
oweibo platform metrics

# Tenant layer (requires tenant_* role)
oweibo tenant user     {list | invite | update-roles | remove}
oweibo tenant apikey   {list | create | revoke}
oweibo tenant settings {get | set}
oweibo tenant audit    tail

# Resource families
oweibo task       {run | status | redirect | pause | cancel | list}
oweibo staging    {list | approve | reject}
oweibo quarantine {list | override}
oweibo scrape     {start | status | stop | list | results | delete | search}
oweibo ledger     {list | pin | reset}
oweibo hitl       {pending | approve | reject}

# Existing top-level shortcuts (kept as aliases)
oweibo run | status | pause | cancel | hitl | session | skills | browser | docs | config
```

Aliases declared via `commander`'s `.alias()` and tracked in a single `ALIAS_MAP` constant so the parity test resolves them.

### 8.2 Auth resolution order

1. `--api-key <value>` flag.
2. `OWEIBO_API_KEY` env var.
3. `~/.oweibo/credentials` refresh token → access JWT (auto-refresh on 401).
4. Else: prompt `oweibo login`.

`~/.oweibo/config.json` keeps `apiUrl`, `tenantId`, `defaultMode`. Secrets move to `~/.oweibo/credentials` (mode 0600); `apiKey` removed from `config.json`.

### 8.3 Output

Every command supports `--json` for machine-readable output. Default human output: pretty-printed table or summary.

---

## 9. Web admin UI (`apps/admin-web`)

- Next.js 15 (App Router, RSC).
- BetterAuth React adapter for session.
- Two route groups gated by middleware:
  - `(platform)/*` — visible only to `platform_*` roles.
  - `(tenant)/[tenantId]/*` — tenant context derived from URL; access-denied if not a member.
- All pages call the same APIs the CLI uses — no duplicated business logic.
- Tenant switcher in the top nav re-issues a JWT for the new active tenant via `/auth/exchange?tenantId=...`.

Pages (v1):

- Platform: tenant list, tenant detail (settings, quotas, audit), user list, audit tail, metrics overview.
- Tenant: user list (invite, role), api-key list (create/revoke), settings (trust mode default, features), tasks dashboard, staging review, quarantine review, ledger view, HITL queue.

---

## 10. Audit log

### 10.1 Coverage

Every state-mutating route declares an `action` constant:

```ts
router.post('/tasks',
  authenticate(...),
  requireScopes('tasks:write'),
  rateLimit('task'),
  validate(SubmitTaskSchema),
  idempotent({ store: redis, ttl: 86400 }),
  audit('task.create'),
  taskHandler);
```

Privileged actions (mark_permanent, reset_ledger, quarantine override, scrape delete, tenant settings update, user invite, role change, api-key create/revoke, tenant suspend) all carry an audit middleware.

### 10.2 Row contents

```text
ts                  TIMESTAMPTZ
actor_principal     "userId" | "apikey:<id>" | "agent:<runId>"
on_behalf_of_user   UUID NULL
source              cli | web | api | system
request_id          correlation id
ip                  client IP (proxy-stripped)
tenant_id           UUID NULL (null for platform actions)
scope_used          TEXT[]   e.g. ['ledger:write']
action              'task.create' | 'ledger.pin' | ...
resource_type       'task' | 'ledger' | ...
resource_id         e.g. taskId or hash
before_hash         sha256(JSON snapshot before mutation)
after_hash          sha256(JSON snapshot after mutation)
outcome             allow | deny | error
details             JSONB (action-specific)
```

### 10.3 Immutability

- INSERTs go through a `SECURITY DEFINER` function (`oweibo.append_audit(...)`).
- No `UPDATE`/`DELETE` policy → defaults deny.
- Old partitions detached and archived to S3 cold tier after 90 days; query path unions live + cold.

### 10.4 Same operationId regardless of source

`oweibo platform audit tail` (CLI), `apps/admin-web/(platform)/audit` (Web), `GET /api/v1/platform/audit` (API) all hit the same handler. Audit row distinguishes only by `source`.

---

## 11. Trust mode integration

Trust modes (`supervised | graduated | autonomous`) remain a first-class concept.

| Mode | Token requirement | Sandbox effect | HITL effect |
|---|---|---|---|
| `supervised` | any `tasks:write` | `repo:read` only | every gate failure escalates to HITL |
| `graduated`  | `tasks:write` + `trust:graduated` | `repo:write` to workspace only | HITL on cross-tenant ops, gate failures |
| `autonomous` | `tasks:write` + `trust:autonomous` + tenant feature | `repo:write` + `tools:execute` in sandbox | HITL only on hard violations (gate-9 ADR) |

`trust:autonomous` is grantable only by `tenant_admin` and only if `tenants.features ->> 'autonomous' = 'true'`. The current code accepts `trust_mode_override` from any caller — that gap closes here.

---

## 12. Memory tier integration

| Tier | Class | v1 keying |
|---|---|---|
| 1 — WorkingMemory | `WorkingMemoryRegistry` | (tenantId, taskId) — unchanged |
| 2 — STM (Redis sliding window) | `ShortTermMemoryStore` | (tenantId, sessionId, userId) — userId added |
| 3 — ProjectRegistry (Redis) | `ProjectRegistry` | (tenantId) — unchanged |
| 4 — Semantic (Qdrant) | `KiloSemanticAdapter` via `TenantSafeQdrant` | (tenantId) — wrapper enforces filter |

The session+user keying on tier 2 prevents one user's chat history bleeding into another user's session within the same tenant. Tier 4 already has tenant isolation from Phase 1; this plan makes the wrapper mandatory.

---

## 13. Quotas and abuse

### 13.1 Tenant quotas

```text
tenants.quotas JSONB:
  maxConcurrentTasks      (default 3 free / configurable paid)
  maxScrapesPerDay        (default 10 free)
  storageBytes            (default 1 GiB free)
  rpsCap                  (default 10 free)
  maxTokensPerDay         (default 1M free; the AaaS unit of value)
  maxAgentRunMinutesPerDay (default 60)
```

Quota service (in `apps/identity` for centralised auth + quota lookup) is queried by gateways via Redis-cached calls. Hard-cap at the gateway layer; soft-warn at 80% usage via webhook/email.

**GenAI metrics are the canonical quota inputs** (see §15.6.1):

- `gen_ai.client.token.usage{oweibo.tenant.id}` → `maxTokensPerDay` burn-down.
- `gen_ai.client.operation.duration` aggregated over `invoke_agent` spans → `maxAgentRunMinutesPerDay` burn-down.
- These same metrics, retained at higher resolution, are the inputs a future metered-billing system reads — emitting them in Phase 6 means billing is a downstream consumer when the team is ready, not a code change.

### 13.2 Abuse signals

- task failure rate > 50% over 1 h → auto-flag for review
- 10× traffic spike vs trailing 24 h baseline → auto-rate-limit at tier 2
- scrape `target_url` matches block-list regex → reject + flag
- multiple SSRF attempts → auto-suspend tenant, page on-call

Auto-suspend writes `tenants.status = 'suspended'`; gateway returns 403 `tenant_suspended` for non-`tenant_admin` calls (admins can still log in to file appeals).

---

## 14. SSRF / sandbox / network policy

Phase 1 hardening preserved verbatim. Additions for v1:

### 14.1 Scrape SSRF guard

```ts
// packages/api-middleware/src/ssrf-guard.ts
async function assertSafeTarget(url: URL) {
  if (!['http:', 'https:'].includes(url.protocol)) throw new BadRequestError('blocked_scheme');
  const ips = await dns.resolve(url.hostname);          // resolve once
  for (const ip of ips) {
    if (isPrivate(ip)) throw new BadRequestError('blocked_target');
  }
  // Pin Host on the actual fetch to defeat DNS rebinding
  return { url, hostHeader: url.hostname, resolvedIp: ips[0] };
}
```

Block ranges: `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `127.0.0.0/8`, `169.254.0.0/16`, `::1`, `fc00::/7`, `fe80::/10`.

### 14.2 Sandbox egress

Hardcoded allowlist via outbound proxy; sandbox containers cannot resolve / reach anything else. Tenant-supplied egress destinations require admin approval and an audit row.

---

## 15. Phased delivery

### 15.0 Phase 0 — Pre-flight P0/P1 fixes (1 week, ships immediately)

These close active exploits today and don't block any later phase. PR-by-PR list:

1. Add `auth` to `GET /staging` and `GET /quarantine`; ignore body/query `tenant_id`/`workspace`.
2. `sanitizeSegment` on all `:id` URL params reaching FS.
3. Wire `scrapeLimiter` to `/scrape/start`.
4. Move `/metrics` behind `METRICS_TOKEN` or a separate listener.
5. JWT signature compare → `crypto.timingSafeEqual`; fail-closed on missing/dev secret.
6. SSRF allow/deny IP guard on `/scrape/start`.
7. Tenant-scope ledger ops (`mark_permanent`, `reset_ledger`).
8. Scrape jobs persist `tenant_id`; ownership check in every `/scrape/*/:jobId`.
9. `/health` returns 503 when degraded; add `/livez`.

**Acceptance:** every POST/DELETE requires a valid token + ownership check; SSRF integration test against `169.254.169.254` returns 4xx; `/metrics` not reachable from public ingress.

### 15.1 Phase 1 — Identity foundation (2 weeks)

- `apps/identity` service with BetterAuth on `betterauth.*` schema.
- RS256 keypair, JWKS endpoint, `jose`-based mint/verify.
- `oweibo.*` schema + RLS migrations: `tenants`, `users`, `tenant_memberships`, `api_keys`, `audit_log`, `outbox`, `tasks` (move from current in-memory `queue` storage).
- BetterAuth ↔ `oweibo.users` Postgres trigger.
- `db.withTenantContext` chokepoint + ESLint rule banning direct `prisma.*`.
- `scripts/check-rls.ts` lint: every model with `tenantId` must have RLS migration.

**Acceptance:** RLS belt-and-suspenders test green; identity service can mint / verify JWTs round-trip; BetterAuth signup creates rows in both schemas atomically.

### 15.2 Phase 2 — Unified auth/authz middleware (3 days) ✅ DONE

- `packages/api-middleware`: `authenticate`, `requireScopes`, `requireTenantMatch`, `audit`, `idempotent`, `rateLimit`.
- Both gateway services migrated to use it.
- Static `TENANT_TOKENS` map adapted as a synthetic API-key importer (legacy tokens accept seamlessly during migration).
- `requestId` middleware + `traceparent` propagation to Qdrant/Ollama/Crawl4AI.

**Acceptance:** every existing route declares `requireScopes`; CI route-audit gate green; legacy tokens still work.

### 15.3 Phase 3 — Endpoint refactor + outbox + JetStream (3 weeks) ✅ DONE

- All route IDOR findings closed by `requireScopes` middleware on every mutating handler.
- NATS JetStream client + file-based outbox publisher (at-least-once delivery to NATS; replay on restart).
- Task state transitions publish to `tasks.<tenantId>.events.*` subjects via outbox.
- Agent JWT wiring: `fetchAgentToken()` calls identity service internal endpoint; `OWEIBO_AGENT_TOKEN` injected into sandbox containers.
- `mintAgentToken` internal-only endpoint (`POST /internal/agent-token`, guarded by `INTERNAL_SERVICE_KEY`); profile-derived scope sets.
- Quota service: Redis-backed daily counters (`tasks_day`, `tokens_day`, `scrapes_day`, `agent_min_day`); fails open when Redis unavailable.
- `assertSafeTarget` SSRF guard promoted to `@oweibo/api-middleware` shared export.
- Config additions: `NATS_URL`, `REDIS_URL`, `AGENT_TOKEN_ENDPOINT`, `INTERNAL_SERVICE_KEY`.
- 3 new dep-cruiser boundary rules: api-middleware isolation + kilo-pipeline cannot import identity.

**Acceptance:** quota cap enforced on `/task`; agent token minted and injected on sandbox spawn; every route rejects unauthenticated callers with 401; SSRF integration test returns 4xx on private IPs.

### 15.4 Phase 4 — Robust CLI (2 weeks, parallel with Phase 3)

- Resource-family subcommands (`platform`, `tenant`, `task`, `staging`, `quarantine`, `scrape`, `ledger`, `hitl`).
- `oweibo {login | logout | whoami}` device-code flow.
- `~/.oweibo/credentials` refresh-token cache.
- Bidirectional parity test in CI.

**Acceptance:** parity test green; all 30+ commands have integration tests against a mock API.

### 15.5 Phase 5 — Web admin UI (3 weeks)

- `apps/admin-web` Next.js 15 RSC.
- Platform group + tenant group with middleware-enforced RBAC.
- Tenant switcher with JWT re-issue.
- All pages call the same operationIds the CLI uses.

**Acceptance:** RBAC redirect tests; cross-tenant deep-link tests; Playwright e2e for tenant_admin and platform_admin journeys.

### 15.6 Phase 6 — Audit, GDPR, observability (2 weeks)

- Audit middleware on every privileged route.
- `oweibo.append_audit` SECURITY DEFINER function.
- Monthly partition cron + MinIO archival worker.
- `DELETE /api/v1/users/:id/personal-data` GDPR erasure (Postgres anonymise, Qdrant delete by user_id, MinIO prefix purge, BetterAuth soft-delete).
- **Observability stack (all self-hosted):**
  - **Langfuse** for LLM-call tracing, prompt versioning, and agent-run replay (already wired in `core-engine`; extended to cover identity service and gateway).
  - **OpenTelemetry SDK** in every service → **self-hosted OTel collector** → **Tempo** (traces) + **Loki** (logs) + **Prometheus** (metrics).
  - **Grafana** for dashboards (the OSS package, not Grafana Cloud).
  - **Alertmanager** routes alerts to email / matrix / webhook (no PagerDuty SaaS).
- Structured logs (pino-http) with redaction; sampling 100% errors / 1% successes.
- All agent/LLM/tool spans conform to **OpenTelemetry GenAI semantic conventions** — §15.6.1 below.

### 15.6.1 OpenTelemetry GenAI semantic conventions (mandatory)

As an agent-as-a-service platform, oweibo's primary observability dimension is *agent activity*, not traditional HTTP traffic. Every span and metric describing LLM calls, agent stages, and tool invocations conforms to the OpenTelemetry GenAI semantic conventions (current stable revision pinned in `packages/observability/CONVENTIONS_VERSION`). Pinning prevents silent attribute renames; conformance is checked in CI.

#### 15.6.1.1 Span taxonomy

| OTel span name | Used when | `gen_ai.operation.name` |
|---|---|---|
| `chat` | Any LLM completion call (Ollama / OpenAI / Anthropic / DeepSeek / OpenRouter) | `chat` |
| `embeddings` | MiniLM or any embedding call | `embeddings` |
| `invoke_agent` | Each pipeline stage: architect, orchestrate, writer-1..5, gates, reflection, recovery | `invoke_agent` |
| `execute_tool` | Every `ToolRegistry.invoke()` call | `execute_tool` |

The agent stages are an explicit hierarchy:

```text
trace: task <taskId>
└── span: invoke_agent (gen_ai.agent.id="orchestrator")
    ├── span: invoke_agent (gen_ai.agent.id="architect")
    │   ├── span: chat              (LLM plan generation)
    │   └── span: oweibo.memory.read (4-tier recall)
    ├── span: invoke_agent (gen_ai.agent.id="writer-1")
    │   ├── span: chat
    │   └── span: execute_tool      (gen_ai.tool.name="git_commit")
    ├── span: oweibo.gate.evaluate  (gate.id="G8A")
    └── span: oweibo.gate.evaluate  (gate.id="G8B")
```

Memory and gate spans use the `oweibo.*` namespace because the GenAI conventions don't define them; they sit alongside the `gen_ai.*` spans without conflict.

#### 15.6.1.2 Required attributes (per span)

```text
# All gen_ai.* spans
gen_ai.system                    "ollama" | "openai" | "anthropic" | "deepseek" | "openrouter"
gen_ai.operation.name            see taxonomy above
gen_ai.request.model             requested model id
gen_ai.response.model            actually-served model id
gen_ai.request.temperature
gen_ai.request.max_tokens
gen_ai.request.top_p
gen_ai.response.id
gen_ai.response.finish_reasons   ["stop"] | ["length"] | ["tool_calls"] | ["content_filter"]
gen_ai.usage.input_tokens
gen_ai.usage.output_tokens

# invoke_agent spans
gen_ai.agent.id                  "architect" | "orchestrate" | "writer-1" | ...
gen_ai.agent.name                human-readable
gen_ai.agent.description         from agent profile

# execute_tool spans
gen_ai.tool.name                 from ToolRegistry registration
gen_ai.tool.call.id              uuid per call
gen_ai.tool.type                 "function" | "retrieval" | "code-execution"

# Custom oweibo.* attributes on EVERY span (multi-tenancy is not in GenAI spec)
oweibo.tenant.id                 from JWT ctx.tenantId
oweibo.user.id                   from JWT sub OR act_as.sub for agent tokens
oweibo.task.id                   originating task uuid
oweibo.run.id                    agent-run id (for sub-agents inside a task)
oweibo.trust.mode                "supervised" | "graduated" | "autonomous"
oweibo.principal.kind            "user" | "api_key" | "agent"
```

The `act_as` claim on agent JWTs ensures every sub-agent span carries the originating user/tenant — three-deep delegation is fully traceable.

#### 15.6.1.3 Required metrics

Emitted to the Prometheus-compatible OTel exporter; histogram buckets defined in `packages/observability/buckets.ts`.

```text
gen_ai.client.token.usage          histogram
  labels: gen_ai.system, gen_ai.request.model, gen_ai.operation.name, gen_ai.token.type ∈ {input, output}
  + oweibo.tenant.id

gen_ai.client.operation.duration   histogram
  labels: gen_ai.system, gen_ai.request.model, gen_ai.operation.name, gen_ai.response.finish_reason
  + oweibo.tenant.id

gen_ai.server.request.duration      histogram (server-side, for any oweibo-proxied LLM call)
gen_ai.server.time_to_first_token   histogram (streaming responses)
gen_ai.server.time_per_output_token histogram
```

The `oweibo.tenant.id` label is the per-tenant cost-attribution dimension. It feeds:

- the **quota service** (`gen_ai.client.token.usage` × tenant pricing → quota burn-down) — §13.
- future **metered billing** — token counts and operation duration are the canonical AaaS billing inputs; emitting them now means billing is a downstream consumer, not a code change.
- per-tenant Grafana dashboards: token spend, p99 LLM latency, top-N agents by cost.

#### 15.6.1.4 Message-content capture (PII policy)

The GenAI conventions optionally capture full prompts/completions as span events. This *will* leak tenant data into traces if turned on naively. Locked policy:

| Environment | `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT` |
|---|---|
| `production` | **`false`** — token counts, role, finish-reason only. No message bodies. |
| `staging` | `false` by default; per-tenant opt-in flag for debugging |
| `development` | `true` |

Full-content tracing for prod debugging goes through **Langfuse**, not OTel. Langfuse is purpose-built for LLM trace bodies, supports tenant-level visibility controls, and already exists in the stack — so the OTel pipeline stays at metadata level (cheap, safe, billing-ready) and Langfuse handles the rich-content path.

#### 15.6.1.5 Langfuse + OTel coexistence

Langfuse exposes an OTel-native ingest endpoint. Wire the OTel SDK once; the collector fans out to:

- **Tempo** — full trace tree, queryable by `oweibo.tenant.id`, `gen_ai.agent.id`, etc.
- **Langfuse** — `gen_ai.*` spans mapped to Langfuse's session/trace/observation model for prompt-versioning and replay.
- **Prometheus** — `gen_ai.*` metrics for billing-grade aggregation.

Single instrumentation, three consumers. The current direct Langfuse SDK calls in `core-engine` are migrated to emit via OTel (they keep working through Langfuse's bridge during the migration).

#### 15.6.1.6 Instrumentation chokepoints (single source of truth)

To make adherence enforceable rather than aspirational, all GenAI calls flow through three instrumented chokepoints:

| Chokepoint | What it instruments | File |
|---|---|---|
| `BaseLLMClient.complete()` | every `chat` span across all providers (Ollama/OpenAI/Anthropic/DeepSeek/OpenRouter) | `kilo/pipeline/src/services/llm/BaseLLMClient.ts` |
| `embeddings.embed()` | every `embeddings` span | `kilo/pipeline/src/services/embeddings.ts` |
| `ToolRegistry.invoke()` | every `execute_tool` span | `packages/core-engine/src/tools/ToolRegistry.ts` |

Agent stages (`runArchitect`, `runOrchestrate`, `writer1..5`, `runGate`, `runReflection`, `runRecovery`) each open an `invoke_agent` span via a shared `withAgentSpan(agentId, fn)` helper in `packages/observability/agent-span.ts`. ESLint custom rule (`scripts/eslint-rules/no-direct-llm-call.js`) fails the build if any provider client is imported outside `BaseLLMClient`, mirroring the existing `no-direct-prisma` and `no-direct-qdrant` rules.

#### 15.6.1.7 CI conformance test

```text
e2e/observability/genai-conformance.test.ts
  ✓ every chat span carries gen_ai.system, gen_ai.request.model, gen_ai.usage.{input,output}_tokens
  ✓ every invoke_agent span carries gen_ai.agent.id and oweibo.tenant.id
  ✓ every execute_tool span carries gen_ai.tool.name and gen_ai.tool.call.id
  ✓ oweibo.tenant.id present on 100% of spans in a synthetic task run
  ✓ message-content capture is false in NODE_ENV=production fixtures
  ✓ Langfuse receives the same gen_ai.* spans as Tempo (both consumers see the same fan-out)
  ✓ token-usage histogram emits one observation per LLM call with tenant label
  ✓ adding a new LLM provider without going through BaseLLMClient fails ESLint
```

Ships as a Phase 6 CI gate. After Phase 6, no PR that breaks GenAI conformance can merge.

**Acceptance:** audit-coverage test (every privileged route emits row); GDPR erasure test on fixture user; trace visible end-to-end for `POST /tasks → executor → Qdrant`.

### 15.7 Phase 7 — Launch hardening (2 weeks)

- k6 load: 500 RPS sustained 30 min, p99 < 500 ms, error rate < 0.1%.
- Chaos: kill identity service → token verification continues (JWKS cached); kill JetStream → tasks resume on restart from disk.
- DR rehearsal: restore from yesterday's base backup + WAL, verify data complete to within 5 min of crash.
- Abuse drill: simulate scrape SSRF attempts, verify auto-suspend.
- Security review pass: external pentest before public launch.

**Acceptance:** all targets met; no P0/P1 in pentest; on-call playbooks signed off.

### 15.8 Phase 8 — Legacy migration sunset (overlap, 60-day window)

- Each entry of static `TENANT_TOKENS` imported as: tenant + synthetic legacy user + tenant_admin membership + api_key (hashed_secret = sha256 of legacy token).
- `Sunset` and `Deprecation` headers on every response carrying a legacy-imported key.
- After 60 days: delete `KILO_API_TOKEN` / `TENANT_TOKENS` env handling; legacy keys still valid (now real api_keys).

**Acceptance:** all existing tenants resolve via the new path; static-map code deleted.

### Total: ~12 weeks to launch readiness; Phase 0 ships in week 1

---

## 16. Test strategy (CI-blocking)

Five suites must be green to merge any change to platform code.

### 16.1 Cross-tenant isolation (auto-generated from OpenAPI)

For every endpoint × every (caller, target) pair:

- same-tenant same-role → success
- same-tenant lower-role → 403 `insufficient_scope`
- cross-tenant any role → 404 `not_found`
- no token → 401
- revoked api_key → 401 within 30 s
- agent token outside parent task scope → 403

Generated from OpenAPI spec; adding a new endpoint forces new test rows.

### 16.2 RLS belt-and-suspenders

Application-layer tenant check disabled via test flag; RLS alone must block:

- cross-tenant SELECT/INSERT/UPDATE/DELETE
- audit_log: UPDATE/DELETE rejected always
- pgBouncer transaction-pool: `SET LOCAL` survives across queries in same txn

### 16.3 Multi-agent delegation

- agent token cannot be minted by external caller
- agent token scope set ⊆ parent task's scope set
- agent token TTL ≤ task remaining budget
- audit row for agent action carries both `actor=agent:<runId>` and `on_behalf_of=<userId>`
- agent acting in `trust=supervised` triggers HITL for unapproved scope use

### 16.4 CLI ↔ API parity (bidirectional)

- every operationId in `openapi.json` has exactly one CLI command
- every CLI command maps to one operationId
- request payloads send only declared fields
- `--json` output validates against response schema

### 16.5 Saga atomicity & outbox

- kill process between `tx.task.update` and bus publish → no inconsistency on restart
- duplicate publish (consumer redelivery) is idempotent due to Idempotency-Key
- outbox-publisher leader election: only one publisher publishes at a time

### 16.6 Trust mode

- `supervised` tenant cannot submit `autonomous` task even with override
- `graduated` tenant can submit `graduated`; ledger logs trust escalation
- `autonomous` task rejected if sandbox cap-drop is missing `ALL`

### 16.7 SSRF / sandbox / sanitization

- `/scrape/start http://169.254.169.254` → 400 `blocked_target`
- `/scrape/start http://qdrant:6333` → 400 `blocked_target`
- DNS rebinding: target resolves public first then internal → fail
- `/staging/:id` with `id='..%2Fetc%2Fpasswd'` → 400, no FS read
- sandbox container: `User=node`, `ReadonlyRootfs=true`, `CapDrop=['ALL']`

### 16.8 Memory tier isolation

- WorkingMemory: `bucket(tenantA, taskX)` inaccessible after task complete
- STM: tenantA sessionX cannot see tenantA sessionY (session-scoped)
- STM: userA cannot see userB's session within same tenant
- ProjectRegistry: tenantA cannot enumerate tenantB project keys
- Qdrant scroll always filters `tenant_id` when invoked from tenant context
- raw qdrant client import outside `packages/qdrant-tenant` fails ESLint

### 16.9 GDPR deletion

- fixture user: 5 tasks, audit rows, Qdrant points, S3 artifacts
- `DELETE /users/:id/personal-data` → email redacted, audit PII fields nulled (rows retained), Qdrant points by user_id deleted, S3 prefix empty, BetterAuth user soft-deleted

### 16.10 Idempotency

- same Idempotency-Key + same body → same response, single side effect
- same key + different body → 409 `idempotency_mismatch`
- key TTL respected; replay after TTL creates new resource

---

## 17. Scale-out roadmap (deferred, Phase 10+)

Triggered when the single node hits one of:

| Signal | Threshold | Response |
|---|---|---|
| Postgres CPU > 70% sustained 1 h | repeated for 3 days | partition hot tables (tasks, audit_log, outbox) by hash(tenant_id) % 64 |
| Single-node task throughput > 80% capacity | 1 week | add task-worker replicas (NATS already supports it) |
| Sandbox concurrent containers > 50 | sustained 1 h | migrate to Kubernetes Jobs with `kata-fc` (Firecracker) RuntimeClass |
| Network egress for tenant > 1 Gbps | sustained 10 min | tenant-scoped network namespace + bandwidth shaping |
| Cross-region latency complaints | first paying enterprise customer | enable second region; tenant `home_region` becomes meaningful |
| DR target tightens to RPO 5 min | business decision | streaming replica + WAL ship to second region |

The schema is already designed for these moves:

- `tenants.home_region` column ships from day 1.
- All tenant-scoped tables include `tenant_id` as first key, so hash-partitioning is a live migration (`pg_partman` or manual `ATTACH PARTITION`).
- NATS JetStream stream config is reproducible across regions; mirroring is config-only.
- Outbox-driven publish ensures cross-region delivery is an operational change, not a code change.

### 17.1 Phase 10 — Sandbox migration to Firecracker

- New RuntimeClass `kata-fc` on Kubernetes.
- Per-tenant namespace at provisioning; NetworkPolicy denies all + opens egress proxy.
- ResourceQuota matches `tenants.quotas`.
- Custom controller honours per-tenant `maxConcurrentTasks`.
- Job-template emits Pod with `runtimeClassName: kata-fc`.

### 17.2 Phase 11 — Postgres partitioning

- Hash-partition `oweibo.tasks` by `tenant_id` into 64 partitions (live migration).
- Time-partition `oweibo.audit_log` already shipped from v1; keep monthly cadence.
- Connection pool sizing per partition; pgBouncer pool-per-database pattern.

### 17.3 Phase 12 — Multi-region

- Activate second region (e.g. `eu-west-1`).
- Per-region Postgres, Redis, Qdrant, NATS.
- `tenants.home_region` becomes meaningful: routing layer dispatches by `home_region`.
- Cross-region: only `revocations` and `audit` mirrored.
- Tenant region migration: admin tool, downtime window.

### 17.4 Phase 13 — Self-hosted edge tier

When the single Caddy/Traefik node becomes the bottleneck or the team needs DDoS / WAF posture, deploy a self-hosted edge tier — **no cloud SaaS**:

- **Bunkerized-nginx** or **OpenResty + Coraza WAF** in front of Caddy/Traefik. OWASP CRS rules for top-10 patterns.
- Edge rate limit (per-IP) via lua-resty-limit-traffic or built-in nginx `limit_req`.
- Edge cache for read-heavy paths (`GET /tasks/:id` 5 s, public `/healthz` 30 s) via Varnish or nginx proxy_cache.
- Anycast routing only if/when team operates multiple POPs themselves.

If the team ever reverses the no-cloud stance, Cloudflare or Fastly drops in front of this edge tier without code changes.

---

## 18. Operational concerns (single-node v1)

### 18.1 Backup

- Postgres: daily base backup + WAL archiving to MinIO. RPO 24 h v1; tightened to 5 min in Phase 12.
- Qdrant: daily snapshot to MinIO.
- Redis: AOF every second + daily snapshot. (State is mostly cache + idempotency; loss tolerable.)
- NATS JetStream: file-storage on a dedicated volume; daily snapshot.
- Langfuse Postgres: daily base backup (LLM trace history is small; same backup target).

### 18.2 Restore

- RTO 4 h v1: restore base backup, replay WAL, restart services. Documented in `apps/identity/docs/restore.md`.

### 18.3 On-call

- **Self-hosted alerting** (Alertmanager + matrix / email / webhook receiver; no PagerDuty SaaS) on:
  - `apps/identity` health 5xx rate > 1% for 5 min
  - kilo-pipeline error rate > 1% for 5 min
  - Postgres replication lag > 60 s (when replica added)
  - JetStream consumer lag > 1000 messages
  - tenant auto-suspend events
  - Langfuse trace ingest failures > 1% for 5 min (degraded observability)
- Runbooks live in `docs/runbooks/*.md`.
- Optional: **Grafana OnCall** (OSS) for rotation/scheduling if the team grows beyond one on-call.

### 18.4 Deployment

- Each service has its own Dockerfile + Helm chart.
- Single Helm release per environment (dev / staging / prod) deploys all services.
- Database migrations run as a pre-install hook with `Atlas` (online migrations only — no exclusive locks during business hours).
- Blue-green deploy at the Caddy/Traefik layer for zero-downtime cutover.

### 18.5 Secrets

- All secrets in HashiCorp Vault (`oweibo/{env}/...`):
  - `oweibo/{env}/jwt/private` (PEM, RS256)
  - `oweibo/{env}/jwt/jwks` (JWKS public set)
  - `oweibo/{env}/postgres/admin`
  - `oweibo/{env}/postgres/app`
  - `oweibo/{env}/redis/auth`
  - `oweibo/{env}/qdrant/api`
  - `oweibo/{env}/s3/access`
  - per-tenant KMS key references
- Vault Agent injector pattern for runtime delivery; no env-var secrets in YAML.

### 18.6 Cost ceiling (rough, v1, self-hosted on commodity infra)

Single beefy host (or 3-node small cluster) running everything. Hetzner / OVH / Vultr / on-prem all comparable.

- One bare-metal box (e.g. AX52: 8c/16t Ryzen, 64 GiB RAM, 2× 1 TiB NVMe): **~$80/mo**
- Or 3-node small K8s cluster (each 4c/8t, 32 GiB, 500 GiB NVMe): **~$240/mo**
- Bandwidth (1 Gbit/s, 20 TiB/mo included on most providers): $0 incremental
- Domain + TLS (Let's Encrypt via Caddy): **~$10/yr**
- LLM inference (if using cloud APIs for some calls — OpenAI/Anthropic/etc.): variable, the dominant cost per task; reduces to near-zero if Ollama/local models cover the workload
- **~$80–250/mo for the platform itself**, plus LLM-call cost (workload-dependent).

The platform itself is OSS top-to-bottom; the only recurring spend is the host(s) and the optional LLM-API egress.

---

## 19. Forward compatibility

Decisions made in v1 that exist solely to preserve scale-out optionality:

- `tenants.home_region` column with default value.
- All tenant-scoped tables prefixed with `tenant_id` in primary key.
- Audit log already partitioned monthly even on single node.
- NATS JetStream chosen over in-memory or Redis Streams because mirroring is config-only.
- Outbox pattern already in place; cross-region replication is an outbox-publisher config change.
- BetterAuth user mirror via Postgres trigger — survives schema-per-tenant migration if ever needed.
- All ports internal; only Caddy/Traefik exposed — CDN layer slots in front without code changes.

---

## 20. Open items (revisit before Phase 1 kickoff)

1. Postgres role split: single `oweibo_app` for both schemas, or separate `betterauth_app` + `oweibo_app`? Default: separate roles with `betterauth_app` blocked from `oweibo.*` schema. Decided: separate.
2. `oweibo.users` mirror via trigger or BetterAuth `databaseHooks`? Default: trigger. Decided: trigger.
3. Single Helm chart vs separate charts per service? Default: single umbrella chart for v1.
4. Self-hosted edge tier choice (Phase 13): Bunkerized-nginx vs OpenResty + Coraza. Defer.
5. Langfuse deployment topology: dedicated Postgres or share oweibo's? Default: dedicated Langfuse Postgres on the same node (different DB, same instance) to keep its trace ingest from contending with platform writes. Confirm before Phase 6.

---

## 21. Mapping back to the original five requirements

| # | Requirement | Plan section |
|---|---|---|
| 1 | Multi-tenancy & identity isolation, no architectural data leakage | §4 (principal model), §5 (RBAC), §6 (RLS + chokepoint) |
| 2 | Granular RBAC with hierarchical roles | §5 (roles, scopes, ROLE_SCOPES) |
| 3 | CLI ↔ API parity, business logic centralised in API | §8 (CLI), §16.4 (parity test) |
| 4 | Dual-layer (Platform / Tenant) management | §4 (URL split), §9 (Web UI route groups), §15.5 |
| 5 | Auth + authz middleware, centralised audit across CLI + Web | §5.5 (middleware), §10 (audit), §16.1 (cross-source audit test) |

Plus the additions during planning:

| # | Requirement | Plan section |
|---|---|---|
| 6 | Multi-agent identity | §4.1, §4.5, §16.3 |
| 7 | Trust mode integration | §11 |
| 8 | Memory tier integration | §12 |
| 9 | GDPR / data sovereignty | §15.6 (Phase 6), §16.9 |
| 10 | Quotas & abuse, AaaS billing readiness | §13, §15.6.1.3 |
| 11 | OpenTelemetry GenAI semantic conventions | §15.6.1 |
| 12 | Self-hosted only — no cloud SaaS | §1.3, §3, §15.6, §17.4, §18 |
| 13 | Agent-as-a-service positioning | §1.1 |

---

**Next step:** ship Phase 0 (the seven security fixes). They land in week 1 and do not commit the team to any architectural decision in this plan — they're pure exploit closure. Phase 1 (identity foundation) starts in week 2.
