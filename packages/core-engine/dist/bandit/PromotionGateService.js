"use strict";
// D.9 — PromotionGateService: enforces cohort_promotion_rules before channel promotion.
// Called by BanditService.promoteArm() and the CI gate script.
//
// Gate criteria (§9.4 + §9.5):
//   - soak_days:            arm must have been on from_channel ≥ N days
//   - min_completions:      ≥ N tasks completed using this arm
//   - min_quality_delta:    bandit arm mean reward > stable-v0 arm mean reward + delta
//   - max_safety_violations: 0 (any violation blocks promotion)
//   - requires_human_approval: if true, rejects unless caller passes humanApproved=true
Object.defineProperty(exports, "__esModule", { value: true });
exports.PromotionGateService = void 0;
class PromotionGateService {
    pool;
    bandit;
    constructor(pool, 
    /** Optional — required only for `recordDecision({decision:'approved'})`. */
    bandit) {
        this.pool = pool;
        this.bandit = bandit;
    }
    /**
     * Evaluate all gate checks for a proposed promotion.
     * Returns allowed=true only if every check passes.
     */
    async evaluate(criteria) {
        const checks = [];
        // Load rules from DB
        const rulesResult = await this.pool.query(`SELECT soak_days, min_completions, min_quality_delta,
              max_safety_violations, requires_human_approval
       FROM oweibo.cohort_promotion_rules
       WHERE from_channel = $1 AND to_channel = $2`, [criteria.fromChannel, criteria.toChannel]);
        if (rulesResult.rows.length === 0) {
            return {
                allowed: false,
                checks: [{ name: 'rules_exist', passed: false, message: `No promotion rules found for ${criteria.fromChannel} → ${criteria.toChannel}`, required: true, actual: false }],
                blockedBy: ['rules_exist'],
            };
        }
        const rules = rulesResult.rows[0];
        // ── Check 1: soak_days ─────────────────────────────────────────────────────
        const soakResult = await this.pool.query(`SELECT EXTRACT(EPOCH FROM (NOW() - MIN(bae.recorded_at))) / 86400 AS days_on_channel
       FROM oweibo.bandit_arm_events bae
       WHERE bae.slot_id = $1 AND bae.arm_id = $2`, [criteria.slotId, criteria.armId]);
        const daysOnChannel = soakResult.rows[0]?.days_on_channel != null
            ? parseFloat(soakResult.rows[0].days_on_channel)
            : 0;
        const soakPassed = daysOnChannel >= rules.soak_days;
        checks.push({
            name: 'soak_days',
            passed: soakPassed,
            message: `Arm has soaked ${daysOnChannel.toFixed(1)}d on ${criteria.fromChannel} (required: ${rules.soak_days}d)`,
            required: rules.soak_days,
            actual: Math.floor(daysOnChannel),
        });
        // ── Check 2: min_completions ───────────────────────────────────────────────
        const completionsResult = await this.pool.query(`SELECT COUNT(*) AS cnt FROM oweibo.bandit_arm_events
       WHERE slot_id = $1 AND arm_id = $2`, [criteria.slotId, criteria.armId]);
        const completions = parseInt(completionsResult.rows[0]?.cnt ?? '0', 10);
        const completionsPassed = completions >= rules.min_completions;
        checks.push({
            name: 'min_completions',
            passed: completionsPassed,
            message: `${completions} completions (required: ${rules.min_completions})`,
            required: rules.min_completions,
            actual: completions,
        });
        // ── Check 3: min_quality_delta ─────────────────────────────────────────────
        // Quality delta: (arm mean reward) - (stable-v0 arm mean reward) for this slot
        const qualityResult = await this.pool.query(`SELECT
         AVG(CASE WHEN bae.arm_id = $1 THEN bae.reward END) AS arm_mean,
         AVG(CASE WHEN ba.alpha / (ba.alpha + ba.beta) < 0.7 THEN bae.reward END) AS stable_mean
       FROM oweibo.bandit_arm_events bae
       JOIN oweibo.bandit_arms ba ON ba.arm_id = bae.arm_id AND ba.slot_id = bae.slot_id
       WHERE bae.slot_id = $2`, [criteria.armId, criteria.slotId]);
        const armMean = parseFloat(qualityResult.rows[0]?.arm_mean ?? '0');
        const stableMean = parseFloat(qualityResult.rows[0]?.stable_mean ?? '0');
        const qualityDelta = armMean - stableMean;
        const minDelta = parseFloat(rules.min_quality_delta);
        const qualityPassed = qualityDelta >= minDelta;
        checks.push({
            name: 'min_quality_delta',
            passed: qualityPassed,
            message: `Quality delta ${qualityDelta.toFixed(4)} vs stable (required: ≥${minDelta})`,
            required: minDelta,
            actual: parseFloat(qualityDelta.toFixed(4)),
        });
        // ── Check 4: max_safety_violations ────────────────────────────────────────
        const safetyResult = await this.pool.query(`SELECT COUNT(*) AS cnt
       FROM oweibo.bandit_arm_events bae
       JOIN oweibo.tasks t
         ON t.id::text = bae.task_id
        AND t.executor_assembled_hash = $1
       WHERE bae.slot_id = $2 AND bae.arm_id = $3
         AND bae.reward = 0`, // reward=0 is a proxy for safety rejection
        [criteria.promptHash, criteria.slotId, criteria.armId]);
        const safetyViolations = parseInt(safetyResult.rows[0]?.cnt ?? '0', 10);
        const safetyPassed = safetyViolations <= rules.max_safety_violations;
        checks.push({
            name: 'max_safety_violations',
            passed: safetyPassed,
            message: `${safetyViolations} safety violations (max allowed: ${rules.max_safety_violations})`,
            required: rules.max_safety_violations,
            actual: safetyViolations,
        });
        // ── Check 5: requires_human_approval ──────────────────────────────────────
        if (rules.requires_human_approval) {
            const humanPassed = criteria.humanApproved === true;
            checks.push({
                name: 'human_approval',
                passed: humanPassed,
                message: humanPassed ? 'Human approval provided' : `Promotion ${criteria.fromChannel} → ${criteria.toChannel} requires human approval`,
                required: true,
                actual: criteria.humanApproved ?? false,
            });
        }
        const blockedBy = checks.filter(c => !c.passed).map(c => c.name);
        return { allowed: blockedBy.length === 0, checks, blockedBy };
    }
    /**
     * List arms whose only remaining blocker is the human_approval gate
     * (i.e. promotion would succeed if a human approves now).
     *
     * Scans every (from,to) channel pair whose rule has `requires_human_approval=true`,
     * for every arm currently active on the from-channel that hasn't already been
     * decided (approved OR rejected) in this direction. Default: beta→stable.
     */
    async listPending() {
        // Find every promotion direction that requires human approval
        const dirRes = await this.pool.query(`SELECT from_channel, to_channel
       FROM oweibo.cohort_promotion_rules
       WHERE requires_human_approval = TRUE`);
        if (dirRes.rowCount === 0)
            return [];
        const pending = [];
        for (const dir of dirRes.rows) {
            // Active arms on the from-channel
            const armsRes = await this.pool.query(`SELECT arm_id, slot_id, prompt_hash
         FROM oweibo.bandit_arms
         WHERE channel = $1 AND active = TRUE
         ORDER BY slot_id, arm_id`, [dir.from_channel]);
            for (const arm of armsRes.rows) {
                // Skip arms already decided in this direction
                const decidedRes = await this.pool.query(`SELECT COUNT(*) AS cnt FROM oweibo.promotion_approvals
           WHERE slot_id = $1 AND arm_id = $2
             AND from_channel = $3 AND to_channel = $4`, [arm.slot_id, arm.arm_id, dir.from_channel, dir.to_channel]);
                if (parseInt(decidedRes.rows[0]?.cnt ?? '0', 10) > 0)
                    continue;
                // Lookup the role for this slot
                const roleRes = await this.pool.query(`SELECT role FROM oweibo.prompt_versions WHERE hash = $1 LIMIT 1`, [arm.prompt_hash]);
                const role = (roleRes.rows[0]?.role ?? 'architect');
                // Run gates with humanApproved=true to see if the only blocker is the human gate
                const result = await this.evaluate({
                    fromChannel: dir.from_channel,
                    toChannel: dir.to_channel,
                    slotId: arm.slot_id,
                    armId: arm.arm_id,
                    promptHash: arm.prompt_hash,
                    humanApproved: true,
                });
                // Surface candidates that would promote if approved (allowed=true with humanApproved=true)
                // AND candidates blocked only on human_approval when humanApproved=false (so reviewer sees both states)
                const withoutApproval = await this.evaluate({
                    fromChannel: dir.from_channel,
                    toChannel: dir.to_channel,
                    slotId: arm.slot_id,
                    armId: arm.arm_id,
                    promptHash: arm.prompt_hash,
                    humanApproved: false,
                });
                const onlyBlockerIsHuman = withoutApproval.blockedBy.length === 1 &&
                    withoutApproval.blockedBy[0] === 'human_approval';
                if (!result.allowed && !onlyBlockerIsHuman)
                    continue;
                pending.push({
                    armId: arm.arm_id,
                    slotId: arm.slot_id,
                    role,
                    promptHash: arm.prompt_hash,
                    fromChannel: dir.from_channel,
                    toChannel: dir.to_channel,
                    gateResult: result,
                    priorDecisions: [], // none — we filtered them out above
                });
            }
        }
        return pending;
    }
    /**
     * Record a human approve/reject decision and, on approve, flip the channel pointer.
     *
     * Approval path: re-evaluates gates with `humanApproved=true`; if all pass,
     * calls BanditService.promoteArm() (optimistic-lock on channels.version) then
     * writes the decision row. Throws if BanditService wasn't provided or if the
     * gate would still block for non-human reasons.
     *
     * Rejection path: writes the decision row without touching channels.
     * The same arm can later become eligible again — the rejection is just an
     * audit record that prevents re-surfacing this candidate in listPending().
     */
    async recordDecision(input) {
        const gateResult = await this.evaluate({
            fromChannel: input.fromChannel,
            toChannel: input.toChannel,
            slotId: input.slotId,
            armId: input.armId,
            promptHash: input.promptHash,
            humanApproved: input.decision === 'approved',
        });
        if (input.decision === 'approved') {
            if (!gateResult.allowed) {
                // Gate still blocks for reasons other than human approval — do not record or promote
                return { ok: false, gateResult };
            }
            if (!this.bandit) {
                throw new Error('PromotionGateService.recordDecision: BanditService required for approval');
            }
            // Read current channel version for the optimistic lock
            const verRes = await this.pool.query(`SELECT version FROM oweibo.channels
         WHERE name = $1 AND role = $2 AND slot_id = $3`, [input.toChannel, input.role, input.slotId]);
            const version = BigInt(verRes.rows[0]?.version ?? '0');
            const promoted = await this.bandit.promoteArm({
                role: input.role,
                slotId: input.slotId,
                channel: input.toChannel,
                promptHash: input.promptHash,
                currentVersion: version,
                updatedBy: input.decidedBy,
            });
            if (!promoted) {
                // Lost the optimistic lock — the channel changed under us; do not record
                throw new Error(`PromotionGateService.recordDecision: channel ${input.toChannel}/${input.role}/${input.slotId} changed concurrently — refresh and retry`);
            }
        }
        await this.pool.query(`INSERT INTO oweibo.promotion_approvals
         (arm_id, slot_id, role, from_channel, to_channel, prompt_hash,
          decision, decided_by, reason, gate_snapshot)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [
            input.armId, input.slotId, input.role,
            input.fromChannel, input.toChannel, input.promptHash,
            input.decision, input.decidedBy, input.reason,
            JSON.stringify(gateResult),
        ]);
        return { ok: true, gateResult };
    }
    /** Most-recent decisions, newest first. Used by the admin-web history panel. */
    async listRecentDecisions(limit = 50) {
        const res = await this.pool.query(`SELECT id, arm_id, slot_id, role, from_channel, to_channel, prompt_hash,
              decision, decided_by, decided_at, reason
       FROM oweibo.promotion_approvals
       ORDER BY decided_at DESC
       LIMIT $1`, [limit]);
        return res.rows.map(r => ({
            id: r.id,
            armId: r.arm_id,
            slotId: r.slot_id,
            role: r.role,
            fromChannel: r.from_channel,
            toChannel: r.to_channel,
            promptHash: r.prompt_hash,
            decision: r.decision,
            decidedBy: r.decided_by,
            decidedAt: r.decided_at,
            reason: r.reason,
        }));
    }
}
exports.PromotionGateService = PromotionGateService;
//# sourceMappingURL=PromotionGateService.js.map