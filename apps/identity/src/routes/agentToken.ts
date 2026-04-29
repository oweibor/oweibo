/**
 * Internal agent-token endpoint.
 *
 * POST /internal/agent-token
 *
 * Machine-to-machine only. Called by kilo-pipeline task workers when spawning
 * an agent sandbox. Protected by a shared service secret (INTERNAL_SERVICE_KEY)
 * — NOT exposed via Caddy/Traefik. The route binds to the same listener as the
 * rest of the identity service but is guarded by the shared key check so even
 * if mistakenly routed externally it cannot mint tokens without the secret.
 *
 * Body: {
 *   taskId:               string
 *   runId:                string
 *   userId:               string
 *   tenantId:             string
 *   parentScopes:         string[]
 *   agentProfile:         string   e.g. "architect" | "orchestrate" | "writer-1"
 *   taskBudgetRemainingMs: number
 * }
 *
 * Response: { token: string }
 *
 * @module routes/agentToken
 */

import { Router, Request, Response } from 'express';
import { mintAgentToken } from '../services/jwt.js';
import { config } from '../config.js';
import type { Scope } from '../policy.js';

const router = Router();

function requireServiceKey(req: Request, res: Response, next: () => void): void {
    const provided = req.headers['x-internal-service-key'];
    const expected = config.INTERNAL_SERVICE_KEY;

    if (!expected) {
        res.status(503).json({ error: 'service_unavailable', message: 'INTERNAL_SERVICE_KEY not configured' });
        return;
    }
    if (!provided || provided !== expected) {
        res.status(401).json({ error: 'unauthorized', message: 'Invalid service key' });
        return;
    }
    next();
}

router.post('/internal/agent-token', requireServiceKey, async (req: Request, res: Response) => {
    const { taskId, runId, userId, tenantId, parentScopes, agentProfile, taskBudgetRemainingMs } = req.body;

    if (!taskId || !runId || !userId || !tenantId || !Array.isArray(parentScopes)) {
        res.status(400).json({ error: 'bad_request', message: 'taskId, runId, userId, tenantId, parentScopes are required' });
        return;
    }

    const budgetMs = typeof taskBudgetRemainingMs === 'number' ? taskBudgetRemainingMs : 60 * 60 * 1000;

    try {
        const token = await mintAgentToken({
            taskId,
            runId,
            userId,
            tenantId,
            parentScopes: parentScopes as Scope[],
            agentScopes:  agentScopesForProfile(agentProfile || 'default'),
            taskBudgetRemainingMs: budgetMs,
        });
        res.json({ token });
    } catch (err: any) {
        res.status(500).json({ error: 'internal_error', message: err.message });
    }
});

// Scopes each agent profile is permitted to carry (intersection with parentScopes)
function agentScopesForProfile(profile: string): Scope[] {
    const base: Scope[] = ['tasks:read', 'memory:read', 'memory:write'];
    switch (profile) {
        case 'architect':
        case 'orchestrate':
            return [...base, 'tasks:write', 'staging:read'];
        case 'writer-1': case 'writer-2': case 'writer-3':
        case 'writer-4': case 'writer-5':
            return [...base, 'staging:read'];
        case 'reflection':
        case 'recovery':
            return [...base, 'quarantine:read', 'ledger:read', 'ledger:write'];
        default:
            return base;
    }
}

export default router;
