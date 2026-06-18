-- D.5 (domain-depth): SME review loop schema.
--
-- Five tables + a dedicated DB role:
--
--   * sme_reviewers           — platform-scoped identity surface
--   * sme_credentials         — per-(reviewer, domain) credential
--   * sme_review_queue        — sampled artifacts awaiting review
--   * sme_reviews             — per-reviewer review submissions
--   * sme_aggregated_feedback — platform-team-facing aggregations
--
-- SMEs are NOT bound to any tenant — many are external contractors.
-- Visibility is therefore scoped by (a) the reviewer's own user_id
-- (via SET LOCAL app.user_id) and (b) their active sme_credentials
-- domain memberships, rather than by tenant_id.

-- ── DB role ─────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oweibo_sme_reviewer') THEN
    CREATE ROLE oweibo_sme_reviewer NOINHERIT;
  END IF;
END $$;

-- ── sme_reviewers ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS oweibo.sme_reviewers (
  id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  email        TEXT         NOT NULL UNIQUE,
  display_name TEXT         NOT NULL,
  auth_subject TEXT         NOT NULL UNIQUE,
  kind         TEXT         NOT NULL CHECK (kind IN ('platform_employee','contracted_sme','partner_org_sme')),
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  disabled_at  TIMESTAMPTZ
);

ALTER TABLE oweibo.sme_reviewers ENABLE ROW LEVEL SECURITY;
ALTER TABLE oweibo.sme_reviewers FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS platform_admin_all ON oweibo.sme_reviewers;
CREATE POLICY platform_admin_all ON oweibo.sme_reviewers
  FOR ALL USING (current_setting('app.is_platform_admin', true) = 'true');

DROP POLICY IF EXISTS reviewer_self_read ON oweibo.sme_reviewers;
CREATE POLICY reviewer_self_read ON oweibo.sme_reviewers
  FOR SELECT USING (id::text = current_setting('app.user_id', true));

GRANT SELECT, INSERT, UPDATE ON oweibo.sme_reviewers TO oweibo_app;
GRANT SELECT ON oweibo.sme_reviewers TO oweibo_sme_reviewer;

-- ── sme_credentials ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS oweibo.sme_credentials (
  reviewer_id      UUID         NOT NULL REFERENCES oweibo.sme_reviewers(id) ON DELETE CASCADE,
  domain_slug      TEXT         NOT NULL REFERENCES oweibo.domain_catalog(slug),
  credentials_kind TEXT         NOT NULL,
  -- validated_by references oweibo.users (a platform_admin user). Nullable
  -- because seed/test data may pre-validate without a known admin row.
  validated_by     UUID,
  validated_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  revoked_at       TIMESTAMPTZ,
  PRIMARY KEY (reviewer_id, domain_slug)
);

ALTER TABLE oweibo.sme_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE oweibo.sme_credentials FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS platform_admin_all ON oweibo.sme_credentials;
CREATE POLICY platform_admin_all ON oweibo.sme_credentials
  FOR ALL USING (current_setting('app.is_platform_admin', true) = 'true');

DROP POLICY IF EXISTS reviewer_self_read ON oweibo.sme_credentials;
CREATE POLICY reviewer_self_read ON oweibo.sme_credentials
  FOR SELECT USING (
    reviewer_id::text = current_setting('app.user_id', true)
    AND revoked_at IS NULL
  );

GRANT SELECT, INSERT, UPDATE ON oweibo.sme_credentials TO oweibo_app;
GRANT SELECT ON oweibo.sme_credentials TO oweibo_sme_reviewer;

CREATE INDEX IF NOT EXISTS idx_sme_credentials_active
  ON oweibo.sme_credentials (domain_slug)
  WHERE revoked_at IS NULL;

-- ── sme_review_queue ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS oweibo.sme_review_queue (
  id                 UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  domain_slug        TEXT         NOT NULL REFERENCES oweibo.domain_catalog(slug),
  tenant_id          UUID         NOT NULL REFERENCES oweibo.tenants(id) ON DELETE CASCADE,
  task_id            UUID,
  artifact_kind      TEXT         NOT NULL
                                   CHECK (artifact_kind IN (
                                     'task_output',
                                     'rubric_evaluation',
                                     'compliance_decision',
                                     'regulatory_feed_item'
                                   )),
  artifact_ref       JSONB        NOT NULL,
  anonymized_payload JSONB        NOT NULL,
  state              TEXT         NOT NULL DEFAULT 'pending'
                                   CHECK (state IN ('pending','assigned','reviewed','aggregated','closed')),
  required_reviews   INTEGER      NOT NULL DEFAULT 2,
  sampled_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  closed_at          TIMESTAMPTZ
);

ALTER TABLE oweibo.sme_review_queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE oweibo.sme_review_queue FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS platform_admin_all ON oweibo.sme_review_queue;
CREATE POLICY platform_admin_all ON oweibo.sme_review_queue
  FOR ALL USING (current_setting('app.is_platform_admin', true) = 'true');

