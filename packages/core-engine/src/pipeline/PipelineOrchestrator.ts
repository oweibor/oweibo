// packages/core-engine/src/pipeline/PipelineOrchestrator.ts
// Runs all 11 pipeline stages in sequence against a swarm-produced ArtifactBundle (§8)
import type {
  ArtifactBundle, PipelineTaskInput, PipelineTaskOutput,
  ISandbox, ILLMClient, IPipelineStage, IStageContext, IStageFileSystem,
} from '@oweibo/core-contracts';
import type { LongTermMemoryStore } from '../agentic/LongTermMemoryStore.js';
import type { PromptRegistry } from '../observability/PromptRegistry.js';
import type { TaskEventBus } from '../ingestion/TaskEventBus.js';
import type { LangfuseTraceClient } from 'langfuse';
import { MemoryRetrievalStage }    from './stages/00-memory-retrieval.stage.js';
import { ArchitectStage }          from './stages/01-architect.stage.js';
import { OrchestrateStage }        from './stages/02-orchestrate.stage.js';
import { TDDGateStage }            from './stages/03-tdd-gate.stage.js';
import { CriticGateStage }         from './stages/03b-critic-gate.stage.js';
import { StaticGateStage }         from './stages/04-static-gate.stage.js';
import { DeterministicGateStage }  from './stages/05-deterministic-gate.stage.js';
import { SemanticGateStage }       from './stages/06-semantic-gate.stage.js';
import { ComplianceGateStage }     from './stages/06b-compliance-gate.stage.js';
import { ADRGateStage }            from './stages/07-adr-gate.stage.js';
import { PromoteStage }            from './stages/08-promote.stage.js';
import { SmokeTestStage }          from './stages/08b-smoke-test.stage.js';
import { DocumentationStage }      from './stages/09-documentation.stage.js';
import { EntropyTracker }          from '../agentic/EntropyTracker.js';
import type { Redis }              from 'ioredis';
import * as fsNode                 from 'fs/promises';
import * as pathNode               from 'path';

export interface PipelineOrchestratorDeps {
  sandbox:        ISandbox;
  llm:            ILLMClient;
  memory:         LongTermMemoryStore;
  promptRegistry: PromptRegistry;
  eventBus:       TaskEventBus;
  /** Redis client used by EntropyTracker for cross-worker rule-of-3 detection (G17). */
  redis?:         Redis;
}

const STAGE_ORDER = [
  '00-memory', '01-architect', '02-orchestrate', '03-tdd',
  '03b-critic', '04-static', '05-deterministic', '06-semantic',
  '06b-compliance', '07-adr', '08-promote', '08b-smoke', '09-documentation',
] as const;

const STAGE_PROGRESS: Record<string, number> = {
  '00-memory': 30, '01-architect': 35, '02-orchestrate': 40, '03-tdd': 45,
  '03b-critic': 50, '04-static': 55, '05-deterministic': 60, '06-semantic': 70,
  '06b-compliance': 75, '07-adr': 80, '08-promote': 85, '08b-smoke': 88, '09-documentation': 92,
};

export class PipelineOrchestrator {
  private readonly stages: Map<string, IPipelineStage>;

  constructor(private readonly deps: PipelineOrchestratorDeps) {
    this.stages = new Map<string, IPipelineStage>([
      ['00-memory',         new MemoryRetrievalStage()],
      ['01-architect',      new ArchitectStage()],
      ['02-orchestrate',    new OrchestrateStage()],
      ['03-tdd',            new TDDGateStage()],
      ['03b-critic',        new CriticGateStage()],
      ['04-static',         new StaticGateStage()],
      ['05-deterministic',  new DeterministicGateStage()],
      ['06-semantic',       new SemanticGateStage()],
      ['06b-compliance',    new ComplianceGateStage()],
      ['07-adr',            new ADRGateStage()],
      ['08-promote',        new PromoteStage()],
      ['08b-smoke',         new SmokeTestStage()],
      ['09-documentation',  new DocumentationStage()],
    ]);
  }

