/**
 * K.3 — the Google Drive connector bundle (Service mode, metadata-only
 * depth). The Glean face only: changeFeed + content + acl, deltaSync via
 * the changes API's standing start-page-token. No action capabilities at
 * K.3 (arch roadmap — the Action face arrives with later steps).
 *
 * Webhook hooks register a Drive push channel; in Service-mode
 * deployments without a public receiver the production client refuses
 * (permanent) and the platform runs polling — so `supports.webhooks`
 * stays FALSE here until a receiver ships (INV-15: we declare what
 * certification can demonstrate, nothing more).
 */
import {
  declareConnector,
  SDK_VERSION,
  type ConnectorBundle,
  type ConnectorContext,
} from '@oweibo/connector-sdk';
import {
  makeDriveAclPort,
  makeDriveChangeFeedPort,
  makeDriveContentPort,
  type DriveClientFactory,
} from './ports.js';
import { GoogleDriveClient } from './googleDriveClient.js';

const defaultFactory: DriveClientFactory = (ctx: ConnectorContext) =>
  new GoogleDriveClient(ctx.credentials);

export function makeGoogleDriveBundle(factory: DriveClientFactory = defaultFactory): ConnectorBundle {
  const changeFeed = makeDriveChangeFeedPort(factory);
  const content = makeDriveContentPort(factory);
  const acl = makeDriveAclPort(factory);
  return declareConnector({
    connectorId: 'google-drive',
    displayName: 'Google Drive',
    category: 'storage',
    description:
      'Google Drive content connector (Service mode). Metadata-depth indexing: change feed ' +
      'via the changes API (delta-capable), file metadata, and permission ACLs. Requires an ' +
      'active identity connector (install-order enforcement).',
    catalogVersion: '1.0.0',
    credentialSchema: {
      $schema: 'https://json-schema.org/draft-07/schema',
      type: 'object',
      required: ['client_email', 'private_key', 'impersonation_subject'],
      properties: {
        client_email: { type: 'string', description: 'Service-account email' },
        private_key: { type: 'string', description: 'Service-account private key (PEM)' },
        impersonation_subject: {
          type: 'string',
          description: 'Workspace user the service account impersonates (domain-wide delegation)',
        },
      },
    },
    capabilities: [],                    // Glean face only at K.3
    certificationTarget: 'community',
    sdkVersion: SDK_VERSION,
    enablementTier: 1,
    heartbeatSeconds: 300,
    dataResidency: 'us-east-1',
    supports: { changeFeed: true, content: true, acl: true, deltaSync: true },
    ports: { changeFeed, content, acl },
    freshnessClasses: { title: 'operational', mimeType: 'static', modifiedTime: 'operational' },
    validateConnection: async (ctx) => {
      const probe = await changeFeed.probe(ctx);
      return probe.ok
        ? { ok: true, effectiveSupports: { changeFeed: true, content: true, acl: true, deltaSync: true } }
        : { ok: false, effectiveSupports: {}, detail: probe.detail ?? 'drive probe failed' };
    },
  });
}

/** The production bundle (Drive API v3 client). */
export const googleDriveBundle: ConnectorBundle = makeGoogleDriveBundle();