DROP POLICY IF EXISTS reviewer_domain_scope ON oweibo.sme_review_queue;
CREATE POLICY reviewer_domain_scope ON oweibo.sme_review_queue
  FOR SELECT USING (
    domain_slug IN (
      SELECT c.domain_slug FROM oweibo.sme_credentials c
      WHERE c.reviewer_id::text = current_setting('app.user_id', true)
        AND c.revoked_at IS NULL
    )
  );

GRANT SELECT, INSERT, UPDATE ON oweibo.sme_review_queue TO oweibo_app;
GRANT SELECT, UPDATE (state, closed_at) ON oweibo.sme_review_queue TO oweibo_sme_reviewer;

CREATE INDEX IF NOT EXISTS idx_sme_review_queue_open
  ON oweibo.sme_review_queue (domain_slug, sampled_at DESC)
  WHERE state IN ('pending','assigned');

-- ── sme_reviews ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS oweibo.sme_reviews (
  id                   UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  queue_item_id        UUID         NOT NULL REFERENCES oweibo.sme_review_queue(id) ON DELETE CASCADE,
  reviewer_id          UUID         NOT NULL REFERENCES oweibo.sme_reviewers(id),
  overall_verdict      TEXT         NOT NULL CHECK (overall_verdict IN ('correct','partially_correct','incorrect','out_of_scope')),
  per_criterion        JSONB        NOT NULL DEFAULT '[]',
  ontology_suggestions JSONB        NOT NULL DEFAULT '[]',
  rubric_suggestions   JSONB        NOT NULL DEFAULT '[]',
  rule_suggestions     JSONB        NOT NULL DEFAULT '[]',
  comment              TEXT,
  reviewed_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE (queue_item_id, reviewer_id)
);

ALTER TABLE oweibo.sme_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE oweibo.sme_reviews FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS platform_admin_all ON oweibo.sme_reviews;
CREATE POLICY platform_admin_all ON oweibo.sme_reviews
  FOR ALL USING (current_setting('app.is_platform_admin', true) = 'true');

DROP POLICY IF EXISTS reviewer_insert_own ON oweibo.sme_reviews;
CREATE POLICY reviewer_insert_own ON oweibo.sme_reviews
  FOR INSERT WITH CHECK (
    reviewer_id::text = current_setting('app.user_id', true)
    AND queue_item_id IN (
      SELECT q.id FROM oweibo.sme_review_queue q
      WHERE q.domain_slug IN (
        SELECT c.domain_slug FROM oweibo.sme_credentials c
        WHERE c.reviewer_id::text = current_setting('app.user_id', true)
          AND c.revoked_at IS NULL
      )
    )
  );

DROP POLICY IF EXISTS reviewer_select_own ON oweibo.sme_reviews;
CREATE POLICY reviewer_select_own ON oweibo.sme_reviews
  FOR SELECT USING (reviewer_id::text = current_setting('app.user_id', true));

GRANT SELECT, INSERT, UPDATE ON oweibo.sme_reviews TO oweibo_app;
GRANT SELECT, INSERT ON oweibo.sme_reviews TO oweibo_sme_reviewer;

CREATE INDEX IF NOT EXISTS idx_sme_reviews_queue ON oweibo.sme_reviews (queue_item_id);

-- ── sme_aggregated_feedback ─────────────────────────────────────────────
-- Platform-team-only surface; reviewers never see aggregations.
CREATE TABLE IF NOT EXISTS oweibo.sme_aggregated_feedback (
  id               UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  domain_slug      TEXT         NOT NULL REFERENCES oweibo.domain_catalog(slug),
  target_kind      TEXT         NOT NULL CHECK (target_kind IN ('ontology_glossary','ontology_entity','rubric_criterion','compliance_rule','classifier_weight')),
  target_id        TEXT         NOT NULL,
  suggested_change JSONB        NOT NULL,
  reviewer_count   INTEGER      NOT NULL,
  agreement_ratio  NUMERIC(4,3) NOT NULL CHECK (agreement_ratio BETWEEN 0 AND 1),
  state            TEXT         NOT NULL DEFAULT 'pending_review'
                                CHECK (state IN ('pending_review','approved','rejected','superseded')),
  reviewed_by      UUID,
  reviewed_at      TIMESTAMPTZ,
  decision_reason  TEXT,
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

ALTER TABLE oweibo.sme_aggregated_feedback ENABLE ROW LEVEL SECURITY;
ALTER TABLE oweibo.sme_aggregated_feedback FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS platform_admin_all ON oweibo.sme_aggregated_feedback;
CREATE POLICY platform_admin_all ON oweibo.sme_aggregated_feedback
  FOR ALL USING (current_setting('app.is_platform_admin', true) = 'true');

GRANT SELECT, INSERT, UPDATE ON oweibo.sme_aggregated_feedback TO oweibo_app;

CREATE INDEX IF NOT EXISTS idx_sme_aggregated_pending
  ON oweibo.sme_aggregated_feedback (domain_slug, created_at DESC)
  WHERE state = 'pending_review';

DO $$
BEGIN
  RAISE NOTICE 'D.5 SME review schema installed.';
END;
$$;
