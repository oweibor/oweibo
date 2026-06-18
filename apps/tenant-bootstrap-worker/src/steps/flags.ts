/**
 * T.1: tenant features flag reader.
 *
 * Tenants.features JSONB may store flags in either form:
 *   - flat:   { "tenant.bootstrap.seed_memories.enabled": true }
 *   - nested: { tenant: { bootstrap: { seed_memories: { enabled: true } } } }
 *
 * The reader checks the flat form first (fastest path; matches the convention
 * used by ttv.md when describing feature flags), then falls back to nested.
 */
export function readBoolFlag(features: Readonly<Record<string, unknown>>, dotted: string): boolean {
  if (typeof features[dotted] === 'boolean') return features[dotted] as boolean;
  let cur: unknown = features;
  for (const part of dotted.split('.')) {
    if (cur === null || typeof cur !== 'object') return false;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur === true;
}
