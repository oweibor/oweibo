/**
 * @oweibo/module-codegen
 *
 * Generates the core application code: Express/Next.js entry points,
 * route handlers, middleware, API controllers, and typed request/response
 * schemas (Zod). Runs after module-scaffolding.
 *
 * Implements IModuleGenerator (core-contracts only — no core-engine imports).
 */
import type { IModuleGenerator, IModuleManifest, IBlueprintReader, IGeneratorAPI, ArtifactBundle, ValidationResult } from '@oweibo/core-contracts';
export declare class CodegenGenerator implements IModuleGenerator {
    readonly manifest: IModuleManifest;
    generate(reader: IBlueprintReader, api: IGeneratorAPI): Promise<ArtifactBundle>;
    validate(bundle: ArtifactBundle): ValidationResult;
}
export default CodegenGenerator;
//# sourceMappingURL=index.d.ts.map