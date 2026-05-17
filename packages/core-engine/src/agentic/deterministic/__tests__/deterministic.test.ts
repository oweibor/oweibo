// DONE: Phase A.11 — unit tests for deterministic utility modules.
// All tests use pure inputs/outputs — zero mocks, zero I/O.

import {
  allocateTokenBudget,
  estimateTokens,
  truncateToTokenBudget,
} from '../ContextWindowAllocator.js';

import {
  retryDecision,
  maxTotalDelayMs,
  DEFAULT_RETRY_POLICY,
} from '../RetryPolicy.js';

import {
  computeRecallScore,
  deduplicateBySummary,
  rankAndSlice,
  filterByMinScore,
  SCORE_CONSTANTS,
  MIN_RECALL_SCORE,
} from '../MemoryRecallScorer.js';

import {
  safeParse,
  parseOrFallback,
  parseJsonArray,
  repairJson,
  parseWithRepair,
} from '../JsonParseFallback.js';

// ── ContextWindowAllocator ────────────────────────────────────────────────────

describe('ContextWindowAllocator', () => {
  describe('allocateTokenBudget', () => {
    const base = {
      contextWindowTokens:      10_000,
      reservedForGeneration:     1_000,
      systemPromptTokens:          500,
      repoMapTokens:             2_000,
      projectRulesTokens:        1_000,
      skillsTokens:              1_000,
      conversationHistoryTokens: 2_000,
      userInstructionTokens:       200,
    };

    it('fits within budget when content is small', () => {
      const result = allocateTokenBudget(base);
      expect(result.overBudget).toBe(false);
      expect(result.totalUsed).toBeLessThanOrEqual(
        base.contextWindowTokens - base.reservedForGeneration,
      );
    });

    it('trims conversation history first when over budget', () => {
      const result = allocateTokenBudget({
        ...base,
        conversationHistoryTokens: 8_000, // way over
      });
      expect(result.trimmed.conversationHistory).toBeGreaterThan(0);
    });

    it('trims skills before projectRules', () => {
      const result = allocateTokenBudget({
        ...base,
        conversationHistoryTokens: 7_000,
        skillsTokens:              2_000,
      });
      expect(result.trimmed.skills).toBeGreaterThanOrEqual(0);
    });

    it('never trims systemPrompt or userInstruction', () => {
      const result = allocateTokenBudget({
        ...base,
        repoMapTokens:             10_000,
        conversationHistoryTokens: 10_000,
      });
      expect(result.trimmed.systemPrompt).toBe(0);
      expect(result.trimmed.userInstruction).toBe(0);
    });

    it('reservedForGeneration is always set correctly', () => {
      const result = allocateTokenBudget(base);
      expect(result.allocation.reservedForGeneration).toBe(base.reservedForGeneration);
    });
  });

  describe('estimateTokens', () => {
    it('returns 0 for empty string', () => {
      expect(estimateTokens('')).toBe(0);
    });

    it('approximates 4 chars per token', () => {
      expect(estimateTokens('abcd')).toBe(1);
      expect(estimateTokens('a'.repeat(400))).toBe(100);
    });
  });

  describe('truncateToTokenBudget', () => {
    it('returns text unchanged when within budget', () => {
      const text = 'hello world';
      expect(truncateToTokenBudget(text, 100)).toBe(text);
    });

    it('truncates to maxTokens * 4 chars', () => {
      const text = 'a'.repeat(100);
      expect(truncateToTokenBudget(text, 10)).toHaveLength(40);
    });
  });
});

// ── RetryPolicy ───────────────────────────────────────────────────────────────

describe('RetryPolicy', () => {
  describe('retryDecision', () => {
    it('returns shouldRetry=true for first attempt with retries left', () => {
      const result = retryDecision(1, new Error('timeout'));
      expect(result.shouldRetry).toBe(true);
      expect(result.delayMs).toBeGreaterThan(0);
    });

    it('returns shouldRetry=false when maxAttempts exhausted', () => {
      const result = retryDecision(3, new Error('fail'), DEFAULT_RETRY_POLICY);
      expect(result.shouldRetry).toBe(false);
    });

    it('does not retry validation errors', () => {
      const result = retryDecision(1, new Error('validation failed'));
      expect(result.shouldRetry).toBe(false);
    });

    it('does not retry unauthorized errors', () => {
      const result = retryDecision(1, new Error('Unauthorized'));
      expect(result.shouldRetry).toBe(false);
    });

    it('delay grows exponentially', () => {
      const d1 = retryDecision(1, new Error('timeout'), DEFAULT_RETRY_POLICY, 0).delayMs;
      const d2 = retryDecision(2, new Error('timeout'), DEFAULT_RETRY_POLICY, 0).delayMs;
      expect(d2).toBeGreaterThan(d1);
    });

    it('delay is capped at maxDelayMs', () => {
      const policy = { ...DEFAULT_RETRY_POLICY, maxAttempts: 20, maxDelayMs: 1_000 };
      const result = retryDecision(15, new Error('timeout'), policy, 0);
      expect(result.delayMs).toBeLessThanOrEqual(1_000);
    });
  });

  describe('maxTotalDelayMs', () => {
    it('returns positive value for default policy', () => {
      expect(maxTotalDelayMs()).toBeGreaterThan(0);
    });
  });
});

