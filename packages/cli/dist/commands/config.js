"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.makeConfigCommand = makeConfigCommand;
/**
 * oweibo config — view and set CLI configuration.
 *
 * Usage:
 *   oweibo config get <key>
 *   oweibo config set <key> <value>
 *   oweibo config list
 */
const commander_1 = require("commander");
const fs_1 = require("fs");
const path_1 = require("path");
const os_1 = require("os");
const CONFIG_PATH = (0, path_1.join)((0, os_1.homedir)(), '.oweibo', 'config.json');
function readConfig() {
    if (!(0, fs_1.existsSync)(CONFIG_PATH))
        return {};
    try {
        return JSON.parse((0, fs_1.readFileSync)(CONFIG_PATH, 'utf-8'));
    }
    catch {
        return {};
    }
}
function writeConfig(config) {
    const dir = (0, path_1.dirname)(CONFIG_PATH);
    if (!(0, fs_1.existsSync)(dir))
        (0, fs_1.mkdirSync)(dir, { recursive: true });
    (0, fs_1.writeFileSync)(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n', 'utf-8');
}
const VALID_KEYS = ['apiUrl', 'apiKey', 'tenantId', 'defaultMode'];
function makeConfigCommand() {
    const config = new commander_1.Command('config')
        .description('View and set CLI configuration');
    config
        .command('list')
        .description('List all configuration values')
        .action(() => {
        const cfg = readConfig();
        if (Object.keys(cfg).length === 0) {
            console.log(`No configuration set. Config file: ${CONFIG_PATH}`);
            return;
        }
        for (const [k, v] of Object.entries(cfg)) {
            const display = k === 'apiKey' ? '[hidden]' : v;
            console.log(`${k} = ${display}`);
        }
        console.log(`\nConfig file: ${CONFIG_PATH}`);
    });
    config
        .command('get <key>')
        .description('Get a configuration value')
        .action((key) => {
        const cfg = readConfig();
        const val = cfg[key];
        if (val === undefined) {
            console.error(`Key not found: ${key}`);
            process.exit(1);
        }
        console.log(key === 'apiKey' ? '[hidden — use environment variable OWEIBO_API_KEY]' : val);
    });
    config
        .command('set <key> <value>')
        .description(`Set a configuration value. Valid keys: ${VALID_KEYS.join(', ')}`)
        .action((key, value) => {
        if (!VALID_KEYS.includes(key)) {
            console.error(`Invalid key: ${key}`);
            console.error(`Valid keys: ${VALID_KEYS.join(', ')}`);
            process.exit(1);
        }
        const cfg = readConfig();
        cfg[key] = value;
        writeConfig(cfg);
        console.log(`✓ ${key} set`);
        if (key === 'apiKey') {
            console.log('Tip: For security, consider using the OWEIBO_API_KEY environment variable instead.');
        }
    });
    return config;
}
//# sourceMappingURL=config.js.map