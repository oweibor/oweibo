/**
 * ArtifactFile — a single generated file in an ArtifactBundle.
 * SHA-256 checksum is verified by ExportBundler at signing time.
 */
export interface ArtifactFile {
    readonly path: string;
    readonly content: string;
    readonly encoding: 'utf-8' | 'base64';
    /** SHA-256 of content — verified at export time */
    readonly checksum: string;
}
/**
 * ArtifactBundle — the complete output of a factory generation run.
 * Produced by IModuleGenerator.generate(); consumed by ComplianceGate,
 * DocumentationAgent, and ExportBundler.
 *
 * v6: testFiles required — gate rejects bundles with empty test suites.
 * v8: docFiles added for documentation-as-artifact
 *     (user-guide.md, developer.md, api-reference.md).
 * signature: HMAC-SHA256 applied by ExportBundler; verified before any delivery.
 */
export interface ArtifactBundle {
    readonly files: readonly ArtifactFile[];
    /** Required — TDD gate rejects bundles with empty test suites */
    readonly testFiles: readonly ArtifactFile[];
    readonly dbMigrations: readonly ArtifactFile[];
    readonly k8sManifests: readonly ArtifactFile[];
    /** v8: user-guide.md, developer.md, api-reference.md — populated by DocumentationAgent */
    readonly docFiles: readonly ArtifactFile[];
    readonly knowledgeArtifact: import('./ModuleKnowledge.js').ModuleKnowledge;
    /** HMAC-SHA256 signed by factory private key */
    readonly signature: string;
}
//# sourceMappingURL=ArtifactBundle.d.ts.map