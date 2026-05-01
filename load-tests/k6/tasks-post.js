/**
 * k6 load test — POST /tasks sustained throughput
 *
 * SLA targets (Phase 7):
 *   - 500 RPS sustained for 30 minutes
 *   - p99 latency < 500 ms (sustained phase only)
 *   - Error rate < 0.1 %
 *
 * Required env vars:
 *   K6_TOKEN     Bearer token (JWT or oweibo_legacy_* api-key)
 *   K6_TENANT_ID Tenant ID encoded in the token (used for tagging only)
 *
 * Optional env vars:
 *   K6_BASE_URL  Default: http://localhost:3100
 *   K6_RPS       Override sustained RPS (default 500)
 *   K6_DURATION  Override sustained duration (default 30m)
 *
 * Run:
 *   k6 run --out json=results.json load-tests/k6/tasks-post.js
 *
 * CI (summary only, no live progress):
 *   k6 run --quiet --summary-export=results/load-summary.json load-tests/k6/tasks-post.js
 */

import http from 'k6/http';
import { check, fail } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';

// ---------------------------------------------------------------------------
// Custom metrics
// ---------------------------------------------------------------------------

const tasksSubmitted      = new Counter('tasks_submitted');
const tasksFailed         = new Counter('tasks_failed');
const clarificationNeeded = new Rate('tasks_needs_clarification');
const submitLatency       = new Trend('tasks_submit_latency', true); // ms

// ---------------------------------------------------------------------------
// Realistic instruction pool — varied length and domain
// ---------------------------------------------------------------------------

const INSTRUCTIONS = [
  'Write a Python function that reads a CSV file and returns a dict of column statistics (mean, median, std dev).',
  'Create an Express.js middleware that validates a JWT and extracts the tenantId claim.',
  'Refactor this nested if-else into a lookup table: if (status === "active") return 1; else if (status === "paused") return 2; else if (status === "archived") return 3; else return 0;',
  'Write a SQL query that finds the top 10 customers by total revenue in the last 90 days, grouped by country.',
  'Add TypeScript types to this function: function merge(a, b) { return { ...a, ...b }; }',
  'Write a bash script that monitors disk usage every 5 minutes and sends a webhook if usage exceeds 80%.',
  'Create a React hook that debounces a search input and calls an async API after 300ms idle.',
  'Explain why this PostgreSQL query is slow and suggest an index: SELECT * FROM events WHERE tenant_id = $1 AND created_at > NOW() - INTERVAL \'7 days\';',
  'Write a Dockerfile for a Node.js 20 app that runs as a non-root user and has a health check.',
  'Convert this callback-based code to async/await: fs.readFile(path, (err, data) => { if (err) throw err; process(data); });',
  'Write a Python class for a rate limiter using the token bucket algorithm.',
  'Generate a Zod schema for a user registration form with email, password (min 8 chars), and optional phone number.',
  'Write a GitHub Actions workflow that runs tests on PR and deploys to staging on merge to main.',
  'Audit this error handler for security issues: app.use((err, req, res, next) => { res.json({ error: err.message, stack: err.stack }); });',
  'Write a Redis Lua script that implements a sliding-window rate limiter for 100 requests per minute.',
  'Create a k8s Deployment manifest for a stateless service with 3 replicas, resource limits, and liveness probe.',
  'Write a TypeScript utility type that makes all nested properties of an object optional.',
  'Implement a binary search function in TypeScript with proper type generics and a comparator parameter.',
  'Write an OpenAPI 3.0 spec for a task submission endpoint that accepts instruction and optional deliveryMode.',
  'Create a Prometheus alerting rule that fires if p99 latency exceeds 500ms for more than 5 minutes.',
];

// ---------------------------------------------------------------------------
// k6 options
// ---------------------------------------------------------------------------

const RPS      = parseInt(__ENV.K6_RPS      || '500',  10);
const DURATION = __ENV.K6_DURATION          || '30m';
const BASE_URL = __ENV.K6_BASE_URL          || 'http://localhost:3100';

