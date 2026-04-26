/**
 * @oweibo/module-scaffolding
 *
 * Generates the base project scaffold: directory structure, package.json,
 * tsconfig, ESLint config, Prettier, .gitignore, Docker files, and CI configs.
 * Always the first module to run — all other modules build on top of its output.
 *
 * Implements IModuleGenerator (core-contracts only — no core-engine imports).
 */
import type { IModuleGenerator, IModuleManifest, IBlueprintReader, IGeneratorAPI, ArtifactBundle, ValidationResult } from '@oweibo/core-contracts';
export declare class ScaffoldingGenerator implements IModuleGenerator {
    readonly manifest: IModuleManifest;
    generate(reader: IBlueprintReader, api: IGeneratorAPI): Promise<ArtifactBundle>;
    validate(bundle: ArtifactBundle): ValidationResult;
}
export default ScaffoldingGenerator;
//# sourceMappingURL=index.d.ts.map