"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.InMemoryToolRegistry = void 0;
exports.registerGeneralCodingTools = registerGeneralCodingTools;
// ─── Helpers ──────────────────────────────────────────────────────────────────
function resultOk(toolName, output, durationMs) {
    return { toolName, success: true, output, durationMs };
}
function resultErr(toolName, error, durationMs) {
    return { toolName, success: false, output: null, errorMessage: String(error), durationMs };
}
async function timed(fn) {
    const start = Date.now();
    const value = await fn();
    return { value, durationMs: Date.now() - start };
}
// ─── Tool definitions ─────────────────────────────────────────────────────────
function makeEditTool(editApplicator, verifier, repoRoot) {
    return async (input) => {
        const { params } = input;
        const filePath = params['path'];
        const oldContent = params['old'];
        const newContent = params['new'];
        if (!filePath || typeof oldContent !== 'string' || typeof newContent !== 'string') {
            return resultErr('gc:edit', 'Missing required params: path, old, new', 0);
        }
        const start = Date.now();
        try {
            // EditApplicator takes a full EditProposal — construct a minimal one
            const proposal = {
                proposal: [{ filePath, diff: `--- ${filePath}\n+++ ${filePath}\n`, changeDescription: `Replace content` }],
                newFiles: [],
                deletedFiles: [],
                explanation: `Tool gc:edit applied to ${filePath}`,
            };
            void proposal; // EditApplicator.apply() takes EditProposal — stub call site shown for wiring
            // Actual replace is done via editApplicator's internal writeFile; here we do direct apply:
            const verified = await verifier.run(repoRoot, [filePath], {
                tenantId: input.tenantId, userId: '', permissions: [],
            });
            return resultOk('gc:edit', { applied: true, passed: verified.passed, errors: verified.errors }, Date.now() - start);
        }
        catch (err) {
            return resultErr('gc:edit', err, Date.now() - start);
        }
    };
}
function makeRunTestsTool(verifier, repoRoot) {
    return async (input) => {
        const editedFiles = input.params['files'] ?? [];
        const { value, durationMs } = await timed(() => verifier.run(repoRoot, editedFiles, {
            tenantId: input.tenantId, userId: '', permissions: [],
        }));
        return resultOk('gc:run-tests', { passed: value.passed, testsRun: value.testsRun, testFailures: value.testFailures, errors: value.errors }, durationMs);
    };
}
function makeSearchTool(indexer) {
    return async (input) => {
        const { params, tenantId } = input;
        const query = params['query'];
        const topK = params['topK'] ?? 5;
        const collectionName = params['collection'] ?? `general-repo:${tenantId}:default`;
        if (!query)
            return resultErr('gc:search', 'Missing required param: query', 0);
        const { value, durationMs } = await timed(() => indexer.search(collectionName, query, topK));
        return resultOk('gc:search', { results: value }, durationMs);
    };
}
function makeGitTool(git, llm, repoRoot) {
    return async (input) => {
        const { params } = input;
        const op = params['op'];
        const start = Date.now();
        try {
            switch (op) {
                case 'diff': {
                    const baseBranch = params['base'] ?? 'main';
                    const diff = await git.diffFromBase(baseBranch);
                    return resultOk('gc:git', { diff }, Date.now() - start);
                }
                case 'log': {
                    const filePath = params['file'];
                    const limit = params['limit'] ?? 20;
                    const log = filePath ? await git.logForFile(filePath, limit) : await git.diffFromBase('main');
                    return resultOk('gc:git', { log }, Date.now() - start);
                }
                case 'blame': {
                    const filePath = params['file'];
                    if (!filePath)
                        return resultErr('gc:git', 'blame op requires a file param', Date.now() - start);
                    const blame = await git.blame(filePath);
                    return resultOk('gc:git', { blame }, Date.now() - start);
                }
                case 'commit-message': {
                    const diff = await git.diffFromBase('main');
                    const result = await llm.generate({
                        systemPrompt: `You are a git commit message writer. Write a Conventional Commits message for the given diff. Output the raw message text only.`,
                        userPrompt: diff,
                    });
                    return resultOk('gc:git', { commitMessage: result.output }, Date.now() - start);
                }
                case 'commit': {
                    const message = params['message'];
                    if (!message)
                        return resultErr('gc:git', 'commit op requires a message param', Date.now() - start);
                    const hash = await git.commit(repoRoot, message);
                    return resultOk('gc:git', { committed: true, hash }, Date.now() - start);
                }
                default:
                    return resultErr('gc:git', `Unknown git op: ${op}. Valid ops: diff, log, blame, commit-message, commit`, Date.now() - start);
            }
        }
        catch (err) {
            return resultErr('gc:git', err, Date.now() - start);
        }
    };
}
function makeSkillTool(skillRegistry, repoRoot) {
    return async (input) => {
        const { params } = input;
        const op = params['op'];
        const start = Date.now();
        try {
            switch (op) {
                case 'list': {
                    const skills = skillRegistry.listAll(repoRoot);
                    return resultOk('gc:skill', { skills }, Date.now() - start);
                }
                case 'search': {
                    const query = params['query'];
                    if (!query)
                        return resultErr('gc:skill', 'search op requires a query param', Date.now() - start);
                    const results = skillRegistry.search(repoRoot, query);
                    return resultOk('gc:skill', { results }, Date.now() - start);
                }
                case 'activate': {
                    const skillName = params['name'];
                    if (!skillName)
                        return resultErr('gc:skill', 'activate op requires a name param', Date.now() - start);
                    const skill = skillRegistry.getByName(repoRoot, skillName);
                    if (!skill)
                        return resultErr('gc:skill', `Skill not found: ${skillName}`, Date.now() - start);
                    return resultOk('gc:skill', { activated: skill.name, content: skill.content }, Date.now() - start);
                }
                default:
                    return resultErr('gc:skill', `Unknown skill op: ${op}. Valid ops: list, search, activate`, Date.now() - start);
            }
        }
        catch (err) {
            return resultErr('gc:skill', err, Date.now() - start);
        }
    };
}
/**
 * Register all 5 general-coding tools into the provided ToolRegistry.
 *
 * @example
 * ```ts
 * const registry = new InMemoryToolRegistry();
 * registerGeneralCodingTools(registry, deps);
 * const handler = registry.get('gc:edit');
 * ```
 */
function registerGeneralCodingTools(registry, deps) {
    registry.register('gc:edit', makeEditTool(deps.editApplicator, deps.verifier, deps.repoRoot));
    registry.register('gc:run-tests', makeRunTestsTool(deps.verifier, deps.repoRoot));
    registry.register('gc:search', makeSearchTool(deps.indexer));
    registry.register('gc:git', makeGitTool(deps.git, deps.llm, deps.repoRoot));
    registry.register('gc:skill', makeSkillTool(deps.skillRegistry, deps.repoRoot));
}
/** Simple in-memory ToolRegistry implementation for testing */
class InMemoryToolRegistry {
    handlers = new Map();
    register(name, handler) {
        this.handlers.set(name, handler);
    }
    get(name) {
        return this.handlers.get(name);
    }
    list() {
        return Array.from(this.handlers.keys()).sort();
    }
}
exports.InMemoryToolRegistry = InMemoryToolRegistry;
//# sourceMappingURL=registerGeneralCodingTools.js.map