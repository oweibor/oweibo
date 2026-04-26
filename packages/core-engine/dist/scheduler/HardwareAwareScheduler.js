"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.HardwareAwareScheduler = void 0;
const PROFILE_CONFIGS = {
    n100_like: { maxConcurrentStages: 1, maxConcurrentSandboxes: 1, modelTier: 'small', enableParallelSwarm: false, warmPoolSize: 1 },
    n305: { maxConcurrentStages: 2, maxConcurrentSandboxes: 1, modelTier: 'small', enableParallelSwarm: false, warmPoolSize: 2 },
    celeron: { maxConcurrentStages: 1, maxConcurrentSandboxes: 1, modelTier: 'small', enableParallelSwarm: false, warmPoolSize: 1 },
    core_i3: { maxConcurrentStages: 2, maxConcurrentSandboxes: 2, modelTier: 'medium', enableParallelSwarm: false, warmPoolSize: 2 },
    core_i5: { maxConcurrentStages: 3, maxConcurrentSandboxes: 2, modelTier: 'medium', enableParallelSwarm: true, warmPoolSize: 3 },
    core_i7: { maxConcurrentStages: 4, maxConcurrentSandboxes: 3, modelTier: 'large', enableParallelSwarm: true, warmPoolSize: 4 },
    amd_low: { maxConcurrentStages: 2, maxConcurrentSandboxes: 1, modelTier: 'small', enableParallelSwarm: false, warmPoolSize: 2 },
    amd_mid: { maxConcurrentStages: 3, maxConcurrentSandboxes: 2, modelTier: 'medium', enableParallelSwarm: true, warmPoolSize: 3 },
    amd_high: { maxConcurrentStages: 4, maxConcurrentSandboxes: 3, modelTier: 'large', enableParallelSwarm: true, warmPoolSize: 5 },
    arm64_rpi5: { maxConcurrentStages: 2, maxConcurrentSandboxes: 1, modelTier: 'small', enableParallelSwarm: false, warmPoolSize: 1 },
    arm64_server: { maxConcurrentStages: 4, maxConcurrentSandboxes: 3, modelTier: 'large', enableParallelSwarm: true, warmPoolSize: 4 },
    arm64_rk3588: { maxConcurrentStages: 2, maxConcurrentSandboxes: 2, modelTier: 'medium', enableParallelSwarm: false, warmPoolSize: 2 },
    nvidia_small: { maxConcurrentStages: 3, maxConcurrentSandboxes: 2, modelTier: 'medium', enableParallelSwarm: true, warmPoolSize: 3 },
    nvidia_medium: { maxConcurrentStages: 4, maxConcurrentSandboxes: 3, modelTier: 'large', enableParallelSwarm: true, warmPoolSize: 5 },
    nvidia_large: { maxConcurrentStages: 6, maxConcurrentSandboxes: 4, modelTier: 'large', enableParallelSwarm: true, warmPoolSize: 8 },
    nvidia_rtx: { maxConcurrentStages: 6, maxConcurrentSandboxes: 5, modelTier: 'large', enableParallelSwarm: true, warmPoolSize: 10 },
    apple_silicon: { maxConcurrentStages: 5, maxConcurrentSandboxes: 4, modelTier: 'large', enableParallelSwarm: true, warmPoolSize: 6 },
};
class HardwareAwareScheduler {
    capabilities = null;
    config = null;
    async detect() {
        if (this.capabilities)
            return this.capabilities;
        const { cpus, totalmem } = await import('os');
        const cores = cpus().length;
        const ramGB = Math.round(totalmem() / (1024 ** 3));
        const profile = this.inferProfile(cores, ramGB);
        this.capabilities = {
            profile,
            cpuCores: cores,
            ramGB,
            gpuVRAM_GB: 0,
            hasGPU: false,
            hasAVX2: true,
        };
        return this.capabilities;
    }
    async getConfig(overrideProfile) {
        if (this.config && !overrideProfile)
            return this.config;
        const profile = overrideProfile ?? (await this.detect()).profile;
        this.config = PROFILE_CONFIGS[profile] ?? PROFILE_CONFIGS.core_i5;
        return this.config;
    }
    canRunParallel(stageCount) {
        if (!this.config)
            return false;
        return stageCount <= this.config.maxConcurrentStages;
    }
    getModelTier() {
        return this.config?.modelTier ?? 'medium';
    }
    inferProfile(cores, ramGB) {
        if (cores <= 4 && ramGB <= 8)
            return 'n100_like';
        if (cores <= 4 && ramGB <= 16)
            return 'n305';
        if (cores <= 6 && ramGB <= 16)
            return 'core_i3';
        if (cores <= 8 && ramGB <= 32)
            return 'core_i5';
        if (cores <= 12 && ramGB <= 64)
            return 'core_i7';
        if (cores > 12 && ramGB > 64)
            return 'amd_high';
        return 'core_i5';
    }
}
exports.HardwareAwareScheduler = HardwareAwareScheduler;
//# sourceMappingURL=HardwareAwareScheduler.js.map