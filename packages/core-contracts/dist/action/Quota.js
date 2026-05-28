"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.bucketPayloadSize = bucketPayloadSize;
// ── Pure helpers ─────────────────────────────────────────────────────────
/**
 * Bucket a serialized payload into one of five size bins. Stable across
 * runs; used as a join key for cost prior lookups.
 *
 *   xs:  0..512 B
 *   sm:  512 B..4 KB
 *   md:  4 KB..32 KB
 *   lg:  32 KB..256 KB
 *   xl:  > 256 KB
 */
function bucketPayloadSize(payloadBytes) {
    if (payloadBytes < 512)
        return 'xs';
    if (payloadBytes < 4 * 1024)
        return 'sm';
    if (payloadBytes < 32 * 1024)
        return 'md';
    if (payloadBytes < 256 * 1024)
        return 'lg';
    return 'xl';
}
//# sourceMappingURL=Quota.js.map