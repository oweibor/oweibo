"use strict";
/**
 * BrowserCredentialStore — AES-256-GCM credential vault adapter.
 * (NEW v9.5.6)
 *
 * Fetches and decrypts per-tenant, per-service credentials.
 * The plaintext BrowserCredential exists only in memory during inject-credentials execution.
 * It is NEVER serialised, logged, or passed through DLP filter.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.BrowserCredentialStore = void 0;
const crypto_1 = require("crypto");
const errors_js_1 = require("../contracts/errors.js");
class BrowserCredentialStore {
    vault;
    logger;
    constructor(vault, logger) {
        this.vault = vault;
        this.logger = logger;
    }
    /**
     * Fetch and decrypt a credential.
     * The returned object is transient — never cache it.
     * SECURITY: credential values must not appear in any log or event payload.
     */
    async fetch(serviceId, tenantId) {
        const raw = await this.vault.read(`oweibo/tenants/${tenantId}/browser/credentials/${serviceId}`);
        if (!raw) {
            throw new errors_js_1.BrowserPolicyViolationError(`No credential registered for service "${serviceId}" in tenant "${tenantId}".`);
        }
        return this.decrypt(raw);
    }
    /**
     * Store or update a credential (called via CLI credential-manager tool only).
     */
    async store(serviceId, tenantId, cred) {
        const encrypted = await this.encrypt(cred);
        await this.vault.write(`oweibo/tenants/${tenantId}/browser/credentials/${serviceId}`, encrypted);
        // Log service name only — never log credential values
        this.logger.info({ tenantId, serviceId }, 'Credential stored.');
    }
    async delete(serviceId, tenantId) {
        await this.vault.write(`oweibo/tenants/${tenantId}/browser/credentials/${serviceId}`, null);
        this.logger.info({ tenantId, serviceId }, 'Credential deleted.');
    }
    async decrypt(raw) {
        const keyB64 = await this.vault.read('oweibo/infra/browser/credential-encryption-key');
        const key = Buffer.from(keyB64, 'base64');
        const iv = Buffer.from(raw.iv, 'base64');
        const tag = Buffer.from(raw.tag, 'base64');
        const ct = Buffer.from(raw.ciphertext, 'base64');
        const dec = (0, crypto_1.createDecipheriv)('aes-256-gcm', key, iv);
        dec.setAuthTag(tag);
        const pt = Buffer.concat([dec.update(ct), dec.final()]);
        return JSON.parse(pt.toString('utf8'));
    }
    async encrypt(cred) {
        const keyB64 = await this.vault.read('oweibo/infra/browser/credential-encryption-key');
        const key = Buffer.from(keyB64, 'base64');
        const iv = (0, crypto_1.randomBytes)(12);
        const enc = (0, crypto_1.createCipheriv)('aes-256-gcm', key, iv);
        const pt = Buffer.from(JSON.stringify(cred), 'utf8');
        const ct = Buffer.concat([enc.update(pt), enc.final()]);
        return {
            iv: iv.toString('base64'),
            tag: enc.getAuthTag().toString('base64'),
            ciphertext: ct.toString('base64'),
        };
    }
}
exports.BrowserCredentialStore = BrowserCredentialStore;
//# sourceMappingURL=BrowserCredentialStore.js.map