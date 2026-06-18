/**
 * Internal route tests — closes the F.5.9 server-side gap (memories/seed)
 * plus the B.1 (skills/seed) and B.2 (domain/classify) follow-ups.
 *
 * Per-route assertions:
 *   - Bearer auth via constant-time compare against the internal token
 *   - Validation rejects malformed payloads with 400
 *   - 503 when the route's required dep is missing
 *   - Idempotency-key replays the cached response without re-invoking the dep
 *   - 401 on missing or wrong token
 */
import express from 'express';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import request from 'supertest';
import type { IMemoryOrchestrator, ISkill } from '@oweibo/core-contracts';
import { createInternalRouter, type ISkillRegistryFacade, type InternalRouterOptions } from '../internal.routes.js';
import type { DomainIntakeService } from '../../../seed/DomainIntakeService.js';

function fakeOrchestrator(): IMemoryOrchestrator & { recordCalls: unknown[] } {
  const recordCalls: unknown[] = [];
  return {
    recordCalls,
    record: jest.fn().mockImplementation(async (input: unknown) => {
      recordCalls.push(input);
      return { id: 'm-' + recordCalls.length, scope: { tenantId: 't' }, kind: 'domain-fact', summary: 's', importance: 0.5, tags: [], createdAt: '', updatedAt: '', recallCount: 0 };
    }),
  } as IMemoryOrchestrator & { recordCalls: unknown[] };
}

function makeApp(internalToken: string, orchestrator?: IMemoryOrchestrator) {
  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.use('/api/v1/_internal', createInternalRouter({
    internalToken,
    memoryOrchestrator: orchestrator ?? fakeOrchestrator(),
  }));
  return app;
}

function makeAppWith(opts: Omit<InternalRouterOptions, 'internalToken'> & { internalToken: string }) {
  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.use('/api/v1/_internal', createInternalRouter(opts));
  return app;
}

const tenantId = '11111111-1111-1111-1111-111111111111';
const validSeed = {
  seedId: 'intro-1',
  catalogVersion: 'v1',
  kind: 'domain-fact',
  summary: 'Welcome to the platform',
  importance: 0.5,
  tags: ['seed:intro-1'],
};

