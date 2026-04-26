/**
 * Task 4.3: Gate 8B (Semantic Invariants).
 * Evaluates semantic invariants against the patch using Ollama.
 * Connects through the Ollama Circuit Breaker to ensure hardware safety.
 *
 * @module services/gates/invariantSemantic
 */

const fs = require('fs');
const path = require('path');
const logger = require('../logger');
const metrics = require('../metrics');
const ollama = require('../ollama/client');
const qdrant = require('../qdrant');
const { wrapUntrusted, SYSTEM_PREAMBLE } = require('../llm/promptSanitize');

/**
 * Evaluate semantic invariants via LLM reasoning.
 * 
 * @paramtaskId
 * @paraminvariants - Invariants with type=='sem'
 * @parampatchDiff - Diff of changes
 * @returns
 */
async function evaluateSemantic(taskId, invariants, patchDiff) {
    if (!invariants || invariants.length === 0) {
        logger.debug('Gate 8B passed vacuously (no semantic invariants)');
        return { passed: true, circuitOpen: false, violations: [], passedInvariantIds: [], failedInvariantIds: [] };
    }

    const activeInvariants = invariants;

    logger.info(`Evaluating Gate 8B (${activeInvariants.length} invariants)`, { task_id: taskId });
    const violations        = [];
    const passedInvariantIds = [];  // IDs of invariants that checked clean (for reinforce)
    const failedInvariantIds = [];  // IDs of invariants that blocked the task (for penalise)
    let circuitTripped = false;

    for (const inv of activeInvariants) {
        const prompt = `${SYSTEM_PREAMBLE}Given the following patch diff and codebase invariant, identify if the patch violates the invariant. Be precise. If it violates the rule, explain how. If not, reply exactly "NO_VIOLATION".

Patch diff:
${wrapUntrusted('patch', patchDiff)}

Codebase invariant:
${wrapUntrusted('rule', inv.rule)}`;

        let result;
        try {
            result = await ollama.generate(prompt, 'semantic_check');
        } catch (genErr) {
            logger.error('Gate 8B ollama.generate threw unexpectedly', { invariant_id: inv.id, error: genErr.message });
            violations.push(`Gate 8B evaluation failed for invariant "${inv.rule}": LLM error`);
            continue;
        }

        if (result.tripped) {
            logger.warn('Gate 8B bypassed — Ollama Circuit Open', { invariant_id: inv.id });
            circuitTripped = true;
            continue;
        }

        const { text } = result;

        if (!text.includes('NO_VIOLATION')) {
            metrics.gateFailureCount.inc({ gate: 'G8B', tier: 'T1' });
            logger.warn('Gate 8B Semantic Violation detected', { invariant_id: inv.id });
            violations.push(`Violation of "${inv.rule}": ${text}`);
            if (inv.id) failedInvariantIds.push(inv.id);

            const quarantineDir = '/var/kilo/quarantine/invariants';
            fs.mkdirSync(quarantineDir, { recursive: true });
            try {
                fs.writeFileSync(
                    path.join(quarantineDir, `${inv.id || 'unknown'}_${taskId}.json`),
                    JSON.stringify({ task_id: taskId, invariant: inv, violation: text, patch: patchDiff }, null, 2)
                );
            } catch (e) {
                logger.error('Failed to write invariant to quarantine', { error: e.message });
            }
        } else {
            // NO_VIOLATION — update hit_count inline; full reinforce happens in index.js
            // after ALL gates pass so we only reinforce truly clean runs.
            if (inv.id) {
                passedInvariantIds.push(inv.id);
                qdrant.updatePayload('project_invariants', inv.id, {
                    hit_count: (inv.hit_count || 0) + 1,
                    last_used_at: new Date().toISOString(),
                }).catch((e) => logger.warn('Gate 8B: failed to update hit_count', { invariant_id: inv.id, error: e.message }));
            }
        }
    }

    if (violations.length > 0) {
        return { passed: false, circuitOpen: circuitTripped, violations, passedInvariantIds, failedInvariantIds };
    }

    if (circuitTripped) {
        return { passed: true, circuitOpen: true, warnings: ['Gate 8B bypassed due to overloaded LLM circuit.'], passedInvariantIds, failedInvariantIds };
    }

    logger.info('Gate 8B passed', { task_id: taskId });
    return { passed: true, circuitOpen: false, violations: [], passedInvariantIds, failedInvariantIds };
}

module.exports = { evaluateSemantic };

export {};
