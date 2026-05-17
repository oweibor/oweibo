"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ADRDocTemplate = void 0;
const promises_1 = __importDefault(require("node:fs/promises"));
const node_path_1 = __importDefault(require("node:path"));
const paths_js_1 = require("./paths.js");
/**
 * ADRDocTemplate — writes to docs/adr-inferred/ ONLY (B5, v10.4).
 * NEVER writes to docs/adr/ (human-authored ADRs are read-only).
 *
 * HIGH-3: renders per-ADR sections so DocExporter writes one file per ADR.
 * HIGH-4: deduplicates against docs/adr/ using TF-cosine ≥ 0.85 or evidence IoU ≥ 0.6.
 */
class ADRDocTemplate {
    category = 'adr';
    fileName = paths_js_1.OUTPUT_PATHS.adrInferredReadme;
    isApplicable(k) {
        if (k.inferredADRs.length === 0) {
            return { applicable: false, degradationLevel: 'skipped', reason: 'No ADRs inferred' };
        }
        return { applicable: true, degradationLevel: 'full' };
    }
    async render(k, _ctx, signal) {
        signal?.throwIfAborted();
        // ── Deduplication (HIGH-4): read existing human-authored ADRs ────────────────
        const existingTexts = await readExistingADRTexts(k.rootPath);
        const filtered = k.inferredADRs.filter((adr) => {
            const adrText = `${adr.title} ${adr.context} ${adr.decision}`;
            for (const existing of existingTexts) {
                if (tfCosineSimilarity(adrText, existing.text) >= 0.85)
                    return false;
                if (evidenceIoU(adr.evidence, existing.evidence) >= 0.6)
                    return false;
            }
            return true;
        });
        signal?.throwIfAborted();
        const sections = [];
        // README index section
        const readmeContent = [
            '# Inferred Architecture Decision Records',
            '',
            'This directory contains ADRs **inferred by the Oweibo doc-generator** from',
            'static analysis of the codebase. They are hypotheses about why the code was',
            'structured as it is — not accepted decisions.',
            '',
            '> ⚠️ Do not edit files in this directory. They are regenerated on each doc-gen run.',
            '> Human-authored ADRs live in `docs/adr/`.',
            '',
            `${k.inferredADRs.length - filtered.length} ADR(s) omitted — already covered by docs/adr/.`,
            '',
            `| # | Title | Confidence | Status |`,
            `|---|-------|-----------|--------|`,
            ...filtered.map((adr, i) => `| ${i + 1} | [${adr.title}](./${adrSlug(i, adr.title)}.md) | ${(adr.confidence * 100).toFixed(0)}% | ${adr.status} |`),
        ].join('\n');
        sections.push({ id: 'readme', title: 'README', content: readmeContent, order: 0 });
        // Per-ADR sections — id encodes the target filename stem (used by DocExporter HIGH-3)
        filtered.forEach((adr, idx) => {
            const slug = adrSlug(idx, adr.title);
            const content = [
                `# ${adr.title}`,
                '',
                `**Status:** ${adr.status}  `,
                `**Confidence:** ${(adr.confidence * 100).toFixed(0)}%`,
                '',
                '## Context',
                '',
                adr.context,
                '',
                '## Decision',
                '',
                adr.decision,
                '',
                '## Consequences',
                '',
                ...adr.consequences.map((c) => `- ${c}`),
                '',
                '## Evidence',
                '',
                ...adr.evidence.map((e) => `- \`${e}\``),
                '',
                '---',
                '_This ADR was inferred by the Oweibo doc-generator. It is a hypothesis, not a decision record._',
            ].join('\n');
            sections.push({ id: slug, title: adr.title, content, order: idx + 1 });
        });
        const rendered = sections.find((s) => s.id === 'readme').content;
        return {
            fileName: this.fileName,
            category: this.category,
            title: 'Inferred ADRs',
            sections,
            rendered,
        };
    }
}
exports.ADRDocTemplate = ADRDocTemplate;
// ── Internal helpers ──────────────────────────────────────────────────────────
function adrSlug(idx, title) {
    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50);
    return `adr-${String(idx + 1).padStart(3, '0')}-${slug}`;
}
async function readExistingADRTexts(rootPath) {
    const adrDir = node_path_1.default.join(rootPath, 'docs', 'adr');
    try {
        const entries = await promises_1.default.readdir(adrDir);
        const results = [];
        for (const entry of entries) {
            if (!entry.endsWith('.md'))
                continue;
            const raw = await promises_1.default.readFile(node_path_1.default.join(adrDir, entry), 'utf-8');
            results.push({
                text: raw,
                evidence: extractCodeRefs(raw),
            });
        }
        return results;
    }
    catch {
        return [];
    }
}
function extractCodeRefs(text) {
    const refs = [];
    // Match inline code, file paths referenced in backticks
    for (const m of text.matchAll(/`([^`]+)`/g)) {
        refs.push(m[1]);
    }
    return refs;
}
/** Term-frequency cosine similarity between two text strings. */
function tfCosineSimilarity(a, b) {
    const tokA = tokenize(a);
    const tokB = tokenize(b);
    if (tokA.size === 0 || tokB.size === 0)
        return 0;
    const tf = (tokens, term) => tokens.get(term) ?? 0;
    let dot = 0;
    let normA = 0;
    let normB = 0;
    const allTerms = new Set([...tokA.keys(), ...tokB.keys()]);
    for (const term of allTerms) {
        const va = tf(tokA, term);
        const vb = tf(tokB, term);
        dot += va * vb;
        normA += va * va;
        normB += vb * vb;
    }
    if (normA === 0 || normB === 0)
        return 0;
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
/** Intersection over Union of two string sets. */
function evidenceIoU(a, b) {
    if (a.length === 0 && b.length === 0)
        return 1;
    if (a.length === 0 || b.length === 0)
        return 0;
    const setA = new Set(a.map((s) => s.toLowerCase()));
    const setB = new Set(b.map((s) => s.toLowerCase()));
    let intersection = 0;
    for (const v of setA) {
        if (setB.has(v))
            intersection++;
    }
    const union = setA.size + setB.size - intersection;
    return union === 0 ? 1 : intersection / union;
}
function tokenize(text) {
    const freq = new Map();
    for (const word of text.toLowerCase().match(/\b[a-z][a-z0-9]*\b/g) ?? []) {
        freq.set(word, (freq.get(word) ?? 0) + 1);
    }
    return freq;
}
//# sourceMappingURL=ADRDocTemplate.js.map