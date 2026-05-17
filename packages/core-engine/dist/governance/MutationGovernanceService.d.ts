import type { Pool } from 'pg';
export type MutationStatus = 'mutable' | 'guarded' | 'frozen';
export interface SlotMutationRow {
    slotId: string;
    role: string;
    mutationStatus: MutationStatus;
    freezeReason: string | null;
    /** Most-recent change (if any). */
    lastChangedAt: string | null;
    lastChangedBy: string | null;
    lastRfcUrl: string | null;
}
export interface MutationHistoryEntry {
    id: string;
    slotId: string;
    role: string;
    previousStatus: string;
    newStatus: string;
    reason: string;
    rfcUrl: string | null;
    changedBy: string;
    changedAt: string;
}
export interface SetStatusInput {
    slotId: string;
    role: string;
    newStatus: MutationStatus;
    reason: string;
    rfcUrl?: string;
    changedBy: string;
}
export type SetStatusResult = {
    ok: true;
    previousStatus: string;
    rowsUpdated: number;
} | {
    ok: false;
    error: 'rfc_required' | 'slot_not_found' | 'no_change';
    message: string;
};
export declare class MutationGovernanceService {
    private readonly pool;
    constructor(pool: Pool);
    /** List every distinct (slot_id, role) with current status + last-change metadata. */
    listSlots(filter?: {
        role?: string;
        status?: MutationStatus;
    }): Promise<SlotMutationRow[]>;
    /** Full status-change history for one slot, newest first. */
    getHistory(slotId: string, role: string, limit?: number): Promise<MutationHistoryEntry[]>;
    /**
     * Change mutation_status for every version of a (slot, role) and write a
     * history row. Atomic. Mirrors scripts/platform-prompts.js setStatus().
     */
    setStatus(input: SetStatusInput): Promise<SetStatusResult>;
}
//# sourceMappingURL=MutationGovernanceService.d.ts.map