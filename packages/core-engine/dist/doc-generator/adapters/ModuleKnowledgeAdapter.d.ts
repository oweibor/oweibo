/**
 * ModuleKnowledgeAdapter — converts CodebaseKnowledge → ModuleKnowledge.
 *
 * Enables DocGeneratorPipeline output to feed the factory DocumentationAgent
 * in hybrid flows (§4.3.6, v10.5). Reverse adapter (fromModuleKnowledge) is
 * not needed in P1.
 */
import type { CodebaseKnowledge, ModuleBoundary, ModuleKnowledge } from '@oweibo/core-contracts';
export declare function toModuleKnowledge(knowledge: CodebaseKnowledge, targetModule: ModuleBoundary): ModuleKnowledge;
//# sourceMappingURL=ModuleKnowledgeAdapter.d.ts.map