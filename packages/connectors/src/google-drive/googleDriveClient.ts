/**
 * K.3 — GoogleDriveClient: production DriveClient over Drive API v3,
 * Service mode (service-account domain-wide delegation via
 * shared/googleAuth.ts). Metadata scope only at K.3 depth.
 */
import {
  ServiceAccountTokenSource,
  assertServiceAccountCredentials,
  googleApiGet,
} from '../shared/googleAuth.js';
import { PortError } from '@oweibo/connector-sdk';
import type {
  DriveChange,
  DriveChangePage,
  DriveClient,
  DriveFileMeta,
  DriveFilePage,
  DrivePermission,
} from './driveClient.js';

const DRIVE_BASE = 'https://www.googleapis.com/drive/v3';
const SCOPES = ['https://www.googleapis.com/auth/drive.metadata.readonly'];
const FILE_FIELDS = 'id,name,mimeType,modifiedTime,version,trashed';

export class GoogleDriveClient implements DriveClient {
  private readonly tokens: ServiceAccountTokenSource;

  constructor(credentials: Readonly<Record<string, unknown>>) {
    const creds = assertServiceAccountCredentials(credentials, 'google-drive');
    this.tokens = new ServiceAccountTokenSource(creds, SCOPES);
  }

  async getStartPageToken(): Promise<string> {
    const body = await this.get(`/changes/startPageToken`, {});
    const token = body['startPageToken'];
    if (typeof token !== 'string') throw PortError.permanent('drive startPageToken missing');
    return token;
  }

  async listChanges(pageToken: string): Promise<DriveChangePage> {
    const body = await this.get('/changes', {
      pageToken,
      pageSize: '100',
      fields: `nextPageToken,newStartPageToken,changes(fileId,removed,file(${FILE_FIELDS}))`,
    });
    const raw = (body['changes'] as Array<Record<string, unknown>> | undefined) ?? [];
    const changes: DriveChange[] = raw.map((c) => ({
      fileId: String(c['fileId']),
      removed: c['removed'] === true,
      ...(c['file'] ? { file: toMeta(c['file'] as Record<string, unknown>) } : {}),
    }));
    return {
      changes,
      nextPageToken: typeof body['nextPageToken'] === 'string' ? body['nextPageToken'] : null,
      ...(typeof body['newStartPageToken'] === 'string'
        ? { newStartPageToken: body['newStartPageToken'] }
        : {}),
    };
  }

  async listFiles(pageToken: string | null): Promise<DriveFilePage> {
    const body = await this.get('/files', {
      pageSize: '100',
      fields: `nextPageToken,files(${FILE_FIELDS})`,
      ...(pageToken ? { pageToken } : {}),
    });
    const raw = (body['files'] as Array<Record<string, unknown>> | undefined) ?? [];
    return {
      files: raw.map(toMeta),
      nextPageToken: typeof body['nextPageToken'] === 'string' ? body['nextPageToken'] : null,
    };
  }

  async getFile(fileId: string): Promise<DriveFileMeta> {
    const body = await this.get(`/files/${encodeURIComponent(fileId)}`, { fields: FILE_FIELDS });
    return toMeta(body);
  }

  async listPermissions(fileId: string): Promise<readonly DrivePermission[]> {
    const body = await this.get(`/files/${encodeURIComponent(fileId)}/permissions`, {
      fields: 'permissions(id,type,emailAddress,domain,role)',
    });
    const raw = (body['permissions'] as Array<Record<string, unknown>> | undefined) ?? [];
    return raw.map((p) => ({
      id: String(p['id']),
      type: p['type'] as DrivePermission['type'],
      emailAddress: p['emailAddress'] as string | undefined,
      domain: p['domain'] as string | undefined,
      role: p['role'] as DrivePermission['role'],
    }));
  }

  async watchChanges(channelId: string): Promise<void> {
    // Drive push channels need a public HTTPS receiver; wiring the
    // receiver is platform deployment scope. Registering without one is
    // a misconfiguration, surfaced as permanent (not silently ignored).
    void channelId;
    throw PortError.permanent(
      'drive push channels require a configured webhook receiver — polling mode is active until one exists',
    );
  }

  async stopChannel(channelId: string): Promise<void> {
    void channelId;
  }

  private async get(path: string, params: Record<string, string>): Promise<Record<string, unknown>> {
    const token = await this.tokens.getToken();
    const qs = new URLSearchParams(params).toString();
    return googleApiGet(`${DRIVE_BASE}${path}${qs ? `?${qs}` : ''}`, token, `drive API ${path}`);
  }
}

function toMeta(f: Record<string, unknown>): DriveFileMeta {
  return {
    id: String(f['id']),
    name: String(f['name'] ?? ''),
    mimeType: String(f['mimeType'] ?? ''),
    modifiedTime: String(f['modifiedTime'] ?? ''),
    version: Number(f['version'] ?? 0),
    trashed: f['trashed'] === true,
  };
}
