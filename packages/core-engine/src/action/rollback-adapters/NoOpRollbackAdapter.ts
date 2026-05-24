/**
 * S.3: NoOpRollbackAdapter — a baseline adapter that always reports
 * success. Used by:
 *   - tests as the simplest happy-path adapter
 *   - dev environments to satisfy the registry without wiring real infra
 *   - actions whose rollback truly is a no-op (e.g. local scratch writes
 *     where the workspace is ephemeral)
 *
 * Production wires real adapters (postgres / git / slack / webhook) and
 * the orchestrator routes by adapter name. NoOp is the safety net so
 * a missing adapter at runtime can be replaced with this rather than
 * leaving operators with a dead rollback button.
 */
import type {
  IRollbackAdapter,
  RollbackContext,
  RollbackEnvelope,
  RollbackResult,
} from '@oweibo/core-contracts';

export class NoOpRollbackAdapter implements IRollbackAdapter {
  readonly name: string;

  constructor(name = 'noop') {
    this.name = name;
  }

  async preflight(_envelope: RollbackEnvelope, _ctx: RollbackContext): Promise<void> {
    // No-op adapter accepts every preflight.
  }

  async execute(_envelope: RollbackEnvelope, _ctx: RollbackContext): Promise<RollbackResult> {
    return {
      success: true,
      state: 'fully_reverted',
      details: 'no-op adapter — nothing to revert',
      sideEffects: [],
      costUsdCents: 0,
    };
  }
}
