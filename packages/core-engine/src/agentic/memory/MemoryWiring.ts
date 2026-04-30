/**
 * MemoryWiring — single entry point that constructs the four-tier memory
 * subsystem from environment-derived config.
 *
 * Closes gap analysis #1 (`MemoryOrchestrator` never instantiated) and #2
 * (`main.ts` stub with `null as never` deps). Replaces the broken inline
 * `new QdrantSemanticStore({ qdrant: null, embedder: null })` with a real
 * orchestrator that gracefully degrades when optional deps are missing:
 *
 *   • Tier 1 (WorkingMemoryRegistry) — always available.
 *   • Tier 2 (ShortTermMemoryStore)  — needs Redis. Always wired here.
 *   • Tier 3 (ProjectRegistry)       — needs Redis. Always wired here.
 *   • Tier 4 (QdrantSemanticStore)   — needs Qdrant + an Embedder. Wired
 *     only when `qdrantUrl` and an embedder are present. Otherwise the
 *     orchestrator omits the semantic tier; `record()` synthesises entries
 *     and `recall()` returns []. The contract still holds.
 *
 * Background services (decay, consolidator, promoter, warmer) are
 * constructed only when their preconditions hold (Qdrant for all four;
 * pg.Pool for decay's archival path). `start()` schedules them on
 * configurable intervals; `stop()` clears all timers.
 */

import type { Redis } from 'ioredis';
import type { Pool } from 'pg';
import type {
  IMemoryOrchestrator,
  ISemanticMemoryStore,
} from '@oweibo/core-contracts';

import { MemoryOrchestrator } from './MemoryOrchestrator.js';
import { WorkingMemoryRegistry } from './WorkingMemory.js';
import { ShortTermMemoryStore }  from './ShortTermMemoryStore.js';
import { ProjectRegistry }       from './ProjectRegistry.js';
import {
  QdrantSemanticStore,
  type Embedder,
  type PurgeAuditor,
} from './QdrantSemanticStore.js';
import { OllamaEmbedder } from './OllamaEmbedder.js';
import { MemoryCircuitBreaker } from './MemoryCircuitBreaker.js';
import {
  MemoryDecayService,
  DEFAULT_DECAY_CONFIG,
  type Logger,
} from '../MemoryDecayService.js';
import {
  MemoryConsolidator,
  DEFAULT_CONSOLIDATOR_CONFIG,
} from '../MemoryConsolidator.js';
import {
  MemoryScopePromoter,
  DEFAULT_PROMOTER_CONFIG,
} from '../MemoryScopePromoter.js';
import { MemoryWarmer } from '../MemoryWarmer.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type QdrantClient = any;

const DAY_MS  = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

export interface MemoryWiringConfig {
  readonly redis:    Redis;
  readonly qdrantUrl?:       string;
  readonly qdrantApiKey?:    string;
  readonly ollamaUrl?:       string;
  readonly embedModel?:      string;
  readonly vectorDimension?: number;
  readonly pgPool?:          Pool;
  /** Used by background services to enumerate tenants needing processing. */
  readonly tenantIds?: () => Promise<string[]>;
  readonly logger?:    Logger;
  /** Override an embedder explicitly (skips OllamaEmbedder construction). */
  readonly embedder?: Embedder;
  /**
   * Hook invoked after every successful purgeTenant / purgeProject /
   * purgeUser. Typically wraps `appendAudit()` from @oweibo/db. Declared
   * as a callback so core-engine stays free of DB imports.
   */
  readonly purgeAuditor?: PurgeAuditor;
  /**
   * Configuration for the in-process Qdrant circuit breaker. Pass `false`
   * to disable; pass an object to override the defaults; omit for the
   * defaults (3 failures → 30s cooldown).
   */
  readonly breaker?: false | {
    readonly failureThreshold?: number;
    readonly cooldownMs?:       number;
  };
  readonly schedules?: {
    readonly decayMs?:        number; // default: 7d
    readonly consolidatorMs?: number; // default: 1d
    readonly promoterMs?:     number; // default: 1d
  };
}

export interface MemoryServices {
  decay?:        MemoryDecayService;
  consolidator?: MemoryConsolidator;
  promoter?:     MemoryScopePromoter;
  warmer?:       MemoryWarmer;
}

export interface MemorySubsystem {
  readonly orchestrator: IMemoryOrchestrator;
  readonly semantic:     ISemanticMemoryStore | null;
  readonly services:     MemoryServices;
  readonly start: () => void;
  readonly stop:  () => void;
}

const DEFAULT_LOGGER: Logger = {
  info:  (...a) => console.log('[memory]',  ...a),
  warn:  (...a) => console.warn('[memory]', ...a),
  error: (...a) => console.error('[memory]', ...a),
  debug: () => undefined,
};

