/**
 * S.5.a: DeploymentContentInspector — guards `deploy.prod` actions.
 *
 * Refuses deployments whose artifact hash is not present in the tenant's
 * approved build registry. The registry lookup is pluggable; the default
 * resolver accepts a synchronous in-memory allowlist for tests and a
 * Promise-returning loader for production wiring.
 *
 * Payload shape expected:
 *   { artifactHash: string; version?: string; env?: 'prod' | 'staging'; ... }
 *
 * Outright forbids:
 *   * missing artifactHash
 *   * artifactHash not in approved registry
 *   * env explicitly not 'prod' but action_class says deploy.prod
 *
 * Upgrades to require_approval:
 *   * tenant has no registry resolver wired (open-fail would silently
 *     skip the check — fail-closed instead)
 */
import type {
  ActionContext,
  ContentInspectionResult,
  IContentInspector,
} from '@oweibo/core-contracts';

interface DeployPayload {
  artifactHash?: string;
  version?: string;
  env?: string;
}

export interface IApprovedBuildRegistry {
  /** Returns true if hash is an approved build for the tenant. */
  isApproved(tenantId: string, artifactHash: string): Promise<boolean>;
}

export class DeploymentContentInspector implements IContentInspector {
  readonly name = 'deployment_artifact';

  constructor(private readonly registry?: IApprovedBuildRegistry) {}

  appliesTo(actionClass: string): boolean {
    return actionClass === 'deploy.prod';
  }

  async inspect(ctx: ActionContext): Promise<ContentInspectionResult> {
    const p = (ctx.payload ?? {}) as DeployPayload;

    if (!p.artifactHash || typeof p.artifactHash !== 'string') {
      return {
        verdict: 'forbid',
        reason: 'deploy.prod payload missing artifactHash',
        details: { matched: 'NO_ARTIFACT_HASH' },
      };
    }
    if (p.env && p.env !== 'prod') {
      return {
        verdict: 'forbid',
        reason: `deploy.prod action carries env='${p.env}' (mismatch with action class)`,
        details: { matched: 'ENV_MISMATCH', env: p.env },
      };
    }
    if (!this.registry) {
      return {
        verdict: 'upgrade_to_approval',
        reason: 'no approved-build registry wired — manual approval required',
        details: { matched: 'NO_REGISTRY' },
      };
    }
    const approved = await this.registry.isApproved(ctx.tenantId, p.artifactHash);
    if (!approved) {
      return {
        verdict: 'forbid',
        reason: `artifact hash ${truncate(p.artifactHash)} is not in approved build registry`,
        details: { matched: 'HASH_NOT_APPROVED', artifactHash: p.artifactHash },
      };
    }
    return { verdict: 'allow' };
  }
}

function truncate(s: string, n = 12): string {
  if (s.length <= n) return s;
  return `${s.slice(0, n)}…`;
}
