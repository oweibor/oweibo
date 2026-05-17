"use strict";
/**
 * Template registry — builds all IDocTemplate instances for a pipeline run.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildAllTemplates = buildAllTemplates;
const ArchitectureDocTemplate_js_1 = require("./ArchitectureDocTemplate.js");
const ApiReferenceDocTemplate_js_1 = require("./ApiReferenceDocTemplate.js");
const DeveloperGuideDocTemplate_js_1 = require("./DeveloperGuideDocTemplate.js");
const ModuleReferenceDocTemplate_js_1 = require("./ModuleReferenceDocTemplate.js");
const DataModelDocTemplate_js_1 = require("./DataModelDocTemplate.js");
const EventCatalogueDocTemplate_js_1 = require("./EventCatalogueDocTemplate.js");
const ADRDocTemplate_js_1 = require("./ADRDocTemplate.js");
const DependencyMapDocTemplate_js_1 = require("./DependencyMapDocTemplate.js");
const GettingStartedDocTemplate_js_1 = require("./GettingStartedDocTemplate.js");
const GlossaryDocTemplate_js_1 = require("./GlossaryDocTemplate.js");
const ChangelogDocTemplate_js_1 = require("./ChangelogDocTemplate.js");
function buildAllTemplates(opts) {
    return [
        new ArchitectureDocTemplate_js_1.ArchitectureDocTemplate(),
        new ApiReferenceDocTemplate_js_1.ApiReferenceDocTemplate(),
        new DeveloperGuideDocTemplate_js_1.DeveloperGuideDocTemplate(),
        new ModuleReferenceDocTemplate_js_1.ModuleReferenceDocTemplate(),
        new DataModelDocTemplate_js_1.DataModelDocTemplate(),
        new EventCatalogueDocTemplate_js_1.EventCatalogueDocTemplate(),
        new ADRDocTemplate_js_1.ADRDocTemplate(),
        new DependencyMapDocTemplate_js_1.DependencyMapDocTemplate(),
        new GettingStartedDocTemplate_js_1.GettingStartedDocTemplate(),
        new GlossaryDocTemplate_js_1.GlossaryDocTemplate(),
        new ChangelogDocTemplate_js_1.ChangelogDocTemplate(opts?.redactAuthors ?? true),
    ];
}
//# sourceMappingURL=index.js.map