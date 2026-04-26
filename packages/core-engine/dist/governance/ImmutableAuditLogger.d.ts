/**
 * ImmutableAuditLogger — tamper-evident audit trail (§16d).
 *
 * Writes decision logs to a Redis stream and periodically flushes
 * to S3 for long-term archival. Each entry is hash-chained to the
 * previous entry for tamper detection.
 */
import type { DecisionLog } from '@oweibo/core-contracts';
import type { Redis } from 'ioredis';
export interface AuditEntry extends DecisionLog {
    readonly auditId: string;
    readonly previousHash: string;
    readonly entryHash: string;
}
export declare class ImmutableAuditLogger {
    private readonly taskId;
    private readonly redis?;
    private lastHash;
    constructor(taskId: string, redis?: Redis | undefined);
    log(entry: DecisionLog): Promise<AuditEntry>;
    getLog(): Promise<AuditEntry[]>;
    verifyChain(): Promise<{
        valid: boolean;
        brokenAt?: string;
    }>;
    getKeyDecisions(): Promise<AuditEntry[]>;
}
//# sourceMappingURL=ImmutableAuditLogger.d.ts.map