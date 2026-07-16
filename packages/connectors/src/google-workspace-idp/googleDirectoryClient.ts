/**
 * K.2 — GoogleDirectoryClient: the production DirectoryClient over the
 * Admin SDK Directory API, authenticated via a service account with
 * domain-wide delegation (shared/googleAuth.ts — RS256 JWT bearer grant,
 * no googleapis dependency).
 *
 * Credentials arrive RESOLVED through ConnectorContext.credentials
 * (INV-10 — this module never sees a vault path and never logs a
 * credential field). Failure mapping (§11.7) lives in googleApiGet:
 * 401/403 → permanent; 429/5xx → transient; non-JSON → corrupt.
 */
import {
  ServiceAccountTokenSource,
  assertServiceAccountCredentials,
  googleApiGet,
} from '../shared/googleAuth.js';
import type {
  DirectoryClient,
  DirectoryGroup,
  DirectoryMember,
  DirectoryPage,
  DirectoryUser,
} from './directoryClient.js';

const DIRECTORY_BASE = 'https://admin.googleapis.com/admin/directory/v1';
const SCOPES = [
  'https://www.googleapis.com/auth/admin.directory.user.readonly',
  'https://www.googleapis.com/auth/admin.directory.group.readonly',
  'https://www.googleapis.com/auth/admin.directory.group.member.readonly',
];

export class GoogleDirectoryClient implements DirectoryClient {
  private readonly tokens: ServiceAccountTokenSource;
  private readonly customer: string;

  constructor(credentials: Readonly<Record<string, unknown>>) {
    const creds = assertServiceAccountCredentials(credentials, 'google-workspace-idp');
    this.tokens = new ServiceAccountTokenSource(creds, SCOPES);
    this.customer = (credentials['customer_id'] as string | undefined) ?? 'my_customer';
  }

  async listUsers(pageToken: string | null): Promise<DirectoryPage<DirectoryUser>> {
    const body = await this.get('/users', {
      customer: this.customer,
      maxResults: '200',
      ...(pageToken ? { pageToken } : {}),
    });
    const users = (body['users'] as Array<Record<string, unknown>> | undefined) ?? [];
    return {
      items: users.map((u) => ({
        id: String(u['id']),
        primaryEmail: String(u['primaryEmail'] ?? ''),
        name: (u['name'] as { fullName?: string } | undefined)?.fullName,
        suspended: u['suspended'] === true,
      })),
      nextPageToken: typeof body['nextPageToken'] === 'string' ? body['nextPageToken'] : null,
    };
  }

  async listGroups(pageToken: string | null): Promise<DirectoryPage<DirectoryGroup>> {
    const body = await this.get('/groups', {
      customer: this.customer,
      maxResults: '200',
      ...(pageToken ? { pageToken } : {}),
    });
    const groups = (body['groups'] as Array<Record<string, unknown>> | undefined) ?? [];
    return {
      items: groups.map((g) => ({ id: String(g['id']), name: g['name'] as string | undefined })),
      nextPageToken: typeof body['nextPageToken'] === 'string' ? body['nextPageToken'] : null,
    };
  }

  async listGroupMembers(groupId: string, pageToken: string | null): Promise<DirectoryPage<DirectoryMember>> {
    const body = await this.get(`/groups/${encodeURIComponent(groupId)}/members`, {
      maxResults: '200',
      ...(pageToken ? { pageToken } : {}),
    });
    const members = (body['members'] as Array<Record<string, unknown>> | undefined) ?? [];
    return {
      items: members
        .filter((m) => m['type'] === 'USER' || m['type'] === 'GROUP' || m['type'] === 'CUSTOMER')
        .map((m) => ({ id: String(m['id']), type: m['type'] as DirectoryMember['type'] })),
      nextPageToken: typeof body['nextPageToken'] === 'string' ? body['nextPageToken'] : null,
    };
  }

  private async get(path: string, params: Record<string, string>): Promise<Record<string, unknown>> {
    const token = await this.tokens.getToken();
    const url = `${DIRECTORY_BASE}${path}?${new URLSearchParams(params).toString()}`;
    return googleApiGet(url, token, `directory API ${path}`);
  }
}
