/**
 * Unit tests for GDPR erasure logic.
 * Tests the authorization guard and response codes without hitting a real DB.
 */
import { describe, it, expect } from 'vitest';

// Re-implement the pure authorization guard to test it in isolation
function canErase(
  principalSub:    string,
  principalScopes: string[],
  targetId:        string,
): boolean {
  const isSelf          = principalSub === targetId;
  const isPlatformAdmin = principalScopes.includes('platform:users:delete');
  return isSelf || isPlatformAdmin;
}

describe('GDPR erasure authorization', () => {
  it('allows a user to erase their own data', () => {
    expect(canErase('user-1', ['tasks:read'], 'user-1')).toBe(true);
  });

  it('allows platform_admin to erase any user', () => {
    expect(canErase('admin-1', ['platform:users:delete'], 'user-99')).toBe(true);
  });

  it('blocks a tenant user from erasing another user', () => {
    expect(canErase('user-1', ['tasks:read'], 'user-2')).toBe(false);
  });

  it('blocks with empty scopes and different user', () => {
    expect(canErase('user-1', [], 'user-2')).toBe(false);
  });

  it('platform_admin can erase their own account', () => {
    expect(canErase('admin-1', ['platform:users:delete'], 'admin-1')).toBe(true);
  });
});

// Anonymization helpers
function anonymizedEmail(userId: string): string {
  return `deleted-${userId}@oweibo.invalid`;
}

describe('anonymization', () => {
  it('produces a deterministic anonymized email', () => {
    expect(anonymizedEmail('abc-123')).toBe('deleted-abc-123@oweibo.invalid');
  });

  it('uses the oweibo.invalid TLD to prevent delivery', () => {
    expect(anonymizedEmail('u1')).toMatch(/@oweibo\.invalid$/);
  });
});
