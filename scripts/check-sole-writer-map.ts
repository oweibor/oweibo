#!/usr/bin/env tsx
/**
 * check-sole-writer-map.ts
 *
 * CI gate (ADR-000, INV-16 interim executable): the sole-writer map in
 * ADR-000 §3.6 must stay in exact agreement with the architecture document's
 * §2 Domain Model ownership assignments, encoded below as EXPECTED.
 *
 * Checks, against the table between the sole-writer-map markers:
 *   1. every row names exactly one writer, drawn from the closed subsystem set
 *   2. the entity set matches EXPECTED exactly (no additions, no omissions)
 *   3. every entity's writer matches EXPECTED (no ownership drift)
 *
 * Superseded (not deleted) by the K.0 event-envelope producer-field audit.
 * Pattern precedent: scripts/check-platform-admin-escalation.ts.
 */
import fs from 'fs';
import path from 'path';

const ADR_PATH = path.resolve(
  __dirname,
  '..',
  'plans/connector_implementation_plan/adrs/ADR-000-substrate-reconciliation.md',
);

const BEGIN = '<!-- sole-writer-map:begin -->';
const END = '<!-- sole-writer-map:end -->';

/** The closed writer set: the architecture §21 subsystems that persist entities. */
const ALLOWED_WRITERS = new Set([
  'Integration Runtime',
  'Knowledge Runtime',
  'Planning Runtime',
  'Execution Runtime',
  'Governance Plane',
]);

/**
 * Architecture §2 Domain Model ownership, normalized to the persisting writer
 * ("produced/enforced" splits normalize to the producer; "writer" annotations
 * win). This is the source of truth the ADR table must match.
 */
const EXPECTED: Record<string, string> = {
  'Connector': 'Integration Runtime',
  'SourceAdapter': 'Integration Runtime',
  'CapabilityManifest': 'Integration Runtime',
  'KnowledgeObject': 'Knowledge Runtime',
  'RevisionVector': 'Knowledge Runtime',
  'ACLSnapshot': 'Knowledge Runtime',
  'ProvenanceRecord': 'Knowledge Runtime',
  'Principal': 'Knowledge Runtime',
  'Identity': 'Knowledge Runtime',
  'Edge': 'Knowledge Runtime',
  'Chunk': 'Knowledge Runtime',
  'MembershipRecord': 'Knowledge Runtime',
  'Policy': 'Governance Plane',
  'ExecutionPlan': 'Planning Runtime',
  'CacheEntry': 'Planning Runtime',
  'Action': 'Execution Runtime',
  'Session': 'Execution Runtime',
  'Job / Lease': 'Integration Runtime',
};

function fail(messages: string[]): never {
  console.error('check-sole-writer-map: FAIL (INV-16)');
  for (const m of messages) console.error(`  - ${m}`);
  process.exit(1);
}

if (!fs.existsSync(ADR_PATH)) {
  fail([`ADR-000 not found at ${ADR_PATH}`]);
}

const doc = fs.readFileSync(ADR_PATH, 'utf8');
const beginIdx = doc.indexOf(BEGIN);
const endIdx = doc.indexOf(END);
if (beginIdx === -1 || endIdx === -1 || endIdx < beginIdx) {
  fail(['sole-writer-map markers missing or malformed in ADR-000 §3.6']);
}

const block = doc.slice(beginIdx + BEGIN.length, endIdx);
const errors: string[] = [];
const found: Record<string, string> = {};

for (const raw of block.split('\n')) {
  const line = raw.trim();
  if (!line.startsWith('|')) continue;
  const cells = line.split('|').map((c) => c.trim()).filter((c) => c.length > 0);
  if (cells.length === 0) continue;
  // Skip header and separator rows.
  if (cells[0] === 'Entity' || /^-+$/.test(cells[0]!.replace(/\s/g, ''))) continue;

  if (cells.length !== 2) {
    errors.push(`row "${line}" must have exactly two cells (Entity | Sole writer)`);
    continue;
  }
  const [entity, writer] = cells as [string, string];

  if (found[entity] !== undefined) {
    errors.push(`entity "${entity}" appears more than once — a sole writer is exactly one row`);
    continue;
  }
  found[entity] = writer;

  if (!ALLOWED_WRITERS.has(writer)) {
    errors.push(`entity "${entity}" names writer "${writer}" — not in the closed subsystem set`);
  }
}

for (const [entity, writer] of Object.entries(EXPECTED)) {
  if (found[entity] === undefined) {
    errors.push(`entity "${entity}" (arch §2) is missing from the ADR-000 map`);
  } else if (found[entity] !== writer) {
    errors.push(
      `ownership drift: "${entity}" — ADR-000 says "${found[entity]}", arch §2 says "${writer}"`,
    );
  }
}

for (const entity of Object.keys(found)) {
  if (EXPECTED[entity] === undefined) {
    errors.push(`entity "${entity}" is in the ADR-000 map but not in arch §2 — undeclared entity`);
  }
}

if (errors.length > 0) fail(errors);

console.log(
  `check-sole-writer-map: OK — ${Object.keys(found).length} entities, ` +
    'each with exactly one writer, in agreement with arch §2 (INV-16).',
);
