import type { DeliveryConfig } from '@oweibo/core-contracts';
/**
 * Assembles a typed DeliveryConfig from validated request body fields.
 * Called after SubmitTaskSchema validation so all mode-specific fields are present.
 */
export declare function buildDeliveryConfig(body: {
    deliveryMode: 'download-link' | 'git-push' | 'webhook';
    gitRepoUrl?: string;
    gitBranch?: string;
    webhookUrl?: string;
}): DeliveryConfig;
//# sourceMappingURL=helpers.d.ts.map