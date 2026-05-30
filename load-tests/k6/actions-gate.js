/**
 * F.7.2 (ttv-finals): k6 load test — action gate sustained throughput.
 *
 * Scenario (per plan §F.7.2):
 *   - 100 tenants × 10 actions/sec each × 10 min = 60,000 total
 *   - p99 gate decision latency < 200 ms
 *   - 0 % dropped events (verified post-test against
 *     oweibo.processed_outbox_events by scripts/verify-no-dropped-events.ts)
 *
 * The gate isn't directly HTTP-exposed (it's an internal ActionTrustLadder
 * call), so this scenario drives the closest HTTP surface that exercises
 * the gate's rate-limit + quota path: POST
 * /tenants/{tenantId}/actions/quotas/preflight. Each request synchronously
 * resolves through the gate without mutating any persistent state, which
 * lets the load test stay idempotent across re-runs.
 *
 * Required env vars:
 *   K6_TOKEN_<TENANT_ID>   Bearer token signed for tenant <TENANT_ID>
 *                          (one per tenant; supply 100 to cover the full set)
 *   K6_TENANT_IDS          Comma-separated list of 100 tenant UUIDs to
 *                          rotate through (one VU per tenant)
 *
 * Optional env vars:
 *   K6_BASE_URL            Default: http://localhost:3100
 *   K6_RPS_PER_TENANT      Override per-tenant RPS (default 10)
 *   K6_DURATION            Override sustained duration (default 10m)
 *   K6_ACTION_CLASS        Override action class probed (default
 *                          'read.tenant_db' — a non-mutating class)
 *
 * Run:
 *   k6 run --out json=results.json load-tests/k6/actions-gate.js
 *
 * Post-run verification (assertion 2 + 3):
 *   tsx scripts/verify-no-dropped-events.ts
 */

import http from 'k6/http';
import { check, fail } from 'k6';
import { Counter, Trend } from 'k6/metrics';

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

const gateLatency       = new Trend('gate_latency', true);  // ms
const gateRequests      = new Counter('gate_requests');
const gateFailures      = new Counter('gate_failures');
const rateLimitedHits   = new Counter('rate_limited_hits');
const forbiddenHits     = new Counter('forbidden_hits');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const BASE_URL        = __ENV.K6_BASE_URL        || 'http://localhost:3100';
const RPS_PER_TENANT  = parseInt(__ENV.K6_RPS_PER_TENANT || '10', 10);
const DURATION        = __ENV.K6_DURATION        || '10m';
const ACTION_CLASS    = __ENV.K6_ACTION_CLASS    || 'read.tenant_db';
const TENANT_IDS      = (__ENV.K6_TENANT_IDS || '').split(',').filter(Boolean);
const TENANT_COUNT    = TENANT_IDS.length;

if (TENANT_COUNT === 0) {
  // Defer fail() to setup() so __ENV resolution shows in the error report.
  console.warn('[actions-gate] K6_TENANT_IDS is empty; setup() will fail.');
}

// ---------------------------------------------------------------------------
// k6 scenarios
// ---------------------------------------------------------------------------

// Aggregate target = 100 tenants × 10 RPS = 1000 RPS.
const TARGET_RPS = TENANT_COUNT * RPS_PER_TENANT;

export const options = {
  scenarios: {
    actions_gate: {
      executor: 'ramping-arrival-rate',
      startRate: 0,
      timeUnit: '1s',
      preAllocatedVUs: Math.ceil(TARGET_RPS * 0.3),
      maxVUs:          Math.ceil(TARGET_RPS * 1.5),
      stages: [
        { target: TARGET_RPS, duration: '60s'    }, // warm-up
        { target: TARGET_RPS, duration: DURATION }, // sustained
        { target: 0,          duration: '30s'    }, // cool-down
      ],
    },
  },

  thresholds: {
    // Plan §F.7.2 acceptance: p99 gate decision latency < 200ms.
    'http_req_duration{scenario:actions_gate}': ['p(99)<200'],
    // Errors are HTTP-level (5xx, network). Hard rate-limit responses are
    // 429 and counted separately via rateLimitedHits.
    'http_req_failed{scenario:actions_gate}':   ['rate<0.001'],
    gate_latency: ['p(99)<200'],
  },

  summaryTrendStats: ['min', 'med', 'avg', 'p(90)', 'p(95)', 'p(99)', 'p(99.9)', 'max'],
};

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