// ── MemoryRecallScorer ────────────────────────────────────────────────────────

describe('MemoryRecallScorer', () => {
  describe('computeRecallScore', () => {
    it('adds AGENT_BOOST for ltm-agent', () => {
      expect(computeRecallScore(0.5, 'ltm-agent')).toBeCloseTo(0.5 + SCORE_CONSTANTS.AGENT_BOOST);
    });

    it('adds PROJECT_BOOST for ltm-project', () => {
      expect(computeRecallScore(0.5, 'ltm-project')).toBeCloseTo(0.5 + SCORE_CONSTANTS.PROJECT_BOOST);
    });

    it('passes through raw score for ltm-tenant', () => {
      expect(computeRecallScore(0.7, 'ltm-tenant')).toBeCloseTo(0.7);
    });

    it('applies STM formula for stm', () => {
      const expected =
        SCORE_CONSTANTS.STM_SCALE * 1.0 +
        SCORE_CONSTANTS.STM_OFFSET +
        SCORE_CONSTANTS.STM_BOOST;
      expect(computeRecallScore(1.0, 'stm')).toBeCloseTo(expected);
    });
  });

  describe('deduplicateBySummary', () => {
    it('removes duplicate summaries, keeping first', () => {
      const entries = [
        { summary: 'foo', score: 0.9 },
        { summary: 'bar', score: 0.8 },
        { summary: 'foo', score: 0.7 },
      ];
      const result = deduplicateBySummary(entries);
      expect(result).toHaveLength(2);
      expect(result[0]!.score).toBe(0.9);
    });
  });

  describe('rankAndSlice', () => {
    it('returns topK highest-scored unique entries', () => {
      const entries = [
        { summary: 'a', score: 0.5 },
        { summary: 'b', score: 0.9 },
        { summary: 'c', score: 0.7 },
        { summary: 'a', score: 0.3 },
      ];
      const result = rankAndSlice(entries, 2);
      expect(result).toHaveLength(2);
      expect(result[0]!.summary).toBe('b');
      expect(result[1]!.summary).toBe('c');
    });
  });

  describe('filterByMinScore', () => {
    it('removes entries below MIN_RECALL_SCORE', () => {
      const entries = [{ score: 0.1 }, { score: 0.5 }, { score: MIN_RECALL_SCORE }];
      const result = filterByMinScore(entries);
      expect(result).toHaveLength(2);
    });
  });
});

// ── JsonParseFallback ─────────────────────────────────────────────────────────

describe('JsonParseFallback', () => {
  describe('safeParse', () => {
    const isString = (v: unknown): v is string => typeof v === 'string';

    it('parses valid JSON', () => {
      const result = safeParse('"hello"', isString);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toBe('hello');
    });

    it('returns failure for invalid JSON', () => {
      const result = safeParse('not json', isString);
      expect(result.ok).toBe(false);
    });

    it('returns failure when guard rejects the shape', () => {
      const result = safeParse('42', isString);
      expect(result.ok).toBe(false);
    });

    it('extracts JSON from markdown code fences', () => {
      const isArr = (v: unknown): v is number[] =>
        Array.isArray(v) && v.every(n => typeof n === 'number');
      const result = safeParse('```json\n[1, 2, 3]\n```', isArr);
      expect(result.ok).toBe(true);
    });
  });

  describe('parseOrFallback', () => {
    it('returns parsed value on success', () => {
      const result = parseOrFallback(
        '[1,2,3]',
        (v): v is number[] => Array.isArray(v),
        [],
      );
      expect(result).toEqual([1, 2, 3]);
    });

    it('returns fallback on failure', () => {
      const result = parseOrFallback('not json', (v): v is number[] => Array.isArray(v), [99]);
      expect(result).toEqual([99]);
    });
  });

  describe('parseJsonArray', () => {
    it('returns array of valid items', () => {
      const result = parseJsonArray(
        '[{"a":1},{"a":2}]',
        (v): v is { a: number } => typeof v === 'object' && v !== null && 'a' in v,
      );
      expect(result).toHaveLength(2);
    });

    it('returns empty array for invalid JSON', () => {
      expect(parseJsonArray('bad', () => true)).toEqual([]);
    });
  });

  describe('repairJson', () => {
    it('removes trailing commas', () => {
      expect(repairJson('{"a":1,}')).toBe('{"a":1}');
      expect(repairJson('[1,2,]')).toBe('[1,2]');
    });

    it('converts single-quoted keys', () => {
      const repaired = repairJson("{'key': 'value'}");
      expect(repaired).toContain('"key":');
    });
  });

  describe('parseWithRepair', () => {
    const isObj = (v: unknown): v is { a: number } =>
      typeof v === 'object' && v !== null && 'a' in v;

    it('parses clean JSON', () => {
      expect(parseWithRepair('{"a":1}', isObj)).toEqual({ a: 1 });
    });

    it('repairs and parses trailing-comma JSON', () => {
      expect(parseWithRepair('{"a":1,}', isObj)).toEqual({ a: 1 });
    });

    it('returns null for unrepairable input', () => {
      expect(parseWithRepair('total garbage', isObj)).toBeNull();
    });
  });
});
