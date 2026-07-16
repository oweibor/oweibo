/**
 * ActionClassFloor — the platform floor that keeps high-risk action classes
 * at require_approval or stricter, and bars them from being pinned to execute.
 *
 * Regression guard for the gap where an operator could pin financial.payment
 * (etc.) straight to `execute` and grant standing, unattended authority.
 */
import {
  ALWAYS_REQUIRE_APPROVAL_CLASSES,
  isFloorClass,
  pinViolatesFloor,
  PinFloorViolationError,
  type PinMode,
} from '../ActionClassFloor.js';

describe('ActionClassFloor', () => {
  const FLOOR = [
    'financial.payment',
    'personnel.access_grant',
    'personnel.access_revoke',
    'irreversible.delete_resource',
    'irreversible.public_publish',
  ] as const;

  afterEach(() => {
    delete process.env['ACTION_PIN_FLOOR_CLASSES'];
  });

  it('baseline set covers exactly the five high-risk classes', () => {
    expect([...ALWAYS_REQUIRE_APPROVAL_CLASSES].sort()).toEqual([...FLOOR].sort());
  });

  it('isFloorClass is true for every baseline class, false for ordinary ones', () => {
    for (const c of FLOOR) expect(isFloorClass(c)).toBe(true);
    for (const c of ['read.local', 'write.local.scratch', 'write.tenant_db.prod', 'deploy.prod']) {
      expect(isFloorClass(c)).toBe(false);
    }
  });

  it('bars pinning a floor class to execute, but allows require_approval / forbidden / non-live modes', () => {
    for (const c of FLOOR) {
      expect(pinViolatesFloor(c, 'execute')).toBe(true);
      for (const m of ['require_approval', 'forbidden', 'dry_run', 'shadow'] as PinMode[]) {
        expect(pinViolatesFloor(c, m)).toBe(false);
      }
    }
  });

  it('never bars an ordinary class from any mode (including execute)', () => {
    for (const m of ['execute', 'dry_run', 'shadow', 'require_approval', 'forbidden'] as PinMode[]) {
      expect(pinViolatesFloor('write.local.scratch', m)).toBe(false);
      expect(pinViolatesFloor('deploy.nonprod', m)).toBe(false);
    }
  });

  it('ACTION_PIN_FLOOR_CLASSES extends the floor (add-only)', () => {
    expect(pinViolatesFloor('write.tenant_db.prod', 'execute')).toBe(false);
    process.env['ACTION_PIN_FLOOR_CLASSES'] = 'write.tenant_db.prod, deploy.prod';
    expect(isFloorClass('write.tenant_db.prod')).toBe(true);
    expect(pinViolatesFloor('write.tenant_db.prod', 'execute')).toBe(true);
    expect(pinViolatesFloor('deploy.prod', 'execute')).toBe(true);
    // baseline still enforced
    expect(pinViolatesFloor('financial.payment', 'execute')).toBe(true);
    // ordinary class unaffected
    expect(pinViolatesFloor('read.local', 'execute')).toBe(false);
  });

  it('PinFloorViolationError carries a stable code + context', () => {
    const err = new PinFloorViolationError('financial.payment', 'execute');
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe('pin_below_action_class_floor');
    expect(err.actionClass).toBe('financial.payment');
    expect(err.mode).toBe('execute');
  });
});
