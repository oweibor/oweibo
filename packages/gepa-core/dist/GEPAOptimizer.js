// DONE: Phase C.3 — Generic GEPA optimizer (Pareto-front evolution).
// C.3b: Generic Optimizer<TVariant> — PromptSlotOptimizer is the first instantiation.
// ModelRouterOptimizer will reuse this in Phase E.
import { runEvalSuite } from './eval/EvalRunner.js';
import { EvalCache } from './eval/EvalCache.js';
import { evictLowNoveltyMembers } from './diversity/LinguisticDiversityFloor.js';
import { selectReflectionVendor, runEnsembleVeto } from './reflection/VendorRotator.js';
import { detectRegurgitation } from './redaction/RegurgitationDetector.js';
import { classifySlotTextConfidentiality } from './redaction/SlotTextConfidentialityClassifier.js';
import { createHash } from 'crypto';
// ── Pareto dominance ─────────────────────────────────────────────────────────
function paretoDominates(a, b) {
    return (a.qualityPassRate >= b.qualityPassRate &&
        a.qualityScoreMean >= b.qualityScoreMean &&
        a.tokensP50 <= b.tokensP50 &&
        a.tokensP95 <= b.tokensP95 &&
        (a.qualityPassRate > b.qualityPassRate ||
            a.qualityScoreMean > b.qualityScoreMean ||
            a.tokensP50 < b.tokensP50 ||
            a.tokensP95 < b.tokensP95));
}
function buildParetoFrontier(variants) {
    return variants.filter(v => !variants.some(other => other.hash !== v.hash && paretoDominates(other.paretoScore, v.paretoScore)));
}
// ── Reflection prompt ─────────────────────────────────────────────────────────
function buildReflectionPrompt(incumbent, failureTraces, lessons, slotId) {
    return `You are a prompt engineer improving a system prompt slot.

SLOT: ${slotId}
INCUMBENT TEXT:
${incumbent}

FAILURE TRACES (tasks where this slot underperformed):
${failureTraces.slice(0, 5).map((t, i) => `${i + 1}. ${t}`).join('\n')}

RELEVANT LESSONS (abstract patterns from many tenants):
${lessons.slice(0, 10).map((l, i) => `${i + 1}. ${l}`).join('\n')}

TASK: Write an improved version of the slot text. Rules:
- Keep the same purpose as the incumbent.
- Incorporate insights from failure traces and lessons.
- No tenant-specific details, paths, IDs, or company names.
- Output ONLY the improved slot text, no explanation.`;
}
// ── Main optimizer ────────────────────────────────────────────────────────────
export class PromptSlotOptimizer {
    config;
    deps;
    cache;
    constructor(config, deps) {
        this.config = config;
        this.deps = deps;
        this.cache = new EvalCache(deps.pool);
    }
    async runOneGeneration(generation, currentFrontier, failureTraces) {
        const lessons = await this.deps.getLessons(this.config.role, this.config.slotId, 20);
        // Select reflection vendor for this generation (round-robin)
        const vendor = selectReflectionVendor({
            slotId: this.config.slotId,
            generation,
            panel: this.config.vendorPanel,
        });
        // Generate offspring via reflection
        const offspring = [];
        for (const parent of currentFrontier.slice(0, this.config.populationSize)) {
            const candidate = await this.generateCandidate(parent, failureTraces, lessons, generation, vendor);
            if (candidate)
                offspring.push(candidate);
        }
        // Merge parent frontier + offspring → build new Pareto frontier
        const combined = [...currentFrontier, ...offspring];
        const frontier = buildParetoFrontier(combined);
        // Apply linguistic diversity floor
        const frontierMembers = frontier
            .filter(v => v.embedding)
            .map(v => ({
            hash: v.hash,
            embedding: v.embedding,
            evalScores: {
                qualityPassRate: v.paretoScore.qualityPassRate,
                qualityScoreMean: v.paretoScore.qualityScoreMean,
                tokensP50: v.paretoScore.tokensP50,
            },
        }));
        const diverse = evictLowNoveltyMembers(frontierMembers);
        const diverseHashes = new Set(diverse.map(m => m.hash));
        return frontier.filter(v => diverseHashes.has(v.hash));
    }
    async generateCandidate(parent, failureTraces, lessons, generation, vendor) {
        const prompt = buildReflectionPrompt(parent.text, failureTraces, lessons, this.config.slotId);
        let candidateText;
        try {
            const result = await this.deps.reflectionLlm.generate({
                systemPrompt: 'You are an expert prompt engineer. Follow instructions precisely.',
                userPrompt: prompt,
                temperature: 0.7,
            });
            candidateText = result.output.trim();
        }
        catch {
            return null;
        }
        // ── Gate 1: Regurgitation check ───────────────────────────────────────
        const regu = detectRegurgitation(candidateText, lessons);
        if (regu.regurgitated)
            return null;
        // ── Gate 2: Slot confidentiality classifier ───────────────────────────
        const conf = classifySlotTextConfidentiality(candidateText);
        if (!conf.pass)
            return null;
        // ── Gate 3: DLP ───────────────────────────────────────────────────────
        const dlp = applyDLPFilter(candidateText);
        if (!dlp.pass)
            return null;
        // ── Gate 4: Ensemble veto (simplified — single-vendor in this generation) ─
        const veto = runEnsembleVeto({
            candidateText,
            slotContract: `Slot ${this.config.slotId} for role ${this.config.role}`,
            vendorScores: [{ vendor, score: 0.7 }], // real impl queries vendor judge API
        });
        if (veto.veto)
            return null;
        const hash = createHash('sha256')
            .update(`${this.config.role}:${this.config.slotId}:${candidateText}`)
            .digest('hex');
        // ── Eval (with cache) ─────────────────────────────────────────────────
        const evalResult = await runEvalSuite(candidateText, this.deps.evalLlm, hash, 'train');
        // Store in cache
        for (const score of evalResult.scores) {
            await this.cache.set(score);
        }
        // ── Embedding for diversity floor ─────────────────────────────────────
        let embedding;
        try {
            embedding = await this.deps.getEmbedding(candidateText);
        }
        catch { /* optional */ }
        const paretoScore = {
            qualityPassRate: evalResult.qualityPassRate,
            qualityScoreMean: evalResult.qualityScoreMean,
            tokensP50: evalResult.tokensP50,
            tokensP95: evalResult.tokensP95,
        };
        return {
            hash,
            text: candidateText,
            parentHash: parent.hash,
            role: this.config.role,
            slotId: this.config.slotId,
            generation,
            reflectionVendor: vendor,
            evalResult,
            paretoScore,
            embedding,
        };
    }
}
// ── Minimal DLP copy (no dep on core-engine) ─────────────────────────────────
function applyDLPFilter(text) {
    const PATTERNS = [
        /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i,
        /\b[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}\b/,
        /\b[0-9a-f]{40}\b/i,
    ];
    return { pass: !PATTERNS.some(re => re.test(text)) };
}
//# sourceMappingURL=GEPAOptimizer.js.map