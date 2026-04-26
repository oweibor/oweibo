/**
 * Task 4.6: Gate 9 (ADR Check).
 * Implements 3-state logic (ACTIVE, EMPTY, PHASE2) against architectural decisions.
 * Violations trigger T1 HALT.
 * 
 * @module services/gates/adrCheck
 */

const logger = require('../logger');
const metrics = require('../metrics');
const ollama = require('../ollama/client');
const { wrapUntrusted, SYSTEM_PREAMBLE } = require('../llm/promptSanitize');

/**
 * Evaluate patch against project decisions (ADRs).
 * 
 * @paramtaskId 
 * @paramdecisions - Retrieved promoted ADRs
 * @paramisLibraryDocsLoaded - Phase 2 flag indicator
 * @parampatchDiff - Patch changes
 * @returns
 */
async function evaluateADRs(taskId, decisions, isLibraryDocsLoaded, patchDiff) {
    // State 2: EMPTY (no ADRs exist yet)
    if (!decisions || decisions.length === 0) {
        logger.info('Gate 9 passed vacuously (State: EMPTY - no ADRs enforced)', { task_id: taskId });
        return { passed: true, state: 'EMPTY', violations: [] };
    }

    // State 3: PHASE2 (library docs absent)
    if (!isLibraryDocsLoaded) {
        logger.warn('Gate 9 passed with warning (State: PHASE2 - library docs absent)', { task_id: taskId });
        return { passed: true, state: 'PHASE2', violations: [] }; // Pass but warn
    }

    // State 1: ACTIVE
    logger.info(`Evaluating Gate 9 (${decisions.length} ADRs)`, { task_id: taskId });
    const violations = [];

    for (const adr of decisions) {
        const prompt = `${SYSTEM_PREAMBLE}Given the following patch diff and Architectural Decision Record (ADR), does the patch contradict the ADR? Answer only YES or NO. If YES, briefly state why.

Patch diff:
${wrapUntrusted('patch', patchDiff)}

ADR title: ${wrapUntrusted('adr_title', adr.title)}
ADR decision: ${wrapUntrusted('adr_rationale', adr.rationale)}`;

        const result = await ollama.generate(prompt, 'semantic_check');

        if (result.tripped) {
            logger.warn('Gate 9 bypassed — Ollama Circuit Open', { adr_title: adr.title });
            continue;
        }

        if (result.text.toUpperCase().includes('YES')) {
            metrics.gateFailureCount.inc({ gate: 'G9', tier: 'T1' });
            logger.warn('Gate 9 ADR Contradiction detected', { adr_title: adr.title });
            violations.push(`Contradicts ADR "${adr.title}": ${result.text}`);
        }
    }

    if (violations.length > 0) {
        return { passed: false, state: 'ACTIVE', violations };
    }

    logger.info('Gate 9 passed (State: ACTIVE)', { task_id: taskId });
    return { passed: true, state: 'ACTIVE', violations: [] };
}

module.exports = { evaluateADRs };

export {};
