---
name: incident-triage
description: Triage a production incident with a stable, low-stress procedure that prioritizes stop-the-bleed over root-cause.
tags: [incident, scope:starter]
applies_to: [general-coding]
---

# incident-triage

Apply this procedure when something is observably broken in production.

1. **Stop the bleed first.** Identify the smallest reversible mitigation —
   feature flag off, traffic shift, scale down, rollback. Apply it.
   Do NOT chase the root cause until the bleed stops.
2. **Communicate.** Post a one-line status in the incident channel
   *before* digging in. "Investigating elevated 5xx on /api/v1/orders;
   mitigation applied (flag off)." This unblocks oncall partners.
3. **Capture state.** Snapshot logs, traces, and metric panels for the
   incident window. After the system stabilizes, this is your forensic
   record.
4. **Find the trigger.** Ask: what changed? Recent deploy, traffic
   pattern, dependency outage, schema migration?
5. **Confirm root cause.** A theory is not a root cause until you can
   *reproduce* the failure with the trigger and *prevent* it with the
   fix.
6. **Write the postmortem.** Blameless. Focus on what surprised you and
   what guard would have caught it earlier.

Resist the urge to skip step 1. Investigations during an active outage
are slower and more error-prone than investigations after the bleeding
has stopped.
