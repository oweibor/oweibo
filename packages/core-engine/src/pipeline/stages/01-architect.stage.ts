// packages/core-engine/src/pipeline/stages/01-architect.stage.ts
import { CANONICAL_ROLES } from '@oweibo/core-contracts';
import type { CanonicalRole, IPipelineStage, IStageContext, IStageResult } from '@oweibo/core-contracts';

export class ArchitectStage implements IPipelineStage {
  readonly name: CanonicalRole = CANONICAL_ROLES[0]!;

  async execute(ctx: IStageContext): Promise<IStageResult> {
    const { bundle, logger } = ctx;
    if (!bundle.files || bundle.files.length === 0) {
      return { passed: false, errorCode: 'NO_FILES', message: 'ArchitectAgent produced no source files.', blockPromotion: true };
    }
    if (!bundle.knowledgeArtifact) {
      return { passed: false, errorCode: 'NO_KNOWLEDGE_ARTIFACT', message: 'ArchitectAgent produced no knowledgeArtifact.', blockPromotion: true };
    }
    if (!bundle.knowledgeArtifact.userFlows?.length) logger.warn('[Stage 01] knowledgeArtifact.userFlows is empty.');
    if (!bundle.knowledgeArtifact.glossary?.length)   logger.warn('[Stage 01] knowledgeArtifact.glossary is empty.');
    for (const f of [...bundle.files, ...bundle.testFiles]) {
      if (!f.path || !f.content) {
        return { passed: false, errorCode: 'MALFORMED_FILE', message: `File missing path or content: ${JSON.stringify(f).slice(0, 100)}`, blockPromotion: true };
      }
    }
    logger.info(`[Stage 01] Architect validation passed. ${bundle.files.length} source files, ${bundle.testFiles.length} test files.`);
    return { passed: true };
  }
}
