# Runbook: approval-lifecycle-worker SLA backlog

**Phase:** F.7.3 (ttv-finals)
**Owner:** Platform on-call
**Alert source:** Prometheus rule `oweibo_approval_sla_backlog_p99_minutes > 5`

## Symptom

`oweibo.approval_sla_state` rows accumulate where `next_action_due_at < NOW()` but `next_action_status = 'pending'`. SLA notifications + escalations + auto-expiry aren't firing on time. Operators see stale "pending approval" UI badges; tenants miss escalation windows.

## Quick triage (5 min)

1. **Check worker health.**
   ```bash
   kubectl -n oweibo get pods -l app=approval-lifecycle-worker
   kubectl -n oweibo logs -l app=approval-lifecycle-worker --tail=200 | grep -E 'fatal|error|threw'
   ```

2. **Measure the backlog.**
   ```sql
   SELECT
     COUNT(*) FILTER (WHERE next_action_due_at < NOW())                              AS overdue_now,
     COUNT(*) FILTER (WHERE next_action_due_at < NOW() - INTERVAL '5 min')           AS overdue_5min,
     COUNT(*) FILTER (WHERE next_action_due_at < NOW() - INTERVAL '15 min')          AS overdue_15min,
     EXTRACT(EPOCH FROM NOW() - MIN(next_action_due_at)) / 60                         AS oldest_overdue_minutes
     FROM oweibo.approval_sla_state
    WHERE next_action_status = 'pending';
   ```

3. **Identify the policy with the backlog.**
   ```sql
   SELECT action_class, COUNT(*) AS overdue
     FROM oweibo.approval_sla_state s
     JOIN oweibo.action_proposals p ON p.id = s.proposal_id
    WHERE s.next_action_due_at < NOW() AND s.next_action_status = 'pending'
    GROUP BY action_class
    ORDER BY overdue DESC
    LIMIT 10;
   ```

## Common causes + fixes

| Symptom | Cause | Fix |
|---|---|---|
| Worker in `APPROVAL_LIFECYCLE_STANDALONE_NOOP_ACK` mode | Operator ack of refuse-to-start during a deploy. | Unset the env + restart pods. |
| `notificationChannelOpenFailed` errors | InApp / Email / Slack / Webhook channel misconfigured. | Inspect `oweibo.notification_dispatch_log.error` for the specific channel; reconfigure the secret. |
| Worker draining slowly but visible progress | Throughput too low for the load. | Bump replica count: `kubectl -n oweibo scale deploy/approval-lifecycle-worker --replicas=3`. The advisory lock + SKIP LOCKED on the queue makes scaling safe (no double-processing). |
| Worker logs `OperationDisabledError` on bandit_learning | Platform mode dropped below 4. | Confirm intentional (incident response?) — if not, restore mode via platform admin route. |
| Webhook dispatches all failing with `403` | Tenant rotated their webhook secret without updating us. | Mark webhook config inactive: `UPDATE oweibo.tenant_notification_webhooks SET state='disabled' WHERE id='<id>';` and email the tenant. |

## Manual drain

If the worker is healthy but the queue is too deep to drain organically:

```sql
-- Mark a specific overdue policy slot 'expired' immediately (skips
-- notification, terminal state).
UPDATE oweibo.approval_sla_state
   SET next_action_status = 'expired',
       updated_at = NOW()
 WHERE proposal_id = '<PROPOSAL_ID>';

-- Bulk close all overdue proposals (use with care!):
UPDATE oweibo.action_proposals
   SET state = 'expired', decided_at = NOW(), decision_reason = 'sla_backlog_manual_close'
 WHERE state = 'pending'
   AND id IN (
     SELECT proposal_id FROM oweibo.approval_sla_state
      WHERE next_action_due_at < NOW() - INTERVAL '1 hour'
   );
```

The corresponding `approval_sla_state` rows are cleaned up by the next SLA tick.

## Escalation

- **5 min** — page L2 if the backlog is growing faster than it's draining.
- **30 min** — page security if the backlog includes any `irreversible.*` or `financial.*` class proposals — those are time-sensitive.

## Related dashboards

- Grafana: "Approval SLA" — backlog age histogram, tick rate, channel dispatch success rate
- Grafana: "Notification channels" — per-channel failure rate
