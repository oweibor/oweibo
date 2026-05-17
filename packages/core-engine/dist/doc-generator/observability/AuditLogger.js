"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.AuditLogger = exports.ConsoleAuditSink = void 0;
const node_crypto_1 = require("node:crypto");
/** Console fallback sink — used in tests and when no persistent sink is wired. */
class ConsoleAuditSink {
    log(event) {
        console.info('[AuditLog]', JSON.stringify(event));
    }
}
exports.ConsoleAuditSink = ConsoleAuditSink;
class AuditLogger {
    sink;
    constructor(sink = new ConsoleAuditSink()) {
        this.sink = sink;
    }
    enqueued(tenantId, sessionId, rootPath, actor) {
        void this.sink.log(this.build('doc_gen.enqueued', tenantId, sessionId, actor, {
            // Store SHA-256[0:16] of rootPath, not the raw path (MED-2 / SOC 2)
            repoPathHash: hashPath(rootPath),
        }));
    }
    started(tenantId, sessionId) {
        void this.sink.log(this.build('doc_gen.started', tenantId, sessionId));
    }
    complete(tenantId, sessionId, writtenFiles) {
        void this.sink.log(this.build('doc_gen.complete', tenantId, sessionId, undefined, { writtenFiles }));
    }
    failed(tenantId, sessionId, reason) {
        void this.sink.log(this.build('doc_gen.failed', tenantId, sessionId, undefined, { reason }));
    }
    cancelled(tenantId, sessionId, actor) {
        void this.sink.log(this.build('doc_gen.cancelled', tenantId, sessionId, actor));
    }
    configLoaded(tenantId, sessionId, configPath) {
        void this.sink.log(this.build('doc_gen.config.loaded', tenantId, sessionId, undefined, {
            configPathHash: hashPath(configPath),
        }));
    }
    secretBlocked(tenantId, sessionId, templateName) {
        void this.sink.log(this.build('doc_gen.secret.blocked', tenantId, sessionId, undefined, { templateName }));
    }
    accessDenied(tenantId, sessionId, actor, reason) {
        void this.sink.log(this.build('doc_gen.access.denied', tenantId, sessionId, actor, { reason }));
    }
    quotaExceeded(tenantId, sessionId, spent, limit) {
        void this.sink.log(this.build('doc_gen.quota.exceeded', tenantId, sessionId, undefined, { spent, limit }));
    }
    adrNamespaceViolation(tenantId, sessionId, fileName) {
        void this.sink.log(this.build('doc_gen.adr.namespace_violation', tenantId, sessionId, undefined, { fileName }));
    }
    build(type, tenantId, sessionId, actor, payload) {
        return { type, tenantId, sessionId, timestamp: new Date().toISOString(), actor, payload };
    }
}
exports.AuditLogger = AuditLogger;
/** SHA-256 of `p`, first 16 hex characters. */
function hashPath(p) {
    return (0, node_crypto_1.createHash)('sha256').update(p).digest('hex').slice(0, 16);
}
//# sourceMappingURL=AuditLogger.js.map