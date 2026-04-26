/**
 * hardware-detect — runtime hardware capability detection (§5.3).
 *
 * Detects CPU, memory, GPU, and feature flags to determine the best
 * HardwareProfile for scheduling decisions.
 */
import { cpus, totalmem, arch, platform } from 'os';
import { execSync } from 'child_process';
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

function tryExec(cmd: string): string {
  try {
    return execSync(cmd, { timeout: 5000, encoding: 'utf-8' }).trim();
  } catch {
    return '';
  }
}

function detectGPU(): { name: string | null; vramMB: number } {
  // Try NVIDIA first
  const nvidiaSmi = tryExec('nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits');
  if (nvidiaSmi) {
    const parts = nvidiaSmi.split(',').map(s => s.trim());
    return { name: parts[0] ?? null, vramMB: parseInt(parts[1] ?? '0', 10) };
  }

  // macOS — check for Apple Silicon GPU
  if (platform() === 'darwin') {
    const spDisplay = tryExec('system_profiler SPDisplaysDataType 2>/dev/null');
    if (spDisplay.includes('Apple')) {
      return { name: 'Apple Silicon (Unified)', vramMB: 0 };
    }
  }

  return { name: null, vramMB: 0 };
}

function inferProfile(cores: number, ramGB: number, gpu: { name: string | null; vramMB: number }): HardwareProfile {
  const cpuModel = cpus()[0]?.model?.toLowerCase() ?? '';

  // Apple Silicon detection
  if (platform() === 'darwin' && arch() === 'arm64') return 'apple_silicon';

  // NVIDIA GPU detection
  if (gpu.name) {
    if (gpu.vramMB >= 16000) return 'nvidia_rtx';
    if (gpu.vramMB >= 8000) return 'nvidia_large';
    if (gpu.vramMB >= 4000) return 'nvidia_medium';
    return 'nvidia_small';
  }

  // ARM detection
  if (arch() === 'arm64') {
    if (cpuModel.includes('rk3588')) return 'arm64_rk3588';
    if (cores >= 8 && ramGB >= 16) return 'arm64_server';
    return 'arm64_rpi5';
  }

  // Intel/AMD by spec
  if (cpuModel.includes('n100')) return 'n100_like';
  if (cpuModel.includes('n305')) return 'n305';
  if (cpuModel.includes('celeron')) return 'celeron';

  if (cpuModel.includes('amd') || cpuModel.includes('ryzen') || cpuModel.includes('epyc')) {
    if (cores >= 12 && ramGB >= 32) return 'amd_high';
    if (cores >= 6 && ramGB >= 16) return 'amd_mid';
    return 'amd_low';
  }

  // Intel Core series
  if (cores <= 4 && ramGB <= 8) return 'n100_like';
  if (cores <= 4 && ramGB <= 16) return 'core_i3';
  if (cores <= 8 && ramGB <= 32) return 'core_i5';
  return 'core_i7';
}

export function detectHardware(): DetectedHardware {
  const cpuInfo = cpus();
  const cores = cpuInfo.length;
  const ramGB = Math.round(totalmem() / (1024 ** 3));
  const gpu = detectGPU();
  const profile = inferProfile(cores, ramGB, gpu);

  return {
    cpuModel: cpuInfo[0]?.model ?? 'unknown',
    cpuCores: cores,
    cpuArch: arch(),
    ramGB,
    platform: platform(),
    gpuName: gpu.name,
    gpuVRAM_MB: gpu.vramMB,
    profile,
  };
}
