/**
 * Env bootstrap for env-gated suites that exercise withTenantContext.
 *
 * MUST be the first import of any suite that (transitively) imports
 * ../client.js: the PrismaClient singleton is constructed at module scope,
 * and ES-module imports are hoisted — an inline `process.env` assignment in
 * the test file's body runs AFTER the client has already captured (and
 * validated) DATABASE_URL. Importing this module first wins the race.
 *
 * Suites remain skip-gated on TEST_DATABASE_URL exactly as before; this only
 * makes them self-sufficient instead of requiring the caller to export both
 * variables (found 2026-07-10 — the binding suites had never actually run
 * with TEST_DATABASE_URL alone).
 */
if (process.env['TEST_DATABASE_URL'] && !process.env['DATABASE_URL']) {
  process.env['DATABASE_URL'] = process.env['TEST_DATABASE_URL'];
}

export {};
