/**
 * HardwareAwareScheduler — hardware-aware pipeline scheduling (§5.3, Principle #4).
 *
 * Maps detected hardware profiles to concurrency limits and model tier selections.
 * Low-power devices (N100, Celeron) run stages sequentially; high-end devices
 * (NVIDIA RTX, Apple Silicon) run parallel stage groups.
 */
import type { HardwareProfile } from '@oweibo/core-contracts';
export interface HardwareCapabilities {
    readonly profile: HardwareProfile;
    readonly cpuCores: number;
    readonly ramGB: number;
    readonly gpuVRAM_GB: number;
    readonly hasGPU: boolean;
    readonly hasAVX2: boolean;
}
export interface SchedulerConfig {
    readonly maxConcurrentStages: number;
    readonly maxConcurrentSandboxes: number;
    readonly modelTier: 'small' | 'medium' | 'large';
    readonly enableParallelSwarm: boolean;
    readonly warmPoolSize: number;
}
export declare class HardwareAwareScheduler {
    private capabilities;
    private config;
    detect(): Promise<HardwareCapabilities>;
    getConfig(overrideProfile?: HardwareProfile): Promise<SchedulerConfig>;
    canRunParallel(stageCount: number): boolean;
    getModelTier(): 'small' | 'medium' | 'large';
    private inferProfile;
}
//# sourceMappingURL=HardwareAwareScheduler.d.ts.map