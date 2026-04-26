/**
 * IGoal — the top-level goal submitted to CognitiveEngine for decomposition.
 */
export interface IGoal {
  readonly description: string;
  readonly context?: string;
}

/**
 * ISubGoal — a decomposed goal leaf or intermediate node.
 * Children form a DAG; dependsOn encodes sequencing constraints.
 */
export interface ISubGoal {
  readonly description: string;
  readonly toolName?: string;
  readonly input?: Readonly<Record<string, unknown>>;
  readonly dependsOn?: readonly string[];
  readonly children?: readonly ISubGoal[];
}

/**
 * Plan — the output of MultiStrategyPlanner.
 * Moved from core-engine to core-contracts (C-7/A-2) to respect boundary rules —
 * modules that need to inspect the active plan import from here, not core-engine.
 */
export interface Plan {
  readonly id: string;
  readonly strategy: string;
  readonly subGoals: readonly ISubGoal[];
  readonly feasibilityScore: number;
  readonly riskScore: number;
  readonly estimatedTokens: number;
}
