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
export declare function getLLMConfig(profile: HardwareProfile): HardwareLLMMap;
export declare function getModelForTier(profile: HardwareProfile, tier: 'small' | 'medium' | 'large' | 'embedding'): LLMModelConfig;
export declare function useCloudModels(): HardwareLLMMap;
//# sourceMappingURL=hardware-llm-map.d.ts.map