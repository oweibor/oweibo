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
import type { BrowserAction, BrowserActionResult, IBrowserExecutionContext } from '@oweibo/core-contracts';
/** Sink that the action notifies when a gate resolution arrives. */
export interface IGateResolver {
    /**
     * Resolve a pending gate by id. Returns true if the gate existed and was
     * resolved by this call, false if it was unknown or already resolved.
     */
    resolveGate(gateId: string, accept: boolean, promptText?: string): Promise<boolean>;
}
export declare class ExtensionHitlRespondAction {
    private readonly resolver;
    constructor(resolver: IGateResolver);
    /** Set on actions originating from the trusted bridge ingress path. */
    static readonly INTERNAL_MARKER: unique symbol;
    /**
     * Mark an action as originating from the trusted bridge so the executor
     * accepts it. The bridge dispatcher applies this marker before invoking.
     */
    static markInternal<A extends {
        type: 'extension-hitl-respond';
    }>(action: A): A;
    execute(action: Extract<BrowserAction, {
        type: 'extension-hitl-respond';
    }>, context: IBrowserExecutionContext): Promise<BrowserActionResult>;
    private fail;
}
//# sourceMappingURL=ExtensionHitlRespondAction.d.ts.map