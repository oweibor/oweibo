/**
 * CLI authentication endpoints.
 *
 * POST /api/v1/auth/token    — email + password → { access_token, refresh_token, ... }
 * POST /api/v1/auth/refresh  — refresh_token   → { access_token, expires_at }
 * GET  /api/v1/auth/me       — verify JWT and return caller info
 * POST /api/v1/auth/logout   — stateless; signals client to clear local credentials
 */
import { Router } from 'express';
import { SignJWT, jwtVerify } from 'jose';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { auth } from '../services/betterAuth.js';
import { prisma } from '@oweibo/db';
import { mintAccessToken, verifyAccessToken } from '../services/jwt.js';
import { expandRoles } from '../policy.js';
import { getPrivateKey, getPublicKey } from '../services/jwks.js';
import { config } from '../config.js';
import type { Principal } from '@oweibo/db';

const router = Router();

// ── Schemas ────────────────────────────────────────────────────────────────

const TokenSchema = z.object({
  email:    z.string().email(),
  password: z.string().min(1),
  tenantId: z.string().uuid().optional(),
});

const RefreshSchema = z.object({ refresh_token: z.string().min(1) });

// ── Refresh-token helpers ─────────────────────────────────────────────────

async function mintRefreshToken(userId: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    type:   'refresh',
    sub:    userId,
    jti:    uuidv4(),
    ctx:    { tenantId: '' },
    scopes: [] as string[],
    trust:  'supervised' as const,
  })
    .setProtectedHeader({ alg: 'RS256', kid: config.JWT_KEY_ID })
    .setIssuer(config.JWT_ISSUER)
    .setAudience(config.JWT_AUDIENCE)
    .setIssuedAt(now)
    .setExpirationTime(now + config.REFRESH_TOKEN_TTL)
    .sign(getPrivateKey());
}

async function verifyRefreshToken(token: string): Promise<{ userId: string }> {
  const { payload } = await jwtVerify(token, getPublicKey(), {
    issuer:     config.JWT_ISSUER,
    audience:   config.JWT_AUDIENCE,
    algorithms: ['RS256'],
  });
  if ((payload as any).type !== 'refresh') {
    throw new Error('not a refresh token');
  }
  return { userId: payload.sub ?? '' };
}

// ── Principal builder (shared by /token and /refresh) ─────────────────────

async function buildPrincipal(userId: string, preferredTenantId?: string): Promise<Principal> {
  const [user, memberships] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId } }),
    prisma.tenantMembership.findMany({
      where:   { userId, tenant: { status: 'active' } },
      orderBy: { createdAt: 'asc' },
    }),
  ]);

  const platformRoles: string[] = (user as any)?.platformRoles ?? [];

  const membership =
    memberships.find(m => m.tenantId === preferredTenantId) ?? memberships[0];

  const allRoles = [...platformRoles, ...(membership?.roles ?? [])];

  return {
    sub:    userId,
    kind:   'user',
    scopes: expandRoles(allRoles),
    ctx:    { tenantId: membership?.tenantId ?? '' },
  };
}

// ── Routes ─────────────────────────────────────────────────────────────────

// POST /api/v1/auth/token
router.post('/api/v1/auth/token', async (req, res) => {
  const parsed = TokenSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'validation_error', issues: parsed.error.flatten() });
    return;
  }
  const { email, password, tenantId } = parsed.data;

  try {
    const result = await auth.api.signInEmail({ body: { email, password } });
    const userId  = result.user.id;
    const userEmail = result.user.email;

    const principal = await buildPrincipal(userId, tenantId);

    const [access_token, refresh_token] = await Promise.all([
      mintAccessToken(principal),
      mintRefreshToken(userId),
    ]);

    res.json({
      access_token,
      refresh_token,
      expires_at:  new Date(Date.now() + config.ACCESS_TOKEN_TTL * 1000).toISOString(),
      token_type:  'Bearer',
      user_id:     userId,
      tenant_id:   principal.ctx.tenantId || null,
      email:       userEmail,
      scopes:      principal.scopes,
    });
  } catch (err: any) {
    const status = err?.status ?? err?.statusCode;
    if (status === 401 || err?.message?.toLowerCase().includes('credential')) {
      res.status(401).json({ error: 'invalid_credentials' });
    } else {
      console.error('[authToken] sign-in error:', err);
      res.status(500).json({ error: 'internal_error' });
    }
  }
});

// POST /api/v1/auth/refresh
router.post('/api/v1/auth/refresh', async (req, res) => {
  const parsed = RefreshSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'validation_error' });
    return;
  }
  try {
    const { userId }  = await verifyRefreshToken(parsed.data.refresh_token);
    const principal   = await buildPrincipal(userId);
    const access_token = await mintAccessToken(principal);

    res.json({
      access_token,
      expires_at: new Date(Date.now() + config.ACCESS_TOKEN_TTL * 1000).toISOString(),
      token_type: 'Bearer',
    });
  } catch {
    res.status(401).json({ error: 'invalid_refresh_token' });
  }
});

// GET /api/v1/auth/me
router.get('/api/v1/auth/me', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  try {
    const claims = await verifyAccessToken(authHeader.slice(7));
    if ((claims as any).type === 'refresh') {
      res.status(401).json({ error: 'access_token_required' });
      return;
    }
    const userId = claims.sub ?? '';
    const user   = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, email: true } });
    res.json({
      user_id:   userId,
      email:     user?.email ?? null,
      tenant_id: claims.ctx.tenantId || null,
      scopes:    claims.scopes,
      trust:     claims.trust,
    });
  } catch {
    res.status(401).json({ error: 'invalid_token' });
  }
});

// POST /api/v1/auth/logout  (JWT is stateless — client must clear credentials)
router.post('/api/v1/auth/logout', (_req, res) => {
  res.status(204).send();
});

export default router;
