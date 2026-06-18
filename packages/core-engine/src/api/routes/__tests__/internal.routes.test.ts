/**
 * Internal route tests — closes the F.5.9 server-side gap.
 *
 * Asserts:
 *   - Bearer auth via constant-time compare against the internal token
 *   - Validation rejects malformed payloads with 400
 *   - record() is invoked once per seed; result split is returned
 *   - Idempotency-key replays the cached response without re-invoking record
 *   - 401 on missing or wrong token
 */
import express from 'express';
import request from 'supertest';
import type { IMemoryOrchestrator } from '@oweibo/core-contracts';
import { createInternalRouter } from '../internal.routes.js';

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
});
