/**
 * calibration.routes.ts — F.4.6 HTTP surface for the tenant readiness
 * snapshot. Backs the admin-web CalibrationBadge (already shipped) and
 * a future /onboarding readiness page (F.4.8).
 *
 *   GET /tenants/:tenantId/calibration  — current readiness snapshot
 *
 * Response shape matches the badge's existing contract — the badge
 * currently calls identity-service, but per the F.4 URL convention the
 * canonical surface is here on the pipeline service. Identity's mirror
 * stays for backwards compatibility until F.4.8 migrates the badge.
 *
 *   { tenantId, score, threshold, summary, signals,
 *     gateEnabled, meetsAutonomousThreshold,
 *     actionClassScores, snapshotAt, sourceSig }
 */
import { Router, type Response } from 'express';
import type { AuthenticatedRequest } from '../middleware/authenticate.js';
import { requireTenantParamMatchesJwt } from '../middleware/tenantParam.js';
import type { CalibrationService } from '../../infrastructure/CalibrationService.js';

/**
 * Mirrors apps/identity's `AUTONOMOUS_GATE_THRESHOLD`. Stay in sync —
 * identity's tenant.ts comments call out the duplication.
 */
const AUTONOMOUS_GATE_THRESHOLD = 0.6;

export interface CalibrationRouterDeps {
  readonly calibration: CalibrationService;
  /**
   * Override the autonomous-gate flag. Default reads
   * TENANT_CALIBRATION_GATE_AUTONOMOUS_ENABLED, matching identity-service.
   */
  readonly gateEnabled?: () => boolean;
}

export function createCalibrationRouter(deps: CalibrationRouterDeps): Router {
  const gateEnabled = deps.gateEnabled
    ?? (() => process.env['TENANT_CALIBRATION_GATE_AUTONOMOUS_ENABLED'] === 'true');

  const router = Router({ mergeParams: true });
  router.use(requireTenantParamMatchesJwt as unknown as import('express').RequestHandler);

  router.get('/', async (req, res) => {
    const r = req as unknown as AuthenticatedRequest;
    try {
      const readiness = await deps.calibration.compute(r.tenantId);
      // Flatten the badge-facing signal subset (numbers + booleans only,
      // matching identity's existing response). Full per-class scores +
      // raw signals also surface so a downstream page can show detail.
      const badgeSignals: Record<string, number | boolean> = {
        accountAgeDays: readiness.signals.accountAgeDays,
        organicMemoryCount: readiness.signals.organicMemoryCount,
        slotsWithLearnedArms: readiness.signals.slotsWithLearnedArms,
        completedTaskCount: readiness.signals.completedTaskCount,
        bootstrapReady: readiness.signals.bootstrapReady,
      };
      res.json({
        tenantId: r.tenantId,
        score: readiness.score,
        threshold: AUTONOMOUS_GATE_THRESHOLD,
        summary: readiness.summary,
        signals: badgeSignals,
        gateEnabled: gateEnabled(),
        meetsAutonomousThreshold: readiness.score >= AUTONOMOUS_GATE_THRESHOLD,
        actionClassScores: readiness.actionClassScores,
        snapshotAt: readiness.snapshotAt,
        sourceSig: readiness.sourceSig,
      });
    } catch (err) {
      handleError(err, res);
    }
  });

  return router;
}

function handleError(err: unknown, res: Response): void {
  const message = err instanceof Error ? err.message : 'internal_error';
  res.status(500).json({ error: 'internal_error', message });
}
