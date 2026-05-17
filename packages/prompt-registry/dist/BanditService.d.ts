import type { Pool } from 'pg';
export declare class BanditService {
    private readonly pg;
    constructor(pg: Pool);
    /** Phase D.2 stub — returns undefined (caller falls back to channel pointer). */
    draw(_channel: string, _slotId: string, _taskId: string): string | undefined;
    /** Phase D.2 stub — no-op. */
    recordReward(_taskId: string, _slotId: string, _armId: string, _reward: number): Promise<void>;
}
//# sourceMappingURL=BanditService.d.ts.map