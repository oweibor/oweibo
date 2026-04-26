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

import { createHash } from 'node:crypto';

export type AuditEventType =
  | 'doc_gen.enqueued'
  | 'doc_gen.started'
  | 'doc_gen.complete'
  | 'doc_gen.failed'
  | 'doc_gen.cancelled'
  | 'doc_gen.config.loaded'
  | 'doc_gen.secret.blocked'
  | 'doc_gen.access.denied'
  | 'doc_gen.quota.exceeded'
  | 'doc_gen.adr.namespace_violation';

export interface AuditEvent {
  readonly type:        AuditEventType;
  readonly tenantId:    string;
  readonly sessionId:   string;
  readonly timestamp:   string;
  readonly actor?:      string;
  readonly payload?:    Record<string, unknown>;
}

export interface IAuditSink {
  log(event: AuditEvent): Promise<void> | void;
}

/** Console fallback sink — used in tests and when no persistent sink is wired. */
export class ConsoleAuditSink implements IAuditSink {
  log(event: AuditEvent): void {
    console.info('[AuditLog]', JSON.stringify(event));
  }
}

export class AuditLogger {
  constructor(private readonly sink: IAuditSink = new ConsoleAuditSink()) {}

  enqueued(tenantId: string, sessionId: string, rootPath: string, actor?: string): void {
    void this.sink.log(this.build('doc_gen.enqueued', tenantId, sessionId, actor, {
      // Store SHA-256[0:16] of rootPath, not the raw path (MED-2 / SOC 2)
      repoPathHash: hashPath(rootPath),
    }));
  }

  started(tenantId: string, sessionId: string): void {
    void this.sink.log(this.build('doc_gen.started', tenantId, sessionId));
  }

  complete(tenantId: string, sessionId: string, writtenFiles: number): void {
    void this.sink.log(this.build('doc_gen.complete', tenantId, sessionId, undefined, { writtenFiles }));
  }

  failed(tenantId: string, sessionId: string, reason: string): void {
    void this.sink.log(this.build('doc_gen.failed', tenantId, sessionId, undefined, { reason }));
  }

  cancelled(tenantId: string, sessionId: string, actor?: string): void {
    void this.sink.log(this.build('doc_gen.cancelled', tenantId, sessionId, actor));
  }

  configLoaded(tenantId: string, sessionId: string, configPath: string): void {
    void this.sink.log(this.build('doc_gen.config.loaded', tenantId, sessionId, undefined, {
      configPathHash: hashPath(configPath),
    }));
  }

  secretBlocked(tenantId: string, sessionId: string, templateName: string): void {
    void this.sink.log(this.build('doc_gen.secret.blocked', tenantId, sessionId, undefined, { templateName }));
  }

  accessDenied(tenantId: string, sessionId: string, actor: string, reason: string): void {
    void this.sink.log(this.build('doc_gen.access.denied', tenantId, sessionId, actor, { reason }));
  }

  quotaExceeded(tenantId: string, sessionId: string, spent: number, limit: number): void {
    void this.sink.log(this.build('doc_gen.quota.exceeded', tenantId, sessionId, undefined, { spent, limit }));
  }

  adrNamespaceViolation(tenantId: string, sessionId: string, fileName: string): void {
    void this.sink.log(this.build('doc_gen.adr.namespace_violation', tenantId, sessionId, undefined, { fileName }));
  }

  private build(
    type:      AuditEventType,
    tenantId:  string,
    sessionId: string,
    actor?:    string,
    payload?:  Record<string, unknown>,
  ): AuditEvent {
    return { type, tenantId, sessionId, timestamp: new Date().toISOString(), actor, payload };
  }
}

/** SHA-256 of `p`, first 16 hex characters. */
function hashPath(p: string): string {
  return createHash('sha256').update(p).digest('hex').slice(0, 16);
}