  async run(
    bundle:    ArtifactBundle,
    input:     PipelineTaskInput,
    trace:     LangfuseTraceClient,
    sessionId: string,
  ): Promise<PipelineTaskOutput> {
    const { sandbox, llm, memory, promptRegistry, eventBus } = this.deps;
    const workspacePath = `/workspaces/${input.scaffoldInput.tenantId}/${input.instruction.slice(0, 20).replace(/\W/g, '-')}`;

    const logger = {
      info:  (msg: string) => console.info(`[Pipeline] ${msg}`),
      warn:  (msg: string) => console.warn(`[Pipeline] ${msg}`),
      error: (msg: string) => console.error(`[Pipeline] ${msg}`),
    };

    const fs: IStageFileSystem = {
      writeFile: async (p, content) => {
        await fsNode.mkdir(pathNode.dirname(p), { recursive: true });
        await fsNode.writeFile(p, content, 'utf8');
      },
      readFile: async (p) => fsNode.readFile(p, 'utf8'),
      exists:   async (p) => fsNode.access(p).then(() => true).catch(() => false),
    };

    const ctx: IStageContext = {
      bundle,
      sandbox,
      fs,
      workspacePath,
      llm,
      llmConfig:            { model: process.env['LLM_MODEL'] ?? 'claude-sonnet-4-6', temperature: 0.1 },
      promptRegistry,
      memory: memory as unknown as IStageContext['memory'],
      originalRequirements: '',
      scaffoldInput:        input.scaffoldInput,
      trace,
      logger,
      taskId:               input.instruction,
      sessionId,
    };

    const decisionLog: any[] = [];
    const pushDecision = (stage: string, result: string) => decisionLog.push({
      id: `${stage}-${Date.now()}`, stage, result, decision: result, rationale: result,
      requirementRef: '', alternatives: [], rejectedReasons: [], timestamp: new Date().toISOString(),
    });
    const tokensUsed = 0;

    // G17: Rule-of-3 entropy detection. Emits an EntropyViolation when a stage
    // fails 3+ times with semantically similar errors so the caller can trigger
    // an Architect Reset instead of looping indefinitely.
    const entropy = this.deps.redis ? new EntropyTracker(this.deps.redis, ctx.taskId) : null;

    for (const stageName of STAGE_ORDER) {
      const stage    = this.stages.get(stageName)!;
      const progress = STAGE_PROGRESS[stageName] ?? 50;

      await eventBus.publish(sessionId, { taskId: ctx.taskId, type: 'stage-started', message: `Running ${stage.name}...`, progress });

      const result = await stage.execute(ctx);
      pushDecision(stageName, result.passed ? 'PASS' : `FAIL:${result.errorCode}`);

      if (result.passed) {
        await entropy?.recordSuccess(stageName);
      } else {
        const violation = await entropy?.recordFailure(stageName, result.message ?? result.errorCode ?? 'unknown');
        if (violation) {
          logger.error(`[Pipeline] Entropy ${violation.recommendation} triggered for ${stageName} after ${violation.attempts} attempts.`);
          return {
            taskId:      ctx.taskId,
            status:      'failed',
            stage:       stageName,
            error: {
              stage:            stageName,
              attempt:          violation.attempts,
              maxAttempts:      3,
              errorCode:        'GATE_FAILED',
              message:          `Entropy ${violation.recommendation}: ${violation.errorPattern}`,
              recoveryStrategy: violation.recommendation === 'architect-reset' ? 'architect-replan'
                              : violation.recommendation === 'human-escalation' ? 'human-escalation'
                              : 'retry',
            },
            decisionLog,
            tokensUsed,
          };
        }
      }

      if (!result.passed && result.blockPromotion) {
        return {
          taskId:      ctx.taskId,
          status:      'failed',
          stage:       stageName,
          error: {
            stage:            stageName,
            attempt:          1,
            maxAttempts:      3,
            errorCode:        (result.errorCode ?? 'GATE_FAILED') as 'GATE_FAILED',
            message:          result.message ?? 'Stage failed',
            recoveryStrategy: 'retry',
          },
          decisionLog,
          tokensUsed,
        };
      }
    }

    await eventBus.publish(sessionId, { taskId: ctx.taskId, type: 'stage-completed', message: 'All pipeline gates passed.', progress: 90 });

    return { taskId: ctx.taskId, status: 'success', stage: '08b-smoke', artifacts: bundle, decisionLog, tokensUsed };
  }
}
