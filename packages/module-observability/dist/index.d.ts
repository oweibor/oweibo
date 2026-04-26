/**
 * @oweibo/module-observability
 *
 * Generates the observability layer: Prometheus metrics exposition,
 * Winston structured logger, Grafana dashboard JSON, and OpenTelemetry
 * trace exporter config. Runs after module-codegen.
 *
 * Implements IModuleGenerator (core-contracts only — no core-engine imports).
 */
import type { IModuleGenerator, IModuleManifest, IBlueprintReader, IGeneratorAPI, ArtifactBundle, ValidationResult } from '@oweibo/core-contracts';
export declare class ObservabilityGenerator implements IModuleGenerator {
    readonly manifest: IModuleManifest;
    generate(reader: IBlueprintReader, api: IGeneratorAPI): Promise<ArtifactBundle>;
    validate(bundle: ArtifactBundle): ValidationResult;
}
export default ObservabilityGenerator;
//# sourceMappingURL=index.d.ts.map