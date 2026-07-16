#!/usr/bin/env tsx
/**
 * seed-admin.ts — create the first platform_admin so you can log in.
 *
 * Prereqs: `pnpm db:setup` has run AND the identity service is running
 * (it owns BetterAuth sign-up + the betterauth_user_sync trigger path).
 *
 * Run:
 *   node --env-file=.env.dev --import tsx scripts/seed-admin.ts
 *   # or: pnpm seed:admin
 *
 * Env:
 *   ADMIN_EMAIL     (default admin@oweibo.local)
 *   ADMIN_PASSWORD  (default ChangeMe-12345!  — min 12 chars, matches BetterAuth)
 *   IDENTITY_URL    (default http://localhost:3110)
 *   DATABASE_URL    (required — to grant the platform_admin role)
 *
 * Flow:
 *   1. POST /api/auth/sign-up/email → creates betterauth.users row; the
 *      betterauth_user_sync trigger mirrors it into oweibo.users. Idempotent:
 *      an "already exists" response is treated as success.
 *   2. UPDATE oweibo.users SET platform_roles = {platform_admin} WHERE email.
 *      Without this the JWT lacks platform:tenants:read and the admin-web
 *      middleware bounces you to /unauthorized.
 */
import { createRequire } from 'node:module';
import path from 'node:path';

// `pg` lives in @oweibo/db, not the repo root — resolve it from there.
const dbRequire = createRequire(path.join(__dirname, '..', 'packages', 'db', 'package.json'));
const { Client } = dbRequire('pg') as typeof import('pg');

const EMAIL    = process.env['ADMIN_EMAIL']    ?? 'admin@oweibo.local';
const PASSWORD = process.env['ADMIN_PASSWORD'] ?? 'ChangeMe-12345!';
const IDENTITY = process.env['IDENTITY_URL']   ?? 'http://localhost:3110';
const DB_URL   = process.env['DATABASE_URL'];

async function main(): Promise<void> {
  if (!DB_URL) {
    console.error('DATABASE_URL is required.');
    process.exit(2);
  }
  if (PASSWORD.length < 12) {
    console.error('ADMIN_PASSWORD must be at least 12 characters (BetterAuth minPasswordLength).');
    process.exit(2);
  }

  // ── Step 1: sign up via BetterAuth (fires the sync trigger) ────────────────
  console.log(`[seed-admin] Signing up ${EMAIL} at ${IDENTITY} …`);
  let res: Response;
  try {
    res = await fetch(`${IDENTITY}/api/auth/sign-up/email`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ name: EMAIL.split('@')[0], email: EMAIL, password: PASSWORD }),
    });
  } catch (err) {
    console.error(`[seed-admin] Could not reach identity at ${IDENTITY}. Is it running?`, err);
    process.exit(1);
  }

  if (res.ok) {
    console.log('[seed-admin] Sign-up ok.');
  } else {
    const body = await res.text().catch(() => '');
    const looksExisting = res.status === 422 || /exist|already|unique/i.test(body);
    if (looksExisting) {
      console.log('[seed-admin] User already exists — continuing to grant role.');
    } else {
      console.error(`[seed-admin] Sign-up failed: ${res.status} ${body.slice(0, 300)}`);
      process.exit(1);
    }
  }

  // ── Step 2: grant platform_admin ───────────────────────────────────────────
  const client = new Client({ connectionString: DB_URL });
  await client.connect();
  try {
    const upd = await client.query(
      `UPDATE oweibo.users
          SET platform_roles = ARRAY['platform_admin']
        WHERE email = $1`,
      [EMAIL],
    );
    if (upd.rowCount === 0) {
      console.error(
        `[seed-admin] No oweibo.users row for ${EMAIL}. The betterauth_user_sync ` +
        'trigger did not mirror the user — check that migration 001 applied and ' +
        'that DATABASE_URL points at the same database identity uses.',
      );
      process.exit(1);
    }
    console.log(`[seed-admin] Granted platform_admin to ${EMAIL}.`);
    console.log('');
    console.log('  ✓ Done. Log in at http://localhost:3120/login');
    console.log(`      email:    ${EMAIL}`);
    console.log(`      password: ${PASSWORD === 'ChangeMe-12345!' ? 'ChangeMe-12345!  (change this!)' : '(as provided)'}`);
  } finally {
    await client.end();
  }
}

main().catch((err: unknown) => {
  console.error('[seed-admin] fatal:', err);
  process.exit(2);
});
