/**
 * hardware-llm-map — maps hardware profiles to recommended LLM models (§5.3).
 *
 * Each profile maps to a set of model recommendations for different operation
 * tiers (small, medium, large). Used by ModelRouter to select the best model
 * for a given operation based on available hardware.
 */
import type { HardwareProfile } from '@oweibo/core-contracts';

export interface LLMModelConfig {
  readonly modelId: string;
  readonly provider: 'ollama' | 'anthropic' | 'openai' | 'bedrock';
  readonly contextWindow: number;
  readonly quantization?: string;
}

export interface HardwareLLMMap {
  readonly small: LLMModelConfig;
  readonly medium: LLMModelConfig;
  readonly large: LLMModelConfig;
  readonly embedding: LLMModelConfig;
}

const OLLAMA_SMALL: LLMModelConfig = {
  modelId: 'qwen2.5-coder:1.5b', provider: 'ollama', contextWindow: 32768,
};
const OLLAMA_MEDIUM: LLMModelConfig = {
  modelId: 'qwen2.5-coder:7b', provider: 'ollama', contextWindow: 32768,
};
const OLLAMA_LARGE: LLMModelConfig = {
  modelId: 'qwen2.5-coder:32b', provider: 'ollama', contextWindow: 32768, quantization: 'q4_K_M',
};
const OLLAMA_EMBEDDING: LLMModelConfig = {
  modelId: 'nomic-embed-text', provider: 'ollama', contextWindow: 8192,
};

const CLOUD_SMALL: LLMModelConfig = {
  modelId: 'claude-haiku-4-5-20251001', provider: 'anthropic', contextWindow: 200000,
};
const CLOUD_MEDIUM: LLMModelConfig = {
  modelId: 'claude-sonnet-4-6', provider: 'anthropic', contextWindow: 200000,
};
const CLOUD_LARGE: LLMModelConfig = {
  modelId: 'claude-opus-4-6', provider: 'anthropic', contextWindow: 200000,
};

const HARDWARE_LLM_MAP: Record<HardwareProfile, HardwareLLMMap> = {
  // Low-power — smallest local models only
  n100_like: { small: OLLAMA_SMALL, medium: OLLAMA_SMALL, large: OLLAMA_MEDIUM, embedding: OLLAMA_EMBEDDING },
  n305:      { small: OLLAMA_SMALL, medium: OLLAMA_MEDIUM, large: OLLAMA_MEDIUM, embedding: OLLAMA_EMBEDDING },
  celeron:   { small: OLLAMA_SMALL, medium: OLLAMA_SMALL, large: OLLAMA_MEDIUM, embedding: OLLAMA_EMBEDDING },

  // Standard Intel
  core_i3: { small: OLLAMA_SMALL, medium: OLLAMA_MEDIUM, large: OLLAMA_MEDIUM, embedding: OLLAMA_EMBEDDING },
  core_i5: { small: OLLAMA_SMALL, medium: OLLAMA_MEDIUM, large: OLLAMA_LARGE,  embedding: OLLAMA_EMBEDDING },
  core_i7: { small: OLLAMA_SMALL, medium: OLLAMA_MEDIUM, large: OLLAMA_LARGE,  embedding: OLLAMA_EMBEDDING },

  // AMD
  amd_low:  { small: OLLAMA_SMALL, medium: OLLAMA_MEDIUM, large: OLLAMA_MEDIUM, embedding: OLLAMA_EMBEDDING },
  amd_mid:  { small: OLLAMA_SMALL, medium: OLLAMA_MEDIUM, large: OLLAMA_LARGE,  embedding: OLLAMA_EMBEDDING },
  amd_high: { small: OLLAMA_SMALL, medium: OLLAMA_MEDIUM, large: OLLAMA_LARGE,  embedding: OLLAMA_EMBEDDING },

  // ARM
  arm64_rpi5:   { small: OLLAMA_SMALL, medium: OLLAMA_SMALL,  large: OLLAMA_MEDIUM, embedding: OLLAMA_EMBEDDING },
  arm64_server: { small: OLLAMA_SMALL, medium: OLLAMA_MEDIUM, large: OLLAMA_LARGE,  embedding: OLLAMA_EMBEDDING },
  arm64_rk3588: { small: OLLAMA_SMALL, medium: OLLAMA_MEDIUM, large: OLLAMA_MEDIUM, embedding: OLLAMA_EMBEDDING },

  // NVIDIA GPU — can run larger quantized models via GPU offload
  nvidia_small:  { small: OLLAMA_SMALL, medium: OLLAMA_MEDIUM, large: OLLAMA_LARGE, embedding: OLLAMA_EMBEDDING },
  nvidia_medium: { small: OLLAMA_SMALL, medium: OLLAMA_MEDIUM, large: OLLAMA_LARGE, embedding: OLLAMA_EMBEDDING },
  nvidia_large:  { small: OLLAMA_SMALL, medium: OLLAMA_LARGE,  large: OLLAMA_LARGE, embedding: OLLAMA_EMBEDDING },
  nvidia_rtx:    { small: OLLAMA_SMALL, medium: OLLAMA_LARGE,  large: OLLAMA_LARGE, embedding: OLLAMA_EMBEDDING },

  // Apple Silicon — unified memory benefits large models
  apple_silicon: { small: OLLAMA_SMALL, medium: OLLAMA_MEDIUM, large: OLLAMA_LARGE, embedding: OLLAMA_EMBEDDING },
};

export function getLLMConfig(profile: HardwareProfile): HardwareLLMMap {
  return HARDWARE_LLM_MAP[profile] ?? HARDWARE_LLM_MAP.core_i5;
}

export function getModelForTier(
  profile: HardwareProfile,
  tier: 'small' | 'medium' | 'large' | 'embedding',
): LLMModelConfig {
  const map = getLLMConfig(profile);
  return map[tier];
}

export function useCloudModels(): HardwareLLMMap {
  return { small: CLOUD_SMALL, medium: CLOUD_MEDIUM, large: CLOUD_LARGE, embedding: OLLAMA_EMBEDDING };
}
