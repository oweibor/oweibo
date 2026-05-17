// DONE: Phase A.3 — frame-template assembly with HMAC-SHA256 signature verification
import { createHash, createHmac, timingSafeEqual } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import type { PromptRegistry } from './PromptRegistry.js';

const SLOT_PATTERN = /\{\{slot:([a-z_]+)\}\}/g;
const TEMPLATES_DIR = join(__dirname, '..', 'templates');
const SIGS_DIR      = join(TEMPLATES_DIR, 'sigs');

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
export class PromptAssembler {
  constructor(private readonly registry: PromptRegistry) {}

  /**
   * Assemble a role's prompt from its per-slot hashes.
   * @param role           Agent role (architect | executor | reviewer | decomposer)
   * @param slotHashes     Map of slotId → prompt_hash (must contain all slots in the template)
   * @param templateVersion Frame template version to load (default: 'stable-v0')
   */
  async assemble(
    role:            string,
    slotHashes:      Record<string, string>,
    templateVersion = 'stable-v0',
  ): Promise<AssembledPrompt> {
    const frameText = this.loadAndVerifyFrame(role, templateVersion);

    // Collect all slot ids referenced in the frame
    const slotIds = [...frameText.matchAll(SLOT_PATTERN)].map(m => m[1]!);

    // Fetch text for each slot hash
    const slotTexts: Record<string, string> = {};
    await Promise.all(slotIds.map(async (slotId) => {
      const hash = slotHashes[slotId];
      if (!hash) throw new Error(
        `[PromptAssembler] no hash supplied for slot "${slotId}" in role "${role}"`,
      );
      const version = await this.registry.get(hash);
      slotTexts[slotId] = version.text;
    }));

    // Interpolate
    const assembled = frameText.replace(SLOT_PATTERN, (_, slotId: string) => slotTexts[slotId] ?? '');
    const assembledHash = createHash('sha256').update(assembled).digest('hex');

    return { text: assembled, hash: assembledHash };
  }

  /**
   * Convenience: resolve all slot hashes for a role+channel, then assemble.
   * This is the hot path called by CohortRouter at task start.
   */
  async assembleForChannel(
    role:            string,
    channel:         string,
    templateVersion = 'stable-v0',
  ): Promise<AssembledPrompt & { slotHashes: Record<string, string> }> {
    const slots = await this.registry.listSlots(channel, role);
    const slotHashes: Record<string, string> = {};
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
  private loadAndVerifyFrame(role: string, templateVersion: string): string {
    const signingKey = process.env['FRAME_SIGNING_KEY'];
    if (!signingKey) throw new Error(
      '[PromptAssembler] FRAME_SIGNING_KEY env var is not set — cannot verify frame template',
    );

    const templateFile = `${role}.${templateVersion}.tpl`;
    const sigFile      = `${templateFile}.sig`;

    let frameText: string;
    let expectedSigHex: string;
    try {
      frameText      = readFileSync(join(TEMPLATES_DIR, templateFile), 'utf-8');
      expectedSigHex = readFileSync(join(SIGS_DIR, sigFile), 'utf-8').trim();
    } catch (err) {
      throw new Error(
        `[PromptAssembler] failed to load frame template "${templateFile}": ${String(err)}`,
      );
    }

    const actualSig   = createHmac('sha256', signingKey).update(frameText).digest();
    const expectedSig = Buffer.from(expectedSigHex, 'hex');

    if (actualSig.length !== expectedSig.length || !timingSafeEqual(actualSig, expectedSig)) {
      throw new Error(
        `[PromptAssembler] frame template signature mismatch for "${templateFile}" — ` +
        'template may have been tampered with',
      );
    }

    return frameText;
  }
}

/**
 * Utility: sign a frame template file and return the HMAC hex.
 * Used by the frame-signing script (scripts/sign-frame-templates.ts).
 */
export function signFrameTemplate(templateText: string, signingKey: string): string {
  return createHmac('sha256', signingKey).update(templateText).digest('hex');
}
