/**
 * ADR-008 §7 conformance suite — field-level freshness predicates, pure.
 * Stricter-wins resolution, per-field live selection (Critical always),
 * document-worst-class, field-disjoint multi-path composition.
 */
import { describe, it, expect } from '@jest/globals';
import {
  resolveFieldFreshness,
  fieldsRequiringLive,
  worstFieldClass,
  composeMultiPath,
  DEFAULT_FIELD_CLASS,
  FRESHNESS_LATTICE,
  type FreshnessClass,
} from '../fieldFreshness.js';

describe('ADR-008 §3.1 — default field class', () => {
  it('undeclared fields default to operational, NEVER static', () => {
    expect(DEFAULT_FIELD_CLASS).toBe('operational');
    expect(DEFAULT_FIELD_CLASS).not.toBe('static');
  });
});

describe('ADR-008 §3.2 — stricter-wins resolution', () => {
  it('picks the higher-lattice of manifest and SLA', () => {
    expect(resolveFieldFreshness('operational', 'critical')).toBe('critical');
    expect(resolveFieldFreshness('critical', 'operational')).toBe('critical');
  });

  it('is monotonic: an SLA can only tighten, never loosen below the manifest', () => {
    for (const m of FRESHNESS_LATTICE) {
      for (const s of FRESHNESS_LATTICE) {
        const eff = resolveFieldFreshness(m, s);
        expect(FRESHNESS_LATTICE.indexOf(eff)).toBeGreaterThanOrEqual(FRESHNESS_LATTICE.indexOf(m));
      }
    }
  });

  it('is order-independent', () => {
    expect(resolveFieldFreshness('transactional', 'operational'))
      .toBe(resolveFieldFreshness('operational', 'transactional'));
  });

  it('absent SLA leaves the manifest class untouched', () => {
    expect(resolveFieldFreshness('static')).toBe('static');
  });
});

describe('ADR-008 §3.3 — per-field live selection', () => {
  const fresh = 1000; // 1s old
  const old = 30 * 60 * 1000; // 30 min old

  it('Critical is ALWAYS live regardless of index age', () => {
    expect(fieldsRequiringLive([{ field: 'status', effectiveClass: 'critical', indexAgeMs: 0 }])).toEqual(['status']);
    expect(fieldsRequiringLive([{ field: 'status', effectiveClass: 'critical', indexAgeMs: old }])).toEqual(['status']);
  });

  it('transactional is live-preferred (always fetched live)', () => {
    expect(fieldsRequiringLive([{ field: 'sprint', effectiveClass: 'transactional', indexAgeMs: fresh }])).toEqual(['sprint']);
  });

  it('operational is live only when the index is stale', () => {
    expect(fieldsRequiringLive([{ field: 'desc', effectiveClass: 'operational', indexAgeMs: fresh }])).toEqual([]);
    expect(fieldsRequiringLive([{ field: 'desc', effectiveClass: 'operational', indexAgeMs: old }])).toEqual(['desc']);
  });

  it('static is never live', () => {
    expect(fieldsRequiringLive([{ field: 'title', effectiveClass: 'static', indexAgeMs: old }])).toEqual([]);
  });

  it('the Jira example (§5.1): only the volatile fields go live', () => {
    const jira = [
      { field: 'title', effectiveClass: 'operational' as FreshnessClass, indexAgeMs: fresh },
      { field: 'status', effectiveClass: 'critical' as FreshnessClass, indexAgeMs: fresh },
      { field: 'comments', effectiveClass: 'transactional' as FreshnessClass, indexAgeMs: fresh },
      { field: 'priority', effectiveClass: 'operational' as FreshnessClass, indexAgeMs: fresh },
    ];
    expect(fieldsRequiringLive(jira).sort()).toEqual(['comments', 'status']);
  });
});

describe('ADR-008 §3.5 — document-worst-class', () => {
  it('a document is as fresh-sensitive as its most sensitive field', () => {
    expect(worstFieldClass(['static', 'operational', 'critical'])).toBe('critical');
    expect(worstFieldClass(['static', 'operational'])).toBe('operational');
    expect(worstFieldClass([])).toBe('static');
  });
});

describe('ADR-008 §3.4 — field-disjoint multi-path composition', () => {
  it('live fields override the index copy; each field has exactly one source', () => {
    const composed = composeMultiPath(
      { title: 'PR: fix bug', status: 'open (stale)' },
      { status: 'merged (live)' },
    );
    expect(composed.fields).toEqual({ title: 'PR: fix bug', status: 'merged (live)' });
    expect(composed.fieldPaths).toEqual({ title: 'index', status: 'live' });
  });

  it('records the per-field path for provenance', () => {
    const composed = composeMultiPath({ a: 1 }, { b: 2 });
    expect(composed.fieldPaths).toEqual({ a: 'index', b: 'live' });
  });
});
