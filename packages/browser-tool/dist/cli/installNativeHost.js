"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.HOST_NAME = void 0;
exports.installNativeMessagingHost = installNativeMessagingHost;
const node_child_process_1 = require("node:child_process");
const node_fs_1 = require("node:fs");
const node_os_1 = require("node:os");
const node_path_1 = require("node:path");
const HOST_NAME = 'com.oweibo.browser';
exports.HOST_NAME = HOST_NAME;
function defaultInstallDir() {
    switch ((0, node_os_1.platform)()) {
        case 'darwin':
            return (0, node_path_1.join)((0, node_os_1.homedir)(), 'Library', 'Application Support', 'Google', 'Chrome', 'NativeMessagingHosts');
        case 'linux':
            return (0, node_path_1.join)((0, node_os_1.homedir)(), '.config', 'google-chrome', 'NativeMessagingHosts');
        case 'win32':
            return (0, node_path_1.join)((0, node_os_1.homedir)(), 'AppData', 'Local', 'Oweibo', 'NativeMessagingHosts');
        default:
            throw new Error(`unsupported platform: ${(0, node_os_1.platform)()}`);
    }
}
/** Generate the wrapper that exports OWEIBO_NATIVE_TOKEN then execs Node. */
function launcherContents(opts) {
    if ((0, node_os_1.platform)() === 'win32') {
        return {
            ext: 'cmd',
            body: `@echo off
rem Oweibo native messaging host launcher
for /f "usebackq delims=" %%t in ("${opts.tokenVaultPath}") do set OWEIBO_NATIVE_TOKEN=%%t
"${opts.nodeBinary}" "${opts.hostEntryJs}"
`,
        };
    }
    return {
        ext: 'sh',
        body: `#!/usr/bin/env bash
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
function installNativeMessagingHost(opts) {
    const installDir = opts.installDir ?? defaultInstallDir();
    (0, node_fs_1.mkdirSync)(installDir, { recursive: true });
    const nodeBinary = opts.nodeBinary ?? process.execPath;
    const hostEntryJs = (0, node_path_1.resolve)(opts.hostEntryJs);
    const launcher = launcherContents({
        nodeBinary, hostEntryJs, tokenVaultPath: opts.tokenVaultPath,
    });
    const launcherPath = (0, node_path_1.join)(installDir, `${HOST_NAME}.${launcher.ext}`);
    (0, node_fs_1.writeFileSync)(launcherPath, launcher.body, { encoding: 'utf8' });
    if ((0, node_os_1.platform)() !== 'win32')
        (0, node_fs_1.chmodSync)(launcherPath, 0o755);
    const manifest = {
        name: HOST_NAME,
        description: 'Oweibo Browser Native Messaging Host',
        path: launcherPath,
        type: 'stdio',
        allowed_origins: opts.allowedOrigins,
    };
    const manifestPath = (0, node_path_1.join)(installDir, `${HOST_NAME}.json`);
    (0, node_fs_1.writeFileSync)(manifestPath, JSON.stringify(manifest, null, 2), { encoding: 'utf8' });
    // Windows requires a registry key pointing at the manifest file.
    let registryKey;
    if ((0, node_os_1.platform)() === 'win32') {
        registryKey = `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}`;
        try {
            (0, node_child_process_1.execFileSync)('reg', ['add', registryKey, '/ve', '/t', 'REG_SZ', '/d', manifestPath, '/f'], { stdio: 'ignore' });
        }
        catch (e) {
            throw new Error(`failed to write registry key ${registryKey}: ${e.message}`);
        }
    }
    return { manifestPath, launcherPath, registryKey };
}
//# sourceMappingURL=installNativeHost.js.map