"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.canonicalActionId = canonicalActionId;
/**
 * T.−1: IActionGate — the gate every real-world action passes through.
 *
 * Wrap an execution call with `await actionGate.gate(ctx)`. The returned
 * decision indicates whether to execute live, record a dry-run proposal,
 * route to a shadow target, request approval, or block outright.
 *
 * With the action_trust_ladder.enabled feature flag off, `gate()` returns
 * { mode: 'execute' } deterministically — behavior is byte-identical to
 * the pre-T.−1 codepath.
 */
const crypto_1 = require("crypto");
/**
 * Audit-fix (T.−1 #3): the canonical reference implementation every
 * action-issuing tool (kilo-pipeline, browser-tool, channel-gateway, ...)
 * MUST use to compute `ActionContext.actionId`. Centralizing the
 * computation here means:
 *
 *   - the (tenant_id, action_id) UNIQUE on action_proposals reliably
 *     dedupes retries of the same logical action
 *   - two different issuers can't accidentally collide on the same id
 *     for semantically-different actions (because originatingTaskId +
 *     stepNumber differ)
 *   - a retry after a transient failure produces the same id as long as
 *     the inputs are reproducible
 *
 * Inputs:
 *   - tenantId            — already namespaces the id; required
 *   - actionClass         — required; trust-ladder uses it for classification
 *   - payload             — JSON-serializable; canonicalized below before hashing
 *   - originatingTaskId   — the agent task that emitted this action;
 *                           use a stable per-task uuid, not per-attempt
 *   - stepNumber          — 0-based action index within the task;
 *                           differentiates per-action within one task
 *
 * Output: 32-character hex prefix of SHA-256(canonicalForm). The prefix
 * is long enough to keep collision probability negligible (~2^-64 over
 * 32 chars) while staying under the 64-char column constraint on
 * action_proposals.action_id.
 */
function canonicalActionId(args) {
    const payloadHash = (0, crypto_1.createHash)('sha256')
        .update(canonicalJson(args.payload))
        .digest('hex');
    const canonical = [
        args.tenantId,
        args.actionClass,
        args.originatingTaskId,
        String(args.stepNumber),
        payloadHash,
    ].join('\x1f'); // \x1f = ASCII unit separator; not legal in any field
    return (0, crypto_1.createHash)('sha256').update(canonical).digest('hex').slice(0, 32);
}
/**
 * Deterministic JSON serialization: keys sorted at every object level
 * so `{a: 1, b: 2}` and `{b: 2, a: 1}` hash identically.
 */
function canonicalJson(value) {
    if (value === null || value === undefined)
        return 'null';
    if (typeof value !== 'object')
        return JSON.stringify(value);
    if (Array.isArray(value)) {
        return '[' + value.map(canonicalJson).join(',') + ']';
    }
    const obj = value;
    const keys = Object.keys(obj).sort();
    return '{' + keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',') + '}';
}
//# sourceMappingURL=IActionGate.js.map