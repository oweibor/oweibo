// packages/core-engine/src/pipeline/stages/03-tdd-gate.stage.ts
// Runs Jest inside gVisor sandbox against bundle.testFiles
import type { IPipelineStage, IStageContext, IStageResult } from '@oweibo/core-contracts';

export class TDDGateStage implements IPipelineStage {
  readonly name = 'tdd-gate';

  async execute(ctx: IStageContext): Promise<IStageResult> {
    const { bundle, sandbox, workspacePath, fs, logger } = ctx;

    if (!bundle.testFiles || bundle.testFiles.length === 0) {
      return { passed: false, errorCode: 'NO_TESTS', message: 'No test files generated. TDD requires at least one test file.', blockPromotion: true, recoveryHint: 'Generate Jest test files that cover the main business logic.' };
    }

    // Write test + source files to workspace
    for (const f of [...bundle.files, ...bundle.testFiles]) {
      await fs.writeFile(`${workspacePath}/${f.path}`, f.content);
    }

    const result = await sandbox.execute(
      `cd ${workspacePath} && npx jest --no-coverage --passWithNoTests --testTimeout=30000 2>&1`,
      'bash',
    );

    if (result.exitCode !== 0) {
      const failLines = result.stdout.split('\n').filter(l => /FAIL |✕ |● /.test(l)).slice(0, 10);
      return { passed: false, errorCode: 'TEST_FAILURES', message: `Tests failed:\n${failLines.join('\n')}`, rawOutput: result.stdout, blockPromotion: true, recoveryHint: 'Fix failing tests. Do not delete or skip tests.' };
    }

    logger.info(`[Stage 03] TDD gate passed. ${bundle.testFiles.length} test file(s) all passed.`);
    return { passed: true };
  }
}
