# Runbook: forensic packet storage full

**Phase:** F.7.3 (ttv-finals)
**Owner:** Platform on-call + Storage on-call
**Alert source:** S3 bucket `OWEIBO_FORENSIC_S3_BUCKET` reaching 80% of its size budget; or `ForensicPacketBuilder` logging `S3PutObjectFailed` with `EntityTooLarge` / `SlowDown` / `503`

## Symptom

Verifier results with severity ≥ 3 fail to write a forensic packet to S3. The proposal stays open without an associated packet; HITL handoff can't reach the failed action because the packet pointer is missing.

## Quick triage (5 min)

1. **Check bucket size + object count.**
   ```bash
   aws s3 ls s3://$OWEIBO_FORENSIC_S3_BUCKET --recursive --summarize | tail -3
   ```

2. **Identify recent packet failures.**
   ```sql
   SELECT id, tenant_id, severity, storage_ref, created_at
     FROM oweibo.forensic_packet
    WHERE storage_ref IS NULL
      AND created_at > NOW() - INTERVAL '1 hour'
    ORDER BY created_at DESC
    LIMIT 50;
   ```
   Each row is a packet whose payload couldn't be persisted. The verifier still wrote the row; the `storage_ref` column is the S3 key when the upload succeeded.

3. **Inspect the most recent failure.**
   ```bash
   kubectl -n oweibo logs -l app=oweibo-api --tail=500 \
     | grep -E 'ForensicPacketBuilder.*S3PutObject|ForensicPacketStorage'
   ```

## Common causes + fixes

| Symptom | Cause | Fix |
|---|---|---|
| `EntityTooLarge` | Single packet exceeds S3 5GB single-PUT limit. | Implement multipart upload in `S3ForensicPacketStorage.put()` (currently single-PUT). Manual workaround: split the packet's `actionEnvelopes` array into chunks via the admin UI. |
| `SlowDown` / `503 SlowDown` | Prefix throughput exceeded (5,500 PUT/s per prefix). | Switch the key prefix from `forensic/<tenantId>/<packetId>` to `forensic/<sha256-of-tenantId>/<packetId>` to spread across more S3 partitions. |
| `AccessDenied` | IAM role permissions changed or expired. | Confirm role assume + `s3:PutObject` permission on the bucket. |
| Bucket is over the size budget | Lifecycle policy not configured or too lax. | Apply the standard lifecycle: open packets retained 90d, resolved packets retained 30d, replayed packets retained 7d (see below). |

## Standard S3 lifecycle policy

Apply once per bucket; ratifies the retention windows in plan §F.1.10:

```json
{
  "Rules": [
    {
      "ID": "forensic-open-90d",
      "Status": "Enabled",
      "Filter": { "Tag": { "Key": "packet_state", "Value": "open" } },
      "Expiration": { "Days": 90 }
    },
    {
      "ID": "forensic-resolved-30d",
      "Status": "Enabled",
      "Filter": { "Tag": { "Key": "packet_state", "Value": "resolved" } },
      "Expiration": { "Days": 30 }
    },
    {
      "ID": "forensic-replayed-7d",
      "Status": "Enabled",
      "Filter": { "Tag": { "Key": "packet_state", "Value": "replayed" } },
      "Expiration": { "Days": 7 }
    },
    {
      "ID": "abort-incomplete-multipart-1d",
      "Status": "Enabled",
      "AbortIncompleteMultipartUpload": { "DaysAfterInitiation": 1 }
    }
  ]
}
```

The packet-state tag is set by `S3ForensicPacketStorage.put()` from the packet's `state` field at upload time.

Apply via:

```bash
aws s3api put-bucket-lifecycle-configuration \
  --bucket $OWEIBO_FORENSIC_S3_BUCKET \
  --lifecycle-configuration file://forensic-lifecycle.json
```

## Manual cleanup (emergency only)

If the bucket fills to 100% and the lifecycle policy hasn't taken effect yet:

```bash
# Delete RESOLVED packets older than 30 days.
aws s3api list-objects-v2 --bucket $OWEIBO_FORENSIC_S3_BUCKET \
  --prefix forensic/ \
  --query 'Contents[?LastModified < `2026-04-30T00:00:00Z`].Key' \
  --output text \
  | xargs -I {} aws s3api delete-object --bucket $OWEIBO_FORENSIC_S3_BUCKET --key {}
```

After deleting, set `storage_ref=NULL, state='archived'` on the corresponding DB rows so the admin UI shows "expired" rather than "broken pointer":

```sql
UPDATE oweibo.forensic_packet
   SET storage_ref = NULL, state = 'archived'
 WHERE created_at < NOW() - INTERVAL '90 days'
   AND state = 'resolved';
```

## Escalation

- **15 min** — page Storage on-call if `SlowDown` errors persist after the spread-key mitigation.
- **30 min** — page Security if a severity-5 packet failed to write (these are tier-1 incidents whose forensics are required for postmortem).

## Related dashboards

- Grafana: "Forensic packet storage" — write success rate, S3 latency, bucket size
- CloudWatch: S3 bucket metrics (BytesDownloaded, NumberOfObjects)
