/**
 * IPipelineStage — contract all 11 pipeline stages implement.
 * Stages receive IStageContext (assembled by PipelineOrchestrator) and return IStageResult.
 */
import type { ArtifactBundle } from '../types/ArtifactBundle.js';
import type { ScaffoldInput } from '../types/ScaffoldInput.js';
import type { ISandbox } from '../types/AgentTypes.js';
import type { ILLMClient } from '../types/AgentTypes.js';

export interface IStageFileSystem {
  writeFile(path: string, content: string): Promise<void>;
  readFile(path: string): Promise<string>;
  exists(path: string): Promise<boolean>;
}

/** Minimal prompt registry interface — full implementation in core-engine/observability */
export interface IPromptRegistry {
  get(promptName: string): Promise<{ text: string; version: number }>;
}

/** Minimal LongTermMemoryStore interface used by pipeline stages */
export interface IStageLongTermMemory {
  recall(query: string, types?: string[], limit?: number): Promise<Array<{ summary: string; [key: string]: unknown }>>;
  store(entry: Record<string, unknown>): Promise<void>;
}

export interface IStageContext {
  bundle:               ArtifactBundle;
  sandbox:              ISandbox;
  fs:                   IStageFileSystem;
  workspacePath:        string;
  llm:                  ILLMClient;
  llmConfig:            { model: string; temperature: number };
  promptRegistry:       IPromptRegistry;
  memory:               IStageLongTermMemory;
  originalRequirements: string;
  scaffoldInput:        ScaffoldInput;
  trace:                unknown;  // LangfuseTraceClient — typed loosely to avoid langfuse dep
  logger:               { info(msg: string): void; warn(msg: string): void; error(msg: string): void };
  taskId:               string;
  sessionId:            string;
}

export interface IStageResult {
  passed:         boolean;
  errorCode?:     string;
  message?:       string;
  rawOutput?:     string;
  blockPromotion?: boolean;  // true = pipeline halts; recovery loop triggered
  recoveryHint?:  string;
}

export interface IPipelineStage {
  readonly name: string;
  execute(ctx: IStageContext): Promise<IStageResult>;
}
