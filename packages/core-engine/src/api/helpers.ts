// packages/core-engine/src/api/helpers.ts
import type { DeliveryConfig } from '@oweibo/core-contracts';

/**
 * Assembles a typed DeliveryConfig from validated request body fields.
 * Called after SubmitTaskSchema validation so all mode-specific fields are present.
 */
export function buildDeliveryConfig(body: {
  deliveryMode: 'download-link' | 'git-push' | 'webhook';
  gitRepoUrl?: string;
  gitBranch?: string;
  webhookUrl?: string;
}): DeliveryConfig {
  switch (body.deliveryMode) {
    case 'git-push':
      return { mode: 'git-push', gitRepoUrl: body.gitRepoUrl!, gitBranch: body.gitBranch };
    case 'webhook':
      return { mode: 'webhook', webhookUrl: body.webhookUrl! };
    default:
      return { mode: 'download-link' };
  }
}
