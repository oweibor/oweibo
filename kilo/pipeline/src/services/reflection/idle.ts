/**
 * Idle-Time Self-Reflection.
 *
 * When the task queue is empty, this module reads the quarantine/tasks/
 * directory, groups the richer failure payloads (written by convergence.js),
 * sends a batch to Ollama for pattern analysis, and writes any synthesised
 * rules as new staging items for the Promotion Engine to evaluate.
 *
 * Key design decisions:
 *   - Only runs when queue is truly idle (0 running + 0 pending).
 *   - Processes at most REFLECTION_BATCH_SIZE quarantine items per run
 *     to bound LLM token usage on low-power hardware.
 *   - Respects the Ollama Circuit Breaker — skips silently when OPEN.
 *   - Moves processed quarantine files to quarantine/analyzed/ so they
 *     are not re-processed on the next idle cycle.
 *   - A semaphore (isRunning flag) prevents concurrent reflection runs.
 *
 * @module services/reflection/idle
 */

const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const logger = require('../logger');
const config = require('../../config');
const ollama = require('../ollama/client');
const { wrapUntrusted, SYSTEM_PREAMBLE } = require('../llm/promptSanitize');

const QUARANTINE_TASKS_DIR = '/var/kilo/quarantine/tasks';
const QUARANTINE_ANALYZED_DIR = '/var/kilo/quarantine/analyzed';

/** Prevent concurrent reflection runs */
let isRunning = false;

/**
 * Check whether the queue is currently idle.
 * Accepts the queue singleton as a parameter to avoid a circular require.
 *
 * @paramqueue - The TaskQueue singleton from services/queue
 * @returns
 */
function queueIsIdle(queue) {
    return queue.runningCount === 0 && queue.size === 0;
}

/**
 * Read up to batchSize quarantine task files that have not yet been analyzed.
 *
 * @parambatchSize
 * @returnsArray of parsed quarantine payloads
 */
function loadQuarantineBatch(batchSize) {
    if (!fs.existsSync(QUARANTINE_TASKS_DIR)) return [];

    const files = fs.readdirSync(QUARANTINE_TASKS_DIR)
        .filter((f) => f.endsWith('.json'))
        .slice(0, batchSize);

    const items = [];
    for (const file of files) {
        try {
            const raw = fs.readFileSync(path.join(QUARANTINE_TASKS_DIR, file), 'utf8');
            const parsed = JSON.parse(raw);
            parsed._source_file = file;
            items.push(parsed);
        } catch (e) {
            logger.warn('Reflection: could not parse quarantine file', { file, error: e.message });
        }
    }
    return items;
}

/**
 * Move a quarantine file to the analyzed/ subdirectory so it is not
 * re-processed on subsequent idle reflection cycles.
 *
 * @paramfilename
 */
function markAnalyzed(filename) {
    fs.mkdirSync(QUARANTINE_ANALYZED_DIR, { recursive: true });
    const src = path.join(QUARANTINE_TASKS_DIR, filename);
    const dst = path.join(QUARANTINE_ANALYZED_DIR, filename);
    try {
        fs.renameSync(src, dst);
    } catch (e) {
        logger.warn('Reflection: failed to move file to analyzed/', { filename, error: e.message });
    }
}

/**
 * Parse the LLM JSON response and write synthesised rules to staging.
 *
 * @paramllmText - Raw text from Ollama
 * @paramworkspacePath
 * @returnsNumber of staging items written
 */
