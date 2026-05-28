/**
 * D.3 — ActionClassExtensionRegistry tests.
 */
import type { ExtendedActionClassDeclaration } from '@oweibo/core-contracts';
import { ActionClassExtensionRegistry } from '../ActionClassExtensionRegistry.js';

const decl = (slug: string, overrides: Partial<ExtendedActionClassDeclaration> = {}): ExtendedActionClassDeclaration => ({
  slug,
  description: `${slug} description`,
  defaultPolicy: {
    young: 'require_approval',
    withSignal: 'dry_run',
    established: 'execute',
  },
  ...overrides,
});

describe('ActionClassExtensionRegistry', () => {
  it('registers and looks up an extension', () => {
    const r = new ActionClassExtensionRegistry();
    r.register(decl('phi.read'));
    expect(r.isRegistered('phi.read')).toBe(true);
    expect(r.lookup('phi.read')?.description).toBe('phi.read description');
  });

  it('isRegistered returns false for unknown slug', () => {
    const r = new ActionClassExtensionRegistry();
    expect(r.isRegistered('nope')).toBe(false);
    expect(r.lookup('nope')).toBeUndefined();
  });

  it('re-registering with identical declaration is a no-op', () => {
    const r = new ActionClassExtensionRegistry();
    r.register(decl('phi.read'));
    expect(() => r.register(decl('phi.read'))).not.toThrow();
  });

  it('re-registering with a different declaration throws', () => {
    const r = new ActionClassExtensionRegistry();
    r.register(decl('phi.read', { sourceDomain: 'healthcare' }));
    expect(() =>
      r.register(decl('phi.read', { description: 'different', sourceDomain: 'other' })),
    ).toThrow(/conflicting declaration/);
  });

  it('re-registering with a different policy throws', () => {
    const r = new ActionClassExtensionRegistry();
    r.register(decl('phi.read'));
    expect(() =>
      r.register(
        decl('phi.read', {
          defaultPolicy: {
            young: 'forbidden',
            withSignal: 'forbidden',
            established: 'forbidden',
          },
        }),
      ),
    ).toThrow(/conflicting declaration/);
  });

  it('list() enumerates all registered declarations', () => {
    const r = new ActionClassExtensionRegistry();
    r.register(decl('phi.read'));
    r.register(decl('phi.write'));
    expect(r.list().map((d) => d.slug).sort()).toEqual(['phi.read', 'phi.write']);
  });
});
