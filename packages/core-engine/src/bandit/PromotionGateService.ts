// D.9 — PromotionGateService: enforces cohort_promotion_rules before channel promotion.
// Called by BanditService.promoteArm() and the CI gate script.
//
// Gate criteria (§9.4 + §9.5):
//   - soak_days:            arm must have been on from_channel ≥ N days
//   - min_completions:      ≥ N tasks completed using this arm
//   - min_quality_delta:    bandit arm mean reward > stable-v0 arm mean reward + delta
//   - max_safety_violations: 0 (any violation blocks promotion)
//   - requires_human_approval: if true, rejects unless caller passes humanApproved=true

import type { Pool } from 'pg';

export interface PromotionCriteria {
  fromChannel:       string;
  toChannel:         string;
  slotId:            string;
  armId:             string;
  promptHash:        string;
  humanApproved?:    boolean;
}

export interface GateCheck {
  name:    string;
  passed:  boolean;
  message: string;
  required: number | boolean;
  actual:   number | boolean | null;
}

export interface PromotionGateResult {
  allowed:          boolean;
  checks:           GateCheck[];
  blockedBy:        string[];
}

export class PromotionGateService {
  constructor(private readonly pool: Pool) {}

  /**
   * Evaluate all gate checks for a proposed promotion.
   * Returns allowed=true only if every check passes.
   */
  async evaluate(criteria: PromotionCriteria): Promise<PromotionGateResult> {
    const checks: GateCheck[] = [];

    // Load rules from DB
    const rulesResult = await this.pool.query<{
      soak_days:              number;
      min_completions:        number;
      min_quality_delta:      string;
      max_safety_violations:  number;
      requires_human_approval: boolean;
    }>(
      `SELECT soak_days, min_completions, min_quality_delta,
              max_safety_violations, requires_human_approval
       FROM oweibo.cohort_promotion_rules
       WHERE from_channel = $1 AND to_channel = $2`,
      [criteria.fromChannel, criteria.toChannel],
    );

    if (rulesResult.rows.length === 0) {
      return {
        allowed:   false,
        checks:    [{ name: 'rules_exist', passed: false, message: `No promotion rules found for ${criteria.fromChannel} → ${criteria.toChannel}`, required: true, actual: false }],
        blockedBy: ['rules_exist'],
      };
    }

    const rules = rulesResult.rows[0]!;

    // ── Check 1: soak_days ─────────────────────────────────────────────────────
    const soakResult = await this.pool.query<{ days_on_channel: string }>(
      `SELECT EXTRACT(EPOCH FROM (NOW() - MIN(bae.recorded_at))) / 86400 AS days_on_channel
       FROM oweibo.bandit_arm_events bae
       WHERE bae.slot_id = $1 AND bae.arm_id = $2`,
      [criteria.slotId, criteria.armId],
    );
    const daysOnChannel = soakResult.rows[0]?.days_on_channel != null
      ? parseFloat(soakResult.rows[0].days_on_channel)
      : 0;
    const soakPassed = daysOnChannel >= rules.soak_days;
    checks.push({
      name:     'soak_days',
      passed:   soakPassed,
      message:  `Arm has soaked ${daysOnChannel.toFixed(1)}d on ${criteria.fromChannel} (required: ${rules.soak_days}d)`,
      required: rules.soak_days,
      actual:   Math.floor(daysOnChannel),
    });

    // ── Check 2: min_completions ───────────────────────────────────────────────
    const completionsResult = await this.pool.query<{ cnt: string }>(
      `SELECT COUNT(*) AS cnt FROM oweibo.bandit_arm_events
       WHERE slot_id = $1 AND arm_id = $2`,
      [criteria.slotId, criteria.armId],
    );
    const completions = parseInt(completionsResult.rows[0]?.cnt ?? '0', 10);
    const completionsPassed = completions >= rules.min_completions;
    checks.push({
      name:     'min_completions',
      passed:   completionsPassed,
      message:  `${completions} completions (required: ${rules.min_completions})`,
      required: rules.min_completions,
      actual:   completions,
    });

    // ── Check 3: min_quality_delta ─────────────────────────────────────────────
    // Quality delta: (arm mean reward) - (stable-v0 arm mean reward) for this slot
    const qualityResult = await this.pool.query<{ arm_mean: string | null; stable_mean: string | null }>(
      `SELECT
         AVG(CASE WHEN bae.arm_id = $1 THEN bae.reward END) AS arm_mean,
         AVG(CASE WHEN ba.alpha / (ba.alpha + ba.beta) < 0.7 THEN bae.reward END) AS stable_mean
       FROM oweibo.bandit_arm_events bae
       JOIN oweibo.bandit_arms ba ON ba.arm_id = bae.arm_id AND ba.slot_id = bae.slot_id
       WHERE bae.slot_id = $2`,
      [criteria.armId, criteria.slotId],
    );
    const armMean    = parseFloat(qualityResult.rows[0]?.arm_mean    ?? '0');
    const stableMean = parseFloat(qualityResult.rows[0]?.stable_mean ?? '0');
    const qualityDelta = armMean - stableMean;
    const minDelta     = parseFloat(rules.min_quality_delta);
    const qualityPassed = qualityDelta >= minDelta;
    checks.push({
      name:     'min_quality_delta',
      passed:   qualityPassed,
      message:  `Quality delta ${qualityDelta.toFixed(4)} vs stable (required: ≥${minDelta})`,
      required: minDelta,
      actual:   parseFloat(qualityDelta.toFixed(4)),
    });

    // ── Check 4: max_safety_violations ────────────────────────────────────────
    const safetyResult = await this.pool.query<{ cnt: string }>(
      `SELECT COUNT(*) AS cnt
       FROM oweibo.bandit_arm_events bae
       JOIN oweibo.tasks t
         ON t.id::text = bae.task_id
        AND t.executor_assembled_hash = $1
       WHERE bae.slot_id = $2 AND bae.arm_id = $3
         AND bae.reward = 0`,  // reward=0 is a proxy for safety rejection
      [criteria.promptHash, criteria.slotId, criteria.armId],
    );
    const safetyViolations = parseInt(safetyResult.rows[0]?.cnt ?? '0', 10);
    const safetyPassed = safetyViolations <= rules.max_safety_violations;
    checks.push({
      name:     'max_safety_violations',
      passed:   safetyPassed,
      message:  `${safetyViolations} safety violations (max allowed: ${rules.max_safety_violations})`,
      required: rules.max_safety_violations,
      actual:   safetyViolations,
    });

    // ── Check 5: requires_human_approval ──────────────────────────────────────
    if (rules.requires_human_approval) {
      const humanPassed = criteria.humanApproved === true;
      checks.push({
        name:     'human_approval',
        passed:   humanPassed,
        message:  humanPassed ? 'Human approval provided' : `Promotion ${criteria.fromChannel} → ${criteria.toChannel} requires human approval`,
        required: true,
        actual:   criteria.humanApproved ?? false,
      });
    }

    const blockedBy = checks.filter(c => !c.passed).map(c => c.name);
    return { allowed: blockedBy.length === 0, checks, blockedBy };
  }
}
