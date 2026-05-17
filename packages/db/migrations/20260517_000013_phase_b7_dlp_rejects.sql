-- Phase B.7 — DLP reject audit log.
--
-- Records every lesson that was rejected by the LessonDLPFilter (regex /
-- entropy / denylist), the semantic confidentiality classifier, the
-- aggregator-side re-DLP gate, the schema validator, or the confidence
-- threshold filter. The privacy-audit admin page surfaces a timeline,
-- per-stage breakdown, and per-tenant tallies from this table.
--
-- Privacy note: we deliberately do NOT store the rejected content. Only
-- the metadata necessary to spot trends + a content_fingerprint (SHA256
-- of the rejected payload) for de-duplication. This is the whole point
-- of DLP — keeping the rejected data out of any platform store.

CREATE TABLE IF NOT EXISTS oweibo.dlp_rejects (
  id                  UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  rejected_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  -- tenant_id MAY be null when the reject happens on the aggregator side
  -- after the tenant id has been stripped (re_dlp_aggregator stage).
  tenant_id           UUID,
  role                TEXT         NOT NULL CHECK (role IN ('architect','executor','reviewer','decomposer')),
  slot_id             TEXT,
  reject_stage        TEXT         NOT NULL CHECK (reject_stage IN (
                        'dlp_regex',
                        'dlp_entropy',
                        'dlp_denylist',
                        'confidentiality_classifier',
                        're_dlp_aggregator',
                        'schema_invalid',
                        'confidence_below_threshold',
                        'eligibility_failed'
                      )),
  reject_reason       TEXT         NOT NULL,
  content_fingerprint TEXT,        -- SHA256 hex (no content)
  worker              TEXT         NOT NULL DEFAULT 'tenant-distillation',  -- 'pattern-aggregator' for re-DLP rejects
  -- Optional: which DLP rule pattern matched (for regex/denylist stages).
  rule_id             TEXT
);

CREATE INDEX IF NOT EXISTS idx_dlp_rejects_recent
  ON oweibo.dlp_rejects (rejected_at DESC);

CREATE INDEX IF NOT EXISTS idx_dlp_rejects_stage
  ON oweibo.dlp_rejects (reject_stage, rejected_at DESC);

CREATE INDEX IF NOT EXISTS idx_dlp_rejects_tenant
  ON oweibo.dlp_rejects (tenant_id, rejected_at DESC)
  WHERE tenant_id IS NOT NULL;

GRANT SELECT, INSERT ON oweibo.dlp_rejects TO oweibo_app;
