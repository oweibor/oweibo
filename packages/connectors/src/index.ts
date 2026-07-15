/**
 * @oweibo/connectors — composition root (the ONE file in this package
 * allowed to be imported by the platform, and the one exemption in the
 * connectors-import-only-sdk dependency-cruiser rule; ADR-000 / INV-17).
 *
 * The engine loads bundles through this surface only; it never imports
 * an individual connector module.
 */
export {
  googleWorkspaceIdpBundle,
  makeGoogleWorkspaceIdpBundle,
} from './google-workspace-idp/connector.js';
export { mapOidcLoginClaims } from './google-workspace-idp/claims.js';
export { InMemoryDirectoryClient } from './google-workspace-idp/directoryClient.js';
export type {
  DirectoryClient,
  DirectoryUser,
  DirectoryGroup,
  DirectoryMember,
  DirectoryPage,
} from './google-workspace-idp/directoryClient.js';

export {
  googleDriveBundle,
  makeGoogleDriveBundle,
} from './google-drive/connector.js';
export { InMemoryDriveClient } from './google-drive/driveClient.js';
export type {
  DriveClient,
  DriveFileMeta,
  DriveChange,
  DriveChangePage,
  DrivePermission,
} from './google-drive/driveClient.js';
export { mapPermissions, hashGrants } from './google-drive/ports.js';

export { slackBundle, makeSlackBundle } from './slack/connector.js';
export { InMemorySlackClient, messageRef, parseMessageRef } from './slack/slackClient.js';
export type { SlackClient, SlackMessage, SlackChange, SlackChangePage } from './slack/slackClient.js';
export { membersToGrants } from './slack/ports.js';

export { githubBundle, makeGithubBundle } from './github/connector.js';
export { InMemoryGithubClient } from './github/githubClient.js';
export type { GithubClient, GithubIssue, GithubChange, GithubChangePage } from './github/githubClient.js';
export { collaboratorsToGrants } from './github/ports.js';

import type { ConnectorBundle } from '@oweibo/connector-sdk';
import { googleWorkspaceIdpBundle } from './google-workspace-idp/connector.js';
import { googleDriveBundle } from './google-drive/connector.js';
import { slackBundle } from './slack/connector.js';
import { githubBundle } from './github/connector.js';

/** Every first-party bundle, in registry-load order (IdP first — §9.5). */
export const allConnectorBundles: readonly ConnectorBundle[] = [
  googleWorkspaceIdpBundle,
  googleDriveBundle,
  slackBundle,
  githubBundle,
];
