# Runbook: tenant-bootstrap-worker stuck tenants

**Phase:** F.7.3 (ttv-finals)
**Owner:** Platform on-call
**Alert source:** Grafana dashboard "Bootstrap pipeline" — `pending` or `failed` count > 50 for > 30 min

## Symptom

Tenants stay in `oweibo.tenant_bootstrap.state IN ('pending','failed')` for longer than the reconcile sweep interval (default 6h). The bootstrap-worker either isn't draining the queue or is failing the same step repeatedly.

## Quick triage (5 min)

1. **Check worker health.**
   ```bash
   kubectl -n oweibo get pods -l app=tenant-bootstrap-worker
   kubectl -n oweibo logs -l app=tenant-bootstrap-worker --tail=200 | grep -E 'fatal|error|threw'
   ```
   - All pods `Running` and no fatal logs → continue to step 2.
   - Any pod `CrashLoopBackOff` → jump to "Worker won't stay up" below.

2. **Inspect stuck rows.**
   ```sql
   SELECT tenant_id, state, attempts, last_error, updated_at
     FROM oweibo.tenant_bootstrap
    WHERE state IN ('pending','failed')
    ORDER BY updated_at ASC
    LIMIT 20;
   ```
   - Same `last_error` across many rows → systemic problem; check step 3.
   - Different errors per tenant → individual tenant data issues; investigate per row.

3. **Identify the failing step.**
   ```sql
   SELECT step_name, status, attempts, last_error
     FROM oweibo.tenant_bootstrap_steps
    WHERE tenant_id = '<TENANT_ID>'
    ORDER BY started_at DESC;
   ```
   - The first row with `status = 'failed'` is the blocking step. Its `last_error` tells you which adapter exploded.

## Common causes + fixes

| Symptom | Cause | Fix |
|---|---|---|
| Every step `skipped`, state `ready` with zero content | Adapters unwired in worker. | Check `BOOTSTRAP_ALLOW_UNWIRED_STEPS` env; if `true`, operator suppressed the gate. Set to `false` and ensure the wiring path has been deployed (post-F.5). |
| `seed_memories` failed with `internalToken required` | `INTERNAL_API_URL` / `INTERNAL_API_TOKEN` not set. | Provision the secret + restart pods. |
| `domain_intake` failed with `container_runtime_unavailable` | `DOMAIN_INTAKE_ENABLED=true` but docker missing on host. | Either provision docker or set `DOMAIN_INTAKE_ENABLED=false`. |
| `install_ontology_pack` failed with `NoSuchPack` | Catalog drift between pack version and tenant_ontology_install. | Run `pnpm check-bootstrap-tables` against the env; if F.5.0 migration hasn't been applied, apply it. |
| Many tenants stuck on the SAME step but worker logs are silent | Worker hung mid-tick. | Force-restart pods: `kubectl -n oweibo rollout restart deploy/tenant-bootstrap-worker`. |

## Worker won't stay up

```bash
kubectl -n oweibo logs <pod> --previous | head -100
```

| Log signature | Cause | Fix |
|---|---|---|
| `pipeline validation: unwired adapters detected` + exit 2 | Not all 10 steps wired. | Either deploy the wiring fix OR set `BOOTSTRAP_ALLOW_UNWIRED_STEPS=true` if intentional. |
| `DATABASE_URL required` | Missing env. | Confirm the secret is mounted. |
| Connection refused (PG / Redis) | Upstream down. | Page DB / Redis on-call. |

## Manual reconcile

If the periodic sweep is stuck and you want to push specific tenants through:

```sql
-- Reset state so the next event processes them.
UPDATE oweibo.tenant_bootstrap
   SET state = 'pending',
       attempts = 0,
       last_error = NULL,
       updated_at = NOW()
 WHERE tenant_id = ANY(ARRAY['<id1>', '<id2>']::uuid[]);

-- Re-publish a tenant.created.v1 event via the outbox.
INSERT INTO oweibo.outbox (subject, payload)
SELECT 'tenant.created.v1', jsonb_build_object('tenantId', id::text)
  FROM oweibo.tenants
 WHERE id = ANY(ARRAY['<id1>', '<id2>']::uuid[]);
```

The OutboxRelay picks it up within `OUTBOX_POLL_INTERVAL_MS` (default 2s) and the worker handles it.

## Escalation

- **30 min** — page L2 if stuck count keeps growing.
- **2 h**  — page DB on-call if cause traces to PG (lock contention, replication lag).
- **4 h**  — page security if cause is sandbox-related (F.5.10 — DOMAIN_INTAKE_ENABLED issues).

## Related dashboards

- Grafana: "Bootstrap pipeline" — `oweibo.bootstrap.handle_tenant_created` span counts + p99
- Grafana: "Outbox" — `oweibo.outbox.tick` published count + lag
