"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.detectHardware = detectHardware;
/**
 * hardware-detect — runtime hardware capability detection (§5.3).
 *
 * Detects CPU, memory, GPU, and feature flags to determine the best
 * HardwareProfile for scheduling decisions.
 */
const os_1 = require("os");
const child_process_1 = require("child_process");
function tryExec(cmd) {
    try {
        return (0, child_process_1.execSync)(cmd, { timeout: 5000, encoding: 'utf-8' }).trim();
    }
    catch {
        return '';
    }
}
function detectGPU() {
    // Try NVIDIA first
    const nvidiaSmi = tryExec('nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits');
    if (nvidiaSmi) {
        const parts = nvidiaSmi.split(',').map(s => s.trim());
        return { name: parts[0] ?? null, vramMB: parseInt(parts[1] ?? '0', 10) };
    }
    // macOS — check for Apple Silicon GPU
    if ((0, os_1.platform)() === 'darwin') {
        const spDisplay = tryExec('system_profiler SPDisplaysDataType 2>/dev/null');
        if (spDisplay.includes('Apple')) {
            return { name: 'Apple Silicon (Unified)', vramMB: 0 };
        }
    }
    return { name: null, vramMB: 0 };
}
function inferProfile(cores, ramGB, gpu) {
    const cpuModel = (0, os_1.cpus)()[0]?.model?.toLowerCase() ?? '';
    // Apple Silicon detection
    if ((0, os_1.platform)() === 'darwin' && (0, os_1.arch)() === 'arm64')
        return 'apple_silicon';
    // NVIDIA GPU detection
    if (gpu.name) {
        if (gpu.vramMB >= 16000)
            return 'nvidia_rtx';
        if (gpu.vramMB >= 8000)
            return 'nvidia_large';
        if (gpu.vramMB >= 4000)
            return 'nvidia_medium';
        return 'nvidia_small';
    }
    // ARM detection
    if ((0, os_1.arch)() === 'arm64') {
        if (cpuModel.includes('rk3588'))
            return 'arm64_rk3588';
        if (cores >= 8 && ramGB >= 16)
            return 'arm64_server';
        return 'arm64_rpi5';
    }
    // Intel/AMD by spec
    if (cpuModel.includes('n100'))
        return 'n100_like';
    if (cpuModel.includes('n305'))
        return 'n305';
    if (cpuModel.includes('celeron'))
        return 'celeron';
    if (cpuModel.includes('amd') || cpuModel.includes('ryzen') || cpuModel.includes('epyc')) {
        if (cores >= 12 && ramGB >= 32)
            return 'amd_high';
        if (cores >= 6 && ramGB >= 16)
            return 'amd_mid';
        return 'amd_low';
    }
    // Intel Core series
    if (cores <= 4 && ramGB <= 8)
        return 'n100_like';
    if (cores <= 4 && ramGB <= 16)
        return 'core_i3';
    if (cores <= 8 && ramGB <= 32)
        return 'core_i5';
    return 'core_i7';
}
function detectHardware() {
    const cpuInfo = (0, os_1.cpus)();
    const cores = cpuInfo.length;
    const ramGB = Math.round((0, os_1.totalmem)() / (1024 ** 3));
    const gpu = detectGPU();
    const profile = inferProfile(cores, ramGB, gpu);
    return {
        cpuModel: cpuInfo[0]?.model ?? 'unknown',
        cpuCores: cores,
        cpuArch: (0, os_1.arch)(),
        ramGB,
        platform: (0, os_1.platform)(),
        gpuName: gpu.name,
        gpuVRAM_MB: gpu.vramMB,
        profile,
    };
}
//# sourceMappingURL=hardware-detect.js.map