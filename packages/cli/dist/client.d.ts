/**
 * client.ts — HTTP client for the oweibo core-engine API.
 *
 * Reads API_URL and API_KEY from environment / config file.
 * All requests include Authorization: Bearer <token>.
 */
export interface ClientConfig {
    readonly baseUrl: string;
    readonly apiKey: string;
    readonly timeoutMs: number;
}
export interface ApiError {
    status: number;
    body: unknown;
}
declare function loadConfig(): ClientConfig;
export declare const api: {
    get: <T>(path: string, cfg?: Partial<ClientConfig>) => Promise<T>;
    post: <T>(path: string, body?: unknown, cfg?: Partial<ClientConfig>) => Promise<T>;
    delete: <T>(path: string, cfg?: Partial<ClientConfig>) => Promise<T>;
};
export { loadConfig };
//# sourceMappingURL=client.d.ts.map