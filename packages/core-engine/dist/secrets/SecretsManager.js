"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SecretsManager = void 0;
class SecretsManager {
    vault;
    constructor(vault) {
        this.vault = vault;
    }
    async getLangfuseCredentials() { return this.vault.read('langfuse'); }
    async getExportSigningKey() { return this.vault.read('export-signing-key'); }
    async getDatabaseCredentials() { return this.vault.read('database'); }
    async getLLMApiKey(provider) { return this.vault.read(`llm/${provider ?? 'default'}`); }
    async getInfraCredentials(name) { return this.vault.read(`infra/${name ?? 'default'}`); }
    async getSecret(path) {
        const data = await this.vault.read(path);
        if (!data)
            throw new Error(`[SecretsManager] Secret not found at path: ${path}`);
        const value = data.value ?? data.token ?? data.secret ?? data.password;
        if (typeof value !== 'string') {
            throw new Error(`[SecretsManager] Expected string secret at ${path}, got ${typeof value}`);
        }
        return value;
    }
    async getSecretOrNull(path) {
        try {
            return await this.getSecret(path);
        }
        catch {
            return null;
        }
    }
    async putSecret(path, value) {
        await this.vault.write(path, { value });
    }
}
exports.SecretsManager = SecretsManager;
//# sourceMappingURL=SecretsManager.js.map