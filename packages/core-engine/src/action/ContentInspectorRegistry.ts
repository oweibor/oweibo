/**
 * S.5.a: ContentInspectorRegistry — runs all matching inspectors against
 * an action context and combines their verdicts into a single decision.
 *
 * Per-inspector timeout: each inspector has 500ms to return. A timeout
 * is treated as `upgrade_to_approval` (fail-closed: when we cannot
 * decide, we ask a human). This is safer than treating it as `allow`,
 * which would silently bypass the inspector layer.
 *
 * Audit: the registry returns the *combined* verdict and the per-inspector
 * verdict list. The trust ladder persists the per-inspector list into
 * oweibo.content_inspection_results so an admin can see exactly which
 * inspector flagged a payload and why.
 */
import type {
  ActionContext,
  ContentInspectionResult,
  IContentInspector,
} from '@oweibo/core-contracts';
import { combineVerdicts } from '@oweibo/core-contracts';

const INSPECTOR_TIMEOUT_MS = 500;

export interface PerInspectorVerdict {
  readonly inspectorName: string;
  readonly result: ContentInspectionResult;
}

export interface InspectionRunResult {
  readonly combined: ContentInspectionResult;
  readonly perInspector: readonly PerInspectorVerdict[];
}

export class ContentInspectorRegistry {
  private readonly inspectors: IContentInspector[] = [];

  register(inspector: IContentInspector): void {
    if (this.inspectors.some((i) => i.name === inspector.name)) {
      throw new Error(`duplicate content inspector name: ${inspector.name}`);
    }
    this.inspectors.push(inspector);
  }

  names(): readonly string[] {
    return [...this.inspectors.map((i) => i.name)].sort();
  }

  /**
   * Run all matching inspectors. Returns combined + per-inspector
   * verdicts. Empty inspector list → { combined: allow, perInspector: [] }.
   */
  async run(ctx: ActionContext): Promise<InspectionRunResult> {
    const matching = this.inspectors.filter((i) => i.appliesTo(ctx.actionClass));
    if (matching.length === 0) {
      return { combined: { verdict: 'allow' }, perInspector: [] };
    }
    const perInspector: PerInspectorVerdict[] = await Promise.all(
      matching.map(async (i) => {
        try {
          const result = await runWithTimeout(i.inspect(ctx), INSPECTOR_TIMEOUT_MS);
          return { inspectorName: i.name, result };
        } catch (err) {
          // Timeout or thrown error → fail-closed.
          return {
            inspectorName: i.name,
            result: {
              verdict: 'upgrade_to_approval',
              reason: `inspector error: ${err instanceof Error ? err.message : String(err)}`,
            },
          };
        }
      }),
    );
    return {
      combined: combineVerdicts(perInspector.map((p) => p.result)),
      perInspector,
    };
  }
}

function runWithTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race<T>([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`inspector timeout after ${ms}ms`)), ms),
    ),
  ]);
}
