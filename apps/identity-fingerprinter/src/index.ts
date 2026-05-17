// D.13 — Identity fingerprinter (weekly cron).
// Computes per-role style metrics from stable-v0 prompt_versions texts,
// inserts a system_identity_fingerprints row, then compares against the
// prior fingerprint to detect drift.
//
// Drift detection axes:
//   avg_sentence_length  — mean tokens per sentence per role
//   vocab_entropy        — Shannon entropy of top-500 word frequencies per role
//   topic_entropy        — cross-role vocabulary distribution entropy (scalar)
//
// High-severity drift (magnitude > HIGH_THRESHOLD) inserts an identity_drift_events
// row. Auto-trigger: identity_drift_event_total{baseline_window="7d",severity="high"} > 0
// → platform drops to mode 1 (external enforcement not in this service).

import { Pool }    from 'pg';
import cron        from 'node-cron';

// ── Config ────────────────────────────────────────────────────────────────────

const DATABASE_URL   = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  console.error('[identity-fingerprinter] DATABASE_URL required');
  process.exit(1);
}

const CRON_EXPR         = process.env['IDENTITY_CRON']          ?? '0 3 * * 1';    // weekly Monday 03:00
const DRIFT_THRESHOLD   = parseFloat(process.env['DRIFT_THRESHOLD'] ?? '0.20');     // 20% deviation = drift
const HIGH_THRESHOLD    = parseFloat(process.env['HIGH_THRESHOLD']  ?? '0.40');     // 40% = high severity
const STABLE_ROLE       = process.env['STABLE_ROLE_FILTER']     ?? 'stable-v0';     // prompt_versions.version

const pool = new Pool({ connectionString: DATABASE_URL, max: 3 });

// ── OTEL (best-effort) ────────────────────────────────────────────────────────

type OtelCounter = { add(n: number, attrs?: Record<string, string>): void };
let driftCounter: OtelCounter = { add() {} };

try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any
  const api = require('@opentelemetry/api') as any;
  const meter = api.metrics.getMeter('identity-fingerprinter', '0.1.0');
  driftCounter = meter.createCounter('identity_drift_event_total', {
    description: 'Number of identity drift events detected',
  }) as OtelCounter;
} catch { /* no-op — OTEL not installed */ }

// ── Text analysis helpers ─────────────────────────────────────────────────────

function tokenise(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s'-]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 1);
}

function sentences(text: string): string[] {
  return text
    .split(/[.!?]+/)
    .map(s => s.trim())
    .filter(s => s.length > 0);
}

function avgSentenceLength(text: string): number {
  const sents = sentences(text);
  if (sents.length === 0) return 0;
  const totalWords = sents.reduce((sum, s) => sum + tokenise(s).length, 0);
  return totalWords / sents.length;
}

/** Shannon entropy (bits) of a word-frequency distribution. */
function shannonEntropy(freqMap: Map<string, number>): number {
  const total = [...freqMap.values()].reduce((a, b) => a + b, 0);
  if (total === 0) return 0;
  let entropy = 0;
  for (const count of freqMap.values()) {
    const p = count / total;
    if (p > 0) entropy -= p * Math.log2(p);
  }
  return entropy;
}

/** Normalised term-frequency vector over the top-N most frequent words. */
function termFreqVector(text: string, topN = 300): Record<string, number> {
  const tokens = tokenise(text);
  const freq   = new Map<string, number>();
  for (const t of tokens) freq.set(t, (freq.get(t) ?? 0) + 1);

  // Keep top-N by frequency
  const sorted = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, topN);
  const total  = sorted.reduce((s, [, c]) => s + c, 0);
  const vec: Record<string, number> = {};
  for (const [word, count] of sorted) {
    vec[word] = total > 0 ? count / total : 0;
  }
  return vec;
}

/** Cosine similarity between two sparse TF vectors (range [0,1]). */
function cosineSim(a: Record<string, number>, b: Record<string, number>): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (const [w, va] of Object.entries(a)) {
    const vb = b[w] ?? 0;
    dot   += va * vb;
    normA += va * va;
  }
  for (const vb of Object.values(b)) normB += vb * vb;
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom > 0 ? dot / denom : 0;
}

/** Cosine distance = 1 − similarity. */
function cosineDist(a: Record<string, number>, b: Record<string, number>): number {
  return 1 - cosineSim(a, b);
}

// ── Fingerprint computation ───────────────────────────────────────────────────

interface RoleFingerprint {
  avgSentenceLength: number;
  vocabEntropy:      number;
  termFreqVector:    Record<string, number>;
  vocabSize:         number;
}

