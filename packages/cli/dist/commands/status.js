"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.makeStatusCommand = makeStatusCommand;
/**
 * oweibo status — show the current status of a task.
 *
 * Usage:
 *   oweibo status <taskId>
 *   oweibo status <taskId> --follow
 */
const commander_1 = require("commander");
const client_js_1 = require("../client.js");
const sse_js_1 = require("../sse.js");
function makeStatusCommand() {
    return new commander_1.Command('status')
        .description('Show the status of a running or completed task')
        .argument('<taskId>', 'Task ID to query')
        .option('-f, --follow', 'Follow event stream until task completes', false)
        .option('--json', 'Output raw JSON', false)
        .action(async (taskId, opts) => {
        try {
            const status = await client_js_1.api.get(`/tasks/${taskId}`);
            if (opts.json) {
                console.log(JSON.stringify(status, null, 2));
            }
            else {
                console.log(`Task:     ${status.taskId}`);
                console.log(`Status:   ${status.status}`);
                if (status.stage)
                    console.log(`Stage:    ${status.stage}`);
                if (status.progress !== undefined)
                    console.log(`Progress: ${status.progress}%`);
                if (status.startedAt)
                    console.log(`Started:  ${new Date(status.startedAt).toLocaleString()}`);
                if (status.completedAt)
                    console.log(`Finished: ${new Date(status.completedAt).toLocaleString()}`);
                if (status.error)
                    console.error(`Error:    ${status.error}`);
            }
            if (opts.follow && !['completed', 'failed', 'cancelled'].includes(status.status)) {
                console.log('\nFollowing events...\n');
                await (0, sse_js_1.streamEvents)(taskId, (event) => {
                    (0, sse_js_1.printEvent)(event, opts.json ?? false);
                    if (event.type === 'task-completed' || event.type === 'task-failed') {
                        process.exit(event.type === 'task-completed' ? 0 : 1);
                    }
                });
            }
        }
        catch (err) {
            console.error(`Failed to get status for ${taskId}:`, err.message);
            process.exit(1);
        }
    });
}
//# sourceMappingURL=status.js.map