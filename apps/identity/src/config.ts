import { z } from 'zod';

const schema = z.object({
  PORT:              z.string().default('3110').transform(Number),
  NODE_ENV:          z.enum(['development', 'staging', 'production']).default('development'),
  DATABASE_URL:      z.string().min(1),
  REDIS_URL:         z.string().default('redis://localhost:6379'),
  // RS256 keypair — PEM-encoded; loaded from Vault in production via env injection
  JWT_PRIVATE_KEY:   z.string().min(1),
  JWT_PUBLIC_KEY:    z.string().min(1),
  JWT_KEY_ID:        z.string().default('oweibo-rs256-v1'),
  JWT_ISSUER:        z.string().default('https://identity.oweibo.io'),
  JWT_AUDIENCE:      z.string().default('oweibo-api'),
  ACCESS_TOKEN_TTL:  z.string().default('900').transform(Number),   // 15 min
  REFRESH_TOKEN_TTL: z.string().default('2592000').transform(Number), // 30 days
  // BetterAuth
  BETTER_AUTH_SECRET:   z.string().min(32),
  BETTER_AUTH_BASE_URL: z.string().default('http://localhost:3110'),
  // Shared secret for machine-to-machine internal calls (e.g. agent-token mint)
  INTERNAL_SERVICE_KEY: z.string().min(32).optional(),
  // Qdrant base URL for GDPR purge fan-out. QDRANT_URL takes precedence at the
  // call site; QDRANT_HOST is the fallback for callers using the legacy name.
  QDRANT_HOST:          z.string().optional(),
});

function parseConfig() {
  const result = schema.safeParse(process.env);
  if (!result.success) {
    console.error('Identity service config error:', result.error.flatten());
    process.exit(1);
  }
  return result.data;
}

export const config = parseConfig();
