import type { ISandbox } from '@oweibo/core-contracts';
import type { ISecurityContext } from '@oweibo/core-contracts';
export interface AcquireOptions {
    timeoutMs?: number;
}
export interface WarmPoolManager {
    acquire(secCtx: ISecurityContext, opts?: AcquireOptions): Promise<ISandbox>;
    release(sandbox: ISandbox): Promise<void>;
}
//# sourceMappingURL=WarmPoolManager.d.ts.map