/**
 * D.2 (domain-depth): built-in deterministic check executor.
 *
 * Routes `check === 'deterministic'` criteria through a small fn table
 * keyed by `checkConfig.fn`. The v1 fn library covers the patterns
 * actually used by the bundled rubrics:
 *
 *   - grepCheck         — pattern (regex string) must MATCH the modified text
 *   - grepAbsent        — pattern must NOT match the modified text
 *   - auditFieldPresent — context.executorContext.auditRow has a field
 *                         optionally meeting minLength
 *
 * Non-deterministic criteria (llm_judge, sme_required) are returned as
 * `skipped` here — a deployment that wants LLM-judge support wires a
 * different executor. The `compose()` helper at the bottom of this file
 * stacks executors so deterministic + LLM-judge can coexist.
 */
import type {
  CriterionResult,
  ICriterionCheckExecutor,
  RubricCriterion,
  RubricEvaluationContext,
} from '@oweibo/core-contracts';

export class DeterministicCheckExecutor implements ICriterionCheckExecutor {
  async execute(input: {
    criterion: RubricCriterion;
    context: RubricEvaluationContext;
  }): Promise<CriterionResult> {
    const { criterion, context } = input;
    if (criterion.check !== 'deterministic') {
      return skipped(criterion.criterionId, `unsupported_check_kind:${criterion.check}`);
    }
    const cfg = criterion.checkConfig as { fn?: string } | null | undefined;
    if (!cfg || typeof cfg.fn !== 'string') {
      return skipped(criterion.criterionId, 'missing_check_fn');
    }
    const fn = DETERMINISTIC_FNS[cfg.fn];
    if (!fn) {
      return skipped(criterion.criterionId, `unknown_check_fn:${cfg.fn}`);
    }
    try {
      return fn(criterion, cfg as Record<string, unknown>, context);
    } catch (err) {
      return skipped(
        criterion.criterionId,
        err instanceof Error ? `fn_error:${err.message}` : 'fn_error',
      );
    }
  }
}

// ─── Built-in deterministic fns ───────────────────────────────────────────

type DeterministicFn = (
  criterion: RubricCriterion,
  cfg: Record<string, unknown>,
  context: RubricEvaluationContext,
) => CriterionResult;

const DETERMINISTIC_FNS: Readonly<Record<string, DeterministicFn>> = {
  grepCheck: (criterion, cfg, context) => {
    const pattern = readString(cfg, 'pattern');
    const haystack = pickHaystack(cfg, context);
    if (pattern === undefined) {
      return skipped(criterion.criterionId, 'missing_pattern');
    }
    if (haystack === undefined) {
      return skipped(criterion.criterionId, 'missing_haystack');
    }
    const re = new RegExp(pattern, 'm');
    const passed = re.test(haystack);
    return {
      criterionId: criterion.criterionId,
      score: passed ? 1 : 0,
      passed,
      details: { matched: passed, pattern },
    };
  },

  grepAbsent: (criterion, cfg, context) => {
    const pattern = readString(cfg, 'pattern');
    const haystack = pickHaystack(cfg, context);
    if (pattern === undefined) {
      return skipped(criterion.criterionId, 'missing_pattern');
    }
    if (haystack === undefined) {
      return skipped(criterion.criterionId, 'missing_haystack');
    }
    const re = new RegExp(pattern, 'm');
    const matched = re.test(haystack);
    const passed = !matched;
    return {
      criterionId: criterion.criterionId,
      score: passed ? 1 : 0,
      passed,
      details: { matched, pattern },
    };
  },

  auditFieldPresent: (criterion, cfg, context) => {
    const field = readString(cfg, 'field');
    if (field === undefined) {
      return skipped(criterion.criterionId, 'missing_field');
    }
    const minLength = readNumber(cfg, 'minLength') ?? 0;
    const auditRow = (context.executorContext?.['auditRow'] ?? null) as Record<
      string,
      unknown
    > | null;
    if (auditRow === null || typeof auditRow !== 'object') {
      return skipped(criterion.criterionId, 'missing_audit_row');
    }
    const value = auditRow[field];
    let passed: boolean;
    if (value === undefined || value === null) {
      passed = false;
    } else if (typeof value === 'string') {
      passed = value.length >= minLength;
    } else {
      passed = true;
    }
    return {
      criterionId: criterion.criterionId,
      score: passed ? 1 : 0,
      passed,
      details: { field, present: value !== undefined && value !== null, minLength },
    };
  },
};

// ─── Helpers ─────────────────────────────────────────────────────────────

function skipped(criterionId: string, reason: string): CriterionResult {
  return {
    criterionId,
    score: 0,
    passed: false,
    skipped: true,
    skipReason: reason,
  };
}

function readString(cfg: Record<string, unknown>, key: string): string | undefined {
  const v = cfg[key];
  return typeof v === 'string' ? v : undefined;
}

function readNumber(cfg: Record<string, unknown>, key: string): number | undefined {
  const v = cfg[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/**
 * Pick the haystack string for grep-style checks. Looks at `cfg.scope`
 * to select a fixture from `context.executorContext`:
 *   - 'modified_lines' (default) → executorContext.modifiedLines (string)
 *   - 'artifact_body'            → executorContext.artifactBody (string)
 *   - 'audit_details'            → JSON.stringify(executorContext.auditRow ?? {})
 */
function pickHaystack(
  cfg: Record<string, unknown>,
  context: RubricEvaluationContext,
): string | undefined {
  const scope = readString(cfg, 'scope') ?? 'modified_lines';
  const ec = context.executorContext ?? {};
  switch (scope) {
    case 'modified_lines': {
      const v = ec['modifiedLines'];
      return typeof v === 'string' ? v : undefined;
    }
    case 'artifact_body': {
      const v = ec['artifactBody'];
      return typeof v === 'string' ? v : undefined;
    }
    case 'audit_details': {
      const v = ec['auditRow'];
      return v !== undefined && v !== null ? JSON.stringify(v) : undefined;
    }
    default:
      return undefined;
  }
}

// ─── Composition helper ──────────────────────────────────────────────────

/**
 * Compose executors so the first non-skipped result wins. Useful when a
 * deployment wires `compose(deterministic, llmJudge)` and wants LLM
 * judges to only run for criteria the deterministic executor skipped.
 */
export function composeExecutors(
  ...executors: readonly ICriterionCheckExecutor[]
): ICriterionCheckExecutor {
  return {
    async execute(input) {
      let last: CriterionResult | undefined;
      for (const ex of executors) {
        const r = await ex.execute(input);
        if (!r.skipped) return r;
        last = r;
      }
      return (
        last ?? {
          criterionId: input.criterion.criterionId,
          score: 0,
          passed: false,
          skipped: true,
          skipReason: 'no_executor',
        }
      );
    },
  };
}
