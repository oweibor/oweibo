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

import type { ConnectorBundle } from '@oweibo/connector-sdk';
import { googleWorkspaceIdpBundle } from './google-workspace-idp/connector.js';
import { googleDriveBundle } from './google-drive/connector.js';

/** Every first-party bundle, in registry-load order (IdP first — §9.5). */
export const allConnectorBundles: readonly ConnectorBundle[] = [
  googleWorkspaceIdpBundle,
  googleDriveBundle,
];
