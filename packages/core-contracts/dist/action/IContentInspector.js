"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.combineVerdicts = combineVerdicts;
/**
 * Combine multiple inspector verdicts into a single decision. Pure
 * helper exported so tests can verify the combine semantics.
 */
function combineVerdicts(verdicts) {
    if (verdicts.length === 0)
        return { verdict: 'allow' };
    // Worst-of: forbid > upgrade_to_approval > allow.
    let worst = { verdict: 'allow' };
    for (const v of verdicts) {
        if (v.verdict === 'forbid')
            return v;
        if (v.verdict === 'upgrade_to_approval' && worst.verdict !== 'upgrade_to_approval') {
            worst = v;
        }
    }
    return worst;
}
//# sourceMappingURL=IContentInspector.js.map