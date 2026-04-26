"use strict";
/**
 * STMCompressor — synchronous compressor for STM entries into an LTM-writable payload.
 *
 * Used by the endSession() crash-recovery path to condense a session's short-term
 * memory into a single LTM entry at scope 'session:{sessionId}'.
 *
 * The [crash-recovery] prefix on the summary string is the signal endSession() uses
 * to distinguish crash-recovery writes from normal task-end consolidation writes.
 *
 * Design constraints:
 *   - Fully synchronous — no async, no I/O, no LLM calls.
 *   - embedding fields are stripped from the detail payload before inclusion;
 *     they are large binary blobs that bloat LTM detail with data that is never
 *     read back (vectors are re-computed on recall from the summary text).
 *   - Entries tagged 'memory' are skipped — they are retrieval scaffolding
 *     written by the recall path, not reusable session content (same rule as
 *     consolidateFromTask and consolidateTenant).
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.STMCompressor = void 0;
// ─── Compressor ───────────────────────────────────────────────────────────────
class STMCompressor {
    logger;
    constructor(logger) {
        this.logger = logger;
    }
    /**
     * compressEntries — compress a session's STM entries into a single LTM payload.
     *
     * Steps:
     *   1. Filter out entries whose relevanceTags include 'memory' (retrieval scaffolding).
     *   2. Return the empty-session sentinel if nothing remains.
     *   3. Join each entry's summary with ' | ', prefixed with '[crash-recovery] '.
     *   4. Build detail as a plain-object array with the embedding field stripped.
     */
    compressEntries(entries) {
        // ── 1. Filter retrieval scaffolding ───────────────────────────────────────
        const filtered = entries.filter(e => !e.relevanceTags.includes('memory'));
        this.logger.debug('[STMCompressor] compressing entries', {
            total: entries.length,
            retained: filtered.length,
            skipped: entries.length - filtered.length,
        });
        // ── 2. Empty-session sentinel ─────────────────────────────────────────────
        if (filtered.length === 0) {
            return { summary: '[empty session]', detail: [] };
        }
        // ── 3. Summary string ─────────────────────────────────────────────────────
        // The '[crash-recovery] ' prefix is load-bearing — endSession() uses it to
        // distinguish crash-recovery LTM writes from normal task-end writes.
        const summary = '[crash-recovery] ' + filtered.map(e => e.summary).join(' | ');
        // ── 4. Detail payload — strip embeddings ──────────────────────────────────
        // Embeddings are large Float32 blobs that serve no purpose in an LTM detail
        // field — the vector will be recomputed from the summary text on recall.
        const detail = filtered.map(({ embedding: _embedding, ...rest }) => rest);
        return { summary, detail };
    }
}
exports.STMCompressor = STMCompressor;
//# sourceMappingURL=STMCompressor.js.map