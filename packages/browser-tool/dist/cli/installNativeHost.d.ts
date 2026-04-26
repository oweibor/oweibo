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
    manifestPath: string;
    launcherPath: string;
    registryKey?: string;
}
declare const HOST_NAME = "com.oweibo.browser";
export declare function installNativeMessagingHost(opts: InstallOptions): InstallResult;
export { HOST_NAME };
//# sourceMappingURL=installNativeHost.d.ts.map