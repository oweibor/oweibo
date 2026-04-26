"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createSkillsRouter = createSkillsRouter;
const express_1 = require("express");
const node_fs_1 = require("node:fs");
const node_path_1 = __importDefault(require("node:path"));
const OWEIBO_DIR = node_path_1.default.resolve(process.cwd(), '.oweibo');
const SOURCES_FILE = node_path_1.default.join(OWEIBO_DIR, 'skills-sources.json');
const LOCK_FILE = node_path_1.default.join(OWEIBO_DIR, 'skills.lock');
async function readJson(file) {
    const raw = await node_fs_1.promises.readFile(file, 'utf8');
    return JSON.parse(raw);
}
async function writeJson(file, data) {
    await node_fs_1.promises.mkdir(node_path_1.default.dirname(file), { recursive: true });
    await node_fs_1.promises.writeFile(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
}
function createSkillsRouter(deps = {}) {
    const router = (0, express_1.Router)();
    const { fetcher, repoRoot, tenantId } = deps;
    // GET /skills — list configured sources and their locked state
    router.get('/', async (_req, res, next) => {
        try {
            const [manifest, lock] = await Promise.all([
                readJson(SOURCES_FILE).catch(() => ({ version: 1, sources: [] })),
                readJson(LOCK_FILE).catch(() => ({ version: 1, lockfileVersion: 1, skills: {} })),
            ]);
            res.json({ sources: manifest.sources, locked: lock.skills });
        }
        catch (err) {
            next(err);
        }
    });
    // GET /skills/:name — retrieve a single resolved skill record
    router.get('/:name', async (req, res, next) => {
        try {
            const lock = await readJson(LOCK_FILE).catch(() => ({ version: 1, lockfileVersion: 1, skills: {} }));
            const entry = lock.skills[req.params['name']];
            if (!entry) {
                res.status(404).json({ error: 'skill_not_found', name: req.params['name'] });
                return;
            }
            res.json({ name: req.params['name'], ...entry });
        }
        catch (err) {
            next(err);
        }
    });
    // POST /skills/pull — resolve sources from skills-sources.json into skills.lock.
    // v9.4.2: when a RemoteSkillFetcher is injected, delegate so remote skill
    // content is actually materialised under .oweibo/skills/ rather than just
    // recording resolution metadata in the lockfile.
    router.post('/pull', async (_req, res, next) => {
        try {
            if (fetcher && repoRoot && tenantId) {
                const count = await fetcher.fetchAll(repoRoot, tenantId);
                const integrity = fetcher.verifyIntegrity(repoRoot);
                res.json({
                    pulled: count,
                    integrity: { ok: integrity.ok.length, tampered: integrity.tampered.length, unknown: integrity.unknown.length },
                });
                return;
            }
            const manifest = await readJson(SOURCES_FILE);
            const lock = {
                version: 1,
                lockfileVersion: 1,
                skills: {},
            };
            const now = new Date().toISOString();
            for (const src of manifest.sources) {
                lock.skills[src.name] = {
                    source: src.url,
                    version: src.ref ?? 'HEAD',
                    resolvedAt: now,
                    integrity: src.integrity ?? '',
                };
            }
            await writeJson(LOCK_FILE, lock);
            res.json({ pulled: Object.keys(lock.skills).length, skills: lock.skills });
        }
        catch (err) {
            next(err);
        }
    });
    return router;
}
exports.default = createSkillsRouter;
//# sourceMappingURL=skills.routes.js.map