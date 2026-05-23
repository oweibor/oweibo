import type { Pool } from 'pg';
import type { IPlatformLessonRecall, PlatformLessonHit, PlatformLessonRecallQuery } from '@oweibo/core-contracts';
export interface PlatformLessonRecallOptions {
    /** Hard cap on rows scanned per query. Default 200. */
    scanLimit?: number;
    /** topK default when caller omits it. Default 4. */
    defaultTopK?: number;
    /**
     * Optional audit sink. The runtime wires appendAudit from @oweibo/db.
     * When undefined, audit is a no-op (useful for tests).
     */
    audit?: (row: AuditRow) => Promise<void>;
}
export interface AuditRow {
    readonly action: 'memory.platform_lesson.recall';
    readonly details: {
        readonly query_hash: string;
        readonly hits_returned: number;
        readonly bucket_keys: readonly string[];
        readonly role?: string;
        readonly slot_id?: string;
    };
}
export declare class PlatformLessonRecall implements IPlatformLessonRecall {
    private readonly pool;
    private readonly scanLimit;
    private readonly defaultTopK;
    private readonly audit;
    constructor(pool: Pool, opts?: PlatformLessonRecallOptions);
    recall(q: PlatformLessonRecallQuery): Promise<readonly PlatformLessonHit[]>;
    private queryLessons;
}
//# sourceMappingURL=PlatformLessonRecall.d.ts.map