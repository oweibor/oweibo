/**
 * T.4 — MemoryWarmer fifth-channel integration.
 *
 * Existing four-channel behavior is byte-identical when no recall service
 * is injected. With one injected, platform-lesson hits join the merge
 * with PLATFORM_LESSON_SCALE * score + PLATFORM_LESSON_OFFSET and are
 * subject to the same dedup / seed-suppression rules as organic entries.
 */
import { MemoryWarmer } from '../MemoryWarmer.js';
import type {
  ISemanticMemoryStore,
  IPlatformLessonRecall,
  RankedMemoryEntry,
} from '@oweibo/core-contracts';
import type { ShortTermMemoryStore } from '../ShortTermMemoryStore.js';

function rankedEntry(id: string, summary: string, score: number, tags?: string[]): RankedMemoryEntry {
  return {
    id,
    scope: { tenantId: 't', projectId: undefined, userId: undefined, agentId: undefined } as never,
    kind: 'failure-lesson',
    summary,
    importance: 0.5,
    createdAt: '2026-05-22T00:00:00Z',
    updatedAt: '2026-05-22T00:00:00Z',
    recallCount: 0,
    ...(tags ? { tags } : {}),
    score,
    scoreBreakdown: { semantic: score, recency: 0, importance: 0, kindBoost: 0, mmrPenalty: 0 },
  };
}

function ltmStub(recallReturns: readonly RankedMemoryEntry[] = []): ISemanticMemoryStore {
  return {
    store: jest.fn(),
    recall: jest.fn().mockResolvedValue(recallReturns),
    purgeTenant: jest.fn(),
    purgeProject: jest.fn(),
    purgeUser: jest.fn(),
  } as unknown as ISemanticMemoryStore;
}

const stmStub: ShortTermMemoryStore = {
  recall: jest.fn().mockResolvedValue([]),
} as unknown as ShortTermMemoryStore;

describe('MemoryWarmer without platform-lesson channel', () => {
  it('runs the four-channel path unchanged when no recall is injected', async () => {
    const ltm = ltmStub([rankedEntry('a', 'organic agent hit', 0.5)]);
    const warmer = new MemoryWarmer(ltm, stmStub);
    const out = await warmer.warmForTask({
      tenantId: 't', sessionId: 's', agentScope: 'executor:task1',
      taskDescription: 'do thing',
    });
    expect(out.some((r) => r.source === 'platform')).toBe(false);
    expect(out.length).toBeGreaterThan(0);
  });
});

describe('MemoryWarmer with platform-lesson channel', () => {
  it('adds platform-lesson hits when no organic memory exists', async () => {
    const ltm = ltmStub([]);
    const recall: IPlatformLessonRecall = {
      recall: jest.fn().mockResolvedValue([
        { summary: 'platform lesson 1', bucketKey: 'b1', contributorCount: 7, score: 0.9 },
      ]),
    };
    const warmer = new MemoryWarmer(ltm, stmStub, recall);
    const out = await warmer.warmForTask({
      tenantId: 't', sessionId: 's', agentScope: 'executor:task1',
      taskDescription: 'do thing',
    });
    const platformHits = out.filter((r) => r.source === 'platform');
    expect(platformHits).toHaveLength(1);
    expect((platformHits[0]?.entry as any).summary).toBe('platform lesson 1');
  });

  it('organic agent-scope hit outranks a platform lesson with the same score (AGENT_BOOST > PLATFORM_LESSON_OFFSET)', async () => {
    const ltm = ltmStub([rankedEntry('a', 'agent hit', 0.5)]);
    const recall: IPlatformLessonRecall = {
      recall: jest.fn().mockResolvedValue([
        { summary: 'platform lesson 1', bucketKey: 'b1', contributorCount: 7, score: 0.5 },
      ]),
    };
    const warmer = new MemoryWarmer(ltm, stmStub, recall);
    const out = await warmer.warmForTask({
      tenantId: 't', sessionId: 's', agentScope: 'executor:task1',
      taskDescription: 'do thing',
    });
    expect(out[0]?.source).toBe('ltm');
  });

  it('platform lesson with `platform:lesson:*` tag is NOT dropped by suppression filter', async () => {
    const ltm = ltmStub([]);
    const recall: IPlatformLessonRecall = {
      recall: jest.fn().mockResolvedValue([
        { summary: 'platform lesson', bucketKey: 'b1', contributorCount: 7, score: 0.9 },
      ]),
    };
    const warmer = new MemoryWarmer(ltm, stmStub, recall);
    const out = await warmer.warmForTask({
      tenantId: 't', sessionId: 's', agentScope: 'executor:task1',
      taskDescription: 'x',
    });
    // platform:lesson:* tag is NOT a seed:suppressed:* tag, so it survives.
    expect(out.length).toBeGreaterThan(0);
  });

  it('a platform-lesson recall failure degrades silently (warmer does not throw)', async () => {
    const ltm = ltmStub([rankedEntry('a', 'organic', 0.5)]);
    const recall: IPlatformLessonRecall = {
      recall: jest.fn().mockRejectedValue(new Error('db down')),
    };
    const warmer = new MemoryWarmer(ltm, stmStub, recall);
    const out = await warmer.warmForTask({
      tenantId: 't', sessionId: 's', agentScope: 'executor:task1',
      taskDescription: 'x',
    });
    expect(out.length).toBeGreaterThan(0);
    expect(out.some((r) => r.source === 'platform')).toBe(false);
  });

  it('platform-lesson channel does not take a tenantId (privacy guarantee)', async () => {
    const recall: IPlatformLessonRecall = {
      recall: jest.fn().mockResolvedValue([]),
    };
    const warmer = new MemoryWarmer(ltmStub([]), stmStub, recall);
    await warmer.warmForTask({
      tenantId: 'tenant-A', sessionId: 's', agentScope: 'executor:task',
      taskDescription: 'x',
    });
    // The recall call must not have received tenantId in any field.
    const calls = (recall.recall as jest.Mock).mock.calls;
    for (const args of calls) {
      const arg = args[0];
      expect(JSON.stringify(arg)).not.toContain('tenant-A');
    }
  });
});

