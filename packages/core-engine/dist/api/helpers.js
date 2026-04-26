"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildDeliveryConfig = buildDeliveryConfig;
/**
 * Assembles a typed DeliveryConfig from validated request body fields.
 * Called after SubmitTaskSchema validation so all mode-specific fields are present.
 */
function buildDeliveryConfig(body) {
    switch (body.deliveryMode) {
        case 'git-push':
            return { mode: 'git-push', gitRepoUrl: body.gitRepoUrl, gitBranch: body.gitBranch };
        case 'webhook':
            return { mode: 'webhook', webhookUrl: body.webhookUrl };
        default:
            return { mode: 'download-link' };
    }
}
//# sourceMappingURL=helpers.js.map