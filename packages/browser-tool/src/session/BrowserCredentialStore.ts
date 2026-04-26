/**
 * BrowserCredentialStore — AES-256-GCM credential vault adapter.
 * (NEW v9.5.6)
 *
 * Fetches and decrypts per-tenant, per-service credentials.
 * The plaintext BrowserCredential exists only in memory during inject-credentials execution.
 * It is NEVER serialised, logged, or passed through DLP filter.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import type { BrowserCredential, EncryptedCredential } from '@oweibo/core-contracts';
import { BrowserPolicyViolationError } from '../contracts/errors.js';
import type { ILogger } from './SessionReaper.js';

interface IVaultClient {
  read(path: string): Promise<unknown>;
  write(path: string, value: unknown): Promise<void>;
}

export class BrowserCredentialStore {
  constructor(
    private readonly vault: IVaultClient,
    private readonly logger: ILogger,
  ) {}

  /**
   * Fetch and decrypt a credential.
   * The returned object is transient — never cache it.
   * SECURITY: credential values must not appear in any log or event payload.
   */
  async fetch(serviceId: string, tenantId: string): Promise<BrowserCredential> {
    const raw = await this.vault.read(
      `oweibo/tenants/${tenantId}/browser/credentials/${serviceId}`,
    ) as EncryptedCredential | null;
    if (!raw) {
      throw new BrowserPolicyViolationError(
        `No credential registered for service "${serviceId}" in tenant "${tenantId}".`,
      );
    }
    return this.decrypt(raw);
  }

  /**
   * Store or update a credential (called via CLI credential-manager tool only).
   */
  async store(serviceId: string, tenantId: string, cred: BrowserCredential): Promise<void> {
    const encrypted = await this.encrypt(cred);
    await this.vault.write(
      `oweibo/tenants/${tenantId}/browser/credentials/${serviceId}`,
      encrypted,
    );
    // Log service name only — never log credential values
    this.logger.info({ tenantId, serviceId }, 'Credential stored.');
  }

  async delete(serviceId: string, tenantId: string): Promise<void> {
    await this.vault.write(
      `oweibo/tenants/${tenantId}/browser/credentials/${serviceId}`,
      null,
    );
    this.logger.info({ tenantId, serviceId }, 'Credential deleted.');
  }

  private async decrypt(raw: EncryptedCredential): Promise<BrowserCredential> {
    const keyB64 = await this.vault.read(
      'oweibo/infra/browser/credential-encryption-key',
    ) as string;
    const key = Buffer.from(keyB64, 'base64');
    const iv = Buffer.from(raw.iv, 'base64');
    const tag = Buffer.from(raw.tag, 'base64');
    const ct = Buffer.from(raw.ciphertext, 'base64');
    const dec = createDecipheriv('aes-256-gcm', key, iv);
    dec.setAuthTag(tag);
    const pt = Buffer.concat([dec.update(ct), dec.final()]);
    return JSON.parse(pt.toString('utf8')) as BrowserCredential;
  }

  private async encrypt(cred: BrowserCredential): Promise<EncryptedCredential> {
    const keyB64 = await this.vault.read(
      'oweibo/infra/browser/credential-encryption-key',
    ) as string;
    const key = Buffer.from(keyB64, 'base64');
    const iv = randomBytes(12);
    const enc = createCipheriv('aes-256-gcm', key, iv);
    const pt = Buffer.from(JSON.stringify(cred), 'utf8');
    const ct = Buffer.concat([enc.update(pt), enc.final()]);
    return {
      iv: iv.toString('base64'),
      tag: enc.getAuthTag().toString('base64'),
      ciphertext: ct.toString('base64'),
    };
  }
}
