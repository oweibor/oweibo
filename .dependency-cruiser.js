/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'module-cannot-import-core-engine',
      severity: 'error',
      comment: 'Factory modules depend only on core-contracts — never on core-engine internals.',
      from: { path: '^packages/module-', pathNot: '/__tests__/' },
      to:   { path: '^packages/core-engine' },
    },
    {
      name: 'module-cannot-import-other-module',
      severity: 'error',
      comment: 'Modules are boundary-isolated. All inter-module comms via typed events on DomainEventBus. ' +
               'Test files are exempt (they import from their own module, not cross-module).',
      // Exempt __tests__ dirs: a test file imports its own module — not a cross-module import.
      from: { path: '^packages/module-', pathNot: '/__tests__/' },
      to:   { path: '^packages/module-' },
    },
    {
      name: 'core-engine-cannot-import-modules',
      severity: 'error',
      comment: 'Factory Core Independence (Principle #1) — core-engine never depends on modules.',
      from: { path: '^packages/core-engine' },
      to:   { path: '^packages/module-' },
    },
    {
      name: 'core-contracts-cannot-import-core-engine',
      severity: 'error',
      comment: 'core-contracts is the zero-dependency contract layer.',
      from: { path: '^packages/core-contracts' },
      to:   { path: '^packages/core-engine' },
    },
    {
      name: 'event-types-must-come-from-contracts',
      severity: 'error',
      comment: 'Event types are defined in core-contracts/src/events/ — modules must import from there.',
      from: { path: '^packages/module-' },
      to:   { path: '^packages/module-.*/events' },
    },
    {
      // v9.3: channel-gateway boundary rules
      name: 'channel-gateway-cannot-import-core-engine-internals',
      severity: 'error',
      comment: 'channel-gateway may only consume the three public ingestion interfaces.',
      from: { path: '^packages/channel-gateway' },
      to: {
        path: '^packages/core-engine/src/(?!ingestion/(IntentPipeline|TaskEventBus|TaskInterventionGateway))',
      },
    },
    {
      name: 'core-engine-cannot-import-channel-gateway',
      severity: 'error',
      comment: 'core-engine has no knowledge of channel-gateway. Delivery routing is strictly one-way.',
      from: { path: '^packages/core-engine' },
      to:   { path: '^packages/channel-gateway' },
    },
    {
      // v9.4: skills ↔ plugins orthogonality boundary
      name: 'skill-registry-cannot-import-plugin-registry',
      severity: 'error',
      comment: 'Skills and Plugins are orthogonal extension axes.',
      from: { path: '^packages/core-engine/src/general-coding/project/SkillRegistry' },
      to:   { path: '^packages/core-engine/src/registry/PluginRegistry' },
    },
    {
      // v9.5: SynthesisAgent isolation — may only import GeneralCodingAgent, ConversationalLoop types, and VerificationRunner
      name: 'no-synthesizer-factory-import',
      severity: 'error',
      comment: 'SynthesisAgent may only import GeneralCodingAgent, ConversationalLoop types, and VerificationRunner. ' +
               'It must not import SwarmCoordinator, PipelineOrchestrator, or any factory module. ' +
               'This rule prevents synthesis logic from acquiring factory-pipeline side-effects.',
      from: { path: '^packages/core-engine/src/general-coding/SynthesisAgent' },
      to: {
        path: '^packages/core-engine/src/(?!general-coding/(GeneralCodingAgent|ConversationalLoop|editing/VerificationRunner))',
      },
    },
    {
      // v9.5.1: SpecialistAgentFactory and FileClassifier isolation
      name: 'no-specialist-factory-swarm-import',
      severity: 'error',
      comment: 'SpecialistAgentFactory and FileClassifier must not import SwarmCoordinator or PipelineOrchestrator. ' +
               'Specialist agents are subordinate DAG nodes, not factory pipeline participants.',
      from: { path: '^packages/core-engine/src/general-coding/(SpecialistAgentFactory|FileClassifier)' },
      to:   { path: '^packages/core-engine/src/agentic/SwarmCoordinator|^packages/core-engine/src/factory/PipelineOrchestrator' },
    },
    // v9.5: browser-tool boundary rules
    {
      name: 'browser-tool-cannot-import-core-engine-internals',
      severity: 'error',
      comment: 'browser-tool depends only on core-contracts; never on core-engine internals.',
      from: { path: '^packages/browser-tool' },
      to:   { path: '^packages/core-engine/src/(?!ingestion/(IntentPipeline|TaskEventBus|TaskInterventionGateway))' },
    },
    {
      name: 'browser-tool-cannot-import-channel-gateway',
      severity: 'error',
      comment: 'browser-tool has no knowledge of channel-gateway.',
      from: { path: '^packages/browser-tool' },
      to:   { path: '^packages/channel-gateway' },
    },
    {
      name: 'browser-extension-cannot-import-core-engine',
      severity: 'error',
      comment: 'browser-extension is a standalone Chrome extension package with zero server imports.',
      from: { path: '^packages/browser-extension' },
      to:   { path: '^packages/(core-engine|core-contracts|browser-tool|channel-gateway|module-)' },
    },
    {
      name: 'core-contracts-cannot-import-browser-tool',
      severity: 'error',
      comment: 'core-contracts is the zero-dependency contract layer; cannot import from browser-tool.',
      from: { path: '^packages/core-contracts' },
      to:   { path: '^packages/browser-tool' },
    },

    // ── Phase 7: doc-generator module isolation (MED-5, LOW-2) ──────────────────

    {
      name: 'doc-generator-no-agentic-swarm-import',
      severity: 'error',
      comment: 'doc-generator is a standalone subsystem; it must not import from the agentic swarm ' +
               'or factory pipeline orchestrators. All LLM access must go through ILLMClient.',
      from: { path: '^packages/core-engine/src/doc-generator/' },
      to: {
        path: '^packages/core-engine/src/(agentic/SwarmCoordinator|factory/PipelineOrchestrator)',
      },
    },
    {
      name: 'no-factory-import-of-doc-generator',
      severity: 'error',
      comment: 'Agentic pipeline, swarm, and general-coding modules must not import from doc-generator ' +
               'internals. doc-generator is triggered only through DocGeneratorPipeline via the queue.',
      from: {
        path: '^packages/core-engine/src/(agentic|factory|general-coding)/',
      },
      to: {
        path: '^packages/core-engine/src/doc-generator/',
      },
    },
    {
      name: 'doc-generator-llm-via-adapters-only',
      severity: 'error',
      comment: 'Only the doc-generator adapters layer may directly import PromptBudgetEnforcer. ' +
               'All other doc-generator code must use ITokenBudget / PromptBudgetEnforcerAdapter.',
      from: {
        // Any doc-generator file that is NOT inside the adapters/ subdirectory
        path: '^packages/core-engine/src/doc-generator/(?!adapters/)',
      },
      to: {
        path: '^packages/core-engine/src/infrastructure/PromptBudgetEnforcer',
      },
    },
    {
      // LOW-2: guard against reintroducing PromptBudgetEnforcer under the agentic/ tree
      name: 'no-agentic-prompt-budget-enforcer-reintroduction',
      severity: 'error',
      comment: 'PromptBudgetEnforcer must live in infrastructure/, not in agentic/. ' +
               'This rule prevents reintroduction of the pre-v10.4 misplaced file.',
      from: { path: '.' },
      to:   { path: '^packages/core-engine/src/agentic/PromptBudgetEnforcer' },
    },
  ],
  options: {
    doNotFollow: {
      dependencyTypes: [
        'npm', 'npm-dev', 'npm-optional', 'npm-peer', 'npm-bundled', 'npm-no-pkg',
      ],
    },
    // Skip compiled output, vendored modules, test fixtures, and generated
    // artefacts.  Without this the cruiser walks both src/ and dist/ for every
    // package, doubling the graph size and OOMing on monorepo-wide runs.
    exclude: {
      path: [
        '(^|/)dist/',
        '(^|/)node_modules/',
        '(^|/)\\.kilo/',
        '(^|/)__tests__/fixtures/',
        '(^|/)__fixtures__/',
        '(^|/)test/.*\\.fixture\\.',
      ],
    },
    tsPreCompilationDeps: true,
    reporterOptions: {
      text: { highlightFocused: true },
    },
  },
};
