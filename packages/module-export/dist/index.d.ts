/**
 * @oweibo/module-export
 *
 * Generates the Export & Packaging layer: signed Docker image manifests,
 * SQL dump scripts, K8s production overlays, Helm chart skeletons, and
 * HMAC-SHA256 bundle signatures for artifact integrity verification.
 *
 * Implements IModuleGenerator (core-contracts only — no core-engine imports).
 */
import type { IModuleGenerator, IModuleManifest, IBlueprintReader, IGeneratorAPI, ArtifactBundle, ValidationResult } from '@oweibo/core-contracts';
export declare class ExportGenerator implements IModuleGenerator {
    readonly manifest: IModuleManifest;
    generate(reader: IBlueprintReader, api: IGeneratorAPI): Promise<ArtifactBundle>;
    validate(bundle: ArtifactBundle): ValidationResult;
}
export default ExportGenerator;
//# sourceMappingURL=index.d.ts.map