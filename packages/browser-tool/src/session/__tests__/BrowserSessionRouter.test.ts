/**
 * BrowserSessionRouter — rule-by-rule unit coverage.
 *
 * The router has five mutually-exclusive rules; this suite exercises each in
 * isolation by stubbing the four signal sources (reputation, bridge, profile
 * store, stealth pool) and asserting which backend is selected and why.
 */

import { BrowserSessionRouter, type RoutingContext } from '../BrowserSessionRouter.js';

import type { ISecurityContext } from '@oweibo/core-contracts';

const PERMISSIVE: ISecurityContext = {
  permissions: [],
  allowExtensionBridge: true,
  allowPersistentProfile: true,
  allowBrightData: false,
  allowCookieImport: true,
  allowAutofill: true,
};

function makeRouter(opts: {
  tier?:        'cloud-required' | 'cloud-preferred' | 'unknown';
  paired?:      boolean;
  hasProfile?:  boolean;
  poolCount?:   number;
}) {
  return new BrowserSessionRouter({
    reputationStore: { getTier: async () => opts.tier ?? 'unknown' } as never,
    bridge:          { hasActiveSession: () => Boolean(opts.paired) },
    profileStore:    { exists: async () => Boolean(opts.hasProfile) },
    stealthPool:     { availableCount: async () => opts.poolCount ?? 0 },
  });
}

function ctx(over: Partial<RoutingContext> = {}): RoutingContext {
  return {
    tenantId: 't1',
    targetUrl: 'https://example.com',
    securityContext: PERMISSIVE,
    extensionConnected: false,
    persistentProfileExists: false,
    stealthPoolAvailable: false,
    ...over,
  };
}

describe('BrowserSessionRouter', () => {
  test('cloud-required → browserbase when allowBrightData=false', async () => {
    const router = makeRouter({ tier: 'cloud-required' });
    const decision = await router.selectBackend(ctx());
    expect(decision.backend).toBe('browserbase');
    expect(decision.reason).toMatch(/cloud-required/);
  });

  test('cloud-required → brightdata when allowBrightData=true', async () => {
    const router = makeRouter({ tier: 'cloud-required' });
    const decision = await router.selectBackend(
      ctx({ securityContext: { ...PERMISSIVE, allowBrightData: true } }),
    );
    expect(decision.backend).toBe('brightdata');
  });

  test('paired extension wins when permitted', async () => {
    const router = makeRouter({});
    const decision = await router.selectBackend(ctx({ extensionConnected: true }));
    expect(decision.backend).toBe('extension');
  });

  test('paired extension is ignored when allowExtensionBridge=false', async () => {
    const router = makeRouter({});
    const decision = await router.selectBackend(
      ctx({
        extensionConnected: true,
        securityContext: { ...PERMISSIVE, allowExtensionBridge: false },
      }),
    );
    expect(decision.backend).toBe('local');
  });

  test('auth task with persistent profile uses persistent backend', async () => {
    const router = makeRouter({});
    const decision = await router.selectBackend(
      ctx({ persistentProfileExists: true, taskHint: 'auth' }),
    );
    expect(decision.backend).toBe('persistent');
    expect(decision.useStealthPool).toBe(false);
  });

  test('cloud-preferred + warmed pool → persistent w/ stealth pool', async () => {
    const router = makeRouter({ tier: 'cloud-preferred' });
    const decision = await router.selectBackend(ctx({ stealthPoolAvailable: true }));
    expect(decision.backend).toBe('persistent');
    expect(decision.useStealthPool).toBe(true);
  });

  test('default fallback is local', async () => {
    const router = makeRouter({});
    const decision = await router.selectBackend(ctx());
    expect(decision.backend).toBe('local');
  });

  test('buildContext aggregates signal sources', async () => {
    const router = makeRouter({ paired: true, hasProfile: true, poolCount: 3 });
    const built = await router.buildContext({
      tenantId: 't1', targetUrl: 'https://example.com', securityContext: PERMISSIVE,
    });
    expect(built.extensionConnected).toBe(true);
    expect(built.persistentProfileExists).toBe(true);
    expect(built.stealthPoolAvailable).toBe(true);
  });
});
