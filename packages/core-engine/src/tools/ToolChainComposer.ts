// packages/core-engine/src/tools/ToolChainComposer.ts
import type { IToolRegistry, ISecurityContext } from '@oweibo/core-contracts';

export interface ToolChainStep {
  toolName: string;
  inputMapping: Record<string, string | { from: string; path: string }>;
}

export interface ToolChainResult {
  steps: Array<{ stepId: string; toolName: string; output: unknown; durationMs: number }>;
  finalOutput: unknown;
  totalDurationMs: number;
}

export class ToolChainError extends Error {
  constructor(public readonly stepId: string, public readonly toolName: string, detail: string) {
    super(`[ToolChain] Step "${stepId}" (tool: "${toolName}") failed: ${detail}`);
    this.name = 'ToolChainError';
  }
}

export class ToolChainComposer {
  constructor(private readonly registry: IToolRegistry) {}

  async execute(
    steps: ToolChainStep[],
    initialContext: Record<string, unknown>,
    secCtx: ISecurityContext,
  ): Promise<ToolChainResult> {
    const stepOutputs: Record<string, unknown> = { _initial: initialContext };
    const results: ToolChainResult['steps'] = [];
    const chainStart = Date.now();

    for (const [idx, step] of steps.entries()) {
      const stepId = `step_${idx}_${step.toolName}`;
      const resolvedInput = this.resolveInput(step.inputMapping, stepOutputs);
      const result = await this.registry.invoke(step.toolName, resolvedInput, secCtx);

      if (result.status === 'error') {
        throw new ToolChainError(stepId, step.toolName, result.error ?? 'unknown');
      }
      stepOutputs[stepId] = result.output;
      results.push({ stepId, toolName: step.toolName, output: result.output, durationMs: result.durationMs });
    }

    return {
      steps: results,
      finalOutput: results.at(-1)?.output,
      totalDurationMs: Date.now() - chainStart,
    };
  }

  private resolveInput(
    mapping: ToolChainStep['inputMapping'],
    outputs: Record<string, unknown>,
  ): Record<string, unknown> {
    return Object.fromEntries(
      Object.entries(mapping).map(([key, spec]) => [
        key,
        typeof spec === 'string' ? spec : this.dotPath(outputs[spec.from], spec.path),
      ]),
    );
  }

  private dotPath(obj: unknown, path: string): unknown {
    return path.split('.').reduce((acc, k) => (acc as Record<string, unknown>)?.[k], obj);
  }
}
