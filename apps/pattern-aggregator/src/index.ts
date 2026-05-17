// DONE: Phase B.5 — PatternAggregator entry point.
import { Pool } from 'pg';
import Redis from 'ioredis';
import { processLessonMessage } from './PatternAggregator.js';
import { getTenantSecret } from './LessonVerifier.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const REDIS_URL    = process.env['REDIS_URL'] ?? 'redis://localhost:6379';

if (!DATABASE_URL) {
  console.error('[pattern-aggregator] DATABASE_URL is required');
  process.exit(1);
}

const pool = new Pool({ connectionString: DATABASE_URL, max: 5 });
const subscriber = new Redis(REDIS_URL, { maxRetriesPerRequest: null, lazyConnect: true });

const counters: Record<string, number> = {};
function increment(counter: string, _labels?: Record<string, string>) {
  counters[counter] = (counters[counter] ?? 0) + 1;
  if (counters[counter]! % 100 === 0) {
    console.log(`[pattern-aggregator] ${counter}=${counters[counter]}`);
  }
}

async function main() {
  await subscriber.connect();
  console.log('[pattern-aggregator] Connected to Redis. Subscribing to platform.lesson.submitted');

  await subscriber.subscribe('platform.lesson.submitted');
  subscriber.on('message', (_channel: string, raw: string) => {
    void processLessonMessage(raw, {
      pool,
      getSecret: getTenantSecret,
      increment,
    });
  });

  process.on('SIGTERM', async () => {
    console.log('[pattern-aggregator] SIGTERM — shutting down');
    await subscriber.unsubscribe();
    await subscriber.quit();
    await pool.end();
    process.exit(0);
  });
}

main().catch(err => {
  console.error('[pattern-aggregator] Fatal:', err);
  process.exit(1);
});
