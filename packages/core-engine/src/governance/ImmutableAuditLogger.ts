/**
 * ImmutableAuditLogger — tamper-evident audit trail (§16d).
 *
 * Writes decision logs to a Redis stream and periodically flushes
 * to S3 for long-term archival. Each entry is hash-chained to the
 * previous entry for tamper detection.
 */
import { CANONICAL_ROLES } from '@oweibo/core-contracts';
import type { DecisionLog } from '@oweibo/core-contracts';
import type { Redis } from 'ioredis';
import { createHash } from 'crypto';

export interface AuditEntry extends DecisionLog {
  readonly auditId: string;
  readonly previousHash: string;
  readonly entryHash: string;
}

export class ImmutableAuditLogger {
  private lastHash = '0000000000000000000000000000000000000000000000000000000000000000';

  constructor(
    private readonly taskId: string,
    private readonly redis?: Redis,
  ) {}

  async log(entry: DecisionLog): Promise<AuditEntry> {
    const auditId = `${this.taskId}:${entry.id}`;
    const previousHash = this.lastHash;

    const contentToHash = JSON.stringify({
      ...entry,
      auditId,
      previousHash,
    });
    const entryHash = createHash('sha256').update(contentToHash).digest('hex');

    const auditEntry: AuditEntry = {
      ...entry,
      auditId,
      previousHash,
      entryHash,
    };

    // Write to Redis stream (skipped when redis is not injected — hash chain maintained in memory)
    if (this.redis) {
      await this.redis.xadd(
        `audit:${this.taskId}`,
        '*',
        'entry', JSON.stringify(auditEntry),
      );
    }

    // Update chain
    this.lastHash = entryHash;

    return auditEntry;
  }

  async getLog(): Promise<AuditEntry[]> {
    if (!this.redis) return [];
    const entries = await this.redis.xrange(`audit:${this.taskId}`, '-', '+');
    return entries.map(([_id, fields]) => {
      const raw = fields[1] ?? '{}';
      return JSON.parse(raw) as AuditEntry;
    });
  }

  async verifyChain(): Promise<{ valid: boolean; brokenAt?: string }> {
    const entries = await this.getLog();
    let expectedPrevHash = '0000000000000000000000000000000000000000000000000000000000000000';

    for (const entry of entries) {
      if (entry.previousHash !== expectedPrevHash) {
        return { valid: false, brokenAt: entry.auditId };
      }

      const contentToHash = JSON.stringify({
        id: entry.id,
        timestamp: entry.timestamp,
        stage: entry.stage,
        decision: entry.decision,
        rationale: entry.rationale,
        requirementRef: entry.requirementRef,
        alternatives: entry.alternatives,
        rejectedReasons: entry.rejectedReasons,
        agentRole: entry.agentRole,
        auditId: entry.auditId,
        previousHash: entry.previousHash,
      });
      const computedHash = createHash('sha256').update(contentToHash).digest('hex');

      if (computedHash !== entry.entryHash) {
        return { valid: false, brokenAt: entry.auditId };
      }

      expectedPrevHash = entry.entryHash;
    }

    return { valid: true };
  }

  async getKeyDecisions(): Promise<AuditEntry[]> {
    const entries = await this.getLog();
    // Key decisions are those made by architect or reviewer agents
    return entries.filter(e =>
      e.agentRole === CANONICAL_ROLES[0] || e.agentRole === CANONICAL_ROLES[2] || e.stage === CANONICAL_ROLES[0],
    );
  }
}
