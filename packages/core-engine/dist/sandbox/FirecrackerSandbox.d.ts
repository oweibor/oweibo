import type { ISandbox, ISandboxResult, ISandboxResourceLimits } from '@oweibo/core-contracts';
export declare class FirecrackerSandbox implements ISandbox {
    private readonly firecrackerBin;
    private readonly kernelPath;
    private readonly rootfsPath;
    private readonly vmId;
    private readonly socketPath;
    private readonly overlayDir;
    private guestCid;
    constructor(firecrackerBin?: string, kernelPath?: string, rootfsPath?: string);
    execute(script: string, runtime: 'node' | 'python3' | 'bash', limits?: Partial<ISandboxResourceLimits>): Promise<ISandboxResult>;
    bootVM(limits: ISandboxResourceLimits): Promise<void>;
    destroyVM(): Promise<void>;
    healthCheck(): Promise<boolean>;
    private runInsideVM;
    private waitForGuestAgent;
    private fcAPI;
}
//# sourceMappingURL=FirecrackerSandbox.d.ts.map