interface Fingerprint {
  byRole:       Record<string, RoleFingerprint>;
  topicEntropy: number;
}

async function computeFingerprint(): Promise<Fingerprint | null> {
  // Pull all stable-v0 prompt versions (latest per slot_id + role)
  const result = await pool.query<{ role: string; content: string }>(`
    SELECT DISTINCT ON (slot_id, role)
      role, content
    FROM oweibo.prompt_versions
    WHERE version = $1
    ORDER BY slot_id, role, created_at DESC
  `, [STABLE_ROLE]);

  if (result.rows.length === 0) {
    console.log('[identity-fingerprinter] No stable-v0 prompt_versions found — skipping');
    return null;
  }

  // Aggregate text per role
  const roleTexts = new Map<string, string[]>();
  for (const row of result.rows) {
    if (!roleTexts.has(row.role)) roleTexts.set(row.role, []);
    roleTexts.get(row.role)!.push(row.content);
  }

  const byRole: Record<string, RoleFingerprint> = {};

  // Cross-role vocabulary for topic entropy
  const globalFreq = new Map<string, number>();

  for (const [role, texts] of roleTexts) {
    const combined = texts.join('\n\n');
    const tokens   = tokenise(combined);
    const freq     = new Map<string, number>();
    for (const t of tokens) {
      freq.set(t, (freq.get(t) ?? 0) + 1);
      globalFreq.set(t, (globalFreq.get(t) ?? 0) + 1);
    }

    byRole[role] = {
      avgSentenceLength: avgSentenceLength(combined),
      vocabEntropy:      shannonEntropy(freq),
      termFreqVector:    termFreqVector(combined),
      vocabSize:         freq.size,
    };
  }

  const topicEntropy = shannonEntropy(globalFreq);

  return { byRole, topicEntropy };
}

// ── Drift detection ───────────────────────────────────────────────────────────

interface DriftEvent {
  axis:      string;
  magnitude: number;
  severity:  'low' | 'high';
}

function detectDrift(
  prev: Fingerprint,
  curr: Fingerprint,
): DriftEvent[] {
  const events: DriftEvent[] = [];

  // Per-role axes
  const allRoles = new Set([...Object.keys(prev.byRole), ...Object.keys(curr.byRole)]);

  for (const role of allRoles) {
    const p = prev.byRole[role];
    const c = curr.byRole[role];
    if (!p || !c) continue;

    // avg_sentence_length: relative deviation
    if (p.avgSentenceLength > 0) {
      const relDelta = Math.abs(c.avgSentenceLength - p.avgSentenceLength) / p.avgSentenceLength;
      if (relDelta >= DRIFT_THRESHOLD) {
        events.push({
          axis:      `avg_sentence_length:${role}`,
          magnitude: relDelta,
          severity:  relDelta >= HIGH_THRESHOLD ? 'high' : 'low',
        });
      }
    }

    // vocab_entropy: relative deviation
    if (p.vocabEntropy > 0) {
      const relDelta = Math.abs(c.vocabEntropy - p.vocabEntropy) / p.vocabEntropy;
      if (relDelta >= DRIFT_THRESHOLD) {
        events.push({
          axis:      `vocab_entropy:${role}`,
          magnitude: relDelta,
          severity:  relDelta >= HIGH_THRESHOLD ? 'high' : 'low',
        });
      }
    }

    // role_vector cosine distance
    const dist = cosineDist(p.termFreqVector, c.termFreqVector);
    if (dist >= DRIFT_THRESHOLD) {
      events.push({
        axis:      `role_vector:${role}`,
        magnitude: dist,
        severity:  dist >= HIGH_THRESHOLD ? 'high' : 'low',
      });
    }
  }

  // Global topic_entropy
  if (prev.topicEntropy > 0) {
    const relDelta = Math.abs(curr.topicEntropy - prev.topicEntropy) / prev.topicEntropy;
    if (relDelta >= DRIFT_THRESHOLD) {
      events.push({
        axis:      'topic_entropy',
        magnitude: relDelta,
        severity:  relDelta >= HIGH_THRESHOLD ? 'high' : 'low',
      });
    }
  }

  return events;
}

// ── DB operations ─────────────────────────────────────────────────────────────

