import type { ArtifactBundle } from '../types/ArtifactBundle.js';
import type { ScaffoldInput } from '../types/ScaffoldInput.js';
import type { DecisionLog } from '../types/AgentTypes.js';
/**
 * PipelineError — canonical error shape for pipeline stage failures.
 */
export interface PipelineError {
    readonly stage: string;
    readonly attempt: number;
    readonly maxAttempts: number;
    readonly errorCode: 'GATE_FAILED' | 'SANDBOX_TIMEOUT' | 'LLM_HALLUCINATION' | 'CIRCUIT_OPEN';
    readonly message: string;
    readonly recoveryStrategy: 'retry' | 'context-reset' | 'architect-replan' | 'human-escalation';
}
/**
 * PipelineTaskInput — agentic core → pipeline tool invocation contract.
 * The entire 9-stage kilo-pipeline is registered in ToolRegistry as a complex tool.
 * CognitiveEngine provides this structured instruction; the pipeline streams status
 * events back via TaskEventBus.
 */
export interface PipelineTaskInput {
    readonly instruction: string;
    readonly scaffoldInput: ScaffoldInput;
    readonly workspacePath: string;
    /** Max tokens the pipeline may consume for context loading */
    readonly tokenBudget: number;
    readonly trustMode: 'supervised' | 'graduated';
}
/**
 * PipelineTaskOutput — streamed back via TaskEventBus; final state at GET /status/:taskId.
 */
export interface PipelineTaskOutput {
    readonly taskId: string;
    readonly status: 'pending' | 'running' | 'success' | 'failed' | 'circuit-open';
    readonly stage: string;
    readonly artifacts?: ArtifactBundle;
    readonly error?: PipelineError;
    readonly decisionLog: readonly DecisionLog[];
    readonly tokensUsed: number;
}
//# sourceMappingURL=IPipelineTool.d.ts.map