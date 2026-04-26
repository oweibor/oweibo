"use strict";
/**
 * ExtensionHitlRespondAction (v9.5.9) — Internal pipeline action.
 *
 * The extension's HITLSurfaceCoordinator emits this action when ANY surface
 * (in-tab overlay, OS notification, popup) records a user response on a
 * pending gate. The node-side pipeline routes the response back to the
 * waiting DialogManager / VisionLoopGate.
 *
 * This action is NEVER produced by an LLM — it is generated only by the
 * extension bridge ingress path. Calling it directly from agent code is a
 * programming error and is rejected.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.ExtensionHitlRespondAction = void 0;
class ExtensionHitlRespondAction {
    resolver;
    constructor(resolver) {
        this.resolver = resolver;
    }
    /** Set on actions originating from the trusted bridge ingress path. */
    static INTERNAL_MARKER = Symbol.for('oweibo.extensionHitlRespond.internal');
    /**
     * Mark an action as originating from the trusted bridge so the executor
     * accepts it. The bridge dispatcher applies this marker before invoking.
     */
    static markInternal(action) {
        Object.defineProperty(action, ExtensionHitlRespondAction.INTERNAL_MARKER, {
            value: true, enumerable: false,
        });
        return action;
    }
    async execute(action, context) {
        const isInternal = action[ExtensionHitlRespondAction.INTERNAL_MARKER];
        if (!isInternal) {
            return this.fail('extension-hitl-respond is reserved for the bridge ingress path.', 'FORBIDDEN_DIRECT_INVOCATION');
        }
        if (!action.gateId || typeof action.gateId !== 'string') {
            return this.fail('extension-hitl-respond: missing gateId.', 'INVALID_INPUT');
        }
        let resolved = false;
        try {
            resolved = await this.resolver.resolveGate(action.gateId, Boolean(action.accept), action.promptText);
        }
        catch (e) {
            return this.fail(`gate resolution failed: ${e.message}`, 'RESOLVE_ERROR');
        }
        context.eventEmitter.emit('browser-hitl-resolved', {
            gateId: action.gateId,
            accept: Boolean(action.accept),
            tenantId: context.tenantId,
            taskId: context.taskId,
            idempotent: !resolved,
        });
        return {
            success: true,
            actionType: 'extension-hitl-respond',
            observation: resolved
                ? `Gate ${action.gateId} ${action.accept ? 'accepted' : 'dismissed'}.`
                : `Gate ${action.gateId} was already resolved (idempotent).`,
            data: { gateId: action.gateId, accept: Boolean(action.accept), idempotent: !resolved },
        };
    }
    fail(observation, error) {
        return { success: false, actionType: 'extension-hitl-respond', observation, error };
    }
}
exports.ExtensionHitlRespondAction = ExtensionHitlRespondAction;
//# sourceMappingURL=ExtensionHitlRespondAction.js.map