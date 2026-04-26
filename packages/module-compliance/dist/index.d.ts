/**
 * @oweibo/module-compliance
 *
 * Generates the compliance layer: deterministic fintech/payment security
 * checklists, GDPR/SOC2 policy stubs, security headers config, rate-limiting
 * middleware, and PII scrubbing utilities.
 *
 * Implements IModuleGenerator (core-contracts only — no core-engine imports).
 */
import type { IModuleGenerator, IModuleManifest, IBlueprintReader, IGeneratorAPI, ArtifactBundle, ValidationResult } from '@oweibo/core-contracts';
export interface ComplianceCheckItem {
    id: string;
    category: 'authentication' | 'authorization' | 'data-protection' | 'network' | 'audit' | 'cryptography' | 'input-validation';
    severity: 'critical' | 'high' | 'medium' | 'low';
    description: string;
    rationale: string;
    filePath?: string;
    automated: boolean;
}
export interface ComplianceReport {
    checklistVersion: string;
    generatedAt: string;
    appName: string;
    profile: string;
    items: ComplianceCheckItem[];
    summary: {
        critical: number;
        high: number;
        medium: number;
        low: number;
        total: number;
    };
}
export declare class ComplianceGenerator implements IModuleGenerator {
    readonly manifest: IModuleManifest;
    generate(reader: IBlueprintReader, api: IGeneratorAPI): Promise<ArtifactBundle>;
    validate(bundle: ArtifactBundle): ValidationResult;
}
export declare function scrubPii(input: string): string;
export declare function scrubObject(obj: unknown): unknown;
export default ComplianceGenerator;
//# sourceMappingURL=index.d.ts.map