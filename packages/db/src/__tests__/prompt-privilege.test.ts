/**
 * Prompt privilege lockdown integration tests.
 *
 * Verifies that the privilege lockdown migration correctly:
 *   1. Blocks oweibo_app from INSERT/UPDATE on prompt_versions
 *   2. Allows oweibo_app to SELECT from prompt_versions
 *   3. Allows SET LOCAL ROLE gepa_optimizer for write operations
 *   4. Role resets after transaction (SET LOCAL is transaction-scoped)
 *
 * Prerequisites:
 *   - TEST_DATABASE_URL points to a Postgres instance with ALL migrations applied
 *     (including 20260519_000014_prompt_privilege_lockdown.sql)
 *   - oweibo_app role exists and matches DATABASE_URL credentials
 *   - gepa_optimizer role exists (created by the lockdown migration)
 *
 * Run: pnpm --filter @oweibo/db test
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';

const TEST_DB_URL = process.env['TEST_DATABASE_URL'];

// Skip the whole suite if no test database is configured
const describeOrSkip = TEST_DB_URL ? describe : describe.skip;

describeOrSkip('prompt_versions privilege lockdown', () => {
  let pool: Pool;
  const testHash = `lockdown-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_DB_URL });
  });

  afterAll(async () => {
    // Clean up test data (as superuser or via gepa_optimizer)
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE gepa_optimizer');
      await client.query(
        `DELETE FROM oweibo.prompt_versions WHERE hash LIKE 'lockdown-test-%'`,
      );
      await client.query('COMMIT');
    } catch {
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
    await pool.end();
  });

  it('oweibo_app cannot INSERT into prompt_versions directly', async () => {
    // oweibo_app should no longer have INSERT on prompt_versions
    await expect(
      pool.query(
        `INSERT INTO oweibo.prompt_versions
           (hash, role, slot_id, template_version, text, mutation_status)
         VALUES ($1, 'test', 'test-slot', 'test-v0', 'test text', 'stable')`,
        [`${testHash}-direct`],
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  it('oweibo_app cannot UPDATE prompt_versions directly', async () => {
    await expect(
      pool.query(
        `UPDATE oweibo.prompt_versions SET freeze_reason = 'test' WHERE hash = $1`,
        [`${testHash}-nonexistent`],
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  it('oweibo_app can SELECT from prompt_versions', async () => {
    // SELECT should still be allowed
    const result = await pool.query(
      `SELECT hash FROM oweibo.prompt_versions LIMIT 1`,
    );
    // No error thrown — pass regardless of row count
    expect(result).toBeDefined();
  });

  it('SET LOCAL ROLE gepa_optimizer allows INSERT into prompt_versions', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE gepa_optimizer');
      await client.query(
        `INSERT INTO oweibo.prompt_versions
           (hash, role, slot_id, template_version, text, mutation_status)
         VALUES ($1, 'test', 'test-slot', 'test-v0', 'test text for role escalation', 'stable')
         ON CONFLICT (hash) DO NOTHING`,
        [`${testHash}-escalated`],
      );
      await client.query('COMMIT');

      // Verify the row was inserted (as oweibo_app — SELECT is allowed)
      const result = await pool.query(
        `SELECT hash FROM oweibo.prompt_versions WHERE hash = $1`,
        [`${testHash}-escalated`],
      );
      expect(result.rows).toHaveLength(1);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  });

  it('role resets after transaction — next query runs as oweibo_app', async () => {
    const client = await pool.connect();
    try {
      // Transaction 1: escalate to gepa_optimizer
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE gepa_optimizer');
      await client.query('COMMIT');

      // Transaction 2: no SET LOCAL — should be back to oweibo_app
      // This INSERT should fail because oweibo_app lacks INSERT permission
      await expect(
        client.query(
          `INSERT INTO oweibo.prompt_versions
             (hash, role, slot_id, template_version, text, mutation_status)
           VALUES ($1, 'test', 'test-slot', 'test-v0', 'should fail', 'stable')`,
          [`${testHash}-post-reset`],
        ),
      ).rejects.toThrow(/permission denied/i);
    } finally {
      client.release();
    }
  });

  it('SET LOCAL ROLE gepa_optimizer allows UPDATE on prompt_versions', async () => {
    // First ensure a row exists
    const insertClient = await pool.connect();
    try {
      await insertClient.query('BEGIN');
      await insertClient.query('SET LOCAL ROLE gepa_optimizer');
      await insertClient.query(
        `INSERT INTO oweibo.prompt_versions
           (hash, role, slot_id, template_version, text, mutation_status)
         VALUES ($1, 'test', 'test-slot', 'test-v0', 'update test', 'stable')
         ON CONFLICT (hash) DO NOTHING`,
        [`${testHash}-update`],
      );
      await insertClient.query('COMMIT');
    } catch (err) {
      await insertClient.query('ROLLBACK');
      throw err;
    } finally {
      insertClient.release();
    }

    // Now UPDATE via role escalation
    const updateClient = await pool.connect();
    try {
      await updateClient.query('BEGIN');
      await updateClient.query('SET LOCAL ROLE gepa_optimizer');
      const result = await updateClient.query(
        `UPDATE oweibo.prompt_versions
         SET freeze_reason = 'lockdown test'
         WHERE hash = $1`,
        [`${testHash}-update`],
      );
      await updateClient.query('COMMIT');
      expect(result.rowCount).toBe(1);
    } catch (err) {
      await updateClient.query('ROLLBACK');
      throw err;
    } finally {
      updateClient.release();
    }
  });
});