export function setup() {
  if (TENANT_COUNT === 0) {
    fail('K6_TENANT_IDS is required (comma-separated UUID list).');
  }
  // Resolve a token per tenant from K6_TOKEN_<id>. Tokens are pre-signed
  // by the operator before run; this loader is intentionally synchronous.
  const tokens = {};
  for (const tenantId of TENANT_IDS) {
    const tokenVar = `K6_TOKEN_${tenantId.replace(/-/g, '_')}`;
    const token = __ENV[tokenVar];
    if (!token) fail(`${tokenVar} is required for tenant ${tenantId}.`);
    tokens[tenantId] = token;
  }

  // Light smoke check against tenant[0].
  const smokeTenant = TENANT_IDS[0];
  const res = http.post(
    `${BASE_URL}/api/v1/tenants/${smokeTenant}/actions/quotas/preflight`,
    JSON.stringify({ actionClass: ACTION_CLASS }),
    {
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${tokens[smokeTenant]}`,
      },
      timeout: '15s',
    },
  );
  if (res.status >= 500) {
    fail(`Smoke check 5xx (${res.status}): ${res.body.slice(0, 500)}`);
  }
  return { tokens };
}

// ---------------------------------------------------------------------------
// Iteration: per request, pick a tenant round-robin from __ITER
// ---------------------------------------------------------------------------

export default function ({ tokens }) {
  const tenantId = TENANT_IDS[__ITER % TENANT_COUNT];
  const token = tokens[tenantId];

  const start = Date.now();
  const res = http.post(
    `${BASE_URL}/api/v1/tenants/${tenantId}/actions/quotas/preflight`,
    JSON.stringify({ actionClass: ACTION_CLASS }),
    {
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${token}`,
      },
      timeout: '10s',
      tags: { endpoint: 'POST /tenants/{id}/actions/quotas/preflight' },
    },
  );
  const elapsed = Date.now() - start;
  gateLatency.add(elapsed);
  gateRequests.add(1);

  if (res.status === 429) {
    rateLimitedHits.add(1);
    return; // rate-limit is an expected outcome at sustained RPS
  }
  if (res.status === 403 || res.status === 422) {
    forbiddenHits.add(1);
    return;
  }
  const ok = check(res, {
    'status 200 or 204': (r) => r.status === 200 || r.status === 204,
  });
  if (!ok) gateFailures.add(1);
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

export function handleSummary(data) {
  const dur = data.metrics['gate_latency'];
  const p99 = dur?.values?.['p(99)'] ?? 'n/a';
  const rps = data.metrics['http_reqs']?.values?.rate?.toFixed(1) ?? 'n/a';
  const failed = data.metrics['gate_failures']?.values?.count ?? 0;
  const rateLimited = data.metrics['rate_limited_hits']?.values?.count ?? 0;

  const lines = [
    '',
    '════════════════════════════════════════════════════',
    '  F.7.2 load test — action gate',
    '════════════════════════════════════════════════════',
    `  Tenants:        ${TENANT_COUNT}`,
    `  Per-tenant RPS: ${RPS_PER_TENANT}`,
    `  Target RPS:     ${TARGET_RPS}`,
    `  Action class:   ${ACTION_CLASS}`,
    `  Throughput:     ${rps} req/s`,
    `  p99 gate:       ${typeof p99 === 'number' ? p99.toFixed(1) : p99} ms  (SLA < 200 ms)`,
    `  Failures:       ${failed}`,
    `  Rate-limited:   ${rateLimited} (expected at sustained RPS)`,
    '',
    `  SLA p99:        ${typeof p99 === 'number' && p99 < 200 ? 'PASS ✓' : 'FAIL ✗'}`,
    '',
    '  Post-run verification (assertion 2 + 3):',
    '    tsx scripts/verify-no-dropped-events.ts',
    '════════════════════════════════════════════════════',
    '',
  ];

  console.log(lines.join('\n'));
  return {
    stdout: lines.join('\n'),
    'results/actions-gate-summary.json': JSON.stringify(data, null, 2),
  };
}
