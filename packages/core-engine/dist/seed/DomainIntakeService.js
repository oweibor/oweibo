"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DomainIntakeService = void 0;
exports.renderIntakeText = renderIntakeText;
/** Static map of domain → seed skill ids. The full catalog lives in
 *  the connector registry + skill bundle; this is the minimal mapping
 *  shipped with T.2.g. */
const DOMAIN_SEED_SKILLS = {
    finance: ['code-review-pass', 'migration-safety', 'incident-triage'],
    healthcare: ['code-review-pass', 'incident-triage', 'adr-drafting'],
    'ml-research': ['debugging-bisect', 'test-scaffolding', 'refactor-extract'],
    devops: ['incident-triage', 'migration-safety', 'debugging-bisect'],
    ecommerce: ['code-review-pass', 'incident-triage', 'test-scaffolding'],
    legal: ['adr-drafting', 'code-review-pass'],
    gaming: ['debugging-bisect', 'test-scaffolding'],
    media: ['code-review-pass', 'refactor-extract'],
    logistics: ['incident-triage', 'migration-safety'],
    education: ['code-review-pass', 'adr-drafting'],
};
class DomainIntakeService {
    classifier;
    constructor(classifier) {
        this.classifier = classifier;
    }
    async classifyAndRecommend(input) {
        const text = renderIntakeText(input);
        const classification = await this.classifier.classify(text);
        const skills = classification.domain !== 'unclassified'
            ? (DOMAIN_SEED_SKILLS[classification.domain] ?? [])
            : [];
        return {
            classification,
            recommendedSeedSkills: skills,
        };
    }
}
exports.DomainIntakeService = DomainIntakeService;
// ── Helpers ───────────────────────────────────────────────────────────────
function renderIntakeText(input) {
    const parts = [];
    for (const qa of input.interviewAnswers ?? []) {
        parts.push(`Q: ${qa.question}`);
        parts.push(`A: ${qa.answer}`);
    }
    for (const excerpt of input.primerExcerpts ?? []) {
        parts.push(excerpt);
    }
    const repo = input.repoSignals;
    if (repo) {
        if (repo.languages?.length)
            parts.push(`Languages: ${repo.languages.join(', ')}`);
        if (repo.frameworks?.length)
            parts.push(`Frameworks: ${repo.frameworks.join(', ')}`);
        if (repo.notes?.length)
            parts.push(repo.notes.join('\n'));
    }
    return parts.join('\n');
}
//# sourceMappingURL=DomainIntakeService.js.map