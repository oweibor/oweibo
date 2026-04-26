"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AuthGenerator = void 0;
const crypto_1 = require("crypto");
function checksum(c) { return (0, crypto_1.createHash)('sha256').update(c, 'utf-8').digest('hex'); }
function file(path, content) {
    return { path, content, encoding: 'utf-8', checksum: checksum(content) };
}
const MANIFEST = {
    name: 'module-auth',
    version: '0.1.0',
    coreContractsVersion: '>=0.1.0',
    emits: ['auth:completed'],
    consumes: ['scaffolding:completed', 'datalayer:completed'],
    knowledgeArtifactPath: 'knowledge/module-auth.json',
    permissions: ['auth:manage'],
};
const FILES = {
    betterauth: {
        'src/auth/config.ts': `// src/auth/config.ts — BetterAuth
import { betterAuth } from 'better-auth';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import { multiOrganization } from 'better-auth/plugins';
import { prisma } from '../db/client.js';
export const auth = betterAuth({
  database: prismaAdapter(prisma, { provider: 'postgresql' }),
  emailAndPassword: { enabled: true },
  plugins: [multiOrganization()],
  session: { expiresIn: 604800, updateAge: 86400 },
  trustedOrigins: (process.env.TRUSTED_ORIGINS ?? 'http://localhost:3000').split(','),
});
export type Session = typeof auth.$Infer.Session;
export type User = typeof auth.$Infer.Session.user;
`,
        'src/auth/middleware.ts': `// src/auth/middleware.ts
import type { Request, Response, NextFunction } from 'express';
import { auth } from './config.js';
export interface AuthenticatedRequest extends Request { session: import('./config.js').Session; user: import('./config.js').User; }
export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const session = await auth.api.getSession({ headers: req.headers as Record<string, string> });
  if (!session) { res.status(401).json({ error: 'unauthorized' }); return; }
  (req as AuthenticatedRequest).session = session;
  (req as AuthenticatedRequest).user = session.user;
  next();
}
`,
        'src/auth/routes.ts': `// src/auth/routes.ts
import { Router } from 'express';
import { auth } from './config.js';
import { toNodeHandler } from 'better-auth/node';
const router = Router();
router.all('/api/auth/*', toNodeHandler(auth));
export default router;
`,
    },
    'zitadel-native': {
        'src/auth/zitadel.ts': `// src/auth/zitadel.ts — Zitadel OIDC native
import { Issuer } from 'openid-client';
const ZITADEL_DOMAIN = process.env.ZITADEL_DOMAIN ?? '';
const CLIENT_ID = process.env.ZITADEL_CLIENT_ID ?? '';
export async function getZitadelClient() {
  const issuer = await Issuer.discover(\`https://\${ZITADEL_DOMAIN}\`);
  return new issuer.Client({ client_id: CLIENT_ID, response_types: ['code'] });
}
export interface ZitadelClaims { sub: string; email?: string; name?: string; }
`,
    },
    custom: {
        'src/auth/config.ts': `// src/auth/config.ts — custom auth placeholder\n// Implement your authentication strategy here.\nexport {};\n`,
    },
};
function buildAuthTest(provider) {
    return `// src/__tests__/auth.contract.test.ts
describe('module-auth (${provider}) contract', () => {
  it('exports auth module', async () => {
    ${provider === 'zitadel-native'
        ? "const m = await import('../auth/zitadel'); expect(typeof m.getZitadelClient).toBe('function');"
        : "const m = await import('../auth/config'); expect(m).toBeDefined();"}
  });
  ${provider !== 'zitadel-native' && provider !== 'custom' ? `it('exports requireAuth middleware', async () => {
    const m = await import('../auth/middleware');
    expect(typeof m.requireAuth).toBe('function');
  });` : ''}
});
`;
}
class AuthGenerator {
    manifest = MANIFEST;
    async generate(reader, api) {
        const input = reader.getScaffoldInput();
        const provider = input.authProvider ?? 'betterauth';
        const files = [];
        const providerKey = provider === 'authjs' ? 'betterauth' : provider;
        const fileMap = FILES[providerKey] ?? FILES['betterauth'] ?? {};
        for (const [path, content] of Object.entries(fileMap)) {
            await api.writeFile(path, content);
            files.push(file(path, content));
        }
        const testContent = buildAuthTest(provider);
        await api.writeFile('src/__tests__/auth.contract.test.ts', testContent);
        return {
            files,
            testFiles: [file('src/__tests__/auth.contract.test.ts', testContent)],
            dbMigrations: [],
            k8sManifests: [],
            docFiles: [],
            knowledgeArtifact: {
                moduleName: 'module-auth',
                version: MANIFEST.version,
                generatedAt: new Date().toISOString(),
                domainDescription: `Authentication module using ${provider}.`,
                entities: [],
                endpoints: provider !== 'zitadel-native'
                    ? [{ method: 'POST', path: '/api/auth/sign-in', filePath: 'src/auth/routes.ts' },
                        { method: 'POST', path: '/api/auth/sign-out', filePath: 'src/auth/routes.ts' },
                        { method: 'GET', path: '/api/auth/session', filePath: 'src/auth/routes.ts' }]
                    : [],
                emittedEvents: [],
                consumedEvents: [],
                invariants: [{ description: 'All protected routes must use requireAuth middleware', source: 'annotation', filePath: 'src/auth/middleware.ts' }],
                extensionPoints: [{ hookName: 'addOAuthProvider', filePath: 'src/auth/config.ts', description: 'Add OAuth providers to auth config' }],
                userFlows: [
                    { name: 'Sign in', actor: 'User', steps: ['POST /api/auth/sign-in'], outcome: 'Session created' },
                    { name: 'Sign out', actor: 'User', steps: ['POST /api/auth/sign-out'], outcome: 'Session invalidated' },
                ],
                glossary: [{ term: 'Session', definition: 'Server-side record proving a user is authenticated' }],
                exampleUsages: [],
            },
            signature: '',
        };
    }
    validate(bundle) {
        const errors = [];
        if (bundle.files.length === 0)
            errors.push({ code: 'EMPTY_BUNDLE', message: 'Auth module produced no files' });
        if (bundle.testFiles.length === 0)
            errors.push({ code: 'MISSING_TESTS', message: 'Contract test required' });
        return { valid: errors.length === 0, errors, warnings: [] };
    }
}
exports.AuthGenerator = AuthGenerator;
exports.default = AuthGenerator;
//# sourceMappingURL=index.js.map