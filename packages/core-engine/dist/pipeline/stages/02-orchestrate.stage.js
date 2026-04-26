"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.OrchestrateStage = void 0;
class OrchestrateStage {
    name = 'orchestrate';
    async execute(ctx) {
        const { bundle, logger } = ctx;
        if (bundle.knowledgeArtifact?.entities?.length && (!bundle.dbMigrations || bundle.dbMigrations.length === 0)) {
            return { passed: false, errorCode: 'MISSING_MIGRATIONS', message: `knowledgeArtifact declares ${bundle.knowledgeArtifact.entities.length} entities but no dbMigrations.`, blockPromotion: true, recoveryHint: 'ExecutorAgent must generate a migration file for every declared entity.' };
        }
        if (!bundle.k8sManifests || bundle.k8sManifests.length === 0) {
            return { passed: false, errorCode: 'MISSING_K8S_MANIFESTS', message: 'No Kubernetes manifests generated.', blockPromotion: true, recoveryHint: 'ExecutorAgent must generate Deployment, Service, and ConfigMap manifests.' };
        }
        const filePaths = new Set(bundle.files.map(f => f.path));
        for (const f of bundle.files) {
            const imports = [...f.content.matchAll(/from ['"]\.\.?\/([^'"]+)['"]/g)].map(m => m[1] ?? '');
            for (const imp of imports) {
                if (!imp)
                    continue;
                if (!filePaths.has(`${imp}.ts`) && !filePaths.has(imp) && !filePaths.has(`${imp}/index.ts`)) {
                    logger.warn(`[Stage 02] Unresolved import in ${f.path}: '${imp}'`);
                }
            }
        }
        logger.info(`[Stage 02] Orchestration check passed. ${bundle.dbMigrations.length} migrations, ${bundle.k8sManifests.length} manifests.`);
        return { passed: true };
    }
}
exports.OrchestrateStage = OrchestrateStage;
//# sourceMappingURL=02-orchestrate.stage.js.map