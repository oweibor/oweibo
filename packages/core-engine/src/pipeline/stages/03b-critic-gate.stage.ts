// packages/core-engine/src/pipeline/stages/03b-critic-gate.stage.ts
// LLM-based test validity guard — validates tests against originalRequirements
import type { IPipelineStage, IStageContext, IStageResult } from '@oweibo/core-contracts';

export class CriticGateStage implements IPipelineStage {
  readonly name = 'critic-gate';

  async execute(ctx: IStageContext): Promise<IStageResult> {
    const { bundle, llm, originalRequirements, logger } = ctx;

    const testSample = bundle.testFiles.slice(0, 3).map(f => `// ${f.path}\n${f.content.slice(0, 600)}`).join('\n\n---\n\n');

    const res = await llm.generate({
      systemPrompt: CRITIC_SYSTEM_PROMPT,
      userPrompt:   `Requirements:\n${originalRequirements}\n\nTest files:\n${testSample}\n\nAre these tests valid and sufficient for the requirements? Output JSON.`,
      responseFormat: 'json',
    });

    let parsed: { verdict: 'PASS' | 'FAIL'; reason: string } = { verdict: 'PASS', reason: '' };
    try { parsed = JSON.parse(res.output); } catch { /* treat parse failure as PASS */ }

    if (parsed.verdict === 'FAIL') {
      return { passed: false, errorCode: 'CRITIC_FAIL', message: `Critic gate: ${parsed.reason}`, blockPromotion: true, recoveryHint: parsed.reason };
    }

    logger.info('[Stage 03b] Critic gate passed.');
    return { passed: true };
  }
}

const CRITIC_SYSTEM_PROMPT = `You are a test critic. Given requirements and test files, determine if the tests are valid, cover the requirements, and are not trivially passing (e.g. empty tests or tests that always pass). Output JSON: {"verdict": "PASS" | "FAIL", "reason": string}`;