describe('MemoryWarmer — D.1 recallBudgets per-tag-prefix cap', () => {
  it('caps entries with a matching tag prefix at the configured limit', async () => {
    // Five "ontology" entries all tagged `domain:fintech:ontology`, scored
    // 0.9 down to 0.5 so they sort deterministically.
    const ontology = [
      rankedEntry('o1', 'ontology-a', 0.9, ['domain:fintech:ontology']),
      rankedEntry('o2', 'ontology-b', 0.8, ['domain:fintech:ontology']),
      rankedEntry('o3', 'ontology-c', 0.7, ['domain:fintech:ontology']),
      rankedEntry('o4', 'ontology-d', 0.6, ['domain:fintech:ontology']),
      rankedEntry('o5', 'ontology-e', 0.5, ['domain:fintech:ontology']),
    ];
    const ltm = ltmStub(ontology);
    const warmer = new MemoryWarmer(ltm, stmStub);
    const out = await warmer.warmForTask({
      tenantId: 't', sessionId: 's', agentScope: 'executor:task',
      taskDescription: 'q',
      topK: 10,
      recallBudgets: { 'domain:': 3 },
    });
    const ontologyKept = out.filter((r) => {
      const tags = (r.entry as { tags?: readonly string[] }).tags;
      return tags?.some((t) => t.startsWith('domain:')) ?? false;
    });
    expect(ontologyKept).toHaveLength(3);
    // Highest-scored survives the cap.
    expect(ontologyKept[0]!.entry.summary).toBe('ontology-a');
  });

  it('preserves entries that do not match any budgeted prefix', async () => {
    const ontology = rankedEntry('o1', 'onto', 0.9, ['domain:fintech:ontology']);
    const organic = rankedEntry('og1', 'organic-1', 0.6, ['topic:reliability']);
    const organic2 = rankedEntry('og2', 'organic-2', 0.55, ['topic:reliability']);
    const ltm = ltmStub([ontology, organic, organic2]);
    const warmer = new MemoryWarmer(ltm, stmStub);
    const out = await warmer.warmForTask({
      tenantId: 't', sessionId: 's', agentScope: 'executor:task',
      taskDescription: 'q',
      topK: 10,
      recallBudgets: { 'domain:': 1 },
    });
    const summaries = out.map((r) => r.entry.summary);
    expect(summaries).toContain('organic-1');
    expect(summaries).toContain('organic-2');
  });

  it('omitting recallBudgets preserves pre-D.1 behavior (no cap applied)', async () => {
    const ontology = [
      rankedEntry('o1', 'ontology-a', 0.9, ['domain:fintech:ontology']),
      rankedEntry('o2', 'ontology-b', 0.8, ['domain:fintech:ontology']),
      rankedEntry('o3', 'ontology-c', 0.7, ['domain:fintech:ontology']),
      rankedEntry('o4', 'ontology-d', 0.6, ['domain:fintech:ontology']),
    ];
    const ltm = ltmStub(ontology);
    const warmer = new MemoryWarmer(ltm, stmStub);
    const out = await warmer.warmForTask({
      tenantId: 't', sessionId: 's', agentScope: 'executor:task',
      taskDescription: 'q',
      topK: 10,
    });
    const ontologyKept = out.filter((r) => {
      const tags = (r.entry as { tags?: readonly string[] }).tags;
      return tags?.some((t) => t.startsWith('domain:')) ?? false;
    });
    expect(ontologyKept.length).toBeGreaterThan(3);
  });
});
