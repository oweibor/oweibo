// packages/core-engine/src/pipeline/stages/05-deterministic-gate.stage.ts
import { createHash } from 'crypto';
import type { IPipelineStage, IStageContext, IStageResult } from '@oweibo/core-contracts';

export class DeterministicGateStage implements IPipelineStage {
  readonly name = 'deterministic-gate';

  async execute(ctx: IStageContext): Promise<IStageResult> {
    const { bundle, logger } = ctx;
    const ka = bundle.knowledgeArtifact;

    // 1. Checksum integrity
    for (const f of [...bundle.files, ...bundle.testFiles, ...bundle.dbMigrations]) {
      const actual = createHash('sha256').update(f.content).digest('hex');
      if (f.checksum && f.checksum !== actual) {
        return { passed: false, errorCode: 'CHECKSUM_MISMATCH', message: `Checksum mismatch for ${f.path}.`, blockPromotion: true };
      }
    }

    const sourceText = bundle.files.map(f => f.content).join('\n');

    // 2. Endpoint contract
    if (ka?.endpoints) {
      for (const ep of ka.endpoints) {
        const pathEscaped = ep.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(':id', '[^/]+');
        const routePattern = new RegExp(`(?:router|app)\\.${ep.method.toLowerCase()}\\(['"\`]${pathEscaped}`);
        const nextPattern  = new RegExp(`export\\s+async\\s+function\\s+${ep.method.toUpperCase()}`);
        if (!routePattern.test(sourceText) && !nextPattern.test(sourceText)) {
          return { passed: false, errorCode: 'MISSING_ENDPOINT', message: `Endpoint not found: ${ep.method} ${ep.path}`, blockPromotion: true, recoveryHint: `Add the missing route: router.${ep.method.toLowerCase()}('${ep.path}', handler)` };
        }
      }
    }

    // 3. Emitted events
    if (ka?.emittedEvents) {
      for (const ev of ka.emittedEvents) {
        if (!sourceText.includes(`'${ev.eventType}'`) && !sourceText.includes(`"${ev.eventType}"`)) {
          return { passed: false, errorCode: 'MISSING_EVENT_EMIT', message: `Event not emitted in source: '${ev.eventType}'`, blockPromotion: true, recoveryHint: `Add: eventBus.emit('${ev.eventType}', payload)` };
        }
      }
    }

    // 4. Consumed events — warning only
    if (ka?.consumedEvents) {
      for (const ev of ka.consumedEvents) {
        if (!sourceText.includes(`'${ev.eventType}'`) && !sourceText.includes(`"${ev.eventType}"`)) {
          logger.warn(`[Stage 05] Consumed event '${ev.eventType}' declared but no subscriber found.`);
        }
      }
    }

    logger.info('[Stage 05] Deterministic gate passed.');
    return { passed: true };
  }
}
