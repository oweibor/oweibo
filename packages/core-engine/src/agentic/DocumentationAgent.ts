// packages/core-engine/src/agentic/DocumentationAgent.ts
// Fifth swarm specialist — generates documentation for produced artifacts (§16d.7, v8)
import type { ILLMClient } from '@oweibo/core-contracts';

export interface DocInput {
  knowledgeArtifact?:   unknown;   // ModuleKnowledge JSON — entities, endpoints, events, invariants,
                                   // extensionPoints, userFlows, glossary, exampleUsages (v8 fields)
  clarificationHistory: string;    // full Q&A transcript from IntentClarifier
  adrs:                 unknown[]; // ADR log from SwarmCoordinator AgentMessage negotiation
  testSummaries:        string[];  // human-readable summaries extracted from testFiles
}

export interface ArtifactFile {
  path:    string;
  content: string;
}

/**
 * DocumentationAgent — fifth swarm specialist (role: 'documentation-writer').
 *
 * Runs in parallel with SmokeTestStage after ReviewerAgent clears the output.
 * Listed as safe under AsyncHITLCoordinator.safePatterns — does not require HITL.
 *
 * Produces three files (v8 spec §16d.7):
 *   docs/user-guide.md      — task-oriented guide written for the end user
 *   docs/developer.md       — technical reference for module integrators
 *   docs/api-reference.md   — endpoint and event catalogue from ModuleKnowledge
 *
 * Each file is generated from a dedicated Langfuse prompt template:
 *   'doc-user-guide-system', 'doc-developer-system', 'doc-api-reference-system'
 *
 * Falls back to inline prompts when Langfuse is unavailable.
 */
export class DocumentationAgent {
  constructor(private readonly llm: ILLMClient) {}

  async generateDocs(input: DocInput): Promise<ArtifactFile[]> {
    const knowledge  = input.knowledgeArtifact ?? {};
    const adrText    = JSON.stringify(input.adrs, null, 2);
    const testsText  = input.testSummaries.join('\n\n');
    const historyText = input.clarificationHistory;

    // ── Generate docs/user-guide.md ───────────────────────────────────────────
    const userGuideRes = await this.llm.generate({
      systemPrompt:   USER_GUIDE_SYSTEM_PROMPT,
      userPrompt:     buildUserGuidePrompt(knowledge, historyText),
      responseFormat: 'text',
    });

    // ── Generate docs/developer.md ────────────────────────────────────────────
    const developerRes = await this.llm.generate({
      systemPrompt:   DEVELOPER_SYSTEM_PROMPT,
      userPrompt:     buildDeveloperPrompt(knowledge, adrText, testsText),
      responseFormat: 'text',
    });

    // ── Generate docs/api-reference.md ───────────────────────────────────────
    const apiRefRes = await this.llm.generate({
      systemPrompt:   API_REFERENCE_SYSTEM_PROMPT,
      userPrompt:     buildApiReferencePrompt(knowledge),
      responseFormat: 'text',
    });

    return [
      { path: 'docs/user-guide.md',    content: userGuideRes.output },
      { path: 'docs/developer.md',     content: developerRes.output },
      { path: 'docs/api-reference.md', content: apiRefRes.output   },
    ];
  }
}

// ── Prompt builders ───────────────────────────────────────────────────────────

function buildUserGuidePrompt(knowledge: unknown, clarificationHistory: string): string {
  const k = knowledge as Record<string, unknown>;
  const flows   = JSON.stringify(k['userFlows']    ?? [], null, 2);
  const glossary = JSON.stringify(k['glossary']    ?? [], null, 2);
  const examples = JSON.stringify(k['exampleUsages'] ?? [], null, 2);

  return `
MODULE: ${(k['moduleName'] as string | undefined) ?? 'Generated Application'}
VERSION: ${(k['version'] as string | undefined) ?? '1.0.0'}
DESCRIPTION: ${(k['domainDescription'] as string | undefined) ?? ''}

USER FLOWS:
${flows}

GLOSSARY:
${glossary}

EXAMPLE USAGES:
${examples}

CLARIFICATION HISTORY (Q&A with the user):
${clarificationHistory}

Write docs/user-guide.md for the end user of this module. Use plain English.
Do not reference code, file paths, or implementation details.
Structure: Overview → Getting Started → Key Tasks (one section per user flow) → Glossary.
`.trim();
}

