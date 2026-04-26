// packages/core-engine/src/pipeline/stages/00-memory-retrieval.stage.ts
import type { IPipelineStage, IStageContext, IStageResult } from '@oweibo/core-contracts';

export class MemoryRetrievalStage implements IPipelineStage {
  readonly name = 'memory-retrieval';

  async execute(ctx: IStageContext): Promise<IStageResult> {
    const { memory, scaffoldInput, logger } = ctx;
    const recalled = await memory.recall(
      `${scaffoldInput.appName} ${scaffoldInput.stack} ${scaffoldInput.features.join(' ')}`,
      ['successful-strategy', 'tool-heuristic', 'domain-pattern'],
      8,
    );
    (ctx as unknown as Record<string, unknown>)['originalRequirements'] =
      `App: ${scaffoldInput.appName}\nStack: ${scaffoldInput.stack}\nFeatures: ${scaffoldInput.features.join(', ')}\n` +
      (recalled.length ? `Relevant past strategies:\n${recalled.map(m => `- ${m.summary}`).join('\n')}` : 'No relevant past strategies found.');
    logger.info(`[Stage 00] Memory retrieval: ${recalled.length} entries recalled.`);
    return { passed: true };
  }
}
