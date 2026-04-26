/** ModuleEntityField — a single field on an extracted entity. */
export interface ModuleEntityField {
    readonly name: string;
    readonly type: string;
    readonly optional: boolean;
}
/** ModuleEntityDoc — a TypeScript entity (interface or class) extracted from generated files. */
export interface ModuleEntityDoc {
    readonly name: string;
    readonly filePath: string;
    readonly fields: readonly ModuleEntityField[];
}
/** EndpointDoc — an HTTP endpoint extracted from generated route files. */
export interface EndpointDoc {
    readonly method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
    readonly path: string;
    readonly filePath: string;
    readonly description?: string;
}
/** EventDoc — a domain event emitted or consumed by the generated module. */
export interface EventDoc {
    readonly eventType: string;
    readonly filePath: string;
    readonly schemaVersion?: string;
}
/** InvariantDoc — a business invariant extracted from annotations or test assertions. */
export interface InvariantDoc {
    readonly description: string;
    readonly source: 'annotation' | 'test';
    readonly filePath: string;
}
/** ExtensionPointDoc — a plugin hook or lifecycle point in the generated module. */
export interface ExtensionPointDoc {
    readonly hookName: string;
    readonly filePath: string;
    readonly description?: string;
}
/**
 * UserFlowDoc (v8) — task-oriented description of what the app does from the user's perspective.
 * Primary input to the DocumentationAgent user-guide writer.
 * Written by ArchitectAgent (has task intent + domain context).
 */
export interface UserFlowDoc {
    readonly name: string;
    readonly actor: string;
    readonly steps: readonly string[];
    readonly outcome: string;
    readonly relatedEndpoints?: readonly string[];
}
/** GlossaryEntry (v8) — domain term for the user guide glossary. Written by ArchitectAgent. */
export interface GlossaryEntry {
    readonly term: string;
    readonly definition: string;
}
/** ExampleUsageDoc (v8) — human-readable usage example lifted from testFiles by ExecutorAgent. */
export interface ExampleUsageDoc {
    readonly title: string;
    readonly description: string;
    readonly codeSnippet: string;
    readonly language: string;
}
/**
 * ModuleKnowledge — structured knowledge artifact produced by every IModuleGenerator.
 * Consumed by DocumentationAgent (v8) and stored in LongTermMemoryStore.
 *
 * Structural fields extracted deterministically from ArtifactBundle.files (no LLM).
 * Documentation fields (userFlows, glossary, exampleUsages) are agent-written.
 */
export interface ModuleKnowledge {
    readonly moduleName: string;
    readonly version: string;
    readonly generatedAt: string;
    readonly domainDescription: string;
    readonly entities: readonly ModuleEntityDoc[];
    readonly endpoints: readonly EndpointDoc[];
    readonly emittedEvents: readonly EventDoc[];
    readonly consumedEvents: readonly EventDoc[];
    readonly invariants: readonly InvariantDoc[];
    readonly extensionPoints: readonly ExtensionPointDoc[];
    readonly userFlows: readonly UserFlowDoc[];
    readonly glossary: readonly GlossaryEntry[];
    readonly exampleUsages: readonly ExampleUsageDoc[];
}
//# sourceMappingURL=ModuleKnowledge.d.ts.map