function writeSynthesisedRules(llmText, workspacePath) {
    let rules;
    try {
        const jsonStr = llmText.match(/\[[\s\S]*\]/)?.[0];
        if (!jsonStr) return 0;
        rules = JSON.parse(jsonStr);
    } catch (e) {
        logger.warn('Reflection: failed to parse LLM synthesis output', { error: e.message });
        return 0;
    }

    if (!Array.isArray(rules) || rules.length === 0) return 0;

    const stagingDir = path.join(workspacePath, '.kilo', 'staging');
    fs.mkdirSync(stagingDir, { recursive: true });

    let written = 0;
    for (const rule of rules) {
        if (!rule.rule || typeof rule.confidence !== 'number') continue;
        if (rule.confidence < 0.70) continue; // discard low-confidence synthesis

        const id = uuidv4();
        const payload = {
            id,
            type: 'sem_invariant',
            rule: rule.rule,
            rationale: rule.rationale || 'Synthesised from quarantine analysis',
            confidence: rule.confidence,
            corroboration_count: 1,
            source: 'idle_reflection',
            created_at: new Date().toISOString(),
        };

        try {
            fs.writeFileSync(path.join(stagingDir, `${id}.json`), JSON.stringify(payload, null, 2));
            logger.info('Reflection: staged synthesised rule', { id, rule: rule.rule.substring(0, 80) });
            written++;
        } catch (e) {
            logger.error('Reflection: failed to write staging file', { error: e.message });
        }
    }
    return written;
}

/**
 * Run idle reflection if the queue is empty and reflection is not already running.
 *
 * @paramworkspacePath - Path to the directory containing .kilo/
 * @paramqueue - The TaskQueue singleton
 * @returns
 */
async function runIfIdle(workspacePath, queue) {
    if (isRunning) {
        logger.debug('Reflection: already running, skipping this cycle');
        return;
    }

    if (!queueIsIdle(queue)) {
        logger.debug('Reflection: queue not idle, skipping');
        return;
    }

    const batchSize = config.REFLECTION_BATCH_SIZE;
    const batch = loadQuarantineBatch(batchSize);

    if (batch.length === 0) {
        logger.debug('Reflection: no unanalyzed quarantine items, skipping');
        return;
    }

    isRunning = true;
    logger.info('Idle reflection started', { batch_size: batch.length });

    try {
        // Summarise each quarantine item to fit in the prompt
        const taskSummaries = batch.map((item) => ({
            task_id: item.task_id,
            prompt: item.task_prompt ? item.task_prompt.substring(0, 300) : null,
            ladder_steps: item.ladder_steps_attempted || [],
            gates_failed: item.gates_failed || [],
            errors: (item.error_history || []).map((e) => ({
                stage: e.stage,
                error: typeof e.error === 'string' ? e.error.substring(0, 200) : String(e.error),
            })),
        }));

        const prompt = `${SYSTEM_PREAMBLE}You are analyzing ${taskSummaries.length} failed task(s) from a coding agent.
Each entry contains: the original instruction, which retry strategies were attempted, which pipeline gates failed, and the errors encountered at each stage.

Your job: identify PATTERNS across these failures. Focus on systemic issues, not individual bugs.
Produce a JSON array of new architectural rules that, if enforced earlier, would have prevented these failures.

Requirements:
- Each rule must be a single, actionable natural-language sentence.
- Only include rules with genuine cross-task applicability (confidence >= 0.70).
- Output ONLY a valid JSON array, nothing else.

Schema:
[
  {
    "rule": "string — the invariant/rule in natural language",
    "confidence": 0.70-1.0,
    "rationale": "string — why this pattern appeared across these failures"
  }
]

If no clear cross-task patterns exist, output an empty array: []

Failed tasks:
${wrapUntrusted('quarantine_batch', JSON.stringify(taskSummaries, null, 2))}`;

        const result = await ollama.generate(prompt, 'idle_reflection');

        if (result.tripped) {
            logger.warn('Reflection: Ollama circuit open, aborting this cycle');
            return;
        }

        const written = writeSynthesisedRules(result.text, workspacePath);
        logger.info('Idle reflection complete', { synthesised_rules: written, analyzed_tasks: batch.length });

        // Move processed files to analyzed/ regardless of whether rules were written
        for (const item of batch) {
            if (item._source_file) markAnalyzed(item._source_file);
        }
    } catch (err) {
        logger.error('Idle reflection failed', { error: err.message });
    } finally {
        isRunning = false;
    }
}

module.exports = { runIfIdle };

export {};
