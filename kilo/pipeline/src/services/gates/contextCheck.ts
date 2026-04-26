/**
 * Task 4.7: Gate 10 (Context Consistency Check).
 * Evaluates the patch against the project context. 
 * A contradiction here routes to T2 DESTROY (Error Recovery).
 * 
 * @module services/gates/contextCheck
 */

const logger = require('../logger');
const metrics = require('../metrics');
const ollama = require('../ollama/client');
const { wrapUntrusted, SYSTEM_PREAMBLE } = require('../llm/promptSanitize');

/**
 * Check if the patch contradicts the current context.md base facts.
 * 
 * @paramtaskId 
 * @paramprojectContext - Content of context.md
 * @parampatchDiff - Diff of changes
 * @returns
 */
async function checkConsistency(taskId, projectContext, patchDiff) {
    if (!projectContext) {
        logger.debug('Gate 10 passed vacuously (no context provided)');
        return { passed: true, warning: false, breakdown: '' };
    }

    logger.info('Evaluating Gate 10 (Context Consistency)', { task_id: taskId });

    const prompt = `${SYSTEM_PREAMBLE}Given the following patch diff and established project context, does the patch contradict the project context? Answer YES/NO and cite specific contradictions if they exist.

Patch diff:
${wrapUntrusted('patch', patchDiff)}

Established project context:
${wrapUntrusted('context', projectContext)}`;

    const result = await ollama.generate(prompt, 'semantic_check', projectContext);

    if (result.tripped) {
        logger.warn('Gate 10 bypassed — Ollama Circuit Open');
        return { passed: true, warning: true, breakdown: 'Bypassed due to open LLM circuit.' };
    }

    if (result.text.toUpperCase().startsWith('YES') || result.text.includes('YES,')) {
        metrics.gateFailureCount.inc({ gate: 'G10', tier: 'T2' });
        logger.warn('Gate 10 Context Contradiction detected (T2 DESTROY)', { task_id: taskId });
        return { passed: false, warning: false, breakdown: result.text };
    }

    logger.info('Gate 10 passed', { task_id: taskId });
    return { passed: true, warning: false, breakdown: result.text };
}

module.exports = { checkConsistency };

export {};
