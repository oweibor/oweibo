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
import type { STMEntry } from './ShortTermMemoryStore.js';
import type { Logger } from './MemoryDecayService.js';
export interface CompressedSTM {
    summary: string;
    detail: unknown;
}
export declare class STMCompressor {
    private readonly logger;
    constructor(logger: Logger);
    /**
     * compressEntries — compress a session's STM entries into a single LTM payload.
     *
     * Steps:
     *   1. Filter out entries whose relevanceTags include 'memory' (retrieval scaffolding).
     *   2. Return the empty-session sentinel if nothing remains.
     *   3. Join each entry's summary with ' | ', prefixed with '[crash-recovery] '.
     *   4. Build detail as a plain-object array with the embedding field stripped.
     */
    compressEntries(entries: STMEntry[]): CompressedSTM;
}
//# sourceMappingURL=STMCompressor.d.ts.map