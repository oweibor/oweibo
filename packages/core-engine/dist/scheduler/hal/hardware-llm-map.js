"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getLLMConfig = getLLMConfig;
exports.getModelForTier = getModelForTier;
exports.useCloudModels = useCloudModels;
const OLLAMA_SMALL = {
    modelId: 'qwen2.5-coder:1.5b', provider: 'ollama', contextWindow: 32768,
};
const OLLAMA_MEDIUM = {
    modelId: 'qwen2.5-coder:7b', provider: 'ollama', contextWindow: 32768,
};
const OLLAMA_LARGE = {
    modelId: 'qwen2.5-coder:32b', provider: 'ollama', contextWindow: 32768, quantization: 'q4_K_M',
};
const OLLAMA_EMBEDDING = {
    modelId: 'nomic-embed-text', provider: 'ollama', contextWindow: 8192,
};
const CLOUD_SMALL = {
    modelId: 'claude-haiku-4-5-20251001', provider: 'anthropic', contextWindow: 200000,
};
const CLOUD_MEDIUM = {
    modelId: 'claude-sonnet-4-6', provider: 'anthropic', contextWindow: 200000,
};
const CLOUD_LARGE = {
    modelId: 'claude-opus-4-6', provider: 'anthropic', contextWindow: 200000,
};
const HARDWARE_LLM_MAP = {
    // Low-power — smallest local models only
    n100_like: { small: OLLAMA_SMALL, medium: OLLAMA_SMALL, large: OLLAMA_MEDIUM, embedding: OLLAMA_EMBEDDING },
    n305: { small: OLLAMA_SMALL, medium: OLLAMA_MEDIUM, large: OLLAMA_MEDIUM, embedding: OLLAMA_EMBEDDING },
    celeron: { small: OLLAMA_SMALL, medium: OLLAMA_SMALL, large: OLLAMA_MEDIUM, embedding: OLLAMA_EMBEDDING },
    // Standard Intel
    core_i3: { small: OLLAMA_SMALL, medium: OLLAMA_MEDIUM, large: OLLAMA_MEDIUM, embedding: OLLAMA_EMBEDDING },
    core_i5: { small: OLLAMA_SMALL, medium: OLLAMA_MEDIUM, large: OLLAMA_LARGE, embedding: OLLAMA_EMBEDDING },
    core_i7: { small: OLLAMA_SMALL, medium: OLLAMA_MEDIUM, large: OLLAMA_LARGE, embedding: OLLAMA_EMBEDDING },
    // AMD
    amd_low: { small: OLLAMA_SMALL, medium: OLLAMA_MEDIUM, large: OLLAMA_MEDIUM, embedding: OLLAMA_EMBEDDING },
    amd_mid: { small: OLLAMA_SMALL, medium: OLLAMA_MEDIUM, large: OLLAMA_LARGE, embedding: OLLAMA_EMBEDDING },
    amd_high: { small: OLLAMA_SMALL, medium: OLLAMA_MEDIUM, large: OLLAMA_LARGE, embedding: OLLAMA_EMBEDDING },
    // ARM
    arm64_rpi5: { small: OLLAMA_SMALL, medium: OLLAMA_SMALL, large: OLLAMA_MEDIUM, embedding: OLLAMA_EMBEDDING },
    arm64_server: { small: OLLAMA_SMALL, medium: OLLAMA_MEDIUM, large: OLLAMA_LARGE, embedding: OLLAMA_EMBEDDING },
    arm64_rk3588: { small: OLLAMA_SMALL, medium: OLLAMA_MEDIUM, large: OLLAMA_MEDIUM, embedding: OLLAMA_EMBEDDING },
    // NVIDIA GPU — can run larger quantized models via GPU offload
    nvidia_small: { small: OLLAMA_SMALL, medium: OLLAMA_MEDIUM, large: OLLAMA_LARGE, embedding: OLLAMA_EMBEDDING },
    nvidia_medium: { small: OLLAMA_SMALL, medium: OLLAMA_MEDIUM, large: OLLAMA_LARGE, embedding: OLLAMA_EMBEDDING },
    nvidia_large: { small: OLLAMA_SMALL, medium: OLLAMA_LARGE, large: OLLAMA_LARGE, embedding: OLLAMA_EMBEDDING },
    nvidia_rtx: { small: OLLAMA_SMALL, medium: OLLAMA_LARGE, large: OLLAMA_LARGE, embedding: OLLAMA_EMBEDDING },
    // Apple Silicon — unified memory benefits large models
    apple_silicon: { small: OLLAMA_SMALL, medium: OLLAMA_MEDIUM, large: OLLAMA_LARGE, embedding: OLLAMA_EMBEDDING },
};
function getLLMConfig(profile) {
    return HARDWARE_LLM_MAP[profile] ?? HARDWARE_LLM_MAP.core_i5;
}
function getModelForTier(profile, tier) {
    const map = getLLMConfig(profile);
    return map[tier];
}
function useCloudModels() {
    return { small: CLOUD_SMALL, medium: CLOUD_MEDIUM, large: CLOUD_LARGE, embedding: OLLAMA_EMBEDDING };
}
//# sourceMappingURL=hardware-llm-map.js.map