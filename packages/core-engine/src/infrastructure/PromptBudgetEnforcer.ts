/**
 * packages/core-engine/src/infrastructure/PromptBudgetEnforcer.ts
 *
 * PromptBudgetEnforcer — pre-call token accounting for any assembled LLM prompt (§22.26).
 *
 * Sits in the prompt assembly chain immediately AFTER `skills` injection and BEFORE
 * the assembled prompt is frozen and passed to LLM.stream()/complete().
 *
 * Full chain order:
 *   repoMap → projectRules → skills → [PromptBudgetEnforcer] → systemPrompt (sent to LLM)
 *
 * Responsibilities:
 *   1. Measure total assembled prompt tokens using the generation model's tokenizer.
 *   2. If total exceeds (contextWindow − reservedGenerationTokens), trim in priority order:
 *        a. Conversation history (drop oldest turns first)
 *        b. Skills block (truncate from the end)
 *        c. Project rules (truncate from the end)
 *        d. Repo map (truncate from the end)
 *        e. If still over: emit 'context-overflow' event and include overflow notice in trimReport.
 *   3. Always emit a 'cost-estimated' event before the LLM call.
 *
 * Configuration (read from constructor parameters, defaulting if not provided):
 *   - contextWindowTokens   default 200_000  (claude-sonnet-4-6 context window)
 *   - reservedTokens        default   8_000  (held back for model response)
 *   - costPerMillionTokens  default      15  (USD — approximate claude-sonnet-4-6 input cost)
 *
 * The enforcer is stateless — a new instance may be created per LLM call, or a single
 * instance may be shared across calls (all state is in the AssembledPrompt arguments).
 */

import { EventEmitter } from 'node:events';
import type { ModelRouter } from './ModelRouter.js';
import type { TaskEventBus } from '../ingestion/TaskEventBus.js';

// ── Public types ──────────────────────────────────────────────────────────────

export interface AssembledPrompt {
  /** Raw repo map text (RepoMapBuilder output). */
  repoMap: string;
  /** Project rules block (ProjectRulesLoader output). */
  projectRules: string;
  /** Skills injection block (SkillRegistry output). */
  skills: string;
  /** Fixed system prompt for this agent role (from Langfuse / inline constant). */
  systemPrompt: string;
  /** Conversation history from ConversationalLoop / context store. */
  conversationHistory: Array<{ role: 'user' | 'assistant'; content: string }>;
  /** The user's instruction for this turn. */
  userInstruction: string;
}

export interface BudgetedPrompt {
  /**
   * Final system prompt to send to the LLM.
   * Contains: systemPrompt + repoMap + projectRules + skills (all potentially trimmed).
   */
  systemPrompt: string;
  /** Conversation history (potentially trimmed from the front). */
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  /** Total token count of the budgeted prompt (post-trim). */
  totalTokens: number;
  /** True if any trimming was applied. */
  wasTrimmed: boolean;
  /** Human-readable list of each trim operation performed. */
  trimReport: string[];
}

export interface PromptBudgetConfig {
  /** Total context window of the generation model in tokens. Default: 200_000. */
  contextWindowTokens?: number;
  /** Tokens reserved for the model's response. Default: 8_000. */
  reservedGenerationTokens?: number;
  /** Input cost in USD per million tokens (for cost-estimated event). Default: 15. */
  costPerMillionInputTokens?: number;
}

// ── Implementation ────────────────────────────────────────────────────────────

export class PromptBudgetEnforcer extends EventEmitter {
  private readonly contextWindow: number;
  private readonly reservedTokens: number;
  private readonly costPerMillion: number;

  constructor(
    private readonly modelRouter: ModelRouter,
    private readonly eventBus: TaskEventBus,
    config: PromptBudgetConfig = {},
  ) {
    super();
    this.contextWindow  = config.contextWindowTokens      ?? 200_000;
    this.reservedTokens = config.reservedGenerationTokens ?? 8_000;
    this.costPerMillion = config.costPerMillionInputTokens ?? 15;
  }