export const options = {
  scenarios: {
    // Ramp from 0 → target RPS over 30 s, then hold, then ramp down.
    tasks_load: {
      executor: 'ramping-arrival-rate',
      startRate: 0,
      timeUnit: '1s',
      preAllocatedVUs: Math.ceil(RPS * 0.3),   // pre-warm 30 % of expected VUs
      maxVUs:          Math.ceil(RPS * 1.5),    // headroom for slow responses
      stages: [
        { target: RPS,   duration: '30s'     }, // warm-up
        { target: RPS,   duration: DURATION  }, // sustained
        { target: 0,     duration: '30s'     }, // cool-down
      ],
    },
  },

  thresholds: {
    // Sustained phase SLA — applied across the whole run; warm-up / cool-down
    // phases are < 60 s combined so they have minimal effect on p99.
    'http_req_duration{scenario:tasks_load}': ['p(99)<500'],
    'http_req_failed{scenario:tasks_load}':   ['rate<0.001'],

    // Custom metrics — informational (won't abort the run)
    tasks_submit_latency: ['p(99)<500'],
  },

  summaryTrendStats: ['min', 'med', 'avg', 'p(90)', 'p(95)', 'p(99)', 'p(99.9)', 'max'],
};

// ---------------------------------------------------------------------------
// Setup — validate token is set and API is reachable
// ---------------------------------------------------------------------------

export function setup() {
  const token = __ENV.K6_TOKEN;
  if (!token) {
    fail('K6_TOKEN is required. Set it to a valid Bearer token before running.');
  }

  // Light smoke-check: submit one request at low RPS.
  const res = http.post(
    `${BASE_URL}/tasks`,
    JSON.stringify({ instruction: 'Smoke check from k6 setup.' }),
    {
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${token}`,
      },
      timeout: '15s',
    },
  );

  if (res.status !== 201 && res.status !== 202) {
    fail(
      `Setup smoke check failed: expected 201/202, got ${res.status}.\n` +
      `Body: ${res.body.slice(0, 500)}`,
    );
  }

  return { token, baseUrl: BASE_URL };
}

// ---------------------------------------------------------------------------
// Default function — one virtual user iteration
// ---------------------------------------------------------------------------

export default function ({ token, baseUrl }) {
  const instruction = INSTRUCTIONS[Math.floor(Math.random() * INSTRUCTIONS.length)];

  const start = Date.now();
  const res = http.post(
    `${baseUrl}/tasks`,
    JSON.stringify({ instruction }),
    {
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${token}`,
      },
      timeout: '10s',
      tags: { endpoint: 'POST /tasks' },
    },
  );
  submitLatency.add(Date.now() - start);

  const ok = check(res, {
    'status 201 or 202': (r) => r.status === 201 || r.status === 202,
    'body has taskId':   (r) => {
      try {
        const b = JSON.parse(r.body);
        return typeof b.taskId === 'string' && b.taskId.length > 0;
      } catch {
        return false;
      }
    },
  });

  if (ok) {
    tasksSubmitted.add(1);
    try {
      const body = JSON.parse(res.body);
      clarificationNeeded.add(body.status === 'needs_clarification' ? 1 : 0);
    } catch { /* non-critical */ }
  } else {
    tasksFailed.add(1);
  }
}

// ---------------------------------------------------------------------------
// Teardown — print summary to stdout (captured by --summary-export too)
// ---------------------------------------------------------------------------

export function teardown({ token, baseUrl }) {
  // Nothing to clean up — tasks are ephemeral in load test context.
}

export function handleSummary(data) {
  const dur   = data.metrics['http_req_duration'];
  const fail  = data.metrics['http_req_failed'];
  const p99   = dur?.values?.['p(99)']  ?? 'n/a';
  const p999  = dur?.values?.['p(99.9)'] ?? 'n/a';
  const rps   = data.metrics['http_reqs']?.values?.rate?.toFixed(1) ?? 'n/a';
  const errPct = ((fail?.values?.rate ?? 0) * 100).toFixed(3);

  const lines = [
    '',
    '════════════════════════════════════════════════════',
    '  Phase 7 load test — POST /tasks',
    '════════════════════════════════════════════════════',
    `  Throughput:    ${rps} req/s`,
    `  p99 latency:   ${typeof p99 === 'number' ? p99.toFixed(1) : p99} ms  (SLA < 500 ms)`,
    `  p99.9 latency: ${typeof p999 === 'number' ? p999.toFixed(1) : p999} ms`,
    `  Error rate:    ${errPct} %  (SLA < 0.1 %)`,
    '',
    `  SLA p99:       ${typeof p99 === 'number' && p99 < 500  ? 'PASS ✓' : 'FAIL ✗'}`,
    `  SLA errors:    ${parseFloat(errPct) < 0.1             ? 'PASS ✓' : 'FAIL ✗'}`,
    '════════════════════════════════════════════════════',
    '',
  ];

  console.log(lines.join('\n'));

  // Return raw summary JSON alongside the human-readable output.
  return {
    stdout: lines.join('\n'),
    'results/load-summary.json': JSON.stringify(data, null, 2),
  };
}
