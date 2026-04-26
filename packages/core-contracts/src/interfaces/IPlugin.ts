/**
 * IPlugin — runtime plugin lifecycle contract for generated apps (Principle #3).
 * Generated apps support hot plugin install/removal via this interface.
 * All methods must be idempotent.
 */
export interface IPlugin {
  /** Unique plugin identifier — matches the module manifest name */
  readonly id: string;
  readonly version: string;

  /**
   * Called when the plugin is first loaded into the running app.
   * Should register event handlers, initialise DB connections, and set up routes.
   */
  onInstall(): Promise<void>;

  /**
   * Called when the plugin is activated after install or after a pause.
   * Plugin should begin accepting requests.
   */
  onActivate(): Promise<void>;

  /**
   * Called before the plugin is deactivated.
   * Plugin should stop accepting new requests and drain in-flight work.
   */
  onDeactivate(): Promise<void>;

  /**
   * Called during hot upgrade — previous version is deactivated, new version installed.
   * Plugin should migrate any local state to the new schema.
   */
  onUpgrade(previousVersion: string): Promise<void>;

  /**
   * Called when the plugin is permanently removed.
   * Plugin should clean up all persistent resources (DB tables, queues, scheduled jobs).
   * Irreversible — use with care.
   */
  onRemove(): Promise<void>;
}
