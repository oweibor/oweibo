/**
 * K.9 — the GitHub connector bundle (Service mode). The THIRD Tier-0
 * connector, built after the simulation environment (per the doc's deferred-
 * concerns timing). Indexes repository issues; a private repo's collaborators
 * are the audience.
 *
 * Glean face only at K.9 (changeFeed + content + acl, deltaSync via the
 * updated_at watermark). No action capabilities yet.
 *
 * Webhooks: GitHub webhooks are a real push surface, but Service-mode without a
 * public receiver runs polling — `supports.webhooks` stays FALSE (INV-15).
 */
import {
  declareConnector,
  SDK_VERSION,
  type ConnectorBundle,
  type ConnectorContext,
} from '@oweibo/connector-sdk';
import {
  makeGithubAclPort,
  makeGithubChangeFeedPort,
  makeGithubContentPort,
  type GithubClientFactory,
} from './ports.js';
import { InMemoryGithubClient } from './githubClient.js';

const defaultFactory: GithubClientFactory = (_ctx: ConnectorContext) => new InMemoryGithubClient();

export function makeGithubBundle(factory: GithubClientFactory = defaultFactory): ConnectorBundle {
  const changeFeed = makeGithubChangeFeedPort(factory);
  const content = makeGithubContentPort(factory);
  const acl = makeGithubAclPort(factory);
  return declareConnector({
    connectorId: 'github',
    displayName: 'GitHub',
    category: 'source_control',
    description:
      'GitHub content connector (Service mode). Indexes repository issues: an updated_at-' +
      'watermarked change feed (delta-capable), issue title/body/state, and repo-collaborator ' +
      'ACLs. Requires an active identity connector (install-order enforcement).',
    catalogVersion: '1.0.0',
    credentialSchema: {
      $schema: 'https://json-schema.org/draft-07/schema',
      type: 'object',
      required: ['installation_token'],
      properties: {
        installation_token: { type: 'string', description: 'GitHub App installation token' },
      },
    },
    capabilities: [],
    certificationTarget: 'community',
    sdkVersion: SDK_VERSION,
    enablementTier: 0,
    heartbeatSeconds: 300,
    dataResidency: 'us-east-1',
    supports: { changeFeed: true, content: true, acl: true, deltaSync: true },
    ports: { changeFeed, content, acl },
    freshnessClasses: { title: 'operational', body: 'operational', state: 'operational', author: 'static', repo: 'static' },
    validateConnection: async (ctx) => {
      const probe = await changeFeed.probe(ctx);
      return probe.ok
        ? { ok: true, effectiveSupports: { changeFeed: true, content: true, acl: true, deltaSync: true } }
        : { ok: false, effectiveSupports: {}, detail: probe.detail ?? 'github probe failed' };
    },
  });
}

/** The production bundle (real GitHub client injected by the platform at install). */
export const githubBundle: ConnectorBundle = makeGithubBundle();
