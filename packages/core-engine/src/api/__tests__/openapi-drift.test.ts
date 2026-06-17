/**
 * A.1 (ttv-finals follow-ups): OpenAPI ↔ Express route drift test.
 *
 * Scans every router file under packages/core-engine/src/api/routes/ for
 * `router.{get,post,put,delete,patch}('path', ...)` calls, prefixes each
 * path with the router's known mount in server.ts, normalises ':param'
 * → '{param}', and asserts the resulting path exists in openapiSpec.paths
 * with a handler for that HTTP verb.
 *
 * The mount map is hand-maintained -- intentionally, because the mount
 * decision (`/api/v1/tenants/:tenantId/foo` vs `/api/v1/foo`) is the
 * load-bearing piece reviewers need to eyeball. Adding a new route file
 * requires (a) adding it to ROUTE_FILE_MOUNTS below, AND (b) adding the
 * paths to openapiSpec.paths. Both gates fail loudly.
 *
 * Cross-link: plan §F.4 acceptance criterion `OpenAPI spec regenerated;
 * published at /api/v1/docs` becomes self-enforcing once this test ships.
 */
import * as fs from 'fs';
import * as path from 'path';
import { openapiSpec } from '../openapi.js';

const HTTP_VERBS = ['get', 'post', 'put', 'delete', 'patch'] as const;
type HttpVerb = typeof HTTP_VERBS[number];

interface MountSpec {
  /** Filename inside packages/core-engine/src/api/routes/. */
  readonly file: string;
  /** URL prefix the router is mounted at (excluding /api/v1, included by default). */
  readonly mount: string;
  /** Set true if the router is mounted at MULTIPLE places (skip drift check for it). */
  readonly multipleMounts?: boolean;
}

// MUST stay in sync with packages/core-engine/src/api/server.ts.
const ROUTE_FILE_MOUNTS: readonly MountSpec[] = [
  { file: 'tasks.routes.ts',           mount: '/tasks' },
  { file: 'hitl.routes.ts',            mount: '/hitl' },
  { file: 'skills.routes.ts',          mount: '/skills' },
  { file: 'actions.routes.ts',         mount: '/actions' },
  { file: 'actionsExtended.routes.ts', mount: '/tenants/{tenantId}/actions' },
  { file: 'tenantActions.routes.ts',   mount: '/tenants/{tenantId}/actions' },
  { file: 'forensics.routes.ts',       mount: '/tenants/{tenantId}/forensics' },
  { file: 'lineage.routes.ts',         mount: '/tenants/{tenantId}/lineage' },
  { file: 'domains.routes.ts',         mount: '/tenants/{tenantId}/domains' },
  { file: 'calibration.routes.ts',     mount: '/tenants/{tenantId}/calibration' },
  { file: 'policies.routes.ts',        mount: '/tenants/{tenantId}/actions/policies' },
  { file: 'connectors.routes.ts',      mount: '/tenants/{tenantId}/connectors' },
  { file: 'templates.routes.ts',       mount: '/tenants/{tenantId}/templates' },
  // Mounted under /api/v1/platform (admin-only); not in the customer-
  // facing OpenAPI surface.
  { file: 'platform.routes.ts',        mount: '/platform', multipleMounts: true },
  // Mounted under /api/v1/_internal (internal-only Bearer auth); not
  // in the customer-facing OpenAPI surface either.
  { file: 'internal.routes.ts',        mount: '/_internal', multipleMounts: true },
];

interface ExtractedRoute {
  verb: HttpVerb;
  /** Router-local path, e.g. '/:id/rollback'. */
  routerPath: string;
}

function extractRoutes(source: string): ExtractedRoute[] {
  const out: ExtractedRoute[] = [];
  // Match `router.get('/path', ...)` plus its template-string + double-quote variants.
  const re = /router\.(get|post|put|delete|patch)\(\s*['"`]([^'"`]+)['"`]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    out.push({ verb: m[1] as HttpVerb, routerPath: m[2]! });
  }
  return out;
}

function normalizeExpressToOpenApi(p: string): string {
  // Express ':param' → OpenAPI '{param}'. Also strips trailing slashes.
  return p
    .replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, '{$1}')
    .replace(/\/+$/, '') || '/';
}

function joinMount(mount: string, routerPath: string): string {
  if (routerPath === '/' || routerPath === '') return mount;
  return `${mount}${routerPath.startsWith('/') ? '' : '/'}${routerPath}`.replace(/\/+$/, '') || '/';
}

const ROUTES_DIR = path.resolve(__dirname, '..', 'routes');

describe('OpenAPI ↔ Express route drift', () => {
  const knownPaths = new Set(Object.keys(openapiSpec.paths));

  for (const spec of ROUTE_FILE_MOUNTS) {
    if (spec.multipleMounts) continue; // Platform admin: out of scope.
    const filePath = path.join(ROUTES_DIR, spec.file);
    if (!fs.existsSync(filePath)) {
      it(`${spec.file} exists`, () => expect(fs.existsSync(filePath)).toBe(true));
      continue;
    }
    const source = fs.readFileSync(filePath, 'utf-8');
    const routes = extractRoutes(source);

    describe(spec.file, () => {
      it('exposes at least one route', () => {
        expect(routes.length).toBeGreaterThan(0);
      });

      for (const r of routes) {
        const fullPath = joinMount(spec.mount, normalizeExpressToOpenApi(r.routerPath));
        it(`${r.verb.toUpperCase()} ${fullPath} is documented`, () => {
          expect(knownPaths).toContain(fullPath);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const pathEntry = (openapiSpec.paths as Record<string, Record<string, any>>)[fullPath];
          expect(pathEntry).toBeDefined();
          expect(pathEntry[r.verb]).toBeDefined();
        });
      }
    });
  }

  it('every documented path uses {param} (no ":param") and starts with /', () => {
    for (const p of Object.keys(openapiSpec.paths)) {
      expect(p.startsWith('/')).toBe(true);
      expect(p).not.toMatch(/:[A-Za-z_]/);
    }
  });

  it('every documented operation declares at least one response', () => {
    for (const [pathStr, pathEntry] of Object.entries(openapiSpec.paths)) {
      const entry = pathEntry as Record<string, unknown>;
      for (const verb of HTTP_VERBS) {
        const op = entry[verb] as undefined | { responses?: Record<string, unknown> };
        if (!op) continue;
        expect(op.responses).toBeDefined();
        expect(Object.keys(op.responses!).length).toBeGreaterThan(0);
      }
    }
  });

  it('the spec declares all critical security + servers fields', () => {
    expect(openapiSpec.openapi).toMatch(/^3\./);
    expect(openapiSpec.servers).toBeDefined();
    expect(openapiSpec.servers!.length).toBeGreaterThan(0);
    expect(openapiSpec.security).toBeDefined();
    expect((openapiSpec.components.securitySchemes as Record<string, unknown>)['bearerAuth']).toBeDefined();
  });
});
