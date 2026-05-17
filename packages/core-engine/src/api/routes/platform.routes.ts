/**
 * platform.routes.ts — Platform governance routes (§17.5.1, §18.8.3, §9.5, §7.4.3).
 *
 * GET  /platform/operational-mode               — current mode state + transition history
 * POST /platform/operational-mode               — set mode (platform:admin)
 * GET  /platform/charter/thresholds             — current drift threshold config + recent events
 * POST /platform/charter/thresholds             — update thresholds (platform:admin)
 * GET  /platform/promotions/pending             — list arms awaiting human approval (D.6)
 * GET  /platform/promotions/recent              — recent approve/reject history (D.6)
 * POST /platform/promotions/decide              — approve or reject a promotion (platform:admin)
 * GET  /platform/prompts/mutations              — list slots with mutation_status (D.12)
 * GET  /platform/prompts/mutations/:slot/:role  — full mutation history for one slot
 * POST /platform/prompts/mutations              — change mutation_status (platform:admin)
 *
 * Scope guard: POST endpoints require 'platform:admin' in the JWT scopes claim.
 * If scopes are absent (older tokens), fall back to PLATFORM_ADMIN_KEY header.
 */
import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import type { Pool } from 'pg';
import type { AuthenticatedRequest } from '../middleware/authenticate.js';
import {
  OperationalModeService,
  MODE_NAMES,
} from '../../infrastructure/OperationalModeService.js';
import type { PromotionGateService } from '../../bandit/PromotionGateService.js';
import type { MutationGovernanceService } from '../../governance/MutationGovernanceService.js';

// ── Scope guard ───────────────────────────────────────────────────────────────

const PLATFORM_ADMIN_KEY = process.env['PLATFORM_ADMIN_KEY'];

function requirePlatformAdmin(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): void {
  // Prefer scope-based check (identity-service tokens include scopes[])
  if (req.scopes.includes('platform:admin')) {
    next();
    return;
  }
  // Fallback: shared secret header for internal service-to-service calls
  if (PLATFORM_ADMIN_KEY && req.headers['x-platform-admin-key'] === PLATFORM_ADMIN_KEY) {
    next();
    return;
  }
  res.status(403).json({
    error: 'forbidden',
    message: "Requires 'platform:admin' scope or x-platform-admin-key header.",
  });
}

// ── Request schemas ───────────────────────────────────────────────────────────

const SetModeSchema = z.object({
  mode:        z.number().int().min(0).max(5),
  reason:      z.string().min(1).max(1000),
  autoTrigger: z.string().optional(),
});

const SetThresholdsSchema = z.object({
  threshold_7d:    z.number().gt(0).lt(1),
  threshold_30d:   z.number().gt(0).lt(1),
  threshold_90d:   z.number().gt(0).lt(1),
  threshold_vs_v0: z.number().gt(0).lt(1),
  reason:          z.string().min(1).max(1000),
  changedBy:       z.string().optional(),
});

const PromotionDecisionSchema = z.object({
  armId:       z.string().min(1).max(200),
  slotId:      z.string().min(1).max(100),
  role:        z.enum(['architect', 'executor', 'reviewer', 'decomposer']),
  promptHash:  z.string().min(1).max(200),
  fromChannel: z.string().min(1).max(100),
  toChannel:   z.string().min(1).max(100),
  decision:    z.enum(['approved', 'rejected']),
  reason:      z.string().min(1).max(1000),
});

const SetMutationStatusSchema = z.object({
  slotId:    z.string().min(1).max(100),
  role:      z.string().min(1).max(50),
  newStatus: z.enum(['mutable', 'guarded', 'frozen']),
  reason:    z.string().min(1).max(1000),
  rfcUrl:    z.string().url().max(500).optional(),
});

// ── Router factory ────────────────────────────────────────────────────────────

