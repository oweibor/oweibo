#!/usr/bin/env tsx
/**
 * F.7.2 (ttv-finals): post-load-test verification script.
 *
 * Implements the two non-latency assertions from plan §F.7.2:
 *
 *   1. **Zero dropped events** — every oweibo.outbox row published
 *      during the load-test window must have a matching
 *      processed_outbox_events entry for the bootstrap-workers consumer
 *      group. A non-empty diff means events were dropped between
 *      publish and consume.
 *
 *   2. **Rollback success rate > 99%** — for adapter-based rollbacks
 *      (kind != 'webhook'), the rollback_execution.state column should
 *      be 'succeeded' for at least 99% of rows within the test window.
 *
 * Exits non-zero on either failure. Designed to run in CI after a k6
 * load test or staged manually after a soak.
 *
 * Usage:
 *   DATABASE_URL=postgres://... \
 *   TEST_WINDOW_START=2026-05-30T00:00:00Z \
 *   tsx scripts/verify-no-dropped-events.ts
 *
 * Optional env:
 *   CONSUMER_GROUP        Default: bootstrap-workers
 *   ROLLBACK_PASS_RATE    Default: 0.99
 *   TEST_WINDOW_END       Default: NOW()
 */
import { Client } from 'pg';

interface VerificationResult {
  readonly name: string;
  readonly passed: boolean;
  readonly detail: string;
}

async function main(): Promise<void> {
  const url = process.env['DATABASE_URL'];
  if (!url) {
    console.error('DATABASE_URL required');
    process.exit(2);
  }
  const windowStart = process.env['TEST_WINDOW_START'];
  if (!windowStart) {
    console.error('TEST_WINDOW_START required (ISO-8601 timestamp marking k6 setup boundary)');
    process.exit(2);
  }
  const windowEnd = process.env['TEST_WINDOW_END'] ?? new Date().toISOString();
  const consumerGroup = process.env['CONSUMER_GROUP'] ?? 'bootstrap-workers';
  const rollbackPassRate = parseFloat(process.env['ROLLBACK_PASS_RATE'] ?? '0.99');

  const client = new Client({ connectionString: url });
  await client.connect();

  const results: VerificationResult[] = [];
  try {
    results.push(await checkDroppedEvents(client, windowStart, windowEnd, consumerGroup));
    results.push(await checkRollbackSuccessRate(client, windowStart, windowEnd, rollbackPassRate));
  } finally {
    await client.end();
  }

  let exitCode = 0;
  console.log('\n──────── F.7.2 verification ────────');
  for (const r of results) {
    const tag = r.passed ? '✓ PASS' : '✗ FAIL';
    console.log(`${tag}  ${r.name}: ${r.detail}`);
    if (!r.passed) exitCode = 1;
  }
  console.log('────────────────────────────────────\n');
  process.exit(exitCode);
}

async function checkDroppedEvents(
  client: Client,
  start: string,
  end: string,
  consumerGroup: string,
): Promise<VerificationResult> {
  const publishedRes = await client.query<{ id: string }>(
    `SELECT id::text FROM oweibo.outbox
      WHERE published_at IS NOT NULL
        AND published_at >= $1::timestamptz
        AND published_at <= $2::timestamptz
        AND COALESCE((payload ->> '_dead_letter')::boolean, false) = false`,
    [start, end],
  );
  const publishedIds = publishedRes.rows.map((r) => r.id);

  if (publishedIds.length === 0) {
    return {
      name: 'No dropped events',
      passed: true,
      detail: 'zero published events in window (nothing to verify; consider a longer window)',
    };
  }

  const processedRes = await client.query<{ event_id: string }>(
    `SELECT event_id FROM oweibo.processed_outbox_events
      WHERE consumer_group = $1
        AND event_id = ANY($2::text[])`,
    [consumerGroup, publishedIds],
  );
  const processedSet = new Set(processedRes.rows.map((r) => r.event_id));
  const dropped = publishedIds.filter((id) => !processedSet.has(id));

  return {
    name: 'No dropped events',
    passed: dropped.length === 0,
    detail: dropped.length === 0
      ? `${publishedIds.length} published / ${publishedIds.length} consumed by '${consumerGroup}'`
      : `${dropped.length} of ${publishedIds.length} events unconsumed (sample: ${dropped.slice(0, 5).join(', ')})`,
  };
}

async function checkRollbackSuccessRate(
  client: Client,
  start: string,
  end: string,
  threshold: number,
): Promise<VerificationResult> {
  const r = await client.query<{ total: string; succeeded: string }>(
    `SELECT
       COUNT(*) FILTER (WHERE adapter_kind IS NOT NULL AND adapter_kind != 'webhook')                       AS total,
       COUNT(*) FILTER (WHERE adapter_kind IS NOT NULL AND adapter_kind != 'webhook' AND state = 'succeeded') AS succeeded
       FROM oweibo.rollback_execution
      WHERE created_at >= $1::timestamptz
        AND created_at <= $2::timestamptz`,
    [start, end],
  );
  const total = parseInt(r.rows[0]?.total ?? '0', 10);
  const succeeded = parseInt(r.rows[0]?.succeeded ?? '0', 10);
  if (total === 0) {
    return {
      name: `Rollback success rate >= ${(threshold * 100).toFixed(1)}%`,
      passed: true,
      detail: 'zero adapter-based rollbacks in window (nothing to verify)',
    };
  }
  const rate = succeeded / total;
  return {
    name: `Rollback success rate >= ${(threshold * 100).toFixed(1)}%`,
    passed: rate >= threshold,
    detail: `${succeeded}/${total} = ${(rate * 100).toFixed(2)}% (threshold ${(threshold * 100).toFixed(1)}%)`,
  };
}

main().catch((err: unknown) => {
  console.error('verify-no-dropped-events fatal:', err);
  process.exit(2);
});
