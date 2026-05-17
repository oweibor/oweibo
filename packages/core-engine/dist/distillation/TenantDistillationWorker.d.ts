import type { CanonicalRole } from '@oweibo/core-contracts';
import type { ILLMClient } from '@oweibo/core-contracts';
import { type NoveltyContext } from './NoveltyClassifier.js';
export interface CompletedTaskEvent {
    readonly taskId: string;
    readonly tenantId: string;
    readonly role: CanonicalRole;
    readonly slotId: string;
    readonly channel: string;
    readonly outcome: 'success' | 'failure' | 'recovery';
    readonly errorClass?: string;
    readonly toolSequence?: readonly string[];
    readonly subgoalCount?: number;
    readonly dependencyEdgeCount?: number;
    readonly estimatedComplexity?: number;
    readonly goalDescription: string;
    readonly resultSummary?: string;
}
export interface DistillationDeps {
    /** LLM used for lesson text generation (NOT the same instance as agent LLM). */
    readonly llm: ILLMClient;
    /** Redis publish — sends to `platform.lesson.submitted` channel. */
    readonly publish: (channel: string, message: string) => Promise<void>;
    /** Optional Vault client for per-tenant signing key lookup. */
    readonly vaultClient?: {
        read(path: string): Promise<{
            data: {
                key: string;
            };
        }>;
    };
    /** Novelty context provider — returns seen sets for a given tenantId. */
    readonly getNoveltyContext: (tenantId: string) => Promise<NoveltyContext>;
    /** Record a newly seen fingerprint after lesson is generated. */
    readonly recordSeen: (tenantId: string, type: 'error' | 'tool', value: string) => Promise<void>;
    /** Error metric increment (non-fatal). */
    readonly incrementErrorCounter?: (label: string) => void;
    /** D.10: per-tenant cost attribution — called after successful lesson publish. */
    readonly recordCost?: (tenantId: string) => Promise<void>;
}
/**
 * Process a single completed-task event through the full distillation pipeline.
 * Failures are logged but NEVER thrown back to the caller — distillation must
 * never block or impact the task result.
 */
export declare function distillTask(event: CompletedTaskEvent, deps: DistillationDeps): Promise<void>;
/**
 * Create a Redis subscriber that processes task.completed events.
 * Returns a teardown function.
 */
export declare function createDistillationSubscriber(redisSubscribe: (channel: string, handler: (message: string) => void) => (() => void), deps: DistillationDeps): () => void;
//# sourceMappingURL=TenantDistillationWorker.d.ts.map