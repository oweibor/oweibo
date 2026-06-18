/**
 * T.2.b — StarterProjectTemplates: per-template invariants for the
 * starter Project. The full template catalog lands in T.6.
 */
import { starterProjectSpec, STARTER_TEMPLATE_SLUGS } from '../StarterProjectTemplates.js';

describe('starterProjectSpec', () => {
  it('returns the same baseline name + description for every template', () => {
    for (const slug of STARTER_TEMPLATE_SLUGS) {
      const spec = starterProjectSpec(slug);
      expect(spec.name).toBe('Default');
      expect(spec.description).toContain('Starter project');
    }
  });

  it('returns the baseline invariants for the default template', () => {
    const spec = starterProjectSpec('default');
    expect(spec.invariants).toEqual({ 'project.style': 'starter' });
  });

  it('returns typescript+vitest invariants for typescript-app', () => {
    const spec = starterProjectSpec('typescript-app');
    expect(spec.invariants.language).toBe('typescript');
    expect(spec.invariants['test-runner']).toBe('vitest');
  });

  it('returns python+pytest invariants for python-app', () => {
    const spec = starterProjectSpec('python-app');
    expect(spec.invariants.language).toBe('python');
    expect(spec.invariants['test-runner']).toBe('pytest');
  });

  it('falls back to baseline invariants for an unknown template slug', () => {
    const spec = starterProjectSpec('this-template-does-not-exist');
    expect(spec.invariants).toEqual({ 'project.style': 'starter' });
  });

  it('includes the seed:starter-project tag on every spec', () => {
    for (const slug of [...STARTER_TEMPLATE_SLUGS, 'unknown']) {
      const spec = starterProjectSpec(slug);
      expect(spec.tags).toContain('seed:starter-project');
    }
  });
});
