import type { HardwareProfile } from '@oweibo/core-contracts';
export interface DetectedHardware {
    readonly cpuModel: string;
    readonly cpuCores: number;
    readonly cpuArch: string;
    readonly ramGB: number;
    readonly platform: string;
    readonly gpuName: string | null;
    readonly gpuVRAM_MB: number;
    readonly profile: HardwareProfile;
}
export declare function detectHardware(): DetectedHardware;
//# sourceMappingURL=hardware-detect.d.ts.map