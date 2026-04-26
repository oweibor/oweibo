/**
 * ISecretsManager — public interface for secrets retrieval (NEW v2 §5.6).
 *
 * Published in core-contracts so modules (e.g. module-export) can import the interface
 * without importing the concrete VaultSecretsBackend from core-engine.
 * The implementation lives in packages/core-engine/src/secrets/SecretsManager.ts.
 *
 * All methods return Record<string, string> so multiple related secrets can be
 * returned atomically per Vault call, without repeated round-trips.
 */
export interface ISecretsManager {
  getLangfuseCredentials(): Promise<Readonly<Record<string, string>>>;
  getExportSigningKey(): Promise<Readonly<Record<string, string>>>;
  getDatabaseCredentials(tenantId: string): Promise<Readonly<Record<string, string>>>;
  getLLMApiKey(
    provider: 'ollama' | 'openai' | 'anthropic',
  ): Promise<Readonly<Record<string, string>>>;
  getInfraCredentials(
    service: 'qdrant' | 'traefik' | 'k3s' | 'langfuse' | 'otel' | 'sandbox',
  ): Promise<Readonly<Record<string, string>>>;
}
