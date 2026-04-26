"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SafeBrowsingClient = void 0;
// packages/browser-tool/src/policy/SafeBrowsingClient.ts
// Google Safe Browsing v4 lookup (§7.1) — checks URLs against malware/phishing
// lists before navigation or download. Cached in-memory for 1h to limit API quota.
const CACHE_TTL_MS = 60 * 60 * 1000;
class SafeBrowsingClient {
    apiKey;
    cache = new Map();
    constructor(apiKey) {
        this.apiKey = apiKey;
    }
    async check(url) {
        const hit = this.cache.get(url);
        if (hit && hit.expiresAt > Date.now())
            return hit.verdict;
        const res = await fetch(`https://safebrowsing.googleapis.com/v4/threatMatches:find?key=${this.apiKey}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                client: { clientId: 'oweibo', clientVersion: '1.0' },
                threatInfo: {
                    threatTypes: ['MALWARE', 'SOCIAL_ENGINEERING', 'UNWANTED_SOFTWARE'],
                    platformTypes: ['ANY_PLATFORM'],
                    threatEntryTypes: ['URL'],
                    threatEntries: [{ url }],
                },
            }),
        });
        if (!res.ok)
            return 'safe'; // fail-open: don't block on quota errors
        const json = await res.json();
        const verdict = (json.matches?.length ?? 0) > 0 ? 'unsafe' : 'safe';
        this.cache.set(url, { verdict, expiresAt: Date.now() + CACHE_TTL_MS });
        return verdict;
    }
}
exports.SafeBrowsingClient = SafeBrowsingClient;
//# sourceMappingURL=SafeBrowsingClient.js.map