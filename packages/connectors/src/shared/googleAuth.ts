/**
 * Shared Google service-account auth (domain-wide delegation): RS256 JWT
 * bearer grant via node:crypto — no googleapis dependency. Used by every
 * Google connector in this package (workspace-idp Directory API, drive).
 *
 * INV-10: credentials arrive resolved via ConnectorContext.credentials;
 * nothing here logs or re-exports a credential field.
 */
import { createSign } from 'crypto';
import { PortError } from '@oweibo/connector-sdk';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';

export interface GoogleServiceAccountCredentials {
  readonly client_email: string;
  readonly private_key: string;
  /** The Workspace user the service account impersonates. */
  readonly impersonation_subject: string;
}

export function assertServiceAccountCredentials(
  credentials: Readonly<Record<string, unknown>>,
  connectorName: string,
): GoogleServiceAccountCredentials {
  const c = credentials as Partial<GoogleServiceAccountCredentials>;
  if (!c.client_email || !c.private_key || !c.impersonation_subject) {
    throw PortError.permanent(
      `${connectorName} credentials missing client_email / private_key / impersonation_subject`,
    );
  }
  return c as GoogleServiceAccountCredentials;
}

export class ServiceAccountTokenSource {
  private token: { value: string; expiresAtMs: number } | null = null;

  constructor(
    private readonly creds: GoogleServiceAccountCredentials,
    private readonly scopes: readonly string[],
  ) {}

  async getToken(): Promise<string> {
    if (this.token && Date.now() < this.token.expiresAtMs - 60_000) {
      return this.token.value;
    }
    const nowSec = Math.floor(Date.now() / 1000);
    const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const claims = b64url(JSON.stringify({
      iss: this.creds.client_email,
      sub: this.creds.impersonation_subject,
      scope: this.scopes.join(' '),
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

/** Shared GET with the §11.7 failure mapping every Google API caller uses. */
export async function googleApiGet(
  url: string,
  token: string,
  what: string,
): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  } catch (err) {
    throw PortError.transient(`${what} unreachable: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (res.status === 401 || res.status === 403) {
    throw PortError.permanent(`${what} refused (${res.status}) — check delegation scopes / subject`);
  }
  if (res.status === 429 || res.status >= 500) {
    throw PortError.transient(`${what} ${res.status}`);
  }
  if (!res.ok) throw PortError.permanent(`${what} ${res.status}`);
  try {
    return (await res.json()) as Record<string, unknown>;
  } catch {
    throw PortError.corruptPoison(`${what} returned non-JSON`);
  }
}