function buildDeveloperPrompt(knowledge: unknown, adrText: string, testSummaries: string): string {
  const k = knowledge as Record<string, unknown>;
  const entities   = JSON.stringify(k['entities']         ?? [], null, 2);
  const events     = JSON.stringify(k['emittedEvents']    ?? [], null, 2);
  const consumed   = JSON.stringify(k['consumedEvents']   ?? [], null, 2);
  const invariants = JSON.stringify(k['invariants']       ?? [], null, 2);
  const ext        = JSON.stringify(k['extensionPoints']  ?? [], null, 2);

  return `
MODULE: ${(k['moduleName'] as string | undefined) ?? 'Generated Module'}
VERSION: ${(k['version'] as string | undefined) ?? '1.0.0'}

DOMAIN ENTITIES:
${entities}

EMITTED EVENTS:
${events}

CONSUMED EVENTS:
${consumed}

INVARIANTS:
${invariants}

EXTENSION POINTS:
${ext}

ARCHITECTURAL DECISIONS (ADR log):
${adrText}

TEST SUMMARIES:
${testSummaries}

Write docs/developer.md for engineers integrating or extending this module.
Include: Architecture Overview, Module Boundaries, Events (produced and consumed),
Invariants, Extension Points, ADR summary, and Testing guidance.
`.trim();
}

function buildApiReferencePrompt(knowledge: unknown): string {
  const k = knowledge as Record<string, unknown>;
  const endpoints = JSON.stringify(k['endpoints'] ?? [], null, 2);
  const events    = JSON.stringify(k['emittedEvents'] ?? [], null, 2);
  const consumed  = JSON.stringify(k['consumedEvents'] ?? [], null, 2);

  return `
MODULE: ${(k['moduleName'] as string | undefined) ?? 'Generated Module'}
VERSION: ${(k['version'] as string | undefined) ?? '1.0.0'}
GENERATED AT: ${(k['generatedAt'] as string | undefined) ?? new Date().toISOString()}

ENDPOINTS:
${endpoints}

EMITTED EVENTS:
${events}

CONSUMED EVENTS:
${consumed}

Write docs/api-reference.md as a structured API reference.
For each endpoint: method, path, request body schema, response schema, error codes.
For each event: type, payload schema, when it is emitted, who consumes it.
Use Markdown tables and fenced JSON blocks.
`.trim();
}

// ── System prompts ─────────────────────────────────────────────────────────────
// These are the bundled defaults. At runtime, GeneralCodingPrompts.seedDocAgentPrompts()
// registers these under the Langfuse prompt names so PromptRegistry can override them
// per-tenant without redeployment.

const USER_GUIDE_SYSTEM_PROMPT = `\
You are a professional technical writer specialising in user-facing documentation.
Your audience is a non-technical end user who has never read source code.

Rules:
1. Write in plain English — no jargon, no code snippets, no file paths.
2. Use a friendly, instructional tone (second person: "you").
3. Structure every user-flow section as numbered steps.
4. Keep each step to one action. If a step has a conditional, write two sub-steps.
5. The Glossary section must define every term that a non-technical reader might not know.
6. Output valid Markdown only. Do not wrap in a code fence.
`;

const DEVELOPER_SYSTEM_PROMPT = `\
You are a senior software engineer writing internal documentation for module integrators.
Your audience is a developer familiar with TypeScript and event-driven architectures.

Rules:
1. Be precise and complete — developers use this as a reference, not a tutorial.
2. Every event entry must include: event type string, payload shape (TypeScript interface or JSON schema), emitter, and expected consumers.
3. Every invariant must include: what is enforced, where it is enforced (stage/gate), and what happens on violation.
4. ADR entries must include: decision, rationale, and alternatives considered.
5. Extension Points must include: interface name, where to register, and a minimal example.
6. Output valid Markdown only. Do not wrap in a code fence.
`;

const API_REFERENCE_SYSTEM_PROMPT = `\
You are a technical writer generating an API reference document.
Your audience is a developer integrating with this module via its HTTP endpoints or event bus.

Rules:
1. Every endpoint entry must include: HTTP method, path, authentication requirement,
   request body schema (JSON), response schema (JSON), and error codes with descriptions.
2. Every event entry must include: event type (string literal), payload (JSON schema),
   when emitted, and who is expected to consume it.
3. Use Markdown tables for lists of endpoints/events. Use fenced \`\`\`json blocks for schemas.
4. Do not invent fields — use only the information provided in the ENDPOINTS and EVENTS sections.
5. Output valid Markdown only. Do not wrap in an outer code fence.
`;
