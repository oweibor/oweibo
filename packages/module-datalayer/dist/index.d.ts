/**
 * @oweibo/module-datalayer
 *
 * Generates the database access layer: Prisma schema, migrations, typed
 * repository classes, and connection pooling config. Supports PostgreSQL,
 * MySQL, and SQLite.
 *
 * Implements IModuleGenerator (core-contracts only — no core-engine imports).
 */
import type { IModuleGenerator, IModuleManifest, IBlueprintReader, IGeneratorAPI, ArtifactBundle, ValidationResult } from '@oweibo/core-contracts';
export declare class DatalayerGenerator implements IModuleGenerator {
    readonly manifest: IModuleManifest;
    generate(reader: IBlueprintReader, api: IGeneratorAPI): Promise<ArtifactBundle>;
    validate(bundle: ArtifactBundle): ValidationResult;
}
export default DatalayerGenerator;
//# sourceMappingURL=index.d.ts.map