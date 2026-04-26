"use strict";
/**
 * IDocTemplate — pluggable documentation template contract.
 *
 * Each implementation renders one document category from CodebaseKnowledge.
 * Third-party implementations must pass IDocTemplateContractSuite.
 *
 * Design rules:
 *   - render MUST NOT write to the filesystem — return RenderedDocument only.
 *   - render MUST check AbortSignal between LLM calls.
 *   - render output MUST NOT contain secrets matching DocValidator patterns.
 *   - fileName MUST NOT contain path traversal sequences (../, /).
 */
Object.defineProperty(exports, "__esModule", { value: true });
//# sourceMappingURL=IDocTemplate.js.map