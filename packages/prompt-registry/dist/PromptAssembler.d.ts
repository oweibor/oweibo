import type { PromptRegistry } from './PromptRegistry.js';
interface AssembledPrompt {
    text: string;
    /** SHA256 of the assembled text — stored as *_assembled_hash on the task row. */
    hash: string;
}
/**
 * PromptAssembler — loads a frame template, verifies its HMAC-SHA256 signature,
 * fetches slot text for every `{{slot:name}}` placeholder, and returns the
 * assembled prompt text with its content hash.
 *
 * Invariants:
 *   - Frame templates are HUMAN-AUTHORED and GEPA-IMMUTABLE (§2.6).
 *   - Signature verification is fail-loud: a tampered template throws.
 *   - GEPA mutates slot contents only, never frame structure.
 */
export declare class PromptAssembler {
    private readonly registry;
    constructor(registry: PromptRegistry);
    /**
     * Assemble a role's prompt from its per-slot hashes.
     * @param role           Agent role (architect | executor | reviewer | decomposer)
     * @param slotHashes     Map of slotId → prompt_hash (must contain all slots in the template)
     * @param templateVersion Frame template version to load (default: 'stable-v0')
     */
    assemble(role: string, slotHashes: Record<string, string>, templateVersion?: string): Promise<AssembledPrompt>;
    /**
     * Convenience: resolve all slot hashes for a role+channel, then assemble.
     * This is the hot path called by CohortRouter at task start.
     */
    assembleForChannel(role: string, channel: string, templateVersion?: string): Promise<AssembledPrompt & {
        slotHashes: Record<string, string>;
    }>;
    /**
     * Load the frame template from disk and verify its HMAC-SHA256 signature.
     * Throws loudly if the template file or signature is missing or invalid.
     * Invariant §2.6: failure here must never be silenced.
     */
    private loadAndVerifyFrame;
}
/**
 * Utility: sign a frame template file and return the HMAC hex.
 * Used by the frame-signing script (scripts/sign-frame-templates.ts).
 */
export declare function signFrameTemplate(templateText: string, signingKey: string): string;
export {};
//# sourceMappingURL=PromptAssembler.d.ts.map