"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.makeRunCommand = makeRunCommand;
/**
 * oweibo run — submit a task and stream live events.
 *
 * Usage:
 *   oweibo run "build me a Next.js app with auth and Postgres"
 *   oweibo run --file task.txt --tenant acme-corp
 *   oweibo run "fix the login bug" --mode general-coding --wait
 */
const commander_1 = require("commander");
const client_js_1 = require("../client.js");
const sse_js_1 = require("../sse.js");
const fs_1 = require("fs");
function makeRunCommand() {
    return new commander_1.Command('run')
        .description('Submit a task to oweibo and stream live progress events')
        .argument('[instruction]', 'Task instruction (or use --file)')
        .option('-f, --file <path>', 'Read task instruction from a file')
        .option('-t, --tenant <id>', 'Tenant ID (defaults to OWEIBO_TENANT_ID env var)')
        .option('-m, --mode <mode>', 'Task mode: auto | factory | general-coding (default: auto)', 'auto')
        .option('-w, --wait', 'Wait for task completion before exiting (streams events)', false)
        .option('--json', 'Output raw JSON instead of formatted output', false)
        .action(async (instruction, opts) => {
        let taskInstruction = instruction ?? '';
        if (opts.file) {
            if (!(0, fs_1.existsSync)(opts.file)) {
                console.error(`Error: File not found: ${opts.file}`);
                process.exit(1);
            }
            taskInstruction = (0, fs_1.readFileSync)(opts.file, 'utf-8').trim();
        }
        if (!taskInstruction) {
            console.error('Error: Provide an instruction or use --file');
            process.exit(1);
        }
        const tenantId = opts.tenant ?? process.env['OWEIBO_TENANT_ID'] ?? 'default';
        try {
            const task = await client_js_1.api.post('/tasks', {
                instruction: taskInstruction,
                tenantId,
                mode: opts.mode,
            });
            if (opts.json) {
                console.log(JSON.stringify(task));
            }
            else {
                console.log(`Task submitted: ${task.taskId}`);
                console.log(`Status: ${task.status}`);
            }
            if (opts.wait) {
                console.log('Streaming events (Ctrl+C to detach)...\n');
                await (0, sse_js_1.streamEvents)(task.taskId, (event) => {
                    (0, sse_js_1.printEvent)(event, opts.json ?? false);
                    if (event.type === 'task-completed' || event.type === 'task-failed') {
                        process.exit(event.type === 'task-completed' ? 0 : 1);
                    }
                });
            }
        }
        catch (err) {
            console.error('Failed to submit task:', err.message);
            process.exit(1);
        }
    });
}
//# sourceMappingURL=run.js.map