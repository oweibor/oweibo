"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DocGeneratorOrchestrator = void 0;
const CrossRefLinker_js_1 = require("./CrossRefLinker.js");
const DocValidator_js_1 = require("./DocValidator.js");
const DocExporter_js_1 = require("./DocExporter.js");
const DiagramGenerator_js_1 = require("./DiagramGenerator.js");
const DEFAULT_CONCURRENCY = 4;
/**
 * DocGeneratorOrchestrator — drives the rendering pipeline.
 *
 * Pipeline:
 *   1. Template selection (isApplicable)
 *   2. Parallel rendering (max concurrency: 4)
 *   3. Cross-reference linking
 *   4. Validation
 *   5. Export to filesystem
 */
class DocGeneratorOrchestrator {
    templates;
    ctx;
    options;
    crossRefLinker = new CrossRefLinker_js_1.CrossRefLinker();
    validator = new DocValidator_js_1.DocValidator();
    exporter = new DocExporter_js_1.DocExporter();
    diagrams = new DiagramGenerator_js_1.DiagramGenerator();
    constructor(templates, ctx, options) {
        this.templates = templates;
        this.ctx = ctx;
        this.options = options;
    }
    async run(knowledge, signal) {
        signal?.throwIfAborted();
        const warnings = [];
        // ── 1. Template selection ──────────────────────────────────────────────────
        const applicable = this.templates.filter((t) => {
            const check = t.isApplicable(knowledge);
            if (!check.applicable || check.degradationLevel === 'skipped') {
                warnings.push({
                    code: 'TEMPLATE_NOT_APPLICABLE',
                    message: `Template ${t.fileName} skipped: ${check.reason ?? check.degradationLevel}`,
                    context: { template: t.fileName, level: check.degradationLevel },
                });
                return false;
            }
            return true;
        });
        // ── 2. Parallel rendering ──────────────────────────────────────────────────
        const concurrency = this.options.maxConcurrency ?? DEFAULT_CONCURRENCY;
        const rendered = [];
        for (let i = 0; i < applicable.length; i += concurrency) {
            signal?.throwIfAborted();
            const batch = applicable.slice(i, i + concurrency);
            const results = await Promise.allSettled(batch.map((t) => t.render(knowledge, this.ctx, signal)));
            for (let j = 0; j < results.length; j++) {
                const res = results[j];
                if (res.status === 'fulfilled') {
                    rendered.push(res.value);
                }
                else {
                    warnings.push({
                        code: 'TEMPLATE_DEGRADED',
                        message: `Template ${batch[j].fileName} failed: ${res.reason.message}`,
                        context: { template: batch[j].fileName },
                    });
                }
            }
        }
        signal?.throwIfAborted();
        // ── 3. Cross-reference linking ─────────────────────────────────────────────
        const linked = this.crossRefLinker.link(rendered, knowledge);
        // ── 4. Validation ─────────────────────────────────────────────────────────
        const validation = this.validator.validate(linked);
        warnings.push(...validation.warnings);
        const finalDocs = this.options.redactSecrets
            ? linked.map((d) => this.validator.redact(d))
            : linked;
        // ── 5. Export ─────────────────────────────────────────────────────────────
        let writtenFiles = [];
        if (!this.options.skipExport) {
            const exportResult = await this.exporter.export(finalDocs, {
                outputDir: this.options.outputDir,
                strictPaths: true,
            });
            writtenFiles = exportResult.writtenFiles;
            warnings.push(...exportResult.warnings);
        }
        return { rendered: finalDocs, writtenFiles, warnings };
    }
}
exports.DocGeneratorOrchestrator = DocGeneratorOrchestrator;
//# sourceMappingURL=DocGeneratorOrchestrator.js.map