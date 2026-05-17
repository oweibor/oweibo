import type { Pool } from 'pg';
import type { PromptVersionRecord, ChannelRecord } from './types.js';
interface RegisterInput {
    role: string;
    slotId: string;
    templateVersion: string;
    text: string;
    parentHash?: string;
    updatedBy?: string;
}
/** SHA256(role:slotId:templateVersion:text) — canonical content address. */
export declare function computeSlotHash(role: string, slotId: string, templateVersion: string, text: string): string;
/**
 * PromptRegistry — Postgres-authoritative, Langfuse-mirrored prompt slot store.
 *
 * Invariants:
 *   - hash = SHA256(role:slotId:templateVersion:text) — computed before any write
 *   - 60s in-memory TTL cache; no stale reads past TTL
 *   - register() is idempotent: same hash → no-op INSERT ON CONFLICT
 *   - Langfuse mirror is best-effort; failure never throws into caller
 */
export declare class PromptRegistry {
    private readonly pg;
    private readonly langfuseSecretKey?;
    private readonly langfusePublicKey?;
    private readonly cache;
    private readonly channelCache;
    private static readonly TTL_MS;
    constructor(pg: Pool, langfuseSecretKey?: string | undefined, langfusePublicKey?: string | undefined);
    /** Look up a slot version by its content hash. */
    get(hash: string): Promise<PromptVersionRecord>;
    /**
     * Resolve the current channel pointer to its PromptVersionRecord.
     * Falls back to stable-v0 if channel row is missing.
     */
    getChannelPointer(channel: string, role: string, slotId: string): Promise<PromptVersionRecord>;
    /**
     * Register a new slot version.  Idempotent — same content → same hash, no double-write.
     * Mirrors to Langfuse asynchronously after Postgres write succeeds.
     */
    register(input: RegisterInput): Promise<PromptVersionRecord>;
    /** Get all slot IDs for a given role + channel. */
    listSlots(channel: string, role: string): Promise<ChannelRecord[]>;
    /** Flip a channel pointer to a new hash (optimistic lock via version column). */
    updateChannelPointer(channel: string, role: string, slotId: string, newHash: string, expectedVersion: bigint, updatedBy: string): Promise<void>;
    private fromCache;
    private toCache;
    private mirrorToLangfuse;
}
export {};
//# sourceMappingURL=PromptRegistry.d.ts.map