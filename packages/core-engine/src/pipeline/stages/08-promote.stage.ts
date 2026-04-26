// packages/core-engine/src/pipeline/stages/08-promote.stage.ts
import { createHash } from 'crypto';
import type { IPipelineStage, IStageContext, IStageResult } from '@oweibo/core-contracts';

export class PromoteStage implements IPipelineStage {
  readonly name = 'promote';

  async execute(ctx: IStageContext): Promise<IStageResult> {
    const { bundle, workspacePath, fs, logger, taskId } = ctx;
    const stagingPath = `${workspacePath}/staging`;
    const allFiles = [...bundle.files, ...bundle.testFiles, ...bundle.dbMigrations, ...bundle.k8sManifests];

    for (const f of allFiles) await fs.writeFile(`${stagingPath}/${f.path}`, f.content);

    let checksumErrors = 0;
    for (const f of allFiles) {
      const actual = createHash('sha256').update(f.content).digest('hex');
      if (f.checksum && f.checksum !== actual) { logger.error(`[Stage 08] Checksum mismatch for ${f.path}.`); checksumErrors++; }
    }
    if (checksumErrors > 0) return { passed: false, errorCode: 'PROMOTION_CHECKSUM_FAIL', message: `${checksumErrors} file(s) failed checksum during promotion.`, blockPromotion: true };

    const manifest = { taskId, promotedAt: new Date().toISOString(), fileCount: allFiles.length, bundleChecksum: createHash('sha256').update(allFiles.map(f => f.checksum ?? '').join('')).digest('hex') };
    await fs.writeFile(`${stagingPath}/.promote-manifest.json`, JSON.stringify(manifest, null, 2));
    logger.info(`[Stage 08] Promoted ${allFiles.length} files to ${stagingPath}.`);
    return { passed: true };
  }
}
