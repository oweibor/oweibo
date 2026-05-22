/**
 * T.2.g: DomainIntakeService — orchestrates the classifier + recommendation
 * surface for an intake event.
 *
 * Given the raw intake content (interview answers + primer extracts +
 * optional repo signals), this service:
 *   1. Normalises the inputs into a single embedding-ready string.
 *   2. Calls DomainClassifier.
 *   3. Looks up the corresponding template + seed-skill recommendations.
 *
 * The actual persistence of intake artefacts (memories, intake row update)
 * lives in DomainIntakeStep in the worker package — this service is
 * purely the classification + recommendation engine.
 */
import type {
  DomainClassifier,
  DomainClassification,
} from './DomainClassifier.js';

export interface IntakeInput {
  /** Normalised interview Q+A pairs. Both halves contribute to the text. */
  readonly interviewAnswers?: readonly { question: string; answer: string }[];
  /** Extracted text from primer docs (already chunked + concatenated). */
  readonly primerExcerpts?: readonly string[];
  /** Repo languages / framework labels detected by CodebaseAnalyzer. */
  readonly repoSignals?: {
    readonly languages?: readonly string[];
    readonly frameworks?: readonly string[];
    readonly notes?: readonly string[];
  };
}

export interface IntakeRecommendation {
  readonly classification: DomainClassification;
  /** Seed skills associated with the recommended template / domain. */
  readonly recommendedSeedSkills: readonly string[];
}

/** Static map of domain → seed skill ids. The full catalog lives in
 *  the connector registry + skill bundle; this is the minimal mapping
 *  shipped with T.2.g. */
const DOMAIN_SEED_SKILLS: Readonly<Record<string, readonly string[]>> = {
  finance:     ['code-review-pass', 'migration-safety', 'incident-triage'],
  healthcare:  ['code-review-pass', 'incident-triage', 'adr-drafting'],
  'ml-research': ['debugging-bisect', 'test-scaffolding', 'refactor-extract'],
  devops:      ['incident-triage', 'migration-safety', 'debugging-bisect'],
  ecommerce:   ['code-review-pass', 'incident-triage', 'test-scaffolding'],
  legal:       ['adr-drafting', 'code-review-pass'],
  gaming:      ['debugging-bisect', 'test-scaffolding'],
  media:       ['code-review-pass', 'refactor-extract'],
  logistics:   ['incident-triage', 'migration-safety'],
  education:   ['code-review-pass', 'adr-drafting'],
};

export class DomainIntakeService {
  constructor(private readonly classifier: DomainClassifier) {}

  async classifyAndRecommend(input: IntakeInput): Promise<IntakeRecommendation> {
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

// ── Helpers ───────────────────────────────────────────────────────────────

export function renderIntakeText(input: IntakeInput): string {
  const parts: string[] = [];
  for (const qa of input.interviewAnswers ?? []) {
    parts.push(`Q: ${qa.question}`);
    parts.push(`A: ${qa.answer}`);
  }
  for (const excerpt of input.primerExcerpts ?? []) {
    parts.push(excerpt);
  }
  const repo = input.repoSignals;
  if (repo) {
    if (repo.languages?.length) parts.push(`Languages: ${repo.languages.join(', ')}`);
    if (repo.frameworks?.length) parts.push(`Frameworks: ${repo.frameworks.join(', ')}`);
    if (repo.notes?.length) parts.push(repo.notes.join('\n'));
  }
  return parts.join('\n');
}
