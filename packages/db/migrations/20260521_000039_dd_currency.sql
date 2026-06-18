-- D.7 (domain-depth): domain-knowledge currency.
--
-- Two surfaces:
--   * domain_artifact_currency — per-artifact freshness window + refresh
--     policy. Auto-supersede trigger flips prior `current` rows when a
--     newer version of the same (kind, slug) is inserted.
--   * regulatory_feed_items   — raw regulatory updates pulled by feed
--     adapters; awaiting SME review (D.5 surfaces these as
--     'regulatory_feed_item' queue items).
--
-- Platform-curated: cross-tenant. Reads open via read_any; writes
-- restricted to platform_admin.

CREATE TABLE IF NOT EXISTS oweibo.domain_artifact_currency (
  artifact_kind    TEXT         NOT NULL CHECK (artifact_kind IN ('ontology_pack','eval_rubric','compliance_rule_pack','classifier')),
  artifact_id      TEXT         NOT NULL,
  domain_slug      TEXT         REFERENCES oweibo.domain_catalog(slug),
  valid_from       TIMESTAMPTZ  NOT NULL,
  valid_until      TIMESTAMPTZ  NOT NULL,
  refresh_policy   TEXT         NOT NULL CHECK (refresh_policy IN ('manual','annual_review','feed_driven')),
  -- Cadence at which feed_driven artifacts pull updates. NULL for
  -- non-feed-driven. DomainCurrencyMonitor skips a feed whose
  -- last_successful_at is within refresh_interval/4 to avoid hot-loop
  -- on partial failures.
  refresh_interval INTERVAL,
  feed_refs        TEXT[]       NOT NULL DEFAULT '{}',
  state            TEXT         NOT NULL DEFAULT 'current'
                                  CHECK (state IN ('current','expiring_soon','expired','superseded')),
  superseded_by    TEXT,
  last_state_transition TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (artifact_kind, artifact_id),
  CONSTRAINT refresh_interval_only_when_feed_driven
    CHECK ((refresh_policy = 'feed_driven') = (refresh_interval IS NOT NULL))
);

ALTER TABLE oweibo.domain_artifact_currency ENABLE ROW LEVEL SECURITY;
ALTER TABLE oweibo.domain_artifact_currency FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS read_any ON oweibo.domain_artifact_currency;
CREATE POLICY read_any ON oweibo.domain_artifact_currency FOR SELECT USING (true);

DROP POLICY IF EXISTS platform_admin_write ON oweibo.domain_artifact_currency;
CREATE POLICY platform_admin_write ON oweibo.domain_artifact_currency
  FOR ALL USING (current_setting('app.is_platform_admin', true) = 'true');

GRANT SELECT ON oweibo.domain_artifact_currency TO oweibo_app;

CREATE INDEX IF NOT EXISTS idx_domain_artifact_currency_expiring
  ON oweibo.domain_artifact_currency (valid_until)
  WHERE state IN ('current','expiring_soon');

-- ── Auto-supersede trigger ──────────────────────────────────────────────
-- When a newer artifact_id is inserted for the same (artifact_kind,
-- domain_slug), flip prior 'current' / 'expiring_soon' / 'expired' rows
-- to 'superseded' and set their superseded_by pointer.
CREATE OR REPLACE FUNCTION oweibo.mark_prior_artifact_superseded() RETURNS trigger AS $$
BEGIN
  UPDATE oweibo.domain_artifact_currency
     SET state                 = 'superseded',
         superseded_by         = NEW.artifact_id,
         last_state_transition = NOW()
   WHERE artifact_kind = NEW.artifact_kind
     AND domain_slug IS NOT DISTINCT FROM NEW.domain_slug
     AND artifact_id <> NEW.artifact_id
     AND state IN ('current','expiring_soon','expired');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_mark_prior_artifact_superseded ON oweibo.domain_artifact_currency;
CREATE TRIGGER trg_mark_prior_artifact_superseded
  AFTER INSERT ON oweibo.domain_artifact_currency
  FOR EACH ROW EXECUTE FUNCTION oweibo.mark_prior_artifact_superseded();

-- ── regulatory_feed_items ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS oweibo.regulatory_feed_items (
  id                UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  feed_id           TEXT         NOT NULL,
  update_id         TEXT         NOT NULL,
  domain_slug       TEXT         REFERENCES oweibo.domain_catalog(slug),
  published_at      TIMESTAMPTZ  NOT NULL,
  title             TEXT         NOT NULL,
  summary           TEXT         NOT NULL,
  source_url        TEXT         NOT NULL,
  impact_area       TEXT         NOT NULL CHECK (impact_area IN ('rule_pack','ontology','rubric')),
  suggested_targets TEXT[]       NOT NULL DEFAULT '{}',
  review_state      TEXT         NOT NULL DEFAULT 'pending'
                                  CHECK (review_state IN ('pending','reviewed','dismissed','incorporated')),
  ingested_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE (feed_id, update_id)
);

ALTER TABLE oweibo.regulatory_feed_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE oweibo.regulatory_feed_items FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS read_any ON oweibo.regulatory_feed_items;
CREATE POLICY read_any ON oweibo.regulatory_feed_items FOR SELECT USING (true);

DROP POLICY IF EXISTS platform_admin_write ON oweibo.regulatory_feed_items;
CREATE POLICY platform_admin_write ON oweibo.regulatory_feed_items
  FOR ALL USING (current_setting('app.is_platform_admin', true) = 'true');

GRANT SELECT ON oweibo.regulatory_feed_items TO oweibo_app;

CREATE INDEX IF NOT EXISTS idx_regulatory_feed_items_pending
  ON oweibo.regulatory_feed_items (domain_slug, ingested_at DESC)
  WHERE review_state = 'pending';

-- ── domain_feed_health ──────────────────────────────────────────────────
-- Per-feed health: when did it last succeed, last fail. The monitor
-- consults this to skip feeds whose last_successful_at is within
-- refresh_interval/4 (avoids hot-loop on partial failures).
CREATE TABLE IF NOT EXISTS oweibo.domain_feed_health (
  feed_id              TEXT         PRIMARY KEY,
  last_attempted_at    TIMESTAMPTZ,
  last_successful_at   TIMESTAMPTZ,
  last_error           TEXT,
  consecutive_failures INTEGER      NOT NULL DEFAULT 0
);

ALTER TABLE oweibo.domain_feed_health ENABLE ROW LEVEL SECURITY;
ALTER TABLE oweibo.domain_feed_health FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS read_any ON oweibo.domain_feed_health;
CREATE POLICY read_any ON oweibo.domain_feed_health FOR SELECT USING (true);

DROP POLICY IF EXISTS platform_admin_write ON oweibo.domain_feed_health;
CREATE POLICY platform_admin_write ON oweibo.domain_feed_health
  FOR ALL USING (current_setting('app.is_platform_admin', true) = 'true');

GRANT SELECT ON oweibo.domain_feed_health TO oweibo_app;

DO $$
BEGIN
  RAISE NOTICE 'D.7 domain currency schema installed.';
END;
$$;
