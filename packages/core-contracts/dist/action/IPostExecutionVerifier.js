"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.severityAction = severityAction;
/**
 * Severity → recommended next-step mapping. Pure helper; the orchestrator
 * consults this when deciding whether to auto-rollback or escalate.
 *
 *   sev 0 — observed matches expected; no-op
 *   sev 1 — minor drift; logged + metric, no action
 *   sev 2 — material drift; notify owner + propose rollback (operator decides)
 *   sev 3 — significant drift; auto-rollback if policy allows, else block plan
 */
function severityAction(sev) {
    switch (sev) {
        case 0: return 'noop';
        case 1: return 'log';
        case 2: return 'notify';
        case 3: return 'rollback_or_block';
    }
}
//# sourceMappingURL=IPostExecutionVerifier.js.map