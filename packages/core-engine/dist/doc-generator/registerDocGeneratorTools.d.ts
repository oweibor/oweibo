/**
 * registerDocGeneratorTools — registers the doc:generate tool in ToolRegistry (§4.3.5, v10.5).
 *
 * Called from main.ts alongside registerGeneralCodingTools(). An agent editing a
 * codebase via general-coding can invoke doc:generate as a DAG node.
 */
import type { ToolRegistry } from '../tools/ToolRegistry.js';
import type { DocGeneratorPipeline } from './DocGeneratorPipeline.js';
export declare function registerDocGeneratorTools(toolRegistry: ToolRegistry, pipeline: DocGeneratorPipeline): void;
//# sourceMappingURL=registerDocGeneratorTools.d.ts.map