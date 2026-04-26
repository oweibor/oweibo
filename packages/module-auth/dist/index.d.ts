/**
 * @oweibo/module-auth
 *
 * Generates the authentication layer. Supports:
 *   - betterauth (default): BetterAuth with multi-org plugin
 *   - authjs: Auth.js (next-auth v5)
 *   - zitadel-native: OIDC SDK, identity managed by self-hosted Zitadel
 *   - custom: placeholder stubs for tenant-supplied implementation
 *
 * Implements IModuleGenerator (core-contracts only — no core-engine imports).
 */
import type { IModuleGenerator, IModuleManifest, IBlueprintReader, IGeneratorAPI, ArtifactBundle, ValidationResult } from '@oweibo/core-contracts';
export declare class AuthGenerator implements IModuleGenerator {
    readonly manifest: IModuleManifest;
    generate(reader: IBlueprintReader, api: IGeneratorAPI): Promise<ArtifactBundle>;
    validate(bundle: ArtifactBundle): ValidationResult;
}
export default AuthGenerator;
//# sourceMappingURL=index.d.ts.map