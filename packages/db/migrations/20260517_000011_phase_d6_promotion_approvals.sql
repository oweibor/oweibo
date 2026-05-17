-- Phase D.6 — Human veto / promotion approval log (§9.5).
--
-- Auto-promotion fast→beta is gated by PromotionGateService numeric checks;
-- beta→stable promotion additionally requires a recorded human approval here.
-- The promotions/* admin-web page lists candidates whose only blocker is the
-- human_approval gate and writes one row per approve/reject decision.

CREATE TABLE IF NOT EXISTS oweibo.promotion_approvals (
  id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  arm_id        TEXT         NOT NULL,
  slot_id       TEXT         NOT NULL,
  role          TEXT         NOT NULL,
  from_channel  TEXT         NOT NULL,
  to_channel    TEXT         NOT NULL,
  prompt_hash   TEXT         NOT NULL REFERENCES oweibo.prompt_versions(hash),
  decision      TEXT         NOT NULL CHECK (decision IN ('approved', 'rejected')),
  decided_by    TEXT         NOT NULL,
  decided_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  reason        TEXT         NOT NULL,
  -- Snapshot of the gate result at decision time — preserves auditability
  -- even after underlying tables change.
  gate_snapshot JSONB        NOT NULL
);

-- Lookup: "has this arm already been decided in this direction?"
CREATE INDEX IF NOT EXISTS idx_promotion_approvals_arm
  ON oweibo.promotion_approvals (slot_id, arm_id, from_channel, to_channel, decided_at DESC);

-- Lookup: "show me recent decisions across the whole platform"
CREATE INDEX IF NOT EXISTS idx_promotion_approvals_recent
  ON oweibo.promotion_approvals (decided_at DESC);
