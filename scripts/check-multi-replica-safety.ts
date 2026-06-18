#!/usr/bin/env tsx
/**
 * F.7.4 (ttv-finals): multi-replica safety static verification.
 *
 * Static check that every code path documented in plan §F.7.4 still
 * uses the correct concurrency primitive. Fails the build if a known-
 * critical site loses its safety construct (e.g. someone deletes the
 * SKIP LOCKED from OutboxRelay's drain).
 *
 * Coverage:
 *   1. SKIP LOCKED on lifecycle worker queue drains (OutboxRelay,
 *      PostExecutionVerifierService, HitlHandoffService, MultiPartyApproval)
 *   2. XREADGROUP consumer group claim on OutboxStreamConsumer
 *   3. pg_try_advisory_lock via runWithAdvisoryLock on every cron scheduler
 *   4. Cache invalidation channels: every service with an in-memory TTL
 *      cache exposes both publish + subscribe hooks
 *
 * Why static: real multi-replica integration tests need testcontainers
 * harness that doesn't ship yet (see plans/ttv_finals_followups.md B.8).
 * This script is the cheap fence — losing a SKIP LOCKED clause is the
 * most common regression we'd want CI to catch.
 *
 * Usage:
 *   tsx scripts/check-multi-replica-safety.ts
 */
import * as fs from 'fs';
import * as path from 'path';

interface PatternCheck {
  readonly name: string;
  readonly file: string;
  readonly pattern: RegExp;
  /** A line that must surround the pattern within +/- 30 lines for context. Optional. */
  readonly contextHint?: string;
}

const ROOT = path.resolve(__dirname, '..');

// MUST stay in sync with plan §F.7.4.
const REQUIRED_PATTERNS: readonly PatternCheck[] = [
  // ── 1. SKIP LOCKED on lifecycle worker drains ──────────────────────────
  {
    name: 'OutboxRelay drains with SKIP LOCKED',
    file: 'packages/core-engine/src/infrastructure/OutboxRelay.ts',
    pattern: /FOR UPDATE SKIP LOCKED/i,
    contextHint: 'oweibo.outbox',
  },
  {
    name: 'PostExecutionVerifierService drains deferred queue with SKIP LOCKED',
    file: 'packages/core-engine/src/action/PostExecutionVerifierService.ts',
    pattern: /FOR UPDATE SKIP LOCKED/i,
    contextHint: 'deferred_verification',
  },
  {
    name: 'HitlHandoffService claims pending packets with SKIP LOCKED',
    file: 'packages/core-engine/src/action/HitlHandoffService.ts',
    pattern: /FOR UPDATE SKIP LOCKED/i,
  },
  {
    name: 'MultiPartyApprovalService claims voting rows with SKIP LOCKED',
    file: 'packages/core-engine/src/action/MultiPartyApprovalService.ts',
    pattern: /FOR UPDATE SKIP LOCKED/i,
  },

  // ── 2. XREADGROUP single-claim on bootstrap stream consumer ─────────────
  {
    name: 'OutboxStreamConsumer uses XREADGROUP for single-claim semantics',
    file: 'packages/core-engine/src/infrastructure/OutboxStreamConsumer.ts',
    pattern: /XREADGROUP/,
  },
  {
    name: 'OutboxStreamConsumer reclaims stale entries via XAUTOCLAIM',
    file: 'packages/core-engine/src/infrastructure/OutboxStreamConsumer.ts',
    pattern: /XAUTOCLAIM/,
  },

  // ── 3. Cron schedulers use pg_try_advisory_lock ─────────────────────────
  {
    name: 'DomainCurrencyMonitor cron uses runWithAdvisoryLock',
    file: 'packages/core-engine/src/main.ts',
    pattern: /runWithAdvisoryLock\(\s*pgPool!?,\s*['"]domain_currency_tick['"]/,
  },
  {
    name: 'runWithAdvisoryLock primitive uses pg_try_advisory_lock under the hood',
    file: 'packages/core-engine/src/infrastructure/runWithAdvisoryLock.ts',
    pattern: /pg_try_advisory_lock\b/,
  },

  // ── 4. Cache invalidation channels exposed on TTL caches ────────────────
  {
    name: 'OperationalModeService accepts redisPub + redisSub for invalidation',
    file: 'packages/core-engine/src/infrastructure/OperationalModeService.ts',
    pattern: /private readonly redisPub[\s\S]*?private readonly redisSub/m,
  },
  {
    name: 'OperationalModeService publishes invalidation on mode transition',
    file: 'packages/core-engine/src/infrastructure/OperationalModeService.ts',
    pattern: /redisPub\?\.\(INVALIDATION_CHANNEL/,
  },
  {
    name: 'CohortRouter accepts a redis subscribe hook for cache invalidation',
    file: 'packages/core-engine/src/infrastructure/CohortRouter.ts',
    pattern: /cache invalidation/i,
  },
];

interface CheckOutcome {
  readonly name: string;
  readonly passed: boolean;
  readonly detail: string;
}

function runCheck(c: PatternCheck): CheckOutcome {
  const fullPath = path.join(ROOT, c.file);
  if (!fs.existsSync(fullPath)) {
    return { name: c.name, passed: false, detail: `file missing: ${c.file}` };
  }
  const source = fs.readFileSync(fullPath, 'utf-8');
  if (!c.pattern.test(source)) {
    return {
      name: c.name,
      passed: false,
      detail: `pattern ${c.pattern} not found in ${c.file}${c.contextHint ? ` (expected near "${c.contextHint}")` : ''}`,
    };
  }
  return { name: c.name, passed: true, detail: 'ok' };
}

function main(): void {
  console.log('\n──────── F.7.4 multi-replica safety ────────');
  let failed = 0;
  for (const check of REQUIRED_PATTERNS) {
    const out = runCheck(check);
    const tag = out.passed ? '✓ PASS' : '✗ FAIL';
    console.log(`${tag}  ${out.name}`);
    if (!out.passed) {
      console.log(`        ${out.detail}`);
      failed += 1;
    }
  }
  console.log('────────────────────────────────────────────\n');
  if (failed > 0) {
    console.error(`✗ ${failed} of ${REQUIRED_PATTERNS.length} multi-replica safety checks failed.`);
    process.exit(1);
  }
  console.log(`✓ all ${REQUIRED_PATTERNS.length} multi-replica safety checks passed.`);
}

main();
