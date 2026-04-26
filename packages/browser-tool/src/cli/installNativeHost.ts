/**
 * installNativeHost — Drops the Chrome native messaging host manifest into
 * the OS-specific directory so Chrome can locate `com.oweibo.browser`.
 *
 * Cross-platform paths:
 *   macOS:   ~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.oweibo.browser.json
 *   Linux:   ~/.config/google-chrome/NativeMessagingHosts/com.oweibo.browser.json
 *   Windows: HKCU\Software\Google\Chrome\NativeMessagingHosts\com.oweibo.browser
 *            (registry value pointing at a manifest file on disk)
 *
 * The manifest references this Node entry as the host binary and lists the
 * extension origin(s) allowed to connect — by default the Oweibo extension's
 * own chrome-extension:// origin.
 *
 * The pairing token is NOT written into the manifest. It is passed to the
 * host process at launch via OWEIBO_NATIVE_TOKEN, set by a tiny launcher
 * shell script also installed here. The launcher reads the token from the
 * user's vault and execs Node.
 */

import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export interface InstallOptions {
  /** Absolute path to the compiled nativeHostEntry.js. */
  hostEntryJs: string;
  /** Allowed extension origins (chrome-extension://<id>/). */
  allowedOrigins: string[];
  /** Absolute path to the user's vault file holding the pairing token. */
  tokenVaultPath: string;
  /** Override install dir (mainly for tests). */
  installDir?: string;
  /** Override Node binary path (default: process.execPath). */
  nodeBinary?: string;
}

export interface InstallResult {
  manifestPath:  string;
  launcherPath:  string;
  registryKey?:  string; // Windows only
}

const HOST_NAME = 'com.oweibo.browser';

function defaultInstallDir(): string {
  switch (platform()) {
    case 'darwin':
      return join(homedir(), 'Library', 'Application Support', 'Google', 'Chrome', 'NativeMessagingHosts');
    case 'linux':
      return join(homedir(), '.config', 'google-chrome', 'NativeMessagingHosts');
    case 'win32':
      return join(homedir(), 'AppData', 'Local', 'Oweibo', 'NativeMessagingHosts');
    default:
      throw new Error(`unsupported platform: ${platform()}`);
  }
}

/** Generate the wrapper that exports OWEIBO_NATIVE_TOKEN then execs Node. */
function launcherContents(opts: {
  nodeBinary: string; hostEntryJs: string; tokenVaultPath: string;
}): { body: string; ext: string } {
  if (platform() === 'win32') {
    return {
      ext: 'cmd',
      body:
`@echo off
rem Oweibo native messaging host launcher
for /f "usebackq delims=" %%t in ("${opts.tokenVaultPath}") do set OWEIBO_NATIVE_TOKEN=%%t
"${opts.nodeBinary}" "${opts.hostEntryJs}"
`,
    };
  }
  return {
    ext: 'sh',
    body:
`#!/usr/bin/env bash
# Oweibo native messaging host launcher
set -e
if [ ! -f "${opts.tokenVaultPath}" ]; then
  echo "[oweibo-native-host] missing token vault: ${opts.tokenVaultPath}" >&2
  exit 2
fi
export OWEIBO_NATIVE_TOKEN="$(cat "${opts.tokenVaultPath}")"
exec "${opts.nodeBinary}" "${opts.hostEntryJs}"
`,
  };
}

export function installNativeMessagingHost(opts: InstallOptions): InstallResult {
  const installDir = opts.installDir ?? defaultInstallDir();
  mkdirSync(installDir, { recursive: true });

  const nodeBinary  = opts.nodeBinary ?? process.execPath;
  const hostEntryJs = resolve(opts.hostEntryJs);

  const launcher = launcherContents({
    nodeBinary, hostEntryJs, tokenVaultPath: opts.tokenVaultPath,
  });
  const launcherPath = join(installDir, `${HOST_NAME}.${launcher.ext}`);
  writeFileSync(launcherPath, launcher.body, { encoding: 'utf8' });
  if (platform() !== 'win32') chmodSync(launcherPath, 0o755);

  const manifest = {
    name: HOST_NAME,
    description: 'Oweibo Browser Native Messaging Host',
    path: launcherPath,
    type: 'stdio',
    allowed_origins: opts.allowedOrigins,
  };
  const manifestPath = join(installDir, `${HOST_NAME}.json`);
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), { encoding: 'utf8' });

  // Windows requires a registry key pointing at the manifest file.
  let registryKey: string | undefined;
  if (platform() === 'win32') {
    registryKey = `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}`;
    try {
      execFileSync('reg', ['add', registryKey, '/ve', '/t', 'REG_SZ', '/d', manifestPath, '/f'],
        { stdio: 'ignore' });
    } catch (e) {
      throw new Error(`failed to write registry key ${registryKey}: ${(e as Error).message}`);
    }
  }

  return { manifestPath, launcherPath, registryKey };
}

// Allow `node installNativeHost.js --help`-style invocation later; right now
// this module is consumed by the oweibo CLI install command.
export { HOST_NAME };
