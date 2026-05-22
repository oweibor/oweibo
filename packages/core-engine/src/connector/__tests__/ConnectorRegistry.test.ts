/**
 * T.2.f — ConnectorRegistry tests.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { promises as fsp } from 'fs';
import { ConnectorRegistry } from '../ConnectorRegistry.js';
import type { ConnectorCatalogEntry } from '@oweibo/core-contracts';

const SEED_DIR = path.join(__dirname, '..', '..', 'seed', 'connectors');

function entry(overrides: Partial<ConnectorCatalogEntry> = {}): ConnectorCatalogEntry {
  return {
    connectorId: overrides.connectorId ?? 'test',
    displayName: 'Test',
    category: 'custom',
    description: 'test connector',
    catalogVersion: '1',
    credentialSchema: { type: 'object' },
    capabilities: overrides.capabilities ?? [
      { capabilityId: 'do', summary: 'do', actionClass: 'read.local', inputSchema: {}, outputSchema: {} },
    ],
    recommendedFor: overrides.recommendedFor ?? ['*'],
  };
}

describe('ConnectorRegistry.loadFromDirectory', () => {
  it('loads every *.connector.json from the shipped seed directory', async () => {
    const reg = await ConnectorRegistry.loadFromDirectory(SEED_DIR);
    expect(reg.size).toBeGreaterThan(0);
    expect(reg.get('slack')).not.toBeNull();
  });

  it('returns empty registry when directory missing', async () => {
    const tmp = path.join(os.tmpdir(), 'no-conn-' + Date.now());
    const reg = await ConnectorRegistry.loadFromDirectory(tmp);
    expect(reg.size).toBe(0);
  });

  it('throws on missing capability fields', async () => {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'conn-bad-'));
    try {
      await fsp.writeFile(path.join(tmp, 'broken.connector.json'), JSON.stringify({
        connectorId: 'x', displayName: 'X', category: 'custom', description: 'd',
        catalogVersion: '1', credentialSchema: { type: 'object' },
        capabilities: [{ capabilityId: '', summary: '', actionClass: '' }],
        recommendedFor: ['*'],
      }));
      await expect(ConnectorRegistry.loadFromDirectory(tmp)).rejects.toThrow(/capability missing/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('throws on duplicate connectorId across files', async () => {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'conn-dup-'));
    try {
      const dupe = entry({ connectorId: 'dup' });
      await fsp.writeFile(path.join(tmp, 'a.connector.json'), JSON.stringify(dupe));
      await fsp.writeFile(path.join(tmp, 'b.connector.json'), JSON.stringify(dupe));
      await expect(ConnectorRegistry.loadFromDirectory(tmp)).rejects.toThrow(/duplicate connectorId/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('ConnectorRegistry.recommend', () => {
  it('returns wildcard-recommended entries for any template', () => {
    const reg = ConnectorRegistry.fromEntries([
      entry({ connectorId: 'a', recommendedFor: ['*'] }),
    ]);
    expect(reg.recommend('anything').map((e) => e.connectorId)).toEqual(['a']);
  });

  it('returns template-specific entries when slug matches', () => {
    const reg = ConnectorRegistry.fromEntries([
      entry({ connectorId: 'a', recommendedFor: ['nextjs-app'] }),
      entry({ connectorId: 'b', recommendedFor: ['cli-tool'] }),
    ]);
    expect(reg.recommend('nextjs-app').map((e) => e.connectorId)).toEqual(['a']);
  });

  it('excludes entries whose recommendedFor does not match', () => {
    const reg = ConnectorRegistry.fromEntries([
      entry({ connectorId: 'a', recommendedFor: ['fintech-smb'] }),
    ]);
    expect(reg.recommend('default')).toHaveLength(0);
  });
});

describe('ConnectorRegistry.getCapability', () => {
  it('returns the capability when present', () => {
    const reg = ConnectorRegistry.fromEntries([
      entry({
        connectorId: 'slack',
        capabilities: [
          { capabilityId: 'post', summary: 'p', actionClass: 'comm.internal', inputSchema: {}, outputSchema: {} },
        ],
      }),
    ]);
    expect(reg.getCapability('slack', 'post')?.actionClass).toBe('comm.internal');
  });

  it('returns null when connector or capability missing', () => {
    const reg = ConnectorRegistry.fromEntries([entry({ connectorId: 'a' })]);
    expect(reg.getCapability('a', 'nope')).toBeNull();
    expect(reg.getCapability('nope', 'do')).toBeNull();
  });
});

// Validates the shipped catalog entries' capability action-classes belong to
// the known CoreActionClass set. Catches catalog-content drift before deploy.
describe('shipped catalog', () => {
  it('every capability declares an actionClass string', async () => {
    const reg = await ConnectorRegistry.loadFromDirectory(SEED_DIR);
    for (const e of reg.all()) {
      for (const c of e.capabilities) {
        expect(typeof c.actionClass).toBe('string');
        expect(c.actionClass.length).toBeGreaterThan(0);
      }
    }
  });
});
