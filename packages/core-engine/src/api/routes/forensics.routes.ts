/**
 * forensics.routes.ts — F.4.1 HTTP surface for the S.7 forensic + replay
 * pipeline.
 *
 *   GET    /tenants/:tenantId/forensics                       — paginated list
 *   GET    /tenants/:tenantId/forensics/by-plan/:planId       — detail by plan (admin nav)
 *   GET    /tenants/:tenantId/forensics/:id                   — detail by packet id
 *   GET    /tenants/:tenantId/forensics/:id/download          — proxy storage bytes
 *   POST   /tenants/:tenantId/forensics/:id/resolve           — record resolution
 *   POST   /tenants/:tenantId/forensics/:id/replay            — trigger replay
 *   GET    /tenants/:tenantId/forensics/:id/replay/:runId     — replay run status
 *
 * Detail endpoints fetch the row from oweibo.forensic_packets via
 * HitlHandoffService and the packet bytes via the storage adapter, parse
 * the JSON, and merge into a single response. The admin-web detail page
 * expects the parsed packet inline (proposals + executions + verifications
 * + rollbacks + inspections + suggestedActions) — see
 * apps/admin-web/app/(tenant)/[tenantId]/forensics/[planId]/page.tsx.
 *
 * Tenant scoping comes from the URL `:tenantId` param, cross-checked
 * against the JWT claim by `requireTenantParamMatchesJwt`.
 */
import { Router, type Response } from 'express';
import { z } from 'zod';
import type { AuthenticatedRequest } from '../middleware/authenticate.js';
import { requireTenantParamMatchesJwt } from '../middleware/tenantParam.js';
import type { HitlHandoffService, ForensicPacketRow } from '../../action/HitlHandoffService.js';
import type { ActionReplayService } from '../../action/ActionReplayService.js';
import type { ForensicPacket, IForensicPacketStorage } from '@oweibo/core-contracts';

// ── Schemas ──────────────────────────────────────────────────────────────

const ListQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().positive().max(200).optional(),
});

const ResolveBody = z.object({
  resolution: z.enum(['resumed', 'overridden', 'aborted', 'lessons_learned']),
  notes: z.string().max(4000).optional(),
});

const ReplayBody = z.object({
  kind: z.enum(['shadow_full', 'shadow_step', 'what_if']),
  proposalId: z.string().uuid().optional(),
  mutation: z.object({
    path: z.string().min(1).max(200),
    newValue: z.unknown(),
  }).optional(),
}).refine(
  (v) => v.kind !== 'shadow_step' || v.proposalId !== undefined,
  { message: 'shadow_step replay requires proposalId' },
).refine(
  (v) => v.kind !== 'what_if' || v.mutation !== undefined,
  { message: 'what_if replay requires mutation' },
);

// ── Router ───────────────────────────────────────────────────────────────

export interface ForensicsRouterDeps {
  readonly hitlHandoff: HitlHandoffService;
  /** Storage adapter — read-side; same instance the builder used to put. */
  readonly storage: IForensicPacketStorage;
  /** Replay service. Optional: replay endpoints 404 when undefined. */
  readonly actionReplay?: ActionReplayService;
}