export async function wireMemorySubsystem(cfg: MemoryWiringConfig): Promise<MemorySubsystem> {
  const logger = cfg.logger ?? DEFAULT_LOGGER;

  // ── Tiers 1–3: always wired ────────────────────────────────────────────────
  const working   = new WorkingMemoryRegistry();
  // ShortTermMemoryStore and ProjectRegistry use a Redis duck-type subset; the
  // ioredis client satisfies it but TypeScript doesn't know that, so cast.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const shortTerm = new ShortTermMemoryStore(cfg.redis as any);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const projects  = new ProjectRegistry(cfg.redis as any);

  // ── Tier 4: optional ──────────────────────────────────────────────────────
  let qdrant:   QdrantClient | null = null;
  let embedder: Embedder | null = null;
  let semantic: ISemanticMemoryStore | null = null;

  if (cfg.qdrantUrl) {
    try {
      const mod = await import('@qdrant/js-client-rest') as { QdrantClient: new (opts: object) => QdrantClient };
      qdrant = new mod.QdrantClient({
        url: cfg.qdrantUrl,
        // Skip the synchronous server-version handshake that the client
        // otherwise fires off in the constructor — we tolerate version
        // mismatches at runtime and don't want startup noise.
        checkCompatibility: false,
        ...(cfg.qdrantApiKey ? { apiKey: cfg.qdrantApiKey } : {}),
      });
    } catch (err) {
      logger.warn('Qdrant client construction failed; semantic tier disabled', err);
      qdrant = null;
    }
  }

  if (cfg.embedder) {
    embedder = cfg.embedder;
  } else if (cfg.ollamaUrl && cfg.embedModel) {
    const ollama = new OllamaEmbedder({
      baseUrl:   cfg.ollamaUrl,
      model:     cfg.embedModel,
      ...(cfg.vectorDimension ? { dimension: cfg.vectorDimension } : {}),
    });
    embedder = ollama.asEmbedder();
  }

  // Construct the optional in-process circuit breaker. Reused across the
  // semantic store and any service that ends up sharing the Qdrant client.
  const breaker = cfg.breaker === false
    ? undefined
    : new MemoryCircuitBreaker('qdrant-semantic-store', {
        ...(cfg.breaker?.failureThreshold !== undefined ? { failureThreshold: cfg.breaker.failureThreshold } : {}),
        ...(cfg.breaker?.cooldownMs       !== undefined ? { cooldownMs:       cfg.breaker.cooldownMs       } : {}),
      });

  if (qdrant && embedder) {
    semantic = new QdrantSemanticStore({
      qdrant,
      embedder,
      ...(cfg.vectorDimension ? { config: { vectorDimension: cfg.vectorDimension } as never } : {}),
      ...(breaker ? { breaker } : {}),
      ...(cfg.purgeAuditor ? { audit: cfg.purgeAuditor } : {}),
    });
    logger.info('semantic tier wired (Qdrant +', cfg.embedModel ?? 'custom embedder', ')');
  } else {
    logger.warn(
      'semantic tier NOT wired:',
      !qdrant   ? 'no QDRANT_URL'   : '',
      !embedder ? 'no embedder'     : '',
    );
  }

  // ── Orchestrator ──────────────────────────────────────────────────────────
  const orchestrator = new MemoryOrchestrator({
    working, shortTerm, projects,
    ...(semantic ? { semantic } : {}),
  });

  // ── Background services ────────────────────────────────────────────────────
  const services: MemoryServices = {};
  const tenantIds = cfg.tenantIds ?? (async () => [] as string[]);

  if (qdrant && embedder) {
    services.consolidator = new MemoryConsolidator(
      qdrant, embedder, DEFAULT_CONSOLIDATOR_CONFIG, tenantIds, logger,
    );
    services.promoter = new MemoryScopePromoter(
      qdrant, DEFAULT_PROMOTER_CONFIG, tenantIds, logger,
    );
    if (cfg.pgPool) {
      services.decay = new MemoryDecayService(
        qdrant, cfg.pgPool, DEFAULT_DECAY_CONFIG, tenantIds, logger,
      );
    } else {
      logger.warn('MemoryDecayService not started: no pg.Pool provided');
    }
  }
  if (semantic) {
    services.warmer = new MemoryWarmer(
      semantic,
      // MemoryWarmer wants the legacy concrete ShortTermMemoryStore for its
      // recallSemanticTurns() method. The interface ShortTermMemoryStore
      // exposes is the same instance.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      shortTerm as any,
    );
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────
  const intervals: ReturnType<typeof setInterval>[] = [];

  const start = (): void => {
    if (services.decay) {
      const ms = cfg.schedules?.decayMs ?? WEEK_MS;
      intervals.push(setInterval(() => {
        services.decay!.runDecayCycle().catch(e => logger.error('decay cycle failed', e));
      }, ms).unref?.() as ReturnType<typeof setInterval> ?? intervals[intervals.length - 1]);
    }
    if (services.consolidator) {
      const ms = cfg.schedules?.consolidatorMs ?? DAY_MS;
      intervals.push(setInterval(() => {
        services.consolidator!.runConsolidationCycle().catch(e => logger.error('consolidator cycle failed', e));
      }, ms).unref?.() as ReturnType<typeof setInterval> ?? intervals[intervals.length - 1]);
    }
    if (services.promoter) {
      const ms = cfg.schedules?.promoterMs ?? DAY_MS;
      intervals.push(setInterval(() => {
        services.promoter!.runPromotionCycle().catch(e => logger.error('promoter cycle failed', e));
      }, ms).unref?.() as ReturnType<typeof setInterval> ?? intervals[intervals.length - 1]);
    }
    logger.info(`memory background services started (${Object.keys(services).filter(k => services[k as keyof typeof services]).length})`);
  };

  const stop = (): void => {
    for (const i of intervals) clearInterval(i);
    intervals.length = 0;
  };

  return { orchestrator, semantic, services, start, stop };
}
