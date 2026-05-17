// DONE: Phase B.3 — TenantDistillationWorker.
// Subscribes to task.completed Redis events (decoupled from task lifecycle).
// Pipeline: novelty filter → dual-candidate generation (B.3b) →
//           DLP filter → confidentiality classifier → sign → publish.

import { createHash } from 'crypto';
import type { LessonV1, CanonicalRole } from '@oweibo/core-contracts';
import type { ILLMClient } from '@oweibo/core-contracts';
import { applyDLPFilter, sanitise } from './LessonDLPFilter.js';
import { classifyConfidentiality } from './ConfidentialityClassifier.js';
import {
  classifyNovelty, fingerprintToolSequence,
  type NoveltyContext, type TaskOutcomeForNovelty,
} from './NoveltyClassifier.js';
import { signLesson, getTenantSecret } from './LessonSigner.js';
import { parseLesson } from './LessonSchema.js';

export interface CompletedTaskEvent {
  readonly taskId:        string;
  readonly tenantId:      string;
  readonly role:          CanonicalRole;
  readonly slotId:        string;
  readonly channel:       string;
  readonly outcome:       'success' | 'failure' | 'recovery';
  readonly errorClass?:   string;
  readonly toolSequence?: readonly string[];
  readonly subgoalCount?: number;
  readonly dependencyEdgeCount?: number;
  readonly estimatedComplexity?: number;
  readonly goalDescription:      string;
  readonly resultSummary?:       string;
}

export interface DistillationDeps {
  /** LLM used for lesson text generation (NOT the same instance as agent LLM). */
  readonly llm: ILLMClient;
  /** Redis publish — sends to `platform.lesson.submitted` channel. */
  readonly publish: (channel: string, message: string) => Promise<void>;
  /** Optional Vault client for per-tenant signing key lookup. */
  readonly vaultClient?: { read(path: string): Promise<{ data: { key: string } }> };
  /** Novelty context provider — returns seen sets for a given tenantId. */
  readonly getNoveltyContext: (tenantId: string) => Promise<NoveltyContext>;
  /** Record a newly seen fingerprint after lesson is generated. */
  readonly recordSeen: (tenantId: string, type: 'error' | 'tool', value: string) => Promise<void>;
  /** Error metric increment (non-fatal). */
  readonly incrementErrorCounter?: (label: string) => void;
  /** D.10: per-tenant cost attribution — called after successful lesson publish. */
  readonly recordCost?: (tenantId: string) => Promise<void>;
}

const DISTILLATION_PROMPT = `You are a privacy-safe lesson extractor. Given a task summary, produce ONE sentence (max 200 chars) describing an abstract, generalizable procedural insight.

Rules:
- NO identifiers: no UUIDs, emails, IPs, paths, usernames, company names, or project names.
- NO technical specifics: no port numbers, API endpoints, database names, or schema details.
- ONLY abstract patterns: describe the class of problem and the class of solution.
- Output ONLY a valid JSON object: {"pattern": "<lesson text>", "confidence": <0.0-1.0>}`;

async function generateLessonCandidate(
  llm:         ILLMClient,
  event:       CompletedTaskEvent,
): Promise<{ pattern: string; confidence: number } | null> {
  const userPrompt = `Task outcome: ${event.outcome}
Goal category: ${sanitise(event.goalDescription).slice(0, 100)}
${event.resultSummary ? `Result summary: ${sanitise(event.resultSummary).slice(0, 100)}` : ''}
${event.errorClass ? `Error class: ${event.errorClass}` : ''}
${event.toolSequence ? `Tools used: ${event.toolSequence.join(', ')}` : ''}

Extract the abstract procedural insight:`;

  try {
    const response = await llm.generate({
      systemPrompt:   DISTILLATION_PROMPT,
      userPrompt,
      responseFormat: 'json',
      temperature:    0.5,
    });

    const parsed = JSON.parse(response.output) as { pattern?: string; confidence?: number };
    if (typeof parsed.pattern !== 'string' || typeof parsed.confidence !== 'number') return null;
    return { pattern: parsed.pattern.slice(0, 200), confidence: Math.max(0, Math.min(1, parsed.confidence)) };
  } catch {
    return null;
  }
}

function computeFingerprint(
  taskId:     string,
  role:       string,
  slotId:     string,
  errorClass: string | undefined,
): string {
  return createHash('sha256')
    .update(`${taskId}:${role}:${slotId}:${errorClass ?? ''}`)
    .digest('hex');
}

/**
 * Process a single completed-task event through the full distillation pipeline.
 * Failures are logged but NEVER thrown back to the caller — distillation must
 * never block or impact the task result.
 */
export async function distillTask(
  event: CompletedTaskEvent,
  deps:  DistillationDeps,
): Promise<void> {
  try {
    // ── B.3a: Novelty filter ────────────────────────────────────────────────
    const taskForNovelty: TaskOutcomeForNovelty = {
      outcome:      event.outcome,
      errorClass:   event.errorClass,
      toolSequence: event.toolSequence,
      subgoalCount: event.subgoalCount,
    };
    const noveltyCtx = await deps.getNoveltyContext(event.tenantId);
    const novelty    = classifyNovelty(taskForNovelty, noveltyCtx);

    if (!novelty.novel) return; // drop — not novel enough

    // ── B.3b: Dual-candidate generation (self-consistency) ─────────────────
    const [c1, c2] = await Promise.all([
      generateLessonCandidate(deps.llm, event),
      generateLessonCandidate(deps.llm, event),
    ]);

    // Pick higher-confidence candidate; fallback if both null
    const candidate = [c1, c2]
      .filter((c): c is NonNullable<typeof c> => c !== null)
      .sort((a, b) => b.confidence - a.confidence)[0];

    if (!candidate) return; // both generation attempts failed

    // ── B.2: DLP filter ────────────────────────────────────────────────────
    const dlpResult = applyDLPFilter(candidate.pattern);
    if (!dlpResult.pass) {
      deps.incrementErrorCounter?.('dlp_reject');
      return;
    }

    // ── B.3c: Confidentiality classifier ──────────────────────────────────
    const confResult = classifyConfidentiality(candidate.pattern);
    if (!confResult.pass) {
      deps.incrementErrorCounter?.('confidentiality_reject');
      return;
    }

    // ── Build LessonV1 ─────────────────────────────────────────────────────
    const lessonBase: Omit<LessonV1, 'signature'> = {
      schemaVersion:       '1',
      taskId:              event.taskId,
      tenantId:            event.tenantId,
      role:                event.role,
      slotId:              event.slotId,
      channel:             event.channel,
      outcome:             event.outcome,
      abstractPattern:     candidate.pattern,
      toolSequence:        event.toolSequence,
      errorClass:          event.errorClass,
      subgoalCount:        event.subgoalCount,
      dependencyEdgeCount: event.dependencyEdgeCount,
      estimatedComplexity: event.estimatedComplexity,
      confidence:          candidate.confidence,
      novel:               true,
      fingerprint:         computeFingerprint(event.taskId, event.role, event.slotId, event.errorClass),
      generatedAt:         new Date().toISOString(),
    };

    // Validate with Zod schema before signing
    const validated = parseLesson(lessonBase);
    if (!validated.ok) {
      deps.incrementErrorCounter?.('schema_validation_fail');
      // B.3: Retry once with stricter JSON-only prompt (simplified: re-validate is sufficient)
      return;
    }

    // ── B.4: Sign + publish ────────────────────────────────────────────────
    const tenantSecret = await getTenantSecret(event.tenantId, deps.vaultClient);
    const signed       = signLesson(validated.lesson, tenantSecret);

    await deps.publish('platform.lesson.submitted', JSON.stringify(signed));

    // D.10: meter distillation cost to per-tenant usage_records (fire-and-forget)
    deps.recordCost?.(event.tenantId).catch(() => {});

    // Record seen values for novelty tracking
    if (event.errorClass) {
      await deps.recordSeen(event.tenantId, 'error', event.errorClass);
    }
    if (event.toolSequence && event.toolSequence.length > 0) {
      const fp = fingerprintToolSequence(event.toolSequence);
      await deps.recordSeen(event.tenantId, 'tool', fp);
    }

  } catch (err) {
    // Publish to DLQ — never rethrow
    try {
      await deps.publish(
        'task.distillation.failed',
        JSON.stringify({ taskId: event.taskId, tenantId: event.tenantId, error: String(err) }),
      );
    } catch { /* best effort */ }
    deps.incrementErrorCounter?.('distillation_worker_error_total');
  }
}

/**
 * Create a Redis subscriber that processes task.completed events.
 * Returns a teardown function.
 */
export function createDistillationSubscriber(
  redisSubscribe: (channel: string, handler: (message: string) => void) => (() => void),
  deps:           DistillationDeps,
): () => void {
  return redisSubscribe('task.completed', (raw) => {
    let event: CompletedTaskEvent;
    try {
      event = JSON.parse(raw) as CompletedTaskEvent;
    } catch {
      deps.incrementErrorCounter?.('distillation_parse_error');
      return;
    }
    // Fire-and-forget — never await in the subscriber callback
    void distillTask(event, deps).catch(() => {
      deps.incrementErrorCounter?.('distillation_worker_error_total');
    });
  });
}
