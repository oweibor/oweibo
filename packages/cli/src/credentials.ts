/**
 * credentials.ts — read/write ~/.oweibo/credentials
 *
 * Stored as JSON with mode 0o600 (user-read/write only).
 * On Windows, chmod is a no-op; users should secure the profile directory.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';

export const CREDENTIALS_PATH = join(homedir(), '.oweibo', 'credentials');
const CREDENTIALS_DIR = dirname(CREDENTIALS_PATH);

export interface Credentials {
  access_token:  string;
  refresh_token: string;
  expires_at:    string;   // ISO datetime
  token_type:    string;
  user_id:       string;
  tenant_id:     string | null;
  email:         string;
  scopes:        string[];
}

export function readCredentials(): Credentials | null {
  if (!existsSync(CREDENTIALS_PATH)) return null;
  try {
    const raw = readFileSync(CREDENTIALS_PATH, 'utf-8').trim();
    if (!raw || raw === '{}') return null;
    return JSON.parse(raw) as Credentials;
  } catch {
    return null;
  }
}

export function writeCredentials(creds: Credentials): void {
  if (!existsSync(CREDENTIALS_DIR)) mkdirSync(CREDENTIALS_DIR, { recursive: true });
  writeFileSync(CREDENTIALS_PATH, JSON.stringify(creds, null, 2) + '\n', {
    encoding: 'utf-8',
    mode: 0o600,
  });
  try { chmodSync(CREDENTIALS_PATH, 0o600); } catch { /* Windows: no-op */ }
}

export function clearCredentials(): void {
  if (existsSync(CREDENTIALS_PATH)) {
    try { unlinkSync(CREDENTIALS_PATH); } catch { /* ignore */ }
  }
}

export function isTokenExpired(creds: Credentials): boolean {
  // Treat token as expired 60 s before actual expiry so refresh happens before 401
  return new Date(creds.expires_at) <= new Date(Date.now() + 60_000);
}
