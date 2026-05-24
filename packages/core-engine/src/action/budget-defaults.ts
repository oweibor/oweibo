/**
 * S.6: hand-tuned per-class budget defaults. The bottom layer of the
 * BudgetEstimator's three-tier resolver — used only when neither the
 * tenant's history nor the platform-wide priors carry signal.
 *
 * Values are conservative defaults expressed in USD cents per action.
 * Real estimates (tenant history / platform priors) almost always
 * override these; treat the table below as a safety net for cold
 * starts at platform bootstrap.
 */
import type { ActionClass } from '@oweibo/core-contracts';

interface DefaultEntry {
  /** Prefix-matched against actionClass; longest match wins. */
  readonly prefix: string;
  readonly costCents: number;
}

const PLATFORM_BUDGET_DEFAULTS: readonly DefaultEntry[] = [
  { prefix: 'read.local',                  costCents: 0 },
  { prefix: 'read.tenant_db',              costCents: 0 },
  { prefix: 'read.external_api',           costCents: 2 },
  { prefix: 'write.local.scratch',         costCents: 0 },
  { prefix: 'write.local.repo_nonprod',    costCents: 1 },
  { prefix: 'write.local.repo_prod',       costCents: 2 },
  { prefix: 'write.tenant_db.nonprod',     costCents: 1 },
  { prefix: 'write.tenant_db.prod',        costCents: 5 },
  { prefix: 'write.external_api.nonprod',  costCents: 5 },
  { prefix: 'write.external_api.prod',     costCents: 25 },
  { prefix: 'comm.internal',               costCents: 1 },
  { prefix: 'comm.external_email',         costCents: 10 },
  { prefix: 'comm.external_message',       costCents: 10 },
  { prefix: 'financial.payment',           costCents: 50 },
  { prefix: 'personnel.access_grant',      costCents: 25 },
  { prefix: 'personnel.access_revoke',     costCents: 10 },
  { prefix: 'irreversible.delete_resource', costCents: 50 },
  { prefix: 'irreversible.public_publish', costCents: 50 },
  { prefix: 'deploy.nonprod',              costCents: 25 },
  { prefix: 'deploy.prod',                 costCents: 200 },
];

const FALLBACK_COST_CENTS = 10;

/** Pure: returns the hand-tuned default for an action class. */
export function platformBudgetDefault(actionClass: ActionClass): number {
  let best = FALLBACK_COST_CENTS;
  let bestLen = 0;
  for (const e of PLATFORM_BUDGET_DEFAULTS) {
    if (actionClass.startsWith(e.prefix) && e.prefix.length > bestLen) {
      best = e.costCents;
      bestLen = e.prefix.length;
    }
  }
  return best;
}
