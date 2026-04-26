"use strict";
/**
 * client.ts — HTTP client for the oweibo core-engine API.
 *
 * Reads API_URL and API_KEY from environment / config file.
 * All requests include Authorization: Bearer <token>.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.api = void 0;
exports.loadConfig = loadConfig;
function loadConfig() {
    const baseUrl = process.env['OWEIBO_API_URL'] ?? 'http://localhost:3100/api/v1';
    const apiKey = process.env['OWEIBO_API_KEY'] ?? '';
    return { baseUrl, apiKey, timeoutMs: 30_000 };
}
async function request(method, path, body, config) {
    const cfg = { ...loadConfig(), ...config };
    const url = `${cfg.baseUrl}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
    try {
        const res = await fetch(url, {
            method,
            headers: {
                'Content-Type': 'application/json',
                Authorization: cfg.apiKey ? `Bearer ${cfg.apiKey}` : '',
            },
            body: body ? JSON.stringify(body) : undefined,
            signal: controller.signal,
        });
        clearTimeout(timer);
        if (!res.ok) {
            let errorBody;
            try {
                errorBody = await res.json();
            }
            catch {
                errorBody = await res.text();
            }
            const err = new Error(`HTTP ${res.status} ${res.statusText}`);
            err.status = res.status;
            err.body = errorBody;
            throw err;
        }
        const text = await res.text();
        return text ? JSON.parse(text) : {};
    }
    catch (err) {
        clearTimeout(timer);
        throw err;
    }
}
exports.api = {
    get: (path, cfg) => request('GET', path, undefined, cfg),
    post: (path, body, cfg) => request('POST', path, body, cfg),
    delete: (path, cfg) => request('DELETE', path, undefined, cfg),
};
//# sourceMappingURL=client.js.map