/**
 * T.2.d — GoalTemplateCatalog tests.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { promises as fsp } from 'fs';
import { GoalTemplateCatalog, type GoalTemplate } from '../GoalTemplateCatalog.js';

const SEED_DIR = path.join(__dirname, '..', 'goal-templates');

function entry(overrides: Partial<GoalTemplate> = {}): GoalTemplate {
  return {
    templateId: overrides.templateId ?? 't1',
    catalogVersion: '1',
    triggerSummary: 'test',
    subGoalSkeleton: overrides.subGoalSkeleton ?? [{ description: 's1' }],
    applicableTo: overrides.applicableTo ?? { templates: ['*'] },
    ...overrides,
  };
}

describe('GoalTemplateCatalog.loadFromDirectory', () => {
  it('loads every JSON file shipped with the package', async () => {
    const catalog = await GoalTemplateCatalog.loadFromDirectory(SEED_DIR);
    expect(catalog.size).toBeGreaterThan(0);
  });

  it('returns empty catalog when directory missing', async () => {
    const tmp = path.join(os.tmpdir(), 'goal-tpl-empty-' + Date.now());
    const cat = await GoalTemplateCatalog.loadFromDirectory(tmp);
    expect(cat.size).toBe(0);
  });

  it('throws on duplicate templateId across files', async () => {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'goal-tpl-'));
    try {
      const dupe = entry({ templateId: 'dup' });
      await fsp.writeFile(path.join(tmp, 'a.json'), JSON.stringify({ entries: [dupe] }));
      await fsp.writeFile(path.join(tmp, 'b.json'), JSON.stringify({ entries: [dupe] }));
      await expect(GoalTemplateCatalog.loadFromDirectory(tmp)).rejects.toThrow(/duplicate templateId/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('throws on missing subGoalSkeleton', async () => {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'goal-tpl-bad-'));
    try {
      await fsp.writeFile(path.join(tmp, 'bad.json'), JSON.stringify({
        entries: [{ templateId: 'x', catalogVersion: '1', triggerSummary: 'y', subGoalSkeleton: [], applicableTo: { templates: ['*'] } }],
      }));
      await expect(GoalTemplateCatalog.loadFromDirectory(tmp)).rejects.toThrow(/empty subGoalSkeleton/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('GoalTemplateCatalog.forTenant', () => {
  it('returns wildcard entries for any template slug', () => {
    const cat = GoalTemplateCatalog.fromEntries([
      entry({ templateId: 'a', applicableTo: { templates: ['*'] } }),
    ]);
    expect(cat.forTenant({ templateSlug: 'anything' })).toHaveLength(1);
  });

  it('filters by explicit template', () => {
    const cat = GoalTemplateCatalog.fromEntries([
      entry({ templateId: 'a', applicableTo: { templates: ['nextjs-app'] } }),
      entry({ templateId: 'b', applicableTo: { templates: ['cli-tool'] } }),
    ]);
    expect(cat.forTenant({ templateSlug: 'cli-tool' }).map((t) => t.templateId)).toEqual(['b']);
  });

  it('industry filter excludes when industry required but absent', () => {
    const cat = GoalTemplateCatalog.fromEntries([
      entry({ templateId: 'a', applicableTo: { templates: ['*'], industries: ['fintech'] } }),
    ]);
    expect(cat.forTenant({ templateSlug: 'x' })).toHaveLength(0);
  });
});
