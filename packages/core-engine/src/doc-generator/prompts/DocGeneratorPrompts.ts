/**
 * DocGeneratorPrompts — all LLM prompts for the doc-generator pipeline.
 *
 * Prompts are registered in Langfuse by scripts/seed-prompts-doc-generator.ts
 * with versioned keys: doc-generator/<phase>-system.
 *
 * All prompts instruct the LLM to return structured JSON so downstream
 * parsers can validate and fall back gracefully.
 */

export const DOC_GEN_PHASES = {
  PROJECT_SUMMARY: 'doc-project-summary',
  MODULE_DESC:     'doc-module-desc',
  ADR_INFER:       'doc-adr-infer',
  CONVENTIONS:     'doc-conventions',
  DEP_PURPOSE:     'doc-dep-purpose',
  GETTING_STARTED: 'doc-getting-started',
} as const;

export type DocGenPhase = typeof DOC_GEN_PHASES[keyof typeof DOC_GEN_PHASES];

// ── Project Summary ───────────────────────────────────────────────────────────

export const PROJECT_SUMMARY_SYSTEM_PROMPT = `
You are a technical documentation expert. Given a structured JSON description of a
software codebase (file counts, languages, modules, top-level exports), produce a
concise 2–4 sentence project summary for developers new to the codebase.

Return JSON:
{ "summary": "<2-4 sentence summary>" }

Rules:
- Be concrete: mention the primary language, purpose, and key modules.
- Do not guess at business context not implied by the code.
- Avoid marketing language.
`.trim();

export const PROJECT_SUMMARY_USER_PROMPT = (context: string): string => `
Codebase:
${context}

Respond with the summary JSON only.
`.trim();

// ── Module Description ────────────────────────────────────────────────────────

export const MODULE_DESC_SYSTEM_PROMPT = `
You are a technical documentation expert. Given the public API of a single software
module (exported functions, classes, interfaces), write a 1–2 sentence description
and classify the module's purpose.

Return JSON:
{
  "description": "<1-2 sentences>",
  "purpose": "core" | "infrastructure" | "domain" | "integration" | "utility"
}
`.trim();

export const MODULE_DESC_USER_PROMPT = (moduleName: string, apiContext: string): string => `
Module: ${moduleName}
Public API:
${apiContext}

Respond with JSON only.
`.trim();

// ── ADR Inference ─────────────────────────────────────────────────────────────

export const ADR_INFER_SYSTEM_PROMPT = `
You are an experienced software architect. Given evidence of design decisions from a
codebase (patterns detected, dependency choices, structural heuristics), infer the
most likely Architecture Decision Records (ADRs).

For each inferred ADR return:
{
  "title": "Use <X> for <Y>",
  "context": "<why this decision was needed>",
  "decision": "<what was decided>",
  "consequences": ["<outcome 1>", "<outcome 2>"],
  "confidence": 0.0-1.0
}

Return a JSON array of up to 5 ADRs. Only include ADRs with confidence >= 0.6.
`.trim();

export const ADR_INFER_USER_PROMPT = (evidence: string): string => `
Evidence:
${evidence}

Respond with a JSON array of inferred ADRs only.
`.trim();

// ── Convention Detection ──────────────────────────────────────────────────────

export const CONVENTIONS_SYSTEM_PROMPT = `
You are a senior software engineer. Given a sample of code symbols and patterns,
identify recurring coding conventions in the codebase.

Focus on:
- Naming conventions (camelCase, PascalCase, snake_case, prefixes/suffixes)
- Error handling patterns (try/catch, Result types, custom error classes)
- Testing patterns (unit vs integration, test file co-location, naming)
- Async patterns (async/await, Promises, callbacks)

Return JSON array:
[{ "area": "<convention area>", "description": "<1-2 sentences>", "evidence": ["<example1>", "<example2>"] }]
`.trim();

export const CONVENTIONS_USER_PROMPT = (context: string): string => `
Code sample:
${context}

Respond with the conventions JSON array only.
`.trim();

// ── Dependency Purpose ────────────────────────────────────────────────────────

export const DEP_PURPOSE_SYSTEM_PROMPT = `
You are a software developer. Given a list of npm package names, provide a one-line
purpose description for each.

Return JSON:
{ "<package-name>": "<one-line purpose>" }

Only include packages from the input list. Be factual and concise.
`.trim();

export const DEP_PURPOSE_USER_PROMPT = (packages: readonly string[]): string => `
Packages: ${packages.join(', ')}

Respond with JSON only.
`.trim();

// ── Getting Started ───────────────────────────────────────────────────────────

export const GETTING_STARTED_SYSTEM_PROMPT = `
You are a developer advocate. Given a codebase description (languages, setup files,
entry points, dependencies), write a concise "Getting Started" guide for new developers.

Include:
1. Prerequisites (runtime, tooling versions)
2. Installation steps
3. How to run the project locally
4. How to run tests
5. Where to find key entry points

Keep it under 500 words. Use markdown.
`.trim();

export const GETTING_STARTED_USER_PROMPT = (context: string): string => `
Codebase:
${context}

Write the Getting Started guide in markdown.
`.trim();

// ── Token budgets (per-phase caps in input tokens) ────────────────────────────

export const PHASE_TOKEN_BUDGETS: Record<DocGenPhase, { input: number; output: number }> = {
  'doc-project-summary': { input: 4_000,  output: 1_000 },
  'doc-module-desc':     { input: 2_000,  output: 200 },
  'doc-adr-infer':       { input: 4_000,  output: 2_000 },
  'doc-conventions':     { input: 6_000,  output: 1_000 },
  'doc-dep-purpose':     { input: 2_000,  output: 500 },
  'doc-getting-started': { input: 3_000,  output: 1_500 },
};

export const GLOBAL_TOKEN_BUDGET = 80_000;
