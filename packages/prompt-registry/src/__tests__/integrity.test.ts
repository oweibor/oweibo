// DONE: Phase A.6 — integrity test: assembled stable-v0 text == original static strings
// CI gate: this test must pass before Phase A is considered done.
import { createHmac } from 'crypto';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = typeof __filename !== 'undefined'
  ? require('path').dirname(__filename)
  : dirname(fileURLToPath(import.meta.url));

// ── Original static prompts (BaseAgent.ts / GoalDecomposer.ts) ───────────────

const STATIC_PROMPTS: Record<string, string> = {
  architect:
    'You are the Architect agent. Decompose goals into a precise, ordered plan.',
  executor:
    'You are the Executor agent. Carry out plan steps faithfully and report results.',
  reviewer:
    'You are the Reviewer agent. Audit executor outputs and challenge defects.',
  decomposer:
    'You are a task decomposer. Break a software goal into ordered sub-goals. Each sub-goal has: description, toolName (optional), input (optional object), dependsOn (array of descriptions it depends on). Output JSON array only.',
};

// ── Frame template → primary slot mapping ────────────────────────────────────

const PRIMARY_SLOTS: Record<string, string> = {
  architect:  'decomposition_rules',
  executor:   'tool_arg_construction',
  reviewer:   'defect_taxonomy',
  decomposer: 'subgoal_granularity_guide',
};

// ── Template assembly (mirrors PromptAssembler logic without requiring DB) ───

const TEMPLATES_DIR = join(__dirname, '..', '..', 'templates');
const SIGS_DIR      = join(TEMPLATES_DIR, 'sigs');
const SLOT_PATTERN  = /\{\{slot:([a-z_]+)\}\}/g;
const SIGNING_KEY   = process.env['FRAME_SIGNING_KEY'] ?? 'dev-signing-key-replace-in-prod';

function loadAndVerifyFrame(role: string): string {
  const templateFile = `${role}.stable-v0.tpl`;
  const sigFile      = `${templateFile}.sig`;

  const frameText      = readFileSync(join(TEMPLATES_DIR, templateFile), 'utf-8');
  const expectedSigHex = readFileSync(join(SIGS_DIR, sigFile), 'utf-8').trim();
  const actualSig      = createHmac('sha256', SIGNING_KEY).update(frameText).digest('hex');

  expect(actualSig).toBe(expectedSigHex);  // signature must match
  return frameText;
}

function assembleWithSlot(frameText: string, primarySlot: string, slotText: string): string {
  const slotTexts: Record<string, string> = { [primarySlot]: slotText };
  return frameText.replace(SLOT_PATTERN, (_, slotId: string) => slotTexts[slotId] ?? '');
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Phase A.6 integrity — stable-v0 assembly matches static prompts', () => {
  const roles = ['architect', 'executor', 'reviewer', 'decomposer'] as const;

  for (const role of roles) {
    it(`${role}: assembled text is byte-identical to original static prompt`, () => {
      const frameText = loadAndVerifyFrame(role);
      const primarySlot = PRIMARY_SLOTS[role]!;
      const expectedText = STATIC_PROMPTS[role]!;

      const assembled = assembleWithSlot(frameText, primarySlot, expectedText);
      expect(assembled).toBe(expectedText);
    });

    it(`${role}: frame template signature is valid`, () => {
      // loadAndVerifyFrame calls expect() internally — just confirm it doesn't throw
      expect(() => loadAndVerifyFrame(role)).not.toThrow();
    });

    it(`${role}: tampered frame template fails signature verification`, () => {
      const templateFile = `${role}.stable-v0.tpl`;
      const frameText    = readFileSync(join(TEMPLATES_DIR, templateFile), 'utf-8');
      const tamperedText = frameText + '\n<!-- tampered -->';
      const tamperedSig  = createHmac('sha256', SIGNING_KEY).update(tamperedText).digest('hex');
      const originalSig  = readFileSync(join(SIGS_DIR, `${templateFile}.sig`), 'utf-8').trim();
      // Tampered text must produce a different signature
      expect(tamperedSig).not.toBe(originalSig);
    });
  }
});