export function createForensicsRouter(deps: ForensicsRouterDeps): Router {
  const router = Router({ mergeParams: true });
  router.use(requireTenantParamMatchesJwt as unknown as import('express').RequestHandler);

  // ── List ──────────────────────────────────────────────────────────────

  router.get('/', async (req, res) => {
    const r = req as unknown as AuthenticatedRequest;
    const parsed = ListQuery.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_request', issues: parsed.error.issues });
      return;
    }
    try {
      const { rows, nextCursor } = await deps.hitlHandoff.listPaginated(r.tenantId, {
        ...(parsed.data.cursor !== undefined ? { cursor: parsed.data.cursor } : {}),
        ...(parsed.data.limit  !== undefined ? { limit:  parsed.data.limit  } : {}),
      });
      res.json({ packets: rows, nextCursor });
    } catch (err) {
      handleError(err, res);
    }
  });

  // ── Detail by plan id (admin nav) ─────────────────────────────────────
  // Mounted BEFORE /:id so the literal segment doesn't match the id regex.

  router.get('/by-plan/:planId', async (req, res) => {
    const r = req as unknown as AuthenticatedRequest;
    const planId = req.params['planId'] ?? '';
    try {
      const row = await deps.hitlHandoff.getByPlanId(r.tenantId, planId);
      if (!row) {
        res.status(404).json({ error: 'not_found', message: `no forensic packet for plan ${planId}` });
        return;
      }
      const detail = await loadDetail(deps, row);
      res.json({ packet: detail });
    } catch (err) {
      handleError(err, res);
    }
  });

  // ── Detail by packet id ───────────────────────────────────────────────

  router.get('/:id', async (req, res) => {
    const r = req as unknown as AuthenticatedRequest;
    const packetId = req.params['id'] ?? '';
    try {
      const row = await deps.hitlHandoff.getById(r.tenantId, packetId);
      if (!row) {
        res.status(404).json({ error: 'not_found', message: `forensic packet ${packetId} not found` });
        return;
      }
      const detail = await loadDetail(deps, row);
      res.json({ packet: detail });
    } catch (err) {
      handleError(err, res);
    }
  });

  // ── Download (proxy storage bytes) ────────────────────────────────────

  router.get('/:id/download', async (req, res) => {
    const r = req as unknown as AuthenticatedRequest;
    const packetId = req.params['id'] ?? '';
    try {
      const row = await deps.hitlHandoff.getById(r.tenantId, packetId);
      if (!row) {
        res.status(404).json({ error: 'not_found', message: `forensic packet ${packetId} not found` });
        return;
      }
      const bytes = await deps.storage.get(row.storageRef);
      res
        .status(200)
        .setHeader('Content-Type', 'application/json')
        .setHeader('Content-Disposition', `attachment; filename="forensic-${packetId}.json"`)
        .setHeader('X-Packet-Signature', row.signature)
        .send(bytes);
    } catch (err) {
      handleError(err, res);
    }
  });

  // ── Resolve ───────────────────────────────────────────────────────────

  router.post('/:id/resolve', async (req, res) => {
    const r = req as unknown as AuthenticatedRequest;
    const parsed = ResolveBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_request', issues: parsed.error.issues });
      return;
    }
    try {
      await deps.hitlHandoff.resolve({
        tenantId: r.tenantId,
        forensicPacketRowId: req.params['id'] ?? '',
        resolution: parsed.data.resolution,
        resolvedByUserId: r.userId,
        ...(parsed.data.notes !== undefined ? { notes: parsed.data.notes } : {}),
      });
      res.json({ ok: true });
    } catch (err) {
      handleError(err, res);
    }
  });

  // ── Replay trigger ────────────────────────────────────────────────────

  router.post('/:id/replay', async (req, res) => {
    if (!deps.actionReplay) {
      res.status(503).json({
        error: 'replay_disabled',
        message: 'ActionReplayService is not configured (FORENSIC_REPLAY_ENABLED=false?)',
      });
      return;
    }
    const r = req as unknown as AuthenticatedRequest;
    const parsed = ReplayBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_request', issues: parsed.error.issues });
      return;
    }
    try {
      const row = await deps.hitlHandoff.getById(r.tenantId, req.params['id'] ?? '');
      if (!row) {
        res.status(404).json({ error: 'not_found', message: `forensic packet not found` });
        return;
      }
      const mutation = parsed.data.mutation;
      const result = await deps.actionReplay.replay({
        tenantId: r.tenantId,
        planId: row.planId,
        requestedByUserId: r.userId,
        kind: parsed.data.kind,
        ...(parsed.data.proposalId !== undefined ? { proposalId: parsed.data.proposalId } : {}),
        ...(mutation !== undefined
          ? { mutation: { path: mutation.path, newValue: mutation.newValue } }
          : {}),
      });
      res.status(202).json(result);
    } catch (err) {
      handleError(err, res);
    }
  });

  // ── Replay run status ─────────────────────────────────────────────────

  router.get('/:id/replay/:runId', async (req, res) => {
    if (!deps.actionReplay) {
      res.status(503).json({
        error: 'replay_disabled',
        message: 'ActionReplayService is not configured',
      });
      return;
    }
    const r = req as unknown as AuthenticatedRequest;
    const runId = req.params['runId'] ?? '';
    try {
      const run = await deps.actionReplay.getRun(r.tenantId, runId);
      if (!run) {
        res.status(404).json({ error: 'not_found', message: `replay run ${runId} not found` });
        return;
      }
      res.json(run);
    } catch (err) {
      handleError(err, res);
    }
  });

  return router;
}

// ── Internals ────────────────────────────────────────────────────────────

interface ForensicDetailResponse {
  readonly id: string;
  readonly planId: string;
  readonly summary: string | null;
  readonly triggerKind: string;
  readonly state: string;
  readonly storageRef: string;
  readonly signature: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly resolution: string | null;
  readonly resolutionNotes: string | null;
  readonly proposals: ForensicPacket['proposals'];
  readonly executions: ForensicPacket['executions'];
  readonly verifications: ForensicPacket['verifications'];
  readonly rollbacks: ForensicPacket['rollbacks'];
  readonly inspections: ForensicPacket['inspections'];
  readonly suggestedActions: ForensicPacket['suggestedActions'];
}

async function loadDetail(
  deps: ForensicsRouterDeps,
  row: ForensicPacketRow,
): Promise<ForensicDetailResponse> {
  // The storage bytes are JSON of the ForensicPacket. Parse and graft
  // the row metadata on top — the row carries state/resolution which
  // the immutable packet body does not.
  const bytes = await deps.storage.get(row.storageRef);
  const packet = JSON.parse(bytes.toString('utf8')) as ForensicPacket;
  return {
    id: row.id,
    planId: row.planId,
    summary: row.summary,
    triggerKind: row.triggerKind,
    state: row.state,
    storageRef: row.storageRef,
    signature: row.signature,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    resolution: row.resolution,
    resolutionNotes: row.resolutionNotes,
    proposals: packet.proposals,
    executions: packet.executions,
    verifications: packet.verifications,
    rollbacks: packet.rollbacks,
    inspections: packet.inspections,
    suggestedActions: packet.suggestedActions,
  };
}

function handleError(err: unknown, res: Response): void {
  const message = err instanceof Error ? err.message : 'internal_error';
  if (/not found/i.test(message)) {
    res.status(404).json({ error: 'not_found', message });
    return;
  }
  if (/forensic_replay\.enabled is off|disabled/i.test(message)) {
    res.status(503).json({ error: 'forensic_features_disabled', message });
    return;
  }
  if (/invalid|bad request|requires/i.test(message)) {
    res.status(400).json({ error: 'invalid_request', message });
    return;
  }
  res.status(500).json({ error: 'internal_error', message });
}
