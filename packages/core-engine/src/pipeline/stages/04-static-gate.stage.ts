// packages/core-engine/src/pipeline/stages/04-static-gate.stage.ts
import type { IPipelineStage, IStageContext, IStageResult } from '@oweibo/core-contracts';

export class StaticGateStage implements IPipelineStage {
  readonly name = 'static-gate';

  async execute(ctx: IStageContext): Promise<IStageResult> {
    const { bundle, workspacePath, sandbox, fs, logger } = ctx;

    for (const f of [...bundle.files, ...bundle.testFiles]) {
      await fs.writeFile(`${workspacePath}/${f.path}`, f.content);
    }

    // 1. TypeScript compilation
    const tscResult = await sandbox.execute(`cd ${workspacePath} && npx tsc --noEmit --strict 2>&1`, 'bash');
    if (tscResult.exitCode !== 0) {
      return { passed: false, errorCode: 'TYPE_ERRORS', message: `TypeScript compilation failed:\n${tscResult.stdout.slice(0, 2000)}`, rawOutput: tscResult.stdout, blockPromotion: true, recoveryHint: 'Fix all TypeScript type errors.' };
    }

    // 2. ESLint
    const eslintResult = await sandbox.execute(`cd ${workspacePath} && npx eslint . --ext .ts,.tsx --format json 2>&1 || true`, 'bash');
    try {
      const parsed = JSON.parse(eslintResult.stdout) as Array<{ errorCount: number; filePath: string; messages: Array<{ severity: number; message: string }> }>;
      const eslintErrors = parsed.reduce((sum, f) => sum + f.errorCount, 0);
      if (eslintErrors > 0) {
        const firstErrors = parsed.flatMap(f => f.messages.filter(m => m.severity === 2).map(m => `${f.filePath}: ${m.message}`)).slice(0, 5);
        return { passed: false, errorCode: 'LINT_ERRORS', message: `ESLint: ${eslintErrors} error(s):\n${firstErrors.join('\n')}`, blockPromotion: true, recoveryHint: 'Fix ESLint errors.' };
      }
    } catch { logger.warn('[Stage 04] ESLint output not valid JSON.'); }

    // 3. Secret scanning
    const secretPatterns = [
      /['"](?:sk|pk)_(?:live|test)_[A-Za-z0-9]{20,}['"]/,
      /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/,
      /(?:password|secret|api_?key)\s*[:=]\s*['"][^'"]{8,}['"]/i,
    ];
    for (const f of bundle.files) {
      for (const pattern of secretPatterns) {
        if (pattern.test(f.content)) {
          return { passed: false, errorCode: 'HARDCODED_SECRET', message: `Potential hardcoded secret in ${f.path}.`, blockPromotion: true, recoveryHint: 'Replace hardcoded credentials with process.env lookups.' };
        }
      }
    }

    logger.info('[Stage 04] Static gate passed.');
    return { passed: true };
  }
}
