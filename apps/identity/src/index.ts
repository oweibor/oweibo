/**
 * apps/identity — oweibo identity service
 *
 * Port 3110. Owns:
 *   /.well-known/jwks.json           RS256 public keys
 *   /api/auth/*                      BetterAuth sessions
 *   /api/v1/platform/*               platform management (platform_admin only)
 *   /api/v1/tenants/:tenantId/*      tenant management
 *   /healthz                         liveness
 *   /readyz                          readiness
 */
import express from 'express';
import { toNodeHandler } from 'better-auth/node';
import { config } from './config.js';
import { initKeys } from './services/jwks.js';
import { auth } from './services/betterAuth.js';
import jwksRouter       from './routes/jwks.js';
import platformRouter   from './routes/platform.js';
import tenantRouter     from './routes/tenant.js';
import agentTokenRouter from './routes/agentToken.js';
import authTokenRouter  from './routes/authToken.js';
import gdprRouter       from './routes/gdpr.js';
import bootstrapRouter  from './routes/bootstrap.js';

const app = express();
app.use(express.json({ limit: '256kb' }));

// BetterAuth handles all /api/auth/* paths
app.all('/api/auth/*', toNodeHandler(auth));

// JWKS
app.use(jwksRouter);

// Platform management
app.use(platformRouter);

// Tenant management
app.use('/api/v1/tenants', tenantRouter);

// T.2.e: tenant bootstrap status (GET /api/v1/tenants/:tenantId/bootstrap)
app.use(bootstrapRouter);

// CLI authentication: token mint, refresh, me, logout
app.use(authTokenRouter);

// GDPR erasure
app.use(gdprRouter);

// Internal machine-to-machine: agent token minting (not exposed via external proxy)
app.use(agentTokenRouter);

// Liveness / readiness
app.get('/healthz', (_req, res) => res.json({ status: 'ok' }));
app.get('/readyz',  (_req, res) => res.json({ status: 'ok' }));

async function main() {
  await initKeys();
  const server = app.listen(config.PORT, () => {
    console.log(`identity service listening on :${config.PORT}`);
  });

  const shutdown = () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10_000);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT',  shutdown);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
