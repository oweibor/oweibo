"use strict";
/**
 * TaskEventRenderer — formats TaskEvents for the oweibo CLI terminal.
 *
 * Each static method accepts a raw TaskEvent and a timestamp prefix string,
 * and writes formatted output to stdout/stderr. This module is the single
 * place to add new event render cases so sse.ts stays thin.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.TaskEventRenderer = void 0;
class TaskEventRenderer {
    /**
     * Render a single TaskEvent to the terminal. Returns true if the event was
     * handled (has a specific case), false if it fell through to the generic handler.
     */
    static render(event, raw) {
        if (raw) {
            console.log(JSON.stringify(event));
            return true;
        }
        const ts = event.timestamp ? new Date(event.timestamp).toLocaleTimeString() : '';
        const prefix = ts ? `[${ts}]` : '';
        const stage = event.stage ? ` [${event.stage}]` : '';
        switch (event.type) {
            // ── Core task lifecycle ────────────────────────────────────────────────
            case 'stage-started':
                console.log(`${prefix}${stage} → ${event.message ?? 'Stage started'}`);
                return true;
            case 'stage-completed':
                console.log(`${prefix}${stage} ✓ ${event.message ?? 'Done'}`);
                return true;
            case 'stage-failed':
                console.error(`${prefix}${stage} ✗ ${event.message ?? 'Failed'}`);
                return true;
            case 'task-completed':
                console.log('\n✓ Task completed successfully');
                return true;
            case 'task-failed':
                console.error(`\n✗ Task failed: ${event.message ?? 'Unknown error'}`);
                return true;
            case 'hitl-required':
                console.log(`\n⚠ Human review required — use: oweibo redirect ${event.taskId} <message>`);
                return true;
            // ── v9.5: Reactive Orchestrator events ────────────────────────────────
            case 'plan-node-dispatched':
                console.log(`${prefix} → [node] ${event.message ?? 'Dispatching node…'}`);
                return true;
            case 'plan-node-complete':
                console.log(`${prefix} ✓ [node] ${event.message ?? 'Node complete'}`);
                return true;
            case 'plan-amended':
                console.log(`${prefix} ↺ [plan] ${event.message ?? 'Plan amended'}`);
                return true;
            case 'synthesis-started':
                console.log(`${prefix} ⏳ [synthesis] ${event.message ?? 'Merging outputs…'}`);
                return true;
            // ── v9.5.1: Specialist spawning ───────────────────────────────────────
            case 'specialist-spawned':
                console.log(`${prefix} [specialist] ${event.message ?? 'Specialist spawned'}`);
                return true;
            // ── v9.5: Browser session lifecycle ───────────────────────────────────
            case 'browser-session-created':
                console.log(`${prefix} [browser] Session created`);
                return true;
            case 'browser-session-closed':
                console.log(`${prefix} [browser] Session closed`);
                return true;
            case 'browser-navigated': {
                const d = event.data;
                console.log(`${prefix} [browser] → ${d?.['url'] ?? event.message ?? 'navigated'}`);
                return true;
            }
            case 'browser-action': {
                const d = event.data;
                const ok = d?.['success'] !== false;
                const act = d?.['action'] ?? event.message ?? '';
                if (ok)
                    console.log(`${prefix} [browser] ${act}`);
                else
                    console.error(`${prefix} [browser] ✗ ${act}`);
                return true;
            }
            case 'browser-extension-pairing-required':
                console.log(`${prefix} [browser] Extension pairing required — opening pair page…`);
                return true;
            case 'browser-extension-connected':
                console.log(`${prefix} [browser] Extension connected`);
                return true;
            case 'browser-stealth-pool-acquired':
                console.log(`${prefix} [browser] Stealth pool persona acquired`);
                return true;
            case 'browser-profile-restored':
                console.log(`${prefix} [browser] Persistent profile restored`);
                return true;
            case 'browser-hitl-resolved': {
                const d = event.data;
                console.log(`${prefix} [browser] HITL gate resolved by ${d?.['resolvedBy'] ?? 'unknown'}`);
                return true;
            }
            // ── v9.5.9: New browser events ─────────────────────────────────────────
            case 'browser-backend-auto-selected': {
                const d = event.data;
                const selected = d?.['selected'] ?? 'unknown';
                console.log(`${prefix} [browser] Auto-selected backend: ${selected}`);
                return true;
            }
            case 'browser-cookies-imported': {
                const d = event.data;
                const domain = d?.['domain'] ?? '';
                const count = d?.['cookieCount'] ?? 0;
                console.log(`${prefix} [browser] Imported ${count} cookie(s) for ${domain}`);
                return true;
            }
            case 'heartbeat':
                // Suppress heartbeat noise.
                return true;
            default:
                return false;
        }
    }
}
exports.TaskEventRenderer = TaskEventRenderer;
//# sourceMappingURL=TaskEventRenderer.js.map