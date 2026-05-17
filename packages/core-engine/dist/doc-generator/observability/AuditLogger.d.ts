/**
 * AuditLogger — append-only audit events for doc-gen operations (C8, v10.5 / SOC 2).
 *
 * Each event is a JSONL line written to the audit log stream. Event type names
 * follow the doc_gen.* scheme (MED-2) for consistency with metrics naming.
 *
 * Events:
 *   doc_gen.enqueued           — POST /generate accepted
 *   doc_gen.started            — worker picked up job
 *   doc_gen.complete           — run succeeded
 *   doc_gen.failed             — run failed
 *   doc_gen.cancelled          — operator cancelled
 *   doc_gen.config.loaded      — config file loaded
 *   doc_gen.secret.blocked     — secret redacted from rendered output
 *   doc_gen.access.denied      — authorization failure
 *   doc_gen.quota.exceeded     — daily token quota exhausted
 *   doc_gen.adr.namespace_violation — ADR attempted write outside adr-inferred/
 *
 * Security (MED-2): rootPath is stored as SHA-256[0:16] hex — never the raw path.
 */
export type AuditEventType = 'doc_gen.enqueued' | 'doc_gen.started' | 'doc_gen.complete' | 'doc_gen.failed' | 'doc_gen.cancelled' | 'doc_gen.config.loaded' | 'doc_gen.secret.blocked' | 'doc_gen.access.denied' | 'doc_gen.quota.exceeded' | 'doc_gen.adr.namespace_violation';
export interface AuditEvent {
    readonly type: AuditEventType;
    readonly tenantId: string;
    readonly sessionId: string;
    readonly timestamp: string;
    readonly actor?: string;
    readonly payload?: Record<string, unknown>;
}
export interface IAuditSink {
    log(event: AuditEvent): Promise<void> | void;
}
/** Console fallback sink — used in tests and when no persistent sink is wired. */
export declare class ConsoleAuditSink implements IAuditSink {
    log(event: AuditEvent): void;
}
export declare class AuditLogger {
    private readonly sink;
    constructor(sink?: IAuditSink);
    enqueued(tenantId: string, sessionId: string, rootPath: string, actor?: string): void;
    started(tenantId: string, sessionId: string): void;
    complete(tenantId: string, sessionId: string, writtenFiles: number): void;
    failed(tenantId: string, sessionId: string, reason: string): void;
    cancelled(tenantId: string, sessionId: string, actor?: string): void;
    configLoaded(tenantId: string, sessionId: string, configPath: string): void;
    secretBlocked(tenantId: string, sessionId: string, templateName: string): void;
    accessDenied(tenantId: string, sessionId: string, actor: string, reason: string): void;
    quotaExceeded(tenantId: string, sessionId: string, spent: number, limit: number): void;
    adrNamespaceViolation(tenantId: string, sessionId: string, fileName: string): void;
    private build;
}
//# sourceMappingURL=AuditLogger.d.ts.map