describe('POST /api/v1/_internal/memories/seed', () => {
  it('rejects requests without a Bearer token (401)', async () => {
    const app = makeApp('secret');
    const res = await request(app).post('/api/v1/_internal/memories/seed').send({});
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('unauthorized');
  });

  it('rejects requests with the wrong token (401)', async () => {
    const app = makeApp('secret');
    const res = await request(app)
      .post('/api/v1/_internal/memories/seed')
      .set('authorization', 'Bearer wrong-token')
      .send({ tenantId, seeds: [] });
    expect(res.status).toBe(401);
  });

  it('rejects malformed payloads with 400', async () => {
    const app = makeApp('secret');
    const res = await request(app)
      .post('/api/v1/_internal/memories/seed')
      .set('authorization', 'Bearer secret')
      .send({ tenantId: 'not-a-uuid', seeds: [] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('validation_error');
  });

  it('records each seed and returns the inserted ids', async () => {
    const orch = fakeOrchestrator();
    const app = makeApp('secret', orch);
    const res = await request(app)
      .post('/api/v1/_internal/memories/seed')
      .set('authorization', 'Bearer secret')
      .send({ tenantId, seeds: [validSeed, { ...validSeed, seedId: 'intro-2' }] });
    expect(res.status).toBe(200);
    expect(res.body.inserted).toEqual(['intro-1', 'intro-2']);
    expect(res.body.failed).toEqual([]);
    expect(orch.recordCalls).toHaveLength(2);
    // Server-side dedup tag added on each record call.
    expect((orch.recordCalls[0] as Record<string, unknown>)['tags']).toEqual(
      expect.arrayContaining(['seed:intro-1', 'seed:catalog:v1']),
    );
  });

  it('moves records that throw into the failed array', async () => {
    const orch: IMemoryOrchestrator = {
      record: jest.fn()
        .mockResolvedValueOnce({ id: 'm1' })
        .mockRejectedValueOnce(new Error('downstream blew up')),
    } as unknown as IMemoryOrchestrator;
    const app = makeApp('secret', orch);
    const res = await request(app)
      .post('/api/v1/_internal/memories/seed')
      .set('authorization', 'Bearer secret')
      .send({ tenantId, seeds: [{ ...validSeed, seedId: 'a' }, { ...validSeed, seedId: 'b' }] });
    expect(res.status).toBe(200);
    expect(res.body.inserted).toEqual(['a']);
    expect(res.body.failed).toEqual([expect.stringContaining('b: downstream blew up')]);
  });

  it('honors Idempotency-Key: a replay returns the cached response without re-invoking record', async () => {
    const orch = fakeOrchestrator();
    const app = makeApp('secret', orch);
    const body = { tenantId, seeds: [validSeed] };
    const first = await request(app)
      .post('/api/v1/_internal/memories/seed')
      .set('authorization', 'Bearer secret')
      .set('idempotency-key', 'abc123')
      .send(body);
    expect(first.status).toBe(200);
    expect(orch.recordCalls).toHaveLength(1);

    const second = await request(app)
      .post('/api/v1/_internal/memories/seed')
      .set('authorization', 'Bearer secret')
      .set('idempotency-key', 'abc123')
      .send(body);
    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);
    expect(orch.recordCalls).toHaveLength(1); // No new record call.
  });

  it('different Idempotency-Keys produce independent record calls', async () => {
    const orch = fakeOrchestrator();
    const app = makeApp('secret', orch);
    await request(app)
      .post('/api/v1/_internal/memories/seed')
      .set('authorization', 'Bearer secret')
      .set('idempotency-key', 'key-1')
      .send({ tenantId, seeds: [validSeed] });
    await request(app)
      .post('/api/v1/_internal/memories/seed')
      .set('authorization', 'Bearer secret')
      .set('idempotency-key', 'key-2')
      .send({ tenantId, seeds: [validSeed] });
    expect(orch.recordCalls).toHaveLength(2);
  });

  it('constructor throws on empty internalToken', () => {
    expect(() => createInternalRouter({
      internalToken: '',
      memoryOrchestrator: fakeOrchestrator(),
    })).toThrow(/internalToken is required/);
  });

  it('returns 503 when memoryOrchestrator is unconfigured', async () => {
    const app = makeAppWith({ internalToken: 'secret' }); // no orchestrator
    const res = await request(app)
      .post('/api/v1/_internal/memories/seed')
      .set('authorization', 'Bearer secret')
      .send({ tenantId, seeds: [validSeed] });
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('unconfigured');
    expect(res.body.route).toBe('memories/seed');
  });
});

// ── B.1: POST /api/v1/_internal/skills/seed ─────────────────────────────────

function fakeSkill(id: string): ISkill {
  return {
    id, name: id, description: 'desc', tags: [], appliesTo: [],
    source: '.oweibo/skills', priority: 0, content: '',
    contentHash: 'h', path: '', remote: null,
  } as unknown as ISkill;
}

function fakeSkillRegistry(): ISkillRegistryFacade & { ensureEmbeddedCalls: ISkill[][] } {
  const ensureEmbeddedCalls: ISkill[][] = [];
  return {
    ensureEmbeddedCalls,
    discover: jest.fn((root: string) => [fakeSkill('skill-' + root.split(/[\\/]/).pop())]),
    ensureEmbedded: jest.fn(async (skills: ISkill[]) => {
      ensureEmbeddedCalls.push(skills);
    }),
  } as ISkillRegistryFacade & { ensureEmbeddedCalls: ISkill[][] };
}

describe('POST /api/v1/_internal/skills/seed', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oweibo-skill-root-'));
  const goodBundle = path.join(tmpRoot, 'starter');
  beforeAll(() => fs.mkdirSync(goodBundle, { recursive: true }));
  afterAll(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

  it('rejects requests without a Bearer token (401)', async () => {
    const app = makeAppWith({ internalToken: 'secret', skillRegistry: fakeSkillRegistry(), skillBundleRoot: tmpRoot });
    const res = await request(app).post('/api/v1/_internal/skills/seed').send({});
    expect(res.status).toBe(401);
  });

  it('rejects requests with the wrong token (401)', async () => {
    const app = makeAppWith({ internalToken: 'secret', skillRegistry: fakeSkillRegistry(), skillBundleRoot: tmpRoot });
    const res = await request(app)
      .post('/api/v1/_internal/skills/seed')
      .set('authorization', 'Bearer wrong')
      .send({ tenantId, bundlePath: goodBundle });
    expect(res.status).toBe(401);
  });

  it('returns 503 when skillRegistry is unconfigured', async () => {
    const app = makeAppWith({ internalToken: 'secret', skillBundleRoot: tmpRoot });
    const res = await request(app)
      .post('/api/v1/_internal/skills/seed')
      .set('authorization', 'Bearer secret')
      .send({ tenantId, bundlePath: goodBundle });
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('unconfigured');
    expect(res.body.route).toBe('skills/seed');
  });

  it('rejects malformed payloads with 400', async () => {
    const app = makeAppWith({ internalToken: 'secret', skillRegistry: fakeSkillRegistry(), skillBundleRoot: tmpRoot });
    const res = await request(app)
      .post('/api/v1/_internal/skills/seed')
      .set('authorization', 'Bearer secret')
      .send({ tenantId: 'not-a-uuid', bundlePath: goodBundle });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('validation_error');
  });

  it('rejects bundlePath outside the configured root (path-traversal guard)', async () => {
    const reg = fakeSkillRegistry();
    const app = makeAppWith({ internalToken: 'secret', skillRegistry: reg, skillBundleRoot: tmpRoot });
    const escape = path.join(tmpRoot, '..', 'evil');
    const res = await request(app)
      .post('/api/v1/_internal/skills/seed')
      .set('authorization', 'Bearer secret')
      .send({ tenantId, bundlePath: escape });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_bundle_path');
    // discover never called when guard rejects.
    expect((reg.discover as jest.Mock).mock.calls).toHaveLength(0);
  });

  it('discovers + embeds the bundle and returns registered ids', async () => {
    const reg = fakeSkillRegistry();
    const app = makeAppWith({ internalToken: 'secret', skillRegistry: reg, skillBundleRoot: tmpRoot });
    const res = await request(app)
      .post('/api/v1/_internal/skills/seed')
      .set('authorization', 'Bearer secret')
      .send({ tenantId, bundlePath: goodBundle });
    expect(res.status).toBe(200);
    expect(res.body.registered).toEqual(['skill-starter']);
    expect(res.body.failed).toEqual([]);
    expect(reg.ensureEmbeddedCalls).toHaveLength(1);
  });

  it('moves embedding failures into the failed array', async () => {
    const reg: ISkillRegistryFacade = {
      discover: () => [fakeSkill('a'), fakeSkill('b')],
      ensureEmbedded: jest.fn(async () => { throw new Error('embed down'); }),
    };
    const app = makeAppWith({ internalToken: 'secret', skillRegistry: reg, skillBundleRoot: tmpRoot });
    const res = await request(app)
      .post('/api/v1/_internal/skills/seed')
      .set('authorization', 'Bearer secret')
      .send({ tenantId, bundlePath: goodBundle });
    expect(res.status).toBe(200);
    expect(res.body.registered).toEqual([]);
    expect(res.body.failed).toEqual(expect.arrayContaining([
      expect.stringContaining('a: embed down'),
      expect.stringContaining('b: embed down'),
    ]));
  });

  it('surfaces discover() throws as 400 skill_bundle_discovery_failed', async () => {
    const reg: ISkillRegistryFacade = {
      discover: () => { throw new Error('bundle missing'); },
      ensureEmbedded: jest.fn(),
    };
    const app = makeAppWith({ internalToken: 'secret', skillRegistry: reg, skillBundleRoot: tmpRoot });
    const res = await request(app)
      .post('/api/v1/_internal/skills/seed')
      .set('authorization', 'Bearer secret')
      .send({ tenantId, bundlePath: goodBundle });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('skill_bundle_discovery_failed');
    expect(res.body.message).toContain('bundle missing');
  });

  it('honors Idempotency-Key: a replay returns the cached response without re-invoking ensureEmbedded', async () => {
    const reg = fakeSkillRegistry();
    const app = makeAppWith({ internalToken: 'secret', skillRegistry: reg, skillBundleRoot: tmpRoot });
    const body = { tenantId, bundlePath: goodBundle };
    const first = await request(app)
      .post('/api/v1/_internal/skills/seed')
      .set('authorization', 'Bearer secret')
      .set('idempotency-key', 'skills-key-1')
      .send(body);
    expect(first.status).toBe(200);
    const second = await request(app)
      .post('/api/v1/_internal/skills/seed')
      .set('authorization', 'Bearer secret')
      .set('idempotency-key', 'skills-key-1')
      .send(body);
    expect(second.body).toEqual(first.body);
    expect(reg.ensureEmbeddedCalls).toHaveLength(1);
  });
});

// ── B.2: POST /api/v1/_internal/domain/classify ─────────────────────────────

function fakeIntake(domain: string, confidence: number): DomainIntakeService & { calls: unknown[] } {
  const calls: unknown[] = [];
  const svc = {
    calls,
    classifyAndRecommend: jest.fn(async (input: unknown) => {
      calls.push(input);
      return {
        classification: {
          domain,
          confidence,
          recommendedTemplate: domain === 'unclassified' ? undefined : `${domain}-template`,
          recommendedConnectors: [],
        },
        recommendedSeedSkills: domain === 'unclassified' ? [] : [`${domain}-skill`],
      };
    }),
  } as unknown as DomainIntakeService & { calls: unknown[] };
  return svc;
}

describe('POST /api/v1/_internal/domain/classify', () => {
  it('rejects requests without a Bearer token (401)', async () => {
    const app = makeAppWith({ internalToken: 'secret', domainIntakeService: fakeIntake('finance', 0.9) });
    const res = await request(app).post('/api/v1/_internal/domain/classify').send({});
    expect(res.status).toBe(401);
  });

  it('returns 503 when domainIntakeService is unconfigured', async () => {
    const app = makeAppWith({ internalToken: 'secret' });
    const res = await request(app)
      .post('/api/v1/_internal/domain/classify')
      .set('authorization', 'Bearer secret')
      .send({ tenantId });
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('unconfigured');
    expect(res.body.route).toBe('domain/classify');
  });

  it('rejects malformed payloads with 400', async () => {
    const app = makeAppWith({ internalToken: 'secret', domainIntakeService: fakeIntake('finance', 0.9) });
    const res = await request(app)
      .post('/api/v1/_internal/domain/classify')
      .set('authorization', 'Bearer secret')
      .send({ tenantId: 'bad' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('validation_error');
  });

  it('classifies a real intake and returns the recommendation shape', async () => {
    const svc = fakeIntake('finance', 0.85);
    const app = makeAppWith({ internalToken: 'secret', domainIntakeService: svc });
    const res = await request(app)
      .post('/api/v1/_internal/domain/classify')
      .set('authorization', 'Bearer secret')
      .send({
        tenantId,
        interviewAnswers: [{ question: 'industry?', answer: 'capital markets' }],
        repoSignals: { languages: ['Scala'] },
      });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      classifiedDomain: 'finance',
      classifiedConfidence: 0.85,
      recommendedTemplate: 'finance-template',
      recommendedConnectors: [],
      recommendedSeedSkills: ['finance-skill'],
    });
    expect(svc.calls).toHaveLength(1);
  });

  it('returns null classifiedDomain when classifier returns unclassified', async () => {
    const svc = fakeIntake('unclassified', 0.1);
    const app = makeAppWith({ internalToken: 'secret', domainIntakeService: svc });
    const res = await request(app)
      .post('/api/v1/_internal/domain/classify')
      .set('authorization', 'Bearer secret')
      .send({ tenantId, primerExcerpts: ['short'] });
    expect(res.status).toBe(200);
    expect(res.body.classifiedDomain).toBeNull();
    expect(res.body.recommendedSeedSkills).toEqual([]);
  });

  it('honors Idempotency-Key: replay does not re-invoke classifier', async () => {
    const svc = fakeIntake('healthcare', 0.77);
    const app = makeAppWith({ internalToken: 'secret', domainIntakeService: svc });
    const body = { tenantId, interviewAnswers: [{ question: 'q', answer: 'a' }] };
    const first = await request(app)
      .post('/api/v1/_internal/domain/classify')
      .set('authorization', 'Bearer secret')
      .set('idempotency-key', 'd-1')
      .send(body);
    const second = await request(app)
      .post('/api/v1/_internal/domain/classify')
      .set('authorization', 'Bearer secret')
      .set('idempotency-key', 'd-1')
      .send(body);
    expect(second.body).toEqual(first.body);
    expect(svc.calls).toHaveLength(1);
  });

  it('reports classifier throws as 500 classification_failed', async () => {
    const svc = {
      classifyAndRecommend: jest.fn(async () => { throw new Error('llm down'); }),
    } as unknown as DomainIntakeService;
    const app = makeAppWith({ internalToken: 'secret', domainIntakeService: svc });
    const res = await request(app)
      .post('/api/v1/_internal/domain/classify')
      .set('authorization', 'Bearer secret')
      .send({ tenantId, interviewAnswers: [{ question: 'q', answer: 'a' }] });
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('classification_failed');
    expect(res.body.message).toContain('llm down');
  });
});
