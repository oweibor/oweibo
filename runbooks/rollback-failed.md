# Runbook: rollback failed

**Phase:** F.7.3 (ttv-finals)
**Owner:** Platform on-call + the per-adapter SME (e.g. DB on-call for Postgres rollback)
**Alert source:** `oweibo_rollback_execution_state="failed"` rate > 1% over 15 min OR a single severity-5 rollback failure

## Symptom

`oweibo.rollback_execution.state = 'failed'` for one or more proposals. The original action's side effect persists; the system is in an unintended state and operator-side compensating action is required.

## Per-adapter quick triage

Identify which adapter is responsible:

```sql
SELECT adapter_kind, COUNT(*) AS failed_count,
       MAX(error) AS sample_error
  FROM oweibo.rollback_execution
 WHERE state = 'failed'
   AND created_at > NOW() - INTERVAL '1 hour'
 GROUP BY adapter_kind;
```

Each adapter has a different recovery path. **Jump to the appropriate section below.**

---

## PostgresRollbackAdapter

### Common causes

| Error signature | Cause | Manual fix |
|---|---|---|
| `relation "..." does not exist` | Adapter's UNDO SQL references a dropped/renamed table. | Inspect the original DDL in the proposal payload, reconstruct by hand. |
| `insufficient privileges` | Adapter runs under `oweibo_app` but action was `platform_admin`-scoped. | Run UNDO as `platform_admin` directly: `psql -U platform_admin -c "<UNDO_SQL>"`. |
| `concurrent UPDATE on row` | Row already changed by another writer between original action and rollback. | Manual reconcile: read current row, decide whether to leave or merge with intended pre-state. |
| `unique constraint violation` on reinsert | Row was deleted by a third party between rollback attempts. | Adjust the UNDO to be `INSERT ... ON CONFLICT DO NOTHING`. |

### Manual remediation

```sql
-- Inspect the proposal's rollback_detail to see the intended UNDO SQL.
SELECT id, rollback_kind, rollback_detail
  FROM oweibo.action_proposals
 WHERE id = '<PROPOSAL_ID>';

-- Run the UNDO manually (transactional):
BEGIN;
SET LOCAL ROLE platform_admin;
<the rollback_detail.sql text>
COMMIT;

-- Mark the rollback succeeded so audits don't keep flagging it:
UPDATE oweibo.rollback_execution
   SET state = 'succeeded',
       completed_at = NOW(),
       error = 'manually_rolled_back: <ticket-id>'
 WHERE proposal_id = '<PROPOSAL_ID>';
```

---

## GitRollbackAdapter

### Common causes

| Error signature | Cause | Manual fix |
|---|---|---|
| `non-fast-forward` | Original commit is no longer at HEAD; concurrent commits pushed. | Revert manually: `git revert <commit-sha>` + force-push if owners agree. |
| `Permission denied (publickey)` | Deploy key rotated. | Re-provision the key in the tenant's connector config. |
| `Push declined by remote hook` | Branch protection blocks revert. | Bypass policy via the branch protection admin or coordinate with the tenant. |

### Manual remediation

```bash
git clone <repo>
git revert --no-edit <original-commit-sha>
git push origin <branch>
```

Then update the DB row as in the PG section.

---

## SlackRollbackAdapter

### Common causes

| Error signature | Cause | Manual fix |
|---|---|---|
| `channel_not_found` | Channel was archived or renamed since the original post. | No-op the rollback (the message is effectively gone): mark succeeded with note `channel_archived`. |
| `not_in_channel` | Bot was removed from the channel. | Either re-invite the bot or no-op the rollback. |
| `cant_delete_message` | Message is older than 14 days OR not posted by the bot. | Post a follow-up message: "ATTN: the previous announcement was incorrect and has been retracted." Mark the rollback succeeded with note `cannot_delete_posted_followup`. |

### Manual remediation

If Slack API can't delete, the human-visible compensating action is a follow-up message. Use the tenant's Slack workspace admin UI directly; don't try to re-run the rollback adapter.

---

## DeployRollbackAdapter

### Common causes

| Error signature | Cause | Manual fix |
|---|---|---|
| `deploy not found` | Original deploy ID expired in the deploy system's retention window. | No-op + investigate why rollback waited so long. |
| `target environment locked` | Concurrent deploy is in flight. | Wait for the in-flight deploy to finish or coordinate with the deploying engineer. |
| `previous version artifact missing` | Build artifact GC removed the rollback target. | Manually re-deploy from source: `pnpm -r build && deploy --env=<env> --tag=<commit-sha>`. |

### Manual remediation

Always coordinate with the deploy on-call before running a manual deploy — this affects every tenant on the cluster, not just the one whose rollback failed.

---

## GenericWebhookRollbackAdapter

### Common causes

| Error signature | Cause | Manual fix |
|---|---|---|
| `HTTP 401 / 403` from receiver | Tenant rotated the webhook secret. | Update `oweibo.tenant_notification_webhooks.signing_secret` + retry. |
| `HTTP 404` | Webhook URL deleted. | Mark the webhook config `inactive` + email the tenant. |
| `timeout` | Receiver slow or down. | Retry once via `POST /tenants/{id}/actions/{id}/rollback`. If still failing, no-op + audit. |

### Manual remediation

```bash
# Manually replay the rollback request:
curl -X POST \
  -H "Authorization: Bearer <tenant-token>" \
  -H "Content-Type: application/json" \
  --data '{"reason":"manual_replay_after_failure"}' \
  https://api.oweibo.io/api/v1/tenants/<TENANT_ID>/actions/<PROPOSAL_ID>/rollback
```

If three retries fail, treat as no-op (tenant must reconcile externally).

---

## Universal escalation

- **5 min**: page L2 if the failed adapter is `PostgresRollbackAdapter` and the affected table is shared (`oweibo.*`) — risk of cross-tenant data leak.
- **30 min**: page Security if any rollback is for an `irreversible.*` or `financial.*` action class.
- **2 h**: file a postmortem ticket per failed rollback so adapter improvements are tracked.

## Related dashboards

- Grafana: "Rollback" — per-adapter success rate, latency, failure causes
- Grafana: "Forensic packets" — packets with `state='unresolved'` after a failed rollback
