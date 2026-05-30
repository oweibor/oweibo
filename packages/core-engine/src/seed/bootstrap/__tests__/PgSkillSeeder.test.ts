/**
 * F.5.8 — PgSkillSeeder tests.
 */
import type { ISkill } from '@oweibo/core-contracts';
import { PgSkillSeeder, type ISkillRegistryFacade } from '../PgSkillSeeder.js';

function makeSkill(id: string): ISkill {
  return {
    id, name: id, description: `${id} desc`, filePath: `/${id}/SKILL.md`,
    source: 'skills', content: 'x', contentHash: 'h', tags: [], appliesTo: 'general-coding',
  };
}

function makeFacade(skills: ISkill[], embedThrows = false): ISkillRegistryFacade {
  return {
    discover: jest.fn().mockReturnValue(skills),
    ensureEmbedded: jest.fn().mockImplementation(async () => {
      if (embedThrows) throw new Error('qdrant unreachable');
    }),
  };
}

describe('PgSkillSeeder', () => {
  const tenantId = '11111111-1111-1111-1111-111111111111';

  it('discovers + embeds and returns one registered id per skill', async () => {
    const facade = makeFacade([makeSkill('code-review-pass'), makeSkill('migration-safety')]);
    const seeder = new PgSkillSeeder(facade);

    const out = await seeder.seedSkills(tenantId, '/seed/skills');
    expect(out.registered.sort()).toEqual(['code-review-pass', 'migration-safety']);
    expect(out.failed).toEqual([]);
    expect(facade.discover).toHaveBeenCalledWith('/seed/skills');
    expect(facade.ensureEmbedded).toHaveBeenCalledWith(
      expect.any(Array), tenantId, expect.any(Object),
    );
  });

  it('returns empty result when bundle has no skills', async () => {
    const facade = makeFacade([]);
    const seeder = new PgSkillSeeder(facade);

    const out = await seeder.seedSkills(tenantId, '/empty');
    expect(out.registered).toEqual([]);
    expect(out.failed).toEqual([]);
    expect(facade.ensureEmbedded).not.toHaveBeenCalled();
  });

  it('whole-batch failure puts every skill in `failed`', async () => {
    const facade = makeFacade([makeSkill('a'), makeSkill('b')], /*embedThrows*/ true);
    const seeder = new PgSkillSeeder(facade);

    const out = await seeder.seedSkills(tenantId, '/seed/skills');
    expect(out.registered).toEqual([]);
    expect(out.failed).toHaveLength(2);
    expect(out.failed[0]).toContain('qdrant unreachable');
  });

  it('discover throwing surfaces as a structured error', async () => {
    const facade: ISkillRegistryFacade = {
      discover: jest.fn().mockImplementation(() => { throw new Error('ENOENT /bundle'); }),
      ensureEmbedded: jest.fn(),
    };
    const seeder = new PgSkillSeeder(facade);

    await expect(seeder.seedSkills(tenantId, '/bad'))
      .rejects.toThrow(/skill-bundle-discovery-failed.*ENOENT/);
    expect(facade.ensureEmbedded).not.toHaveBeenCalled();
  });
});
