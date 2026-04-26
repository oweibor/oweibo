// packages/core-engine/src/pipeline/stages/09-documentation.stage.ts
// v8 §16d.7: DocumentationAgent runs after smoke-test and writes
// docs/user-guide.md, docs/developer.md, docs/api-reference.md into the bundle.
import { createHash } from 'crypto';
import type { IPipelineStage, IStageContext, IStageResult, ArtifactFile, ArtifactBundle } from '@oweibo/core-contracts';
import { DocumentationAgent } from '../../agentic/DocumentationAgent.js';

export class DocumentationStage implements IPipelineStage {
  readonly name = 'documentation';

  async execute(ctx: IStageContext): Promise<IStageResult> {
    const { bundle, llm, logger, workspacePath, fs } = ctx;
    const agent = new DocumentationAgent(llm);

    const testSummaries = bundle.testFiles
      .slice(0, 10)
      .map(t => `${t.path}: ${t.content.slice(0, 400).replace(/\s+/g, ' ').trim()}`);

    try {
      const docs = await agent.generateDocs({
        knowledgeArtifact:    bundle.knowledgeArtifact,
        clarificationHistory: ctx.originalRequirements,
        adrs:                 [],
        testSummaries,
      });

      const stagingPath = `${workspacePath}/staging`;
      const artifactFiles: ArtifactFile[] = [];
      for (const doc of docs) {
        await fs.writeFile(`${stagingPath}/${doc.path}`, doc.content);
        artifactFiles.push({
          path:     doc.path,
          content:  doc.content,
          encoding: 'utf-8',
          checksum: createHash('sha256').update(doc.content).digest('hex'),
        });
      }

      // bundle.docFiles is typed readonly on ArtifactBundle but pipeline stages
      // accumulate artifacts on the live bundle object. Cast to the concrete
      // mutable shape to append without widening the public type.
      (bundle as Mutable<ArtifactBundle>).docFiles = [...bundle.docFiles, ...artifactFiles];

      logger.info(`[Stage 09] DocumentationAgent generated ${artifactFiles.length} doc file(s).`);
      return { passed: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`[Stage 09] Documentation generation failed: ${msg}. Continuing without docs.`);
      // Doc generation is non-blocking: a module without docs still ships.
      return { passed: true };
    }
  }
}

type Mutable<T> = { -readonly [P in keyof T]: T[P] };
