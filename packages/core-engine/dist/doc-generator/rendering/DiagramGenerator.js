"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DiagramGenerator = void 0;
/**
 * DiagramGenerator — generates Mermaid diagram source strings from CodebaseKnowledge.
 *
 * Mermaid validation: opt-in via --validate-mermaid / options.validateMermaid (B2, v10.4).
 * Default: diagrams are generated as text strings without validation (avoids puppeteer dep).
 */
class DiagramGenerator {
    options;
    constructor(options = {}) {
        this.options = options;
    }
    /** Generate a flowchart of module dependencies. */
    moduleDependencyGraph(knowledge) {
        const maxNodes = this.options.maxNodes ?? 20;
        const modules = knowledge.modules.slice(0, maxNodes);
        const lines = ['```mermaid', 'graph TD'];
        const ids = new Map();
        modules.forEach((m, i) => {
            const id = `M${i}`;
            ids.set(m.name, id);
            lines.push(`  ${id}["${sanitize(m.name)}"]`);
        });
        for (const mod of modules) {
            const fromId = ids.get(mod.name);
            for (const dep of mod.dependencies) {
                const toId = ids.get(dep.targetModule);
                if (fromId && toId) {
                    const arrow = dep.strength === 'strong' ? '-->' : '-.->';
                    lines.push(`  ${fromId} ${arrow} ${toId}`);
                }
            }
        }
        lines.push('```');
        return lines.join('\n');
    }
    /** Generate a simplified call-flow diagram for event edges. */
    eventFlowDiagram(knowledge) {
        const eventEdges = knowledge.callGraph.filter((e) => e.callType === 'event-emit' || e.callType === 'event-subscribe').slice(0, 30);
        if (eventEdges.length === 0)
            return '';
        const lines = ['```mermaid', 'sequenceDiagram'];
        const participants = new Set();
        for (const e of eventEdges) {
            participants.add(e.callerFile.split('/').pop() ?? e.callerFile);
            participants.add(e.calleeFile.split('/').pop() ?? e.calleeFile);
        }
        for (const p of participants) {
            lines.push(`  participant ${sanitize(p)}`);
        }
        for (const e of eventEdges) {
            const from = sanitize(e.callerFile.split('/').pop() ?? e.callerFile);
            const to = sanitize(e.calleeFile.split('/').pop() ?? e.calleeFile);
            const arrow = e.callType === 'event-emit' ? '->>' : '-->>';
            lines.push(`  ${from}${arrow}${to}: ${sanitize(e.calleeSymbol)}`);
        }
        lines.push('```');
        return lines.join('\n');
    }
}
exports.DiagramGenerator = DiagramGenerator;
function sanitize(s) {
    return s.replace(/["[\]]/g, '').slice(0, 40);
}
//# sourceMappingURL=DiagramGenerator.js.map