export function createPlatformRouter(deps: {
  pool:                  Pool;
  operationalMode:       OperationalModeService;
  promotionGate?:        PromotionGateService;
  mutationGovernance?:   MutationGovernanceService;
}): Router {
  const router = Router();
  const { pool, operationalMode, promotionGate, mutationGovernance } = deps;

  // ── GET /platform/operational-mode ────────────────────────────────────────

  router.get(
    '/operational-mode',
    async (_req: Request, res: Response): Promise<void> => {
      const state   = await operationalMode.getModeState();
      const history = await operationalMode.getTransitionHistory(20);

      if (!state) {
        res.json({
          currentMode: 5,
          modeName:    MODE_NAMES[5],
          setBy:       'unknown',
          setAt:       new Date().toISOString(),
          reason:      'No mode record found — defaulting to full operation',
          autoTrigger: null,
          history:     [],
        });
        return;
      }

      res.json({
        currentMode: state.currentMode,
        modeName:    MODE_NAMES[state.currentMode],
        setBy:       state.setBy,
        setAt:       state.setAt,
        reason:      state.reason,
        autoTrigger: state.autoTrigger,
        history,
      });
    },
  );

  // ── POST /platform/operational-mode ───────────────────────────────────────

  router.post(
    '/operational-mode',
    (req, res, next) => requirePlatformAdmin(req as AuthenticatedRequest, res, next),
    async (req: Request, res: Response): Promise<void> => {
      const authed = req as AuthenticatedRequest;
      const parsed = SetModeSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_body', issues: parsed.error.issues });
        return;
      }

      const { mode, reason, autoTrigger } = parsed.data;
      await operationalMode.setMode(mode as 0 | 1 | 2 | 3 | 4 | 5, {
        reason,
        setBy: authed.userId,
        autoTrigger,
      });

      const state = await operationalMode.getModeState();
      res.json({
        ok:          true,
        currentMode: state?.currentMode ?? mode,
        modeName:    MODE_NAMES[(state?.currentMode ?? mode) as 0 | 1 | 2 | 3 | 4 | 5],
      });
    },
  );

  // ── GET /platform/charter/thresholds ──────────────────────────────────────

  router.get(
    '/charter/thresholds',
    async (_req: Request, res: Response): Promise<void> => {
      const [cfgResult, eventsResult] = await Promise.all([
        pool.query<{
          threshold_7d:    string;
          threshold_30d:   string;
          threshold_90d:   string;
          threshold_vs_v0: string;
          updated_by:      string;
          updated_at:      string;
          notes:           string | null;
        }>(
          `SELECT threshold_7d, threshold_30d, threshold_90d, threshold_vs_v0,
                  updated_by, updated_at, notes
           FROM oweibo.identity_drift_thresholds
           WHERE id = TRUE`,
        ),
        pool.query<{
          id:              string;
          detected_at:     string;
          drift_axis:      string;
          drift_magnitude: string;
          acknowledged_at: string | null;
          acknowledged_by: string | null;
        }>(
          `SELECT id, detected_at, drift_axis, drift_magnitude,
                  acknowledged_at, acknowledged_by
           FROM oweibo.identity_drift_events
           ORDER BY detected_at DESC LIMIT 20`,
        ).catch(() => ({ rows: [] as typeof eventsResult.rows })),
      ]);

      const row = cfgResult.rows[0];
      const config = row
        ? {
            threshold_7d:    parseFloat(row.threshold_7d),
            threshold_30d:   parseFloat(row.threshold_30d),
            threshold_90d:   parseFloat(row.threshold_90d),
            threshold_vs_v0: parseFloat(row.threshold_vs_v0),
            updated_by:      row.updated_by,
            updated_at:      row.updated_at,
            notes:           row.notes,
          }
        : {
            threshold_7d:    0.15,
            threshold_30d:   0.20,
            threshold_90d:   0.25,
            threshold_vs_v0: 0.35,
            updated_by:      'default',
            updated_at:      new Date().toISOString(),
            notes:           null,
          };

      const recentEvents = eventsResult.rows.map(e => ({
        id:             e.id,
        detected_at:    e.detected_at,
        drift_axis:     e.drift_axis,
        drift_magnitude: parseFloat(e.drift_magnitude),
        acknowledged_at: e.acknowledged_at,
        acknowledged_by: e.acknowledged_by,
      }));

      res.json({ config, recentEvents });
    },
  );

  // ── POST /platform/charter/thresholds ─────────────────────────────────────

  router.post(
    '/charter/thresholds',
    (req, res, next) => requirePlatformAdmin(req as AuthenticatedRequest, res, next),
    async (req: Request, res: Response): Promise<void> => {
      const authed = req as AuthenticatedRequest;
      const parsed = SetThresholdsSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_body', issues: parsed.error.issues });
        return;
      }

      const { threshold_7d, threshold_30d, threshold_90d, threshold_vs_v0, reason, changedBy } =
        parsed.data;
      const actor = changedBy ?? authed.userId;

      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        // Read current values for audit log
        const prev = await client.query<{
          threshold_7d: string;
          threshold_30d: string;
          threshold_90d: string;
          threshold_vs_v0: string;
        }>(
          `SELECT threshold_7d, threshold_30d, threshold_90d, threshold_vs_v0
           FROM oweibo.identity_drift_thresholds WHERE id = TRUE`,
        );
        const p = prev.rows[0] ?? {
          threshold_7d: '0.15', threshold_30d: '0.20',
          threshold_90d: '0.25', threshold_vs_v0: '0.35',
        };

        // Update singleton
        await client.query(
          `UPDATE oweibo.identity_drift_thresholds
           SET threshold_7d = $1, threshold_30d = $2, threshold_90d = $3,
               threshold_vs_v0 = $4, updated_by = $5, updated_at = NOW(),
               notes = $6
           WHERE id = TRUE`,
          [threshold_7d, threshold_30d, threshold_90d, threshold_vs_v0, actor, reason],
        );

        // Audit log
        await client.query(
          `INSERT INTO oweibo.identity_drift_threshold_changes
             (changed_by, prev_threshold_7d, prev_threshold_30d, prev_threshold_90d,
              prev_threshold_vs_v0, new_threshold_7d, new_threshold_30d, new_threshold_90d,
              new_threshold_vs_v0, reason)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [
            actor,
            parseFloat(p.threshold_7d), parseFloat(p.threshold_30d),
            parseFloat(p.threshold_90d), parseFloat(p.threshold_vs_v0),
            threshold_7d, threshold_30d, threshold_90d, threshold_vs_v0,
            reason,
          ],
        );

        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }

      res.json({ ok: true });
    },
  );

  // ── GET /platform/promotions/pending (D.6) ────────────────────────────────

  router.get(
    '/promotions/pending',
    async (_req: Request, res: Response): Promise<void> => {
      if (!promotionGate) {
        res.status(503).json({ error: 'promotion_gate_unavailable' });
        return;
      }
      const pending = await promotionGate.listPending();
      res.json({ pending });
    },
  );

  // ── GET /platform/promotions/recent (D.6) ─────────────────────────────────

  router.get(
    '/promotions/recent',
    async (req: Request, res: Response): Promise<void> => {
      if (!promotionGate) {
        res.status(503).json({ error: 'promotion_gate_unavailable' });
        return;
      }
      const limit = Math.min(parseInt(String(req.query['limit'] ?? '50'), 10) || 50, 200);
      const recent = await promotionGate.listRecentDecisions(limit);
      res.json({ recent });
    },
  );

  // ── POST /platform/promotions/decide (D.6) ────────────────────────────────

  router.post(
    '/promotions/decide',
    (req, res, next) => requirePlatformAdmin(req as AuthenticatedRequest, res, next),
    async (req: Request, res: Response): Promise<void> => {
      if (!promotionGate) {
        res.status(503).json({ error: 'promotion_gate_unavailable' });
        return;
      }
      const authed = req as AuthenticatedRequest;
      const parsed = PromotionDecisionSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_body', issues: parsed.error.issues });
        return;
      }
      try {
        const result = await promotionGate.recordDecision({
          ...parsed.data,
          decidedBy: authed.userId,
        });
        if (!result.ok) {
          res.status(409).json({
            error:      'gate_blocked',
            message:    'Promotion still blocked for non-human reasons — review gate result and retry',
            gateResult: result.gateResult,
          });
          return;
        }
        res.json({ ok: true, gateResult: result.gateResult });
      } catch (err) {
        res.status(409).json({
          error:   'decision_failed',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  // ── GET /platform/prompts/mutations (D.12) ────────────────────────────────

  router.get(
    '/prompts/mutations',
    async (req: Request, res: Response): Promise<void> => {
      if (!mutationGovernance) {
        res.status(503).json({ error: 'mutation_governance_unavailable' });
        return;
      }
      const role   = typeof req.query['role']   === 'string' ? req.query['role']   : undefined;
      const status = typeof req.query['status'] === 'string' ? req.query['status'] : undefined;
      const filter: { role?: string; status?: 'mutable' | 'guarded' | 'frozen' } = {};
      if (role) filter.role = role;
      if (status === 'mutable' || status === 'guarded' || status === 'frozen') {
        filter.status = status;
      }
      const slots = await mutationGovernance.listSlots(filter);
      res.json({ slots });
    },
  );

  // ── GET /platform/prompts/mutations/:slot/:role (D.12) ────────────────────

  router.get(
    '/prompts/mutations/:slot/:role',
    async (req: Request, res: Response): Promise<void> => {
      if (!mutationGovernance) {
        res.status(503).json({ error: 'mutation_governance_unavailable' });
        return;
      }
      const slotId = req.params['slot'];
      const role   = req.params['role'];
      if (!slotId || !role) {
        res.status(400).json({ error: 'missing_params' });
        return;
      }
      const limit = Math.min(parseInt(String(req.query['limit'] ?? '50'), 10) || 50, 200);
      const history = await mutationGovernance.getHistory(slotId, role, limit);
      res.json({ history });
    },
  );

  // ── POST /platform/prompts/mutations (D.12) ───────────────────────────────

  router.post(
    '/prompts/mutations',
    (req, res, next) => requirePlatformAdmin(req as AuthenticatedRequest, res, next),
    async (req: Request, res: Response): Promise<void> => {
      if (!mutationGovernance) {
        res.status(503).json({ error: 'mutation_governance_unavailable' });
        return;
      }
      const authed = req as AuthenticatedRequest;
      const parsed = SetMutationStatusSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_body', issues: parsed.error.issues });
        return;
      }
      const setStatusInput: Parameters<MutationGovernanceService['setStatus']>[0] = {
        slotId:    parsed.data.slotId,
        role:      parsed.data.role,
        newStatus: parsed.data.newStatus,
        reason:    parsed.data.reason,
        changedBy: authed.userId,
      };
      if (parsed.data.rfcUrl !== undefined) {
        setStatusInput.rfcUrl = parsed.data.rfcUrl;
      }
      const result = await mutationGovernance.setStatus(setStatusInput);
      if (!result.ok) {
        const status = result.error === 'rfc_required'    ? 400
                      : result.error === 'slot_not_found' ? 404
                      : 409;
        res.status(status).json(result);
        return;
      }
      res.json(result);
    },
  );

  return router;
}
