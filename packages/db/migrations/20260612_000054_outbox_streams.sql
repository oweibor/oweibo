-- F.6 (ttv-finals): Redis Streams dedup ledger.
--
-- Companion to the OutboxRelay dual-write + tenant-bootstrap-worker
-- XREADGROUP consumer. Records (consumer_group, event_id) tuples the
-- subscriber has processed so re-delivery (XCLAIM after consumer
-- crash, partial-rollout duplicates between deploy-2 and deploy-3) is
-- absorbed at-most-once at the application layer.
--
-- The event_id is the upstream oweibo.outbox.id (UUID, unique per
-- event). Storing as TEXT keeps the table generic — if a future
-- subscriber consumes a different stream whose ids are not UUIDs, the
-- schema doesn't constrain it.
--
-- Retention: rows older than 7 days are pruned by a periodic job
-- (defined in the worker; not a DB trigger). The CHECK on
-- processed_at + the PRIMARY KEY are the only invariants the schema
-- enforces.
--
-- Cross-tenant by nature (lifecycle events): no RLS, no tenant_id.
-- platform_admin role grants writes; other roles get read-only.

BEGIN;

CREATE TABLE IF NOT EXISTS oweibo.processed_outbox_events (
  consumer_group TEXT         NOT NULL,
  event_id       TEXT         NOT NULL,
  processed_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  PRIMARY KEY (consumer_group, event_id)
);

CREATE INDEX IF NOT EXISTS idx_processed_outbox_events_processed_at
  ON oweibo.processed_outbox_events (processed_at);

GRANT SELECT ON oweibo.processed_outbox_events TO oweibo_app;
GRANT INSERT, DELETE ON oweibo.processed_outbox_events TO oweibo_app;

COMMIT;

DO $$
BEGIN
  RAISE NOTICE 'F.6 processed_outbox_events ledger installed.';
END;
$$;
