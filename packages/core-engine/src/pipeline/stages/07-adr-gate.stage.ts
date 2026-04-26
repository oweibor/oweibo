// packages/core-engine/src/pipeline/stages/07-adr-gate.stage.ts
import { randomUUID } from 'crypto';
import type { IPipelineStage, IStageContext, IStageResult } from '@oweibo/core-contracts';

export class ADRGateStage implements IPipelineStage {
  readonly name = 'adr-gate';

  async execute(ctx: IStageContext): Promise<IStageResult> {
    const { bundle, memory, scaffoldInput, logger, taskId } = ctx;
    const ka = bundle.knowledgeArtifact;

    if (ka?.invariants?.length) {
      for (const inv of ka.invariants) {
        await memory.store({ id: randomUUID(), type: 'domain-invariant', summary: `[${scaffoldInput.appName}] ${inv.description}`, detail: inv, taskId, createdAt: Date.now() });
      }
      logger.info(`[Stage 07] Stored ${ka.invariants.length} domain invariants.`);
    }

    await memory.store({ id: randomUUID(), type: 'successful-strategy', summary: `Stack=${scaffoldInput.stack} db=${scaffoldInput.database} features=[${scaffoldInput.features.join(',')}]`, detail: { scaffoldInput, entityCount: ka?.entities?.length ?? 0, endpointCount: ka?.endpoints?.length ?? 0 }, taskId, createdAt: Date.now() });
    logger.info('[Stage 07] ADR gate passed. Strategy and invariants persisted.');
    return { passed: true };
  }
}
