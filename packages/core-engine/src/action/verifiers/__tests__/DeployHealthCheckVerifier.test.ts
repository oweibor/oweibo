/**
 * Unit tests for DeployHealthCheckVerifier.
 */
import type {
  ActionContext,
  DeferredVerifierInput,
  ImmediateVerifierInput,
} from '@oweibo/core-contracts';
import { DeployHealthCheckVerifier } from '../DeployHealthCheckVerifier.js';

const TENANT = '11111111-1111-1111-1111-111111111111';

function ctx(): ActionContext {
  return {
    tenantId: TENANT,
    userId:   'u-1',
    actionClass: 'deploy.prod.kube' as ActionContext['actionClass'],
    actionId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    summary:  'deploy v1.2.3',
    payload:  {},
    calibrationSnapshot: {
      tenantId: TENANT, accountAgeDays: 30, actionClassScores: {},
      snapshotAt: '2026-05-29T12:00:00Z', sourceSig: 'unsigned',
    },
  };
}

function deferred(verifierConfig: unknown): DeferredVerifierInput {
  return {
    tenantId: TENANT,
    proposalId: 'p-1',
    verifierConfig,
    expected: null,
  };
}

function immediate(verifierConfig: unknown): ImmediateVerifierInput {
  return { ctx: ctx(), proposalId: 'p-1', adapterOutcome: { verifierConfig } };
}

function res(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status, statusText: 'OK', headers: new Headers(),
    redirected: false, type: 'basic', url: '', bodyUsed: false, body: null,
    clone() { return this; },
    arrayBuffer: async () => new ArrayBuffer(0),
    blob: async () => new Blob(),
    formData: async () => new FormData(),
    text: async () => JSON.stringify(body),
    json: async () => body,
    bytes: async () => new Uint8Array(),
  } as unknown as Response;
}

describe('DeployHealthCheckVerifier', () => {
  it('appliesTo every deploy.* class', () => {
    const v = new DeployHealthCheckVerifier();
    expect(v.appliesTo('deploy.prod.kube')).toBe(true);
    expect(v.appliesTo('deploy.staging.lambda')).toBe(true);
    expect(v.appliesTo('write.tenant_db.users')).toBe(false);
  });

  it('returns severity 2 when config is missing', async () => {
    const v = new DeployHealthCheckVerifier({ fetchImpl: jest.fn() as unknown as typeof fetch });
    const r = await v.deferred(deferred(null));
    expect(r.severity).toBe(2);
    expect(r.notes).toMatch(/config/);
  });

  it('returns severity 0 on status match without expectedJsonBody', async () => {
    const fetchImpl = jest.fn(async () => res({})) as unknown as typeof fetch;
    const v = new DeployHealthCheckVerifier({ fetchImpl });
    const r = await v.deferred(deferred({ healthUrl: 'https://h' }));
    expect(r.severity).toBe(0);
  });

  it('returns severity 3 on status mismatch', async () => {
    const fetchImpl = jest.fn(async () => res({}, 503)) as unknown as typeof fetch;
    const v = new DeployHealthCheckVerifier({ fetchImpl });
    const r = await v.deferred(deferred({ healthUrl: 'https://h' }));
    expect(r.severity).toBe(3);
  });

  it('returns severity 3 on network error', async () => {
    const fetchImpl = jest.fn(async () => { throw new Error('ETIMEDOUT'); }) as unknown as typeof fetch;
    const v = new DeployHealthCheckVerifier({ fetchImpl });
    const r = await v.deferred(deferred({ healthUrl: 'https://h' }));
    expect(r.severity).toBe(3);
    expect(r.notes).toMatch(/ETIMEDOUT/);
  });

  it('returns severity 0 when body matches expectedJsonBody exactly', async () => {
    const fetchImpl = jest.fn(async () => res({ version: 'v1.2.3', healthy: true })) as unknown as typeof fetch;
    const v = new DeployHealthCheckVerifier({ fetchImpl });
    const r = await v.deferred(deferred({
      healthUrl: 'https://h',
      expectedJsonBody: { version: 'v1.2.3', healthy: true },
    }));
    expect(r.severity).toBe(0);
  });

  it('returns severity 2 on body diff in non-health fields', async () => {
    const fetchImpl = jest.fn(async () => res({ version: 'v1.2.4', healthy: true })) as unknown as typeof fetch;
    const v = new DeployHealthCheckVerifier({ fetchImpl });
    const r = await v.deferred(deferred({
      healthUrl: 'https://h',
      expectedJsonBody: { version: 'v1.2.3', healthy: true },
    }));
    expect(r.severity).toBe(2);
  });

  it('returns severity 3 when healthy/ready/status field drifts', async () => {
    const fetchImpl = jest.fn(async () => res({ version: 'v1.2.3', healthy: false })) as unknown as typeof fetch;
    const v = new DeployHealthCheckVerifier({ fetchImpl });
    const r = await v.deferred(deferred({
      healthUrl: 'https://h',
      expectedJsonBody: { version: 'v1.2.3', healthy: true },
    }));
    expect(r.severity).toBe(3);
  });

  it('returns severity 3 when response body is not JSON', async () => {
    const stubResponse = res(null);
    stubResponse.json = (async () => { throw new Error('bad json'); }) as unknown as Response['json'];
    const fetchImpl = jest.fn(async () => stubResponse) as unknown as typeof fetch;
    const v = new DeployHealthCheckVerifier({ fetchImpl });
    const r = await v.deferred(deferred({
      healthUrl: 'https://h',
      expectedJsonBody: { healthy: true },
    }));
    expect(r.severity).toBe(3);
  });

  it('immediate() reads config from adapterOutcome.verifierConfig', async () => {
    const fetchImpl = jest.fn(async () => res({})) as unknown as typeof fetch;
    const v = new DeployHealthCheckVerifier({ fetchImpl });
    const r = await v.immediate(immediate({ healthUrl: 'https://h' }));
    expect(r.severity).toBe(0);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