async function persistFingerprint(fp: Fingerprint): Promise<string> {
  const styleMetrics = Object.fromEntries(
    Object.entries(fp.byRole).map(([role, rf]) => [role, {
      avgSentenceLength: rf.avgSentenceLength,
      vocabEntropy:      rf.vocabEntropy,
      vocabSize:         rf.vocabSize,
    }]),
  );

  const result = await pool.query<{ id: string }>(`
    INSERT INTO oweibo.system_identity_fingerprints
      (fingerprint_date, role_vectors, style_metrics, topic_entropy)
    VALUES (CURRENT_DATE, $1, $2, $3)
    ON CONFLICT (fingerprint_date) DO UPDATE SET
      role_vectors   = EXCLUDED.role_vectors,
      style_metrics  = EXCLUDED.style_metrics,
      topic_entropy  = EXCLUDED.topic_entropy,
      computed_at    = NOW()
    RETURNING id
  `, [
    JSON.stringify(fp.byRole),
    JSON.stringify(styleMetrics),
    fp.topicEntropy,
  ]);

  return result.rows[0]!.id;
}

async function persistDriftEvent(
  fromFingerprintId: string,
  event:             DriftEvent,
): Promise<void> {
  await pool.query(`
    INSERT INTO oweibo.identity_drift_events
      (from_fingerprint, drift_axis, drift_magnitude)
    VALUES ($1, $2, $3)
  `, [fromFingerprintId, event.axis, event.magnitude]);
}

// ── Core run ──────────────────────────────────────────────────────────────────

async function runFingerprinter(): Promise<void> {
  const startMs = Date.now();
  console.log('[identity-fingerprinter] Starting fingerprint run');

  const curr = await computeFingerprint();
  if (!curr) return;

  const fingerprintId = await persistFingerprint(curr);
  console.log(`[identity-fingerprinter] Fingerprint saved: id=${fingerprintId}`);

  // Use the second-most-recent row as baseline (excluding the one we just wrote)
  const baseline = await loadBaselineFingerprint(fingerprintId);

  if (!baseline) {
    console.log('[identity-fingerprinter] No prior fingerprint for comparison — establishing baseline');
    return;
  }

  const driftEvents = detectDrift(baseline.fp, curr);

  if (driftEvents.length === 0) {
    console.log('[identity-fingerprinter] No drift detected');
    return;
  }

  let highCount = 0;
  for (const event of driftEvents) {
    await persistDriftEvent(baseline.id, event);
    driftCounter.add(1, {
      axis:             event.axis,
      baseline_window:  '7d',
      resolution:       'pending',
      severity:         event.severity,
    });
    console.log(
      `[identity-fingerprinter] Drift detected: axis=${event.axis} magnitude=${event.magnitude.toFixed(4)} severity=${event.severity}`,
    );
    if (event.severity === 'high') highCount++;
  }

  const elapsedMs = Date.now() - startMs;
  console.log(
    `[identity-fingerprinter] Done: drift_events=${driftEvents.length} high=${highCount} elapsed=${elapsedMs}ms`,
  );

  if (highCount > 0) {
    console.warn(
      `[identity-fingerprinter] HIGH-SEVERITY DRIFT (${highCount} axes). ` +
      `Auto-trigger condition met: platform should drop to mode 1.`,
    );
  }
}

/** Load the most recent fingerprint that is NOT the one we just computed. */
async function loadBaselineFingerprint(
  excludeId: string,
): Promise<{ id: string; fp: Fingerprint } | null> {
  const result = await pool.query<{
    id:            string;
    role_vectors:  unknown;
    topic_entropy: string | null;
  }>(`
    SELECT id, role_vectors, topic_entropy
    FROM oweibo.system_identity_fingerprints
    WHERE id != $1
    ORDER BY fingerprint_date DESC
    LIMIT 1
  `, [excludeId]);

  if (result.rows.length === 0) return null;
  const row = result.rows[0]!;

  try {
    const byRole = row.role_vectors as Record<string, RoleFingerprint>;
    const topicEntropy = row.topic_entropy != null ? parseFloat(row.topic_entropy) : 0;
    return { id: row.id, fp: { byRole, topicEntropy } };
  } catch {
    return null;
  }
}

// ── Entry point ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Run immediately on startup, then schedule
  await runFingerprinter().catch(err => {
    console.error('[identity-fingerprinter] Startup run failed:', String(err));
  });

  cron.schedule(CRON_EXPR, () => {
    runFingerprinter().catch(err => {
      console.error('[identity-fingerprinter] Scheduled run failed:', String(err));
    });
  });

  console.log(`[identity-fingerprinter] Scheduled: "${CRON_EXPR}"`);

  process.on('SIGTERM', async () => {
    console.log('[identity-fingerprinter] SIGTERM — shutting down');
    await pool.end();
    process.exit(0);
  });
}

main().catch(err => {
  console.error('[identity-fingerprinter] Fatal:', err);
  process.exit(1);
});
