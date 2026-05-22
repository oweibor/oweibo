"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.GoalTemplateCatalog = void 0;
/**
 * T.2.d: GoalTemplateCatalog — versioned, in-repo registry of platform-
 * curated goal templates.
 *
 * Each template has:
 *   - templateId: stable key
 *   - triggerSummary: short prose used to embed + match against incoming
 *     user goals
 *   - subGoalSkeleton: pre-baked ISubGoal[] that seeds the decomposer
 *   - applicableTo: optional template / industry filters
 *
 * Catalog files live at `./goal-templates/*.json` and ship as part of the
 * package's dist tree. A separate platform admin tool upserts them into
 * `oweibo.goal_templates` (writes are restricted to platform_admin via
 * the table's RLS policy); the runtime matcher reads from the DB.
 *
 * The in-memory catalog object is the *source of truth* for the JSON
 * shape; the DB is a read-optimized projection.
 */
const fs_1 = require("fs");
const path = __importStar(require("path"));
class GoalTemplateCatalog {
    entries;
    constructor(entries) {
        this.entries = entries;
    }
    static async loadFromDirectory(dir) {
        const files = await fs_1.promises.readdir(dir).catch((err) => {
            if (err.code === 'ENOENT')
                return [];
            throw err;
        });
        const all = [];
        for (const f of files) {
            if (!f.endsWith('.json'))
                continue;
            const raw = await fs_1.promises.readFile(path.join(dir, f), 'utf-8');
            const parsed = JSON.parse(raw);
            if (!Array.isArray(parsed.entries)) {
                throw new Error(`GoalTemplateCatalog: ${f} missing entries[]`);
            }
            for (const e of parsed.entries) {
                validateTemplate(e, f);
                all.push(e);
            }
        }
        assertTemplateIdsUnique(all);
        return new GoalTemplateCatalog(all);
    }
    static fromEntries(entries) {
        assertTemplateIdsUnique(entries);
        return new GoalTemplateCatalog(entries);
    }
    static defaultDirectory() {
        return path.join(__dirname, 'goal-templates');
    }
    forTenant(filter) {
        return this.entries.filter((t) => {
            const templates = t.applicableTo.templates;
            if (!templates.includes('*') && !templates.includes(filter.templateSlug))
                return false;
            const industries = t.applicableTo.industries;
            if (industries && industries.length > 0) {
                if (!filter.industry)
                    return false;
                if (!industries.includes(filter.industry))
                    return false;
            }
            return true;
        });
    }
    get size() {
        return this.entries.length;
    }
    all() {
        return this.entries;
    }
}
exports.GoalTemplateCatalog = GoalTemplateCatalog;
// ── Helpers ───────────────────────────────────────────────────────────────
function validateTemplate(e, source) {
    if (!e || typeof e !== 'object') {
        throw new Error(`GoalTemplateCatalog: ${source} contains a non-object entry`);
    }
    const o = e;
    for (const k of ['templateId', 'catalogVersion', 'triggerSummary']) {
        if (typeof o[k] !== 'string' || o[k] === '') {
            throw new Error(`GoalTemplateCatalog: ${source} entry missing required string field ${k}`);
        }
    }
    if (!Array.isArray(o.subGoalSkeleton) || o.subGoalSkeleton.length === 0) {
        throw new Error(`GoalTemplateCatalog: ${source} entry has empty subGoalSkeleton`);
    }
    const at = o.applicableTo;
    if (!at || !Array.isArray(at.templates)) {
        throw new Error(`GoalTemplateCatalog: ${source} entry missing applicableTo.templates`);
    }
}
function assertTemplateIdsUnique(entries) {
    const seen = new Set();
    for (const e of entries) {
        if (seen.has(e.templateId)) {
            throw new Error(`GoalTemplateCatalog: duplicate templateId ${e.templateId}`);
        }
        seen.add(e.templateId);
    }
}
//# sourceMappingURL=GoalTemplateCatalog.js.map