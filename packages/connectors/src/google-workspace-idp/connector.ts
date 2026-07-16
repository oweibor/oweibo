/**
 * K.2 — the Google Workspace IdP connector bundle (arch §9.5, ADR-010
 * §3.6): the foundational, identity-only connector.
 *
 * Identity-only is structural, not aspirational: `capabilities: []` (no
 * Action face at all), no content/changeFeed/acl ports — the manifest
 * carries ONLY `supports: { principals, groups }`, so INV-15 holds by
 * shape. It is infrastructure, not a business-app connector: content
 * connectors refuse to install until an IdP connector is Healthy
 * (install-order enforcement, platform-side).
 */
import {
  declareConnector,
  SDK_VERSION,
  type ConnectorBundle,
  type ConnectorContext,
} from '@oweibo/connector-sdk';
import { makeWorkspacePrincipalsPort, type DirectoryClientFactory } from './principalsPort.js';
import { GoogleDirectoryClient } from './googleDirectoryClient.js';

const defaultFactory: DirectoryClientFactory = (ctx: ConnectorContext) =>
  new GoogleDirectoryClient(ctx.credentials);

/**
 * Build the bundle with an injectable DirectoryClient factory —
 * certification and tests bind InMemoryDirectoryClient; production uses
 * the default (Admin SDK over service-account delegation).
 */
export function makeGoogleWorkspaceIdpBundle(
  factory: DirectoryClientFactory = defaultFactory,
): ConnectorBundle {
  const principals = makeWorkspacePrincipalsPort(factory);
  return declareConnector({
    connectorId: 'google-workspace-idp',
    displayName: 'Google Workspace (Identity)',
    category: 'identity',
    description:
      'Foundational identity connector: principals, groups, and nested-group membership ' +
      'from Google Workspace via the Admin SDK Directory API. Identity-only — supplies the ' +
      'audience ground truth every other connector\'s permission checks evaluate against; ' +
      'carries no content, indexing, or action capabilities.',
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
          description: 'Workspace super-admin the service account impersonates (domain-wide delegation)',
        },
        customer_id: { type: 'string', description: 'Directory customer id; defaults to my_customer' },
      },
    },
    capabilities: [],                    // identity-only — structural, per §9.5
    certificationTarget: 'community',
    sdkVersion: SDK_VERSION,
    // §9.5: infrastructure, installed first, not subject to §10.4 tier
    // defaults — tier 0 (no cost/scope confirmation gate of its own).
    enablementTier: 0,
    heartbeatSeconds: 300,
    supports: { principals: true, groups: true },
    ports: { principals },
    validateConnection: async (ctx) => {
      const probe = await principals.probe(ctx);
      return probe.ok
        ? { ok: true, effectiveSupports: { principals: true, groups: true } }
        : { ok: false, effectiveSupports: {}, detail: probe.detail ?? 'directory probe failed' };
    },
  });
}

/** The production bundle (Admin SDK client). */
export const googleWorkspaceIdpBundle: ConnectorBundle = makeGoogleWorkspaceIdpBundle();
