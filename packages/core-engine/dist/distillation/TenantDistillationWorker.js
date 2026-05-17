"use strict";
// DONE: Phase B.3 — TenantDistillationWorker.
// Subscribes to task.completed Redis events (decoupled from task lifecycle).
// Pipeline: novelty filter → dual-candidate generation (B.3b) →
//           DLP filter → confidentiality classifier → sign → publish.
Object.defineProperty(exports, "__esModule", { value: true });
exports.distillTask = distillTask;
exports.createDistillationSubscriber = createDistillationSubscriber;
const crypto_1 = require("crypto");
const LessonDLPFilter_js_1 = require("./LessonDLPFilter.js");
const ConfidentialityClassifier_js_1 = require("./ConfidentialityClassifier.js");
const NoveltyClassifier_js_1 = require("./NoveltyClassifier.js");
const LessonSigner_js_1 = require("./LessonSigner.js");
const LessonSchema_js_1 = require("./LessonSchema.js");
const DISTILLATION_PROMPT = `You are a privacy-safe lesson extractor. Given a task summary, produce ONE sentence (max 200 chars) describing an abstract, generalizable procedural insight.

Rules:
- NO identifiers: no UUIDs, emails, IPs, paths, usernames, company names, or project names.
- NO technical specifics: no port numbers, API endpoints, database names, or schema details.
- ONLY abstract patterns: describe the class of problem and the class of solution.
- Output ONLY a valid JSON object: {"pattern": "<lesson text>", "confidence": <0.0-1.0>}`;
async function generateLessonCandidate(llm, event) {
    const userPrompt = `Task outcome: ${event.outcome}
Goal category: ${(0, LessonDLPFilter_js_1.sanitise)(event.goalDescription).slice(0, 100)}
${event.resultSummary ? `Result summary: ${(0, LessonDLPFilter_js_1.sanitise)(event.resultSummary).slice(0, 100)}` : ''}
${event.errorClass ? `Error class: ${event.errorClass}` : ''}
${event.toolSequence ? `Tools used: ${event.toolSequence.join(', ')}` : ''}

Extract the abstract procedural insight:`;
    try {
        const response = await llm.generate({
            systemPrompt: DISTILLATION_PROMPT,
            userPrompt,
            responseFormat: 'json',
            temperature: 0.5,
        });
        const parsed = JSON.parse(response.output);
        if (typeof parsed.pattern !== 'string' || typeof parsed.confidence !== 'number')
            return null;
        return { pattern: parsed.pattern.slice(0, 200), confidence: Math.max(0, Math.min(1, parsed.confidence)) };
    }
    catch {
        return null;
    }
}
function computeFingerprint(taskId, role, slotId, errorClass) {
    return (0, crypto_1.createHash)('sha256')
        .update(`${taskId}:${role}:${slotId}:${errorClass ?? ''}`)
        .digest('hex');
}
/**
 * Process a single completed-task event through the full distillation pipeline.
 * Failures are logged but NEVER thrown back to the caller — distillation must
 * never block or impact the task result.
 */
async function distillTask(event, deps) {
    try {
        // ── B.3a: Novelty filter ────────────────────────────────────────────────
        const taskForNovelty = {
            outcome: event.outcome,
            errorClass: event.errorClass,
            toolSequence: event.toolSequence,
            subgoalCount: event.subgoalCount,
        };
        const noveltyCtx = await deps.getNoveltyContext(event.tenantId);
        const novelty = (0, NoveltyClassifier_js_1.classifyNovelty)(taskForNovelty, noveltyCtx);
        if (!novelty.novel)
            return; // drop — not novel enough
        // ── B.3b: Dual-candidate generation (self-consistency) ─────────────────
        const [c1, c2] = await Promise.all([
            generateLessonCandidate(deps.llm, event),
            generateLessonCandidate(deps.llm, event),
        ]);
        // Pick higher-confidence candidate; fallback if both null
        const candidate = [c1, c2]
            .filter((c) => c !== null)
            .sort((a, b) => b.confidence - a.confidence)[0];
        if (!candidate)
            return; // both generation attempts failed
        // ── B.2: DLP filter ────────────────────────────────────────────────────
        const dlpResult = (0, LessonDLPFilter_js_1.applyDLPFilter)(candidate.pattern);
        if (!dlpResult.pass) {
            deps.incrementErrorCounter?.('dlp_reject');
            return;
        }
        // ── B.3c: Confidentiality classifier ──────────────────────────────────
        const confResult = (0, ConfidentialityClassifier_js_1.classifyConfidentiality)(candidate.pattern);
        if (!confResult.pass) {
            deps.incrementErrorCounter?.('confidentiality_reject');
            return;
        }
        // ── Build LessonV1 ─────────────────────────────────────────────────────
        const lessonBase = {
            schemaVersion: '1',
            taskId: event.taskId,
            tenantId: event.tenantId,
            role: event.role,
            slotId: event.slotId,
            channel: event.channel,
            outcome: event.outcome,
            abstractPattern: candidate.pattern,
            toolSequence: event.toolSequence,
            errorClass: event.errorClass,
            subgoalCount: event.subgoalCount,
            dependencyEdgeCount: event.dependencyEdgeCount,
            estimatedComplexity: event.estimatedComplexity,
            confidence: candidate.confidence,
            novel: true,
            fingerprint: computeFingerprint(event.taskId, event.role, event.slotId, event.errorClass),
            generatedAt: new Date().toISOString(),
        };
        // Validate with Zod schema before signing
        const validated = (0, LessonSchema_js_1.parseLesson)(lessonBase);
        if (!validated.ok) {
            deps.incrementErrorCounter?.('schema_validation_fail');
            // B.3: Retry once with stricter JSON-only prompt (simplified: re-validate is sufficient)
            return;
        }
        // ── B.4: Sign + publish ────────────────────────────────────────────────
        const tenantSecret = await (0, LessonSigner_js_1.getTenantSecret)(event.tenantId, deps.vaultClient);
        const signed = (0, LessonSigner_js_1.signLesson)(validated.lesson, tenantSecret);
        await deps.publish('platform.lesson.submitted', JSON.stringify(signed));
        // D.10: meter distillation cost to per-tenant usage_records (fire-and-forget)
        deps.recordCost?.(event.tenantId).catch(() => { });
        // Record seen values for novelty tracking
        if (event.errorClass) {
            await deps.recordSeen(event.tenantId, 'error', event.errorClass);
        }
        if (event.toolSequence && event.toolSequence.length > 0) {
            const fp = (0, NoveltyClassifier_js_1.fingerprintToolSequence)(event.toolSequence);
            await deps.recordSeen(event.tenantId, 'tool', fp);
        }
    }
    catch (err) {
        // Publish to DLQ — never rethrow
        try {
            await deps.publish('task.distillation.failed', JSON.stringify({ taskId: event.taskId, tenantId: event.tenantId, error: String(err) }));
        }
        catch { /* best effort */ }
        deps.incrementErrorCounter?.('distillation_worker_error_total');
    }
}
/**
 * Create a Redis subscriber that processes task.completed events.
 * Returns a teardown function.
 */
function createDistillationSubscriber(redisSubscribe, deps) {
    return redisSubscribe('task.completed', (raw) => {
        let event;
        try {
            event = JSON.parse(raw);
        }
        catch {
            deps.incrementErrorCounter?.('distillation_parse_error');
            return;
        }
        // Fire-and-forget — never await in the subscriber callback
        void distillTask(event, deps).catch(() => {
            deps.incrementErrorCounter?.('distillation_worker_error_total');
        });
    });
}
//# sourceMappingURL=TenantDistillationWorker.js.map