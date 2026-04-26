// packages/core-engine/src/pipeline/stages/08b-smoke-test.stage.ts
// Starts the promoted app in gVisor sandbox and hits /health (§8b)
import type { IPipelineStage, IStageContext, IStageResult } from '@oweibo/core-contracts';

export class SmokeTestStage implements IPipelineStage {
  readonly name = 'smoke-test';

  async execute(ctx: IStageContext): Promise<IStageResult> {
    const { workspacePath, sandbox, logger } = ctx;
    const stagingPath = `${workspacePath}/staging`;

    // Install deps and start app in background
    const startResult = await sandbox.execute(
      `cd ${stagingPath} && npm install --production 2>&1 && node dist/index.js &`,
      'bash',
    );
    if (startResult.exitCode !== 0 && !startResult.stdout.includes('[listening]')) {
      logger.warn('[Stage 08b] App may not have started — proceeding with health check anyway.');
    }

    // Poll /health for up to 60s
    const port = process.env.APP_PORT ?? '3000';
    for (let attempt = 0; attempt < 12; attempt++) {
      await new Promise(r => setTimeout(r, 5000));
      const healthResult = await sandbox.execute(`curl -sf http://localhost:${port}/health 2>&1`, 'bash');
      if (healthResult.exitCode === 0) {
        logger.info(`[Stage 08b] Smoke test passed — /health responded 200 at attempt ${attempt + 1}.`);
        return { passed: true };
      }
    }

    return { passed: false, errorCode: 'SMOKE_TEST_TIMEOUT', message: `/health did not respond with 200 within 60s on port ${port}.`, blockPromotion: true, recoveryHint: 'Ensure the app starts correctly, listens on process.env.PORT, and implements GET /health returning 200.' };
  }
}
