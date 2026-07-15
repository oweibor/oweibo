/**
 * K.9 — the Slack connector bundle (Service mode). The second Tier-0
 * connector, and the SDK's real test: it reuses the same six-port authoring
 * surface Drive proved, writing only Slack-specific translation.
 *
 * Glean face only at K.9 (changeFeed + content + acl, deltaSync via the
 * resumable history cursor). No action capabilities yet — posting messages is
 * a later step, gated by the trust ladder like every action.
 *
 * Webhooks: Slack's Events API is a real push surface, but a Service-mode
 * deployment without a public receiver runs polling — so `supports.webhooks`
 * stays FALSE until a receiver ships (INV-15: declare only what certification
 * can demonstrate).
 */
import {
  declareConnector,
  SDK_VERSION,
  type ConnectorBundle,
  type ConnectorContext,
} from '@oweibo/connector-sdk';
import {
  makeSlackAclPort,
  makeSlackChangeFeedPort,
  makeSlackContentPort,
  type SlackClientFactory,
} from './ports.js';
import { InMemorySlackClient } from './slackClient.js';

// Production would bind a real Slack WebClient here; until that ships the
// default factory is unused in Service-mode deployments (the platform injects
// a configured factory), and the certification battery injects a seeded
// InMemorySlackClient.
const defaultFactory: SlackClientFactory = (_ctx: ConnectorContext) => new InMemorySlackClient();

export function makeSlackBundle(factory: SlackClientFactory = defaultFactory): ConnectorBundle {
  const changeFeed = makeSlackChangeFeedPort(factory);
  const content = makeSlackContentPort(factory);
  const acl = makeSlackAclPort(factory);
  return declareConnector({
    connectorId: 'slack',
    displayName: 'Slack',
    category: 'communication',
    description:
      'Slack content connector (Service mode). Indexes channel messages: a resumable ' +
      'history change feed (delta-capable), message text + author, and channel-membership ' +
      'ACLs. Requires an active identity connector (install-order enforcement).',
    catalogVersion: '1.0.0',
    credentialSchema: {
      $schema: 'https://json-schema.org/draft-07/schema',
      type: 'object',
      required: ['bot_token'],
      properties: {
        bot_token: { type: 'string', description: 'Slack bot user OAuth token (xoxb-…)' },
      },
    },
    capabilities: [],                    // Glean face only at K.9
    certificationTarget: 'community',
    sdkVersion: SDK_VERSION,
    enablementTier: 0,                   // Tier 0 — a core connector
    heartbeatSeconds: 300,
    dataResidency: 'us-east-1',
    supports: { changeFeed: true, content: true, acl: true, deltaSync: true },
    ports: { changeFeed, content, acl },
    freshnessClasses: { text: 'operational', author: 'static', channel: 'static', ts: 'static' },
    validateConnection: async (ctx) => {
      const probe = await changeFeed.probe(ctx);
      return probe.ok
        ? { ok: true, effectiveSupports: { changeFeed: true, content: true, acl: true, deltaSync: true } }
        : { ok: false, effectiveSupports: {}, detail: probe.detail ?? 'slack probe failed' };
    },
  });
}

/** The production bundle (real Slack client injected by the platform at install). */
export const slackBundle: ConnectorBundle = makeSlackBundle();
