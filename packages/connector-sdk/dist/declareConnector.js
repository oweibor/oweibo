"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.declareConnector = declareConnector;
function declareConnector(spec) {
    // Invariant 1: capabilityIds unique.
    const seen = new Set();
    for (const c of spec.capabilities) {
        if (seen.has(c.capabilityId)) {
            throw new Error(`declareConnector(${spec.connectorId}): duplicate capabilityId ${JSON.stringify(c.capabilityId)}`);
        }
        seen.add(c.capabilityId);
    }
    // Invariant 2: actionClass non-empty.
    for (const c of spec.capabilities) {
        if (typeof c.actionClass !== 'string' || c.actionClass.length === 0) {
            throw new Error(`declareConnector(${spec.connectorId}): capability ${c.capabilityId} missing actionClass`);
        }
    }
    // Invariant 3: tiers >= 'community' require sandbox declarations.
    const tierOrder = { experimental: 0, community: 1, verified: 2, enterprise: 3 };
    if (tierOrder[spec.certificationTarget] >= tierOrder.community) {
        for (const c of spec.capabilities) {
            if (!c.sandbox) {
                throw new Error(`declareConnector(${spec.connectorId}): tier ${spec.certificationTarget} requires capability ${c.capabilityId} to declare a sandbox`);
            }
        }
    }
    return {
        spec,
        catalogEntry: {
            connectorId: spec.connectorId,
            displayName: spec.displayName,
            category: spec.category,
            description: spec.description,
            catalogVersion: spec.catalogVersion,
            credentialSchema: spec.credentialSchema,
            capabilities: spec.capabilities.map((c) => ({
                capabilityId: c.capabilityId,
                summary: c.summary,
                actionClass: c.actionClass,
                inputSchema: c.inputSchema,
                outputSchema: c.outputSchema,
                ...(c.sandbox
                    ? {
                        shadowTarget: {
                            mode: c.sandbox.mode,
                            ...(c.sandbox.config !== undefined ? { config: c.sandbox.config } : {}),
                        },
                    }
                    : {}),
            })),
            recommendedFor: spec.recommendedFor ?? [],
            certification: spec.certificationTarget,
            certifiedFor: spec.certifiedFor ?? [],
        },
    };
}
//# sourceMappingURL=declareConnector.js.map