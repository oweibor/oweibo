"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PromptAssembler = void 0;
exports.signFrameTemplate = signFrameTemplate;
// DONE: Phase A.3 — frame-template assembly with HMAC-SHA256 signature verification
const crypto_1 = require("crypto");
const fs_1 = require("fs");
const path_1 = require("path");
const SLOT_PATTERN = /\{\{slot:([a-z_]+)\}\}/g;
const TEMPLATES_DIR = (0, path_1.join)(__dirname, '..', 'templates');
const SIGS_DIR = (0, path_1.join)(TEMPLATES_DIR, 'sigs');
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
class PromptAssembler {
    registry;
    constructor(registry) {
        this.registry = registry;
    }
    /**
     * Assemble a role's prompt from its per-slot hashes.
     * @param role           Agent role (architect | executor | reviewer | decomposer)
     * @param slotHashes     Map of slotId → prompt_hash (must contain all slots in the template)
     * @param templateVersion Frame template version to load (default: 'stable-v0')
     */
    async assemble(role, slotHashes, templateVersion = 'stable-v0') {
        const frameText = this.loadAndVerifyFrame(role, templateVersion);
        // Collect all slot ids referenced in the frame
        const slotIds = [...frameText.matchAll(SLOT_PATTERN)].map(m => m[1]);
        // Fetch text for each slot hash
        const slotTexts = {};
        await Promise.all(slotIds.map(async (slotId) => {
            const hash = slotHashes[slotId];
            if (!hash)
                throw new Error(`[PromptAssembler] no hash supplied for slot "${slotId}" in role "${role}"`);
            const version = await this.registry.get(hash);
            slotTexts[slotId] = version.text;
        }));
        // Interpolate
        const assembled = frameText.replace(SLOT_PATTERN, (_, slotId) => slotTexts[slotId] ?? '');
        const assembledHash = (0, crypto_1.createHash)('sha256').update(assembled).digest('hex');
        return { text: assembled, hash: assembledHash };
    }
    /**
     * Convenience: resolve all slot hashes for a role+channel, then assemble.
     * This is the hot path called by CohortRouter at task start.
     */
    async assembleForChannel(role, channel, templateVersion = 'stable-v0') {
        const slots = await this.registry.listSlots(channel, role);
        const slotHashes = {};
        for (const slot of slots) {
            slotHashes[slot.slotId] = slot.promptHash;
        }
        const assembled = await this.assemble(role, slotHashes, templateVersion);
        return { ...assembled, slotHashes };
    }
    /**
     * Load the frame template from disk and verify its HMAC-SHA256 signature.
     * Throws loudly if the template file or signature is missing or invalid.
     * Invariant §2.6: failure here must never be silenced.
     */
    loadAndVerifyFrame(role, templateVersion) {
        const signingKey = process.env['FRAME_SIGNING_KEY'];
        if (!signingKey)
            throw new Error('[PromptAssembler] FRAME_SIGNING_KEY env var is not set — cannot verify frame template');
        const templateFile = `${role}.${templateVersion}.tpl`;
        const sigFile = `${templateFile}.sig`;
        let frameText;
        let expectedSigHex;
        try {
            frameText = (0, fs_1.readFileSync)((0, path_1.join)(TEMPLATES_DIR, templateFile), 'utf-8');
            expectedSigHex = (0, fs_1.readFileSync)((0, path_1.join)(SIGS_DIR, sigFile), 'utf-8').trim();
        }
        catch (err) {
            throw new Error(`[PromptAssembler] failed to load frame template "${templateFile}": ${String(err)}`);
        }
        const actualSig = (0, crypto_1.createHmac)('sha256', signingKey).update(frameText).digest();
        const expectedSig = Buffer.from(expectedSigHex, 'hex');
        if (actualSig.length !== expectedSig.length || !(0, crypto_1.timingSafeEqual)(actualSig, expectedSig)) {
            throw new Error(`[PromptAssembler] frame template signature mismatch for "${templateFile}" — ` +
                'template may have been tampered with');
        }
        return frameText;
    }
}
exports.PromptAssembler = PromptAssembler;
/**
 * Utility: sign a frame template file and return the HMAC hex.
 * Used by the frame-signing script (scripts/sign-frame-templates.ts).
 */
function signFrameTemplate(templateText, signingKey) {
    return (0, crypto_1.createHmac)('sha256', signingKey).update(templateText).digest('hex');
}
//# sourceMappingURL=PromptAssembler.js.map