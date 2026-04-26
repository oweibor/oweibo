import type { ISandbox, ISandboxResult, ISandboxResourceLimits } from '@oweibo/core-contracts';
export declare class GVisorSandbox implements ISandbox {
    private readonly image;
    private readonly workDir;
    constructor(image?: string);
    execute(script: string, runtime: 'node' | 'python3' | 'bash', limits?: Partial<ISandboxResourceLimits>): Promise<ISandboxResult>;
    healthCheck(): Promise<boolean>;
    bootVM(_limits: ISandboxResourceLimits): Promise<void>;
    destroyVM(): Promise<void>;
}
//# sourceMappingURL=GVisorSandbox.d.ts.map