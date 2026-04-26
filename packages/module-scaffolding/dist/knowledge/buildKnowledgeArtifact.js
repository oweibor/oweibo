"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildKnowledgeArtifact = buildKnowledgeArtifact;
function buildKnowledgeArtifact(inputs) {
    const { moduleName, bundle, architectKnowledge, executorExampleUsages } = inputs;
    return {
        moduleName,
        version: '1.0.0',
        generatedAt: new Date().toISOString(),
        domainDescription: architectKnowledge.domainDescription,
        entities: extractEntities(bundle.files),
        endpoints: extractEndpoints(bundle.files),
        emittedEvents: extractEmittedEvents(bundle.files),
        consumedEvents: extractConsumedEvents(bundle.files),
        invariants: extractInvariants(bundle.files, bundle.testFiles),
        extensionPoints: extractExtensionPoints(bundle.files),
        userFlows: architectKnowledge.userFlows,
        glossary: architectKnowledge.glossary,
        exampleUsages: executorExampleUsages,
    };
}
function extractEntities(files) {
    const entities = [];
    for (const f of files) {
        const matches = f.content.matchAll(/export\s+(?:interface|class)\s+(\w+)/g);
        for (const m of matches) {
            entities.push({ name: m[1] ?? '', filePath: f.path, fields: [] });
        }
    }
    return entities;
}
function extractEndpoints(files) {
    const endpoints = [];
    for (const f of files) {
        const expressMatches = f.content.matchAll(/router\.(get|post|put|delete|patch)\(['"`]([^'"`]+)/g);
        for (const m of expressMatches) {
            endpoints.push({ method: (m[1] ?? '').toUpperCase(), path: m[2] ?? '', filePath: f.path });
        }
        const nextMatches = f.content.matchAll(/export\s+async\s+function\s+(GET|POST|PUT|DELETE|PATCH)/g);
        for (const m of nextMatches) {
            const inferredPath = f.path.replace(/^.*app/, '').replace(/\/route\.ts$/, '');
            endpoints.push({ method: (m[1] ?? ''), path: inferredPath, filePath: f.path });
        }
    }
    return endpoints;
}
function extractEmittedEvents(files) {
    const events = [];
    for (const f of files) {
        const matches = f.content.matchAll(/eventBus\.(?:emit|publish)\(['"`]([^'"`]+)/g);
        for (const m of matches) {
            events.push({ eventType: m[1] ?? '', filePath: f.path });
        }
    }
    return events;
}
function extractConsumedEvents(files) {
    const events = [];
    for (const f of files) {
        const matches = f.content.matchAll(/eventBus\.(?:on|subscribe)\(['"`]([^'"`]+)/g);
        for (const m of matches) {
            events.push({ eventType: m[1] ?? '', filePath: f.path });
        }
    }
    return events;
}
function extractInvariants(files, testFiles) {
    const invariants = [];
    for (const f of files) {
        const matches = f.content.matchAll(/@invariant\s+(.+)/g);
        for (const m of matches) {
            invariants.push({ description: (m[1] ?? '').trim(), source: 'annotation', filePath: f.path });
        }
    }
    const rulePattern = /(?:it|test)\(['"`]([^'"`]*(must|never|always|cannot|should not)[^'"`]*)/gi;
    for (const f of testFiles) {
        const matches = f.content.matchAll(rulePattern);
        for (const m of matches) {
            invariants.push({ description: (m[1] ?? '').trim(), source: 'test', filePath: f.path });
        }
    }
    return invariants;
}
function extractExtensionPoints(files) {
    const points = [];
    for (const f of files) {
        const matches = f.content.matchAll(/export\s+(?:function|const)\s+(on\w+|before\w+|after\w+|plugin\w+)/g);
        for (const m of matches) {
            points.push({ hookName: m[1] ?? '', filePath: f.path });
        }
    }
    return points;
}
//# sourceMappingURL=buildKnowledgeArtifact.js.map