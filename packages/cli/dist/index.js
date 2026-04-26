#!/usr/bin/env node
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * @oweibo/cli — oweibo command-line interface.
 *
 * Commands:
 *   run       Submit a task and stream events
 *   status    Show task status
 *   redirect  Send a human intervention to a task
 *   session   Manage general-coding sessions
 *   config    View and set CLI configuration
 *   skills    Manage SKILL.md files (9 subcommands)
 *   browser   Control the agent browser session (open, import-cookies, autofill, pair)
 *
 * Environment variables:
 *   OWEIBO_API_URL    API base URL (default: http://localhost:3100/api/v1)
 *   OWEIBO_API_KEY    Bearer token for authentication
 *   OWEIBO_TENANT_ID  Default tenant ID
 *   OWEIBO_SESSION_ID Default session ID for general-coding commands
 */
const commander_1 = require("commander");
const fs_1 = require("fs");
const path_1 = require("path");
const run_js_1 = require("./commands/run.js");
const status_js_1 = require("./commands/status.js");
const redirect_js_1 = require("./commands/redirect.js");
const session_js_1 = require("./commands/session.js");
const config_js_1 = require("./commands/config.js");
const skills_js_1 = require("./commands/skills.js");
const browser_js_1 = require("./commands/browser.js");
function getVersion() {
    try {
        const pkg = JSON.parse((0, fs_1.readFileSync)((0, path_1.join)(__dirname, '..', 'package.json'), 'utf-8'));
        return pkg.version;
    }
    catch {
        return '0.1.0';
    }
}
const program = new commander_1.Command();
program
    .name('oweibo')
    .description('AI-powered autonomous app factory — command-line interface')
    .version(getVersion(), '-V, --version', 'Output the CLI version')
    .helpOption('-h, --help', 'Display help');
program.addCommand((0, run_js_1.makeRunCommand)());
program.addCommand((0, status_js_1.makeStatusCommand)());
program.addCommand((0, redirect_js_1.makeRedirectCommand)());
program.addCommand((0, session_js_1.makeSessionCommand)());
program.addCommand((0, config_js_1.makeConfigCommand)());
program.addCommand((0, skills_js_1.makeSkillsCommand)());
program.addCommand((0, browser_js_1.makeBrowserCommand)());
// Pause / cancel commands (thin wrappers over POST /tasks/:id/pause|cancel)
program
    .command('pause <taskId>')
    .description('Pause a running task (can be resumed via redirect)')
    .option('--json', 'Output raw JSON')
    .action(async (taskId, opts) => {
    const { api } = await import('./client.js');
    try {
        const result = await api.post(`/tasks/${taskId}/pause`);
        if (opts.json)
            console.log(JSON.stringify(result));
        else
            console.log(`✓ Task ${taskId} paused`);
    }
    catch (err) {
        console.error(`Failed to pause task ${taskId}:`, err.message);
        process.exit(1);
    }
});
program
    .command('cancel <taskId>')
    .description('Cancel a running task')
    .option('--json', 'Output raw JSON')
    .action(async (taskId, opts) => {
    const { api } = await import('./client.js');
    try {
        const result = await api.post(`/tasks/${taskId}/cancel`);
        if (opts.json)
            console.log(JSON.stringify(result));
        else
            console.log(`✓ Task ${taskId} cancelled`);
    }
    catch (err) {
        console.error(`Failed to cancel task ${taskId}:`, err.message);
        process.exit(1);
    }
});
// Show pending HITL requests as a convenience shortcut
program
    .command('hitl')
    .description('List pending HITL (human-in-the-loop) escalation requests')
    .option('-t, --tenant <id>', 'Filter by tenant ID')
    .option('--json', 'Output raw JSON')
    .action(async (opts) => {
    const { api } = await import('./client.js');
    const tenantId = opts.tenant ?? process.env['OWEIBO_TENANT_ID'];
    try {
        const requests = await api.get(`/hitl/pending${tenantId ? `?tenantId=${tenantId}` : ''}`);
        if (opts.json) {
            console.log(JSON.stringify(requests, null, 2));
            return;
        }
        if (requests.length === 0) {
            console.log('No pending HITL requests.');
            return;
        }
        console.log(`Pending HITL requests (${requests.length}):\n`);
        for (const r of requests) {
            console.log(`  ${r.requestId}  task: ${r.taskId}  "${r.reason}"`);
            console.log(`    Escalated: ${new Date(r.escalatedAt).toLocaleString()}`);
            console.log(`    Approve:   oweibo redirect ${r.taskId} --approve ${r.requestId}`);
            console.log(`    Reject:    oweibo redirect ${r.taskId} --reject ${r.requestId}\n`);
        }
    }
    catch (err) {
        console.error('Failed to list HITL requests:', err.message);
        process.exit(1);
    }
});
// Unknown command handler
program.on('command:*', () => {
    console.error(`Unknown command: ${program.args.join(' ')}`);
    console.error(`Run 'oweibo --help' for available commands.`);
    process.exit(1);
});
program.parse(process.argv);
// Show help if no command provided
if (process.argv.length <= 2) {
    program.help();
}
//# sourceMappingURL=index.js.map