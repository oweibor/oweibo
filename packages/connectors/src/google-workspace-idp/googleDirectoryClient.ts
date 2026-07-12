/**
 * K.2 — GoogleDirectoryClient: the production DirectoryClient over the
 * Admin SDK Directory API, authenticated via a service account with
 * domain-wide delegation (JWT bearer grant, RS256 via node:crypto — no
 * googleapis dependency).
 *
 * Credentials arrive RESOLVED through ConnectorContext.credentials
 * (INV-10 — this module never sees a vault path and never logs a
 * credential field): `client_email`, `private_key`,
 * `impersonation_subject` (a super-admin the service account acts as —
 * Directory API requires it), `customer_id` (default `my_customer`).
 *
 * Failure mapping (§11.7 / ADR-012): 401/403 → permanent (revoked grant,
 * missing scope, delegation not configured); 429 and 5xx → transient;
 * network errors → transient. Malformed JSON from the API → corrupt.
 */
import { createSign } from 'crypto';
import { PortError } from '@oweibo/connector-sdk';
import type {
  DirectoryClient,
  DirectoryGroup,
  DirectoryMember,
  DirectoryPage,
  DirectoryUser,
} from './directoryClient.js';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const DIRECTORY_BASE = 'https://admin.googleapis.com/admin/directory/v1';
const SCOPES = [
  'https://www.googleapis.com/auth/admin.directory.user.readonly',
  'https://www.googleapis.com/auth/admin.directory.group.readonly',
  'https://www.googleapis.com/auth/admin.directory.group.member.readonly',
].join(' ');

export interface GoogleDirectoryCredentials {
  readonly client_email: string;
  readonly private_key: string;
  /** Workspace admin the service account impersonates (domain-wide delegation). */
  readonly impersonation_subject: string;
  readonly customer_id?: string;
}

export class GoogleDirectoryClient implements DirectoryClient {
  private readonly creds: GoogleDirectoryCredentials;
  private readonly customer: string;
  private token: { value: string; expiresAtMs: number } | null = null;

  constructor(credentials: Readonly<Record<string, unknown>>) {
    const c = credentials as Partial<GoogleDirectoryCredentials>;
    if (!c.client_email || !c.private_key || !c.impersonation_subject) {
      throw PortError.permanent(
        'google-workspace-idp credentials missing client_email / private_key / impersonation_subject',
      );
    }
    this.creds = c as GoogleDirectoryCredentials;
    this.customer = c.customer_id ?? 'my_customer';
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

  // ── HTTP + auth plumbing ───────────────────────────────────────────────

  private async get(path: string, params: Record<string, string>): Promise<Record<string, unknown>> {
    const token = await this.accessToken();
    const url = `${DIRECTORY_BASE}${path}?${new URLSearchParams(params).toString()}`;
    let res: Response;
    try {
      res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
    } catch (err) {
      throw PortError.transient(
        `directory API unreachable: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (res.status === 401 || res.status === 403) {
      throw PortError.permanent(`directory API refused (${res.status}) — check delegation scopes / admin subject`);
    }
    if (res.status === 429 || res.status >= 500) {
      throw PortError.transient(`directory API ${res.status}`);
    }
    if (!res.ok) {
      throw PortError.permanent(`directory API ${res.status} on ${path}`);
    }
    try {
      return (await res.json()) as Record<string, unknown>;
    } catch {
      throw PortError.corruptPoison(`directory API returned non-JSON for ${path}`);
    }
  }

  private async accessToken(): Promise<string> {
    if (this.token && Date.now() < this.token.expiresAtMs - 60_000) {
      return this.token.value;
    }
    const nowSec = Math.floor(Date.now() / 1000);
    const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const claims = b64url(JSON.stringify({
      iss: this.creds.client_email,
      sub: this.creds.impersonation_subject,
      scope: SCOPES,
      aud: TOKEN_URL,
      iat: nowSec,
      exp: nowSec + 3600,
    }));
    const signer = createSign('RSA-SHA256');
    signer.update(`${header}.${claims}`);
    const signature = signer.sign(this.creds.private_key).toString('base64url');
    const assertion = `${header}.${claims}.${signature}`;

    let res: Response;
    try {
      res = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
          assertion,
        }),
      });
    } catch (err) {
      throw PortError.transient(
        `token endpoint unreachable: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (res.status === 400 || res.status === 401 || res.status === 403) {
      throw PortError.permanent(`token grant refused (${res.status}) — delegation revoked or key invalid`);
    }
    if (!res.ok) throw PortError.transient(`token endpoint ${res.status}`);
    const body = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!body.access_token) throw PortError.permanent('token response carried no access_token');
    this.token = {
      value: body.access_token,
      expiresAtMs: Date.now() + (body.expires_in ?? 3600) * 1000,
    };
    return this.token.value;
  }
}

function b64url(s: string): string {
  return Buffer.from(s, 'utf-8').toString('base64url');
}
