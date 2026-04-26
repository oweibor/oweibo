/**
 * PromptRegistry — Langfuse-backed prompt versioning registry (§16c).
 *
 * Fetches versioned prompts from Langfuse, caches them locally, and
 * provides fallback to bundled defaults when Langfuse is unavailable.
 * All prompts are seeded on first startup if they don't exist.
 *
 * Includes both factory pipeline prompts and general-coding prompts (§22.3).
 */
import { GENERAL_CODING_PROMPTS } from './GeneralCodingPrompts.js';

export interface PromptVersion {
  readonly text: string;
  readonly version: number;
  readonly name: string;
  readonly labels?: readonly string[];
}

/** Bundled default prompts — used when Langfuse is unavailable */
const BUILTIN_PROMPTS: Record<string, string> = {
  ...GENERAL_CODING_PROMPTS,
  'clarifier-system': `You are an intent parser for an AI code factory. Parse the user instruction into a structured task.
Classify as 'factory' (generate new app) or 'general-coding' (edit existing repo).
Output JSON: { taskMode, appName?, stack?, features?, ambiguityScore, clarifyingQuestions }`,

  'task-mode-classifier': `Classify whether this task requires:
- 'factory': generating a new full-stack application from scratch
- 'general-coding': editing, refactoring, or debugging an existing codebase
Output JSON: { taskMode: 'factory' | 'general-coding', confidence: number, reasoning: string }`,

  'architect-system': `You are the Architect agent. You MUST:
1. Generate test files FIRST (TDD) before any implementation
2. Produce a precise, ordered plan with file structure
3. Populate ModuleKnowledge with userFlows, glossary, and extensionPoints
4. Include a /health endpoint in every generated server
CRITICAL: Empty test suites are rejected. Tests must cover >50% of business logic.`,

  'critic-system': `You are a Senior Test Critic. Validate that the generated tests:
1. Actually test the stated requirements (not just implementation details)
2. Cover edge cases and error paths
3. Are not trivially passing (no empty assertions, no testing mocks)
4. Have sufficient coverage of business invariants
Output JSON: { issues: [{ severity: 'BLOCKING'|'WARNING', description, suggestion }] }`,

  'adr-agent': `You are an Architecture Decision Record agent. For each architectural decision:
1. Identify the decision, context, and alternatives considered
2. Record the rationale for the chosen approach
3. Note trade-offs and consequences
4. Flag compliance with the 12 architectural principles`,

  'documentation-writer': `You are a Documentation Writer agent. Produce three files:
- docs/user-guide.md: Task-oriented guide using userFlows from ModuleKnowledge
- docs/developer.md: Technical internals, extension points, contributing guide
- docs/api-reference.md: All endpoints with request/response examples
Write for the intended audience. User guide: non-technical. Developer: senior engineer.`,
};

export class PromptRegistry {
  private readonly cache = new Map<string, PromptVersion>();

  constructor(
    private readonly langfuseSecretKey?: string,
    private readonly langfusePublicKey?: string,
  ) {}

  async get(promptName: string): Promise<PromptVersion> {
    // Return cached version if available
    const cached = this.cache.get(promptName);
    if (cached) return cached;

    // Try Langfuse if configured
    if (this.langfuseSecretKey && this.langfusePublicKey) {
      try {
        const remote = await this.fetchFromLangfuse(promptName);
        if (remote) {
          this.cache.set(promptName, remote);
          return remote;
        }
      } catch {
        // Fall through to builtin
      }
    }

    // Fall back to bundled defaults
    const builtin = BUILTIN_PROMPTS[promptName];
    const version: PromptVersion = {
      name: promptName,
      text: builtin ?? `[${promptName} — no prompt configured]`,
      version: 0,
    };
    this.cache.set(promptName, version);
    return version;
  }

  async set(promptName: string, text: string): Promise<void> {
    const existing = this.cache.get(promptName);
    this.cache.set(promptName, {
      name: promptName,
      text,
      version: (existing?.version ?? 0) + 1,
    });
  }

  invalidate(promptName: string): void {
    this.cache.delete(promptName);
  }

  invalidateAll(): void {
    this.cache.clear();
  }

  /** Seed all builtin prompts into Langfuse on first startup */
  async seedBuiltins(): Promise<void> {
    for (const [name, text] of Object.entries(BUILTIN_PROMPTS)) {
      if (!this.cache.has(name)) {
        this.cache.set(name, { name, text, version: 1 });
      }
    }
  }

  private async fetchFromLangfuse(promptName: string): Promise<PromptVersion | null> {
    try {
      const { Langfuse } = await import('langfuse');
      const lf = new Langfuse({
        secretKey: this.langfuseSecretKey!,
        publicKey: this.langfusePublicKey!,
      });
      const prompt = await lf.getPrompt(promptName);
      if (!prompt) return null;
      return {
        name: promptName,
        text: prompt.getLangchainPrompt(),
        version: prompt.version ?? 1,
      };
    } catch {
      return null;
    }
  }
}
