/**
 * oweibo config — view and set CLI configuration.
 *
 * Usage:
 *   oweibo config get <key>
 *   oweibo config set <key> <value>
 *   oweibo config list
 */
import { Command } from 'commander';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';

const CONFIG_PATH = join(homedir(), '.oweibo', 'config.json');

interface CliConfig {
  apiUrl?: string;
  apiKey?: string;
  tenantId?: string;
  defaultMode?: string;
}

function readConfig(): CliConfig {
  if (!existsSync(CONFIG_PATH)) return {};
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, 'utf-8')) as CliConfig;
  } catch {
    return {};
  }
}

function writeConfig(config: CliConfig): void {
  const dir = dirname(CONFIG_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n', 'utf-8');
}

const VALID_KEYS: Array<keyof CliConfig> = ['apiUrl', 'apiKey', 'tenantId', 'defaultMode'];

export function makeConfigCommand(): Command {
  const config = new Command('config')
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
    .action((key: string) => {
      const cfg = readConfig();
      const val = cfg[key as keyof CliConfig];
      if (val === undefined) {
        console.error(`Key not found: ${key}`);
        process.exit(1);
      }
      console.log(key === 'apiKey' ? '[hidden — use environment variable OWEIBO_API_KEY]' : val);
    });

  config
    .command('set <key> <value>')
    .description(`Set a configuration value. Valid keys: ${VALID_KEYS.join(', ')}`)
    .action((key: string, value: string) => {
      if (!VALID_KEYS.includes(key as keyof CliConfig)) {
        console.error(`Invalid key: ${key}`);
        console.error(`Valid keys: ${VALID_KEYS.join(', ')}`);
        process.exit(1);
      }
      const cfg = readConfig();
      (cfg as Record<string, string>)[key] = value;
      writeConfig(cfg);
      console.log(`✓ ${key} set`);
      if (key === 'apiKey') {
        console.log('Tip: For security, consider using the OWEIBO_API_KEY environment variable instead.');
      }
    });

  return config;
}