  /**
   * enforce — measure the assembled prompt, trim if necessary, publish events.
   *
   * @param prompt    The fully assembled prompt components.
   * @param taskId    Used as the event taskId for TaskEventBus.publish().
   * @param sessionId Used as the channel key for TaskEventBus.publish().
   * @returns         A BudgetedPrompt ready to pass to LLM.stream()/complete().
   */
  async enforce(
    prompt: AssembledPrompt,
    taskId: string,
    sessionId: string,
  ): Promise<BudgetedPrompt> {
    const tokenizer   = this.modelRouter.forGeneration().tokenizer();
    const budget      = this.contextWindow - this.reservedTokens;
    const trimReport: string[] = [];

    // Working copies — trimmed in-place below
    let repoMap       = prompt.repoMap;
    let projectRules  = prompt.projectRules;
    let skills        = prompt.skills;
    let history       = [...prompt.conversationHistory];

    // ── Helper: count tokens for the current assembled set ───────────────────
    const countTotal = (): number => {
      const systemBlock = assembleSystem(prompt.systemPrompt, repoMap, projectRules, skills);
      const historyText = history.map(m => m.content).join('\n');
      return (
        tokenizer.encode(systemBlock).length +
        tokenizer.encode(historyText).length +
        tokenizer.encode(prompt.userInstruction).length
      );
    };

    // Initial measurement
    let total = countTotal();
    let wasTrimmed = false;

    // ── Step a: trim conversation history (oldest turns first) ───────────────
    if (total > budget && history.length > 0) {
      const before = history.length;
      while (total > budget && history.length > 0) {
        history.shift();   // drop the oldest message
        total = countTotal();
      }
      const dropped = before - history.length;
      if (dropped > 0) {
        trimReport.push(`History: dropped ${dropped} oldest message(s) to fit context window.`);
        wasTrimmed = true;
      }
    }

    // ── Step b: trim skills block (truncate from end) ─────────────────────────
    if (total > budget && skills.length > 0) {
      const original = skills;
      skills = truncateToTokenBudget(skills, tokenizer, budget - (total - tokenizer.encode(skills).length));
      if (skills !== original) {
        trimReport.push(
          `Skills: truncated from ${tokenizer.encode(original).length} → ${tokenizer.encode(skills).length} tokens.`,
        );
        wasTrimmed = true;
        total = countTotal();
      }
    }

    // ── Step c: trim project rules (truncate from end) ────────────────────────
    if (total > budget && projectRules.length > 0) {
      const original = projectRules;
      projectRules = truncateToTokenBudget(
        projectRules,
        tokenizer,
        budget - (total - tokenizer.encode(projectRules).length),
      );
      if (projectRules !== original) {
        trimReport.push(
          `Project rules: truncated from ${tokenizer.encode(original).length} → ${tokenizer.encode(projectRules).length} tokens.`,
        );
        wasTrimmed = true;
        total = countTotal();
      }
    }

    // ── Step d: trim repo map (truncate from end) ─────────────────────────────
    if (total > budget && repoMap.length > 0) {
      const original = repoMap;
      repoMap = truncateToTokenBudget(
        repoMap,
        tokenizer,
        budget - (total - tokenizer.encode(repoMap).length),
      );
      if (repoMap !== original) {
        trimReport.push(
          `Repo map: truncated from ${tokenizer.encode(original).length} → ${tokenizer.encode(repoMap).length} tokens.`,
        );
        wasTrimmed = true;
        total = countTotal();
      }
    }

    // ── Step e: still over budget — emit context-overflow ────────────────────
    if (total > budget) {
      trimReport.push(
        `OVERFLOW: prompt is ${total} tokens against budget of ${budget}. ` +
        `All trim strategies exhausted. Proceeding — model may truncate or error.`,
      );
      await this.eventBus.publish(sessionId, {
        taskId,
        type: 'context-overflow',
        message: `Prompt exceeds context budget (${total}/${budget} tokens) after all trimming.`,
        payload: { totalTokens: total, budget, trimReport },
      });
    }

    // ── Cost estimate event (always emitted) ──────────────────────────────────
    const estimatedCostUsd = (total / 1_000_000) * this.costPerMillion;
    await this.eventBus.publish(sessionId, {
      taskId,
      type: 'cost-estimated',
      message: `Estimated prompt: ${total.toLocaleString()} tokens (~$${estimatedCostUsd.toFixed(4)})`,
      payload: { estimatedTokens: total, estimatedCostUsd, sessionId },
    });

    // Emit tokens-consumed so PromptBudgetEnforcerAdapter can credit actual spend (B1).
    this.emit('tokens-consumed', total);

    return {
      systemPrompt: assembleSystem(prompt.systemPrompt, repoMap, projectRules, skills),
      messages:     history,
      totalTokens:  total,
      wasTrimmed,
      trimReport,
    };
  }
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/**
 * assembleSystem — combine system prompt with the three variable blocks.
 * Order matches the chain: systemPrompt first, then data blocks.
 */
function assembleSystem(
  systemPrompt: string,
  repoMap: string,
  projectRules: string,
  skills: string,
): string {
  const parts: string[] = [systemPrompt];
  if (repoMap)      parts.push(`\n\n## Repository Map\n${repoMap}`);
  if (projectRules) parts.push(`\n\n## Project Rules\n${projectRules}`);
  if (skills)       parts.push(`\n\n## Available Skills\n${skills}`);
  return parts.join('');
}

/**
 * truncateToTokenBudget — truncate `text` so it fits within `tokenBudget` tokens.
 * Uses binary-search over character length to avoid O(n²) encode calls.
 */
function truncateToTokenBudget(
  text: string,
  tokenizer: { encode(s: string): number[] },
  tokenBudget: number,
): string {
  if (tokenBudget <= 0) return '';
  if (tokenizer.encode(text).length <= tokenBudget) return text;

  // Binary-search on character length
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi + 1) / 2);
    if (tokenizer.encode(text.slice(0, mid)).length <= tokenBudget) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return text.slice(0, lo);
}
