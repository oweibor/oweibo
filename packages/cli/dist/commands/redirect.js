"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.makeRedirectCommand = makeRedirectCommand;
/**
 * oweibo redirect — send a human intervention message to a paused task.
 *
 * Usage:
 *   oweibo redirect <taskId> "use PostgreSQL not SQLite"
 *   oweibo redirect <taskId> --approve <requestId>
 *   oweibo redirect <taskId> --reject <requestId> "not approved"
 */
const commander_1 = require("commander");
const client_js_1 = require("../client.js");
function makeRedirectCommand() {
    return new commander_1.Command('redirect')
        .description('Send a human intervention message or HITL decision to a task')
        .argument('<taskId>', 'Target task ID')
        .argument('[message]', 'Free-text redirection instruction')
        .option('--approve <requestId>', 'Approve a HITL escalation request by ID')
        .option('--reject <requestId>', 'Reject a HITL escalation request by ID')
        .option('-r, --reason <text>', 'Reason for rejection (used with --reject)')
        .option('--json', 'Output raw JSON', false)
        .action(async (taskId, message, opts) => {
        try {
            if (opts.approve) {
                const result = await client_js_1.api.post(`/hitl/${opts.approve}/approve`, { taskId });
                if (opts.json)
                    console.log(JSON.stringify(result));
                else
                    console.log(`✓ HITL request ${opts.approve} approved`);
                return;
            }
            if (opts.reject) {
                const result = await client_js_1.api.post(`/hitl/${opts.reject}/reject`, { taskId, reason: opts.reason });
                if (opts.json)
                    console.log(JSON.stringify(result));
                else
                    console.log(`✓ HITL request ${opts.reject} rejected`);
                return;
            }
            if (!message) {
                console.error('Error: Provide a message or use --approve / --reject');
                process.exit(1);
            }
            const result = await client_js_1.api.post(`/tasks/${taskId}/redirect`, { message });
            if (opts.json)
                console.log(JSON.stringify(result));
            else
                console.log(`✓ Redirect sent to task ${taskId}`);
        }
        catch (err) {
            console.error(`Failed to redirect task ${taskId}:`, err.message);
            process.exit(1);
        }
    });
}
//# sourceMappingURL=redirect.js.map