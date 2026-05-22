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
import type { DomainClassifier, DomainClassification } from './DomainClassifier.js';
export interface IntakeInput {
    /** Normalised interview Q+A pairs. Both halves contribute to the text. */
    readonly interviewAnswers?: readonly {
        question: string;
        answer: string;
    }[];
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
export declare class DomainIntakeService {
    private readonly classifier;
    constructor(classifier: DomainClassifier);
    classifyAndRecommend(input: IntakeInput): Promise<IntakeRecommendation>;
}
export declare function renderIntakeText(input: IntakeInput): string;
//# sourceMappingURL=DomainIntakeService.d.ts.map