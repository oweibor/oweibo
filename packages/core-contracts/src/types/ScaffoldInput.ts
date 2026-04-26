/**
 * HardwareProfile — union aligned with config.js VALID_PROFILES (17 profiles).
 * Used by ScaffoldInput, HardwareAwareScheduler, and ModelRouter.
 */
export type HardwareProfile =
  // Low-power Intel
  | 'n100_like'
  | 'n305'
  | 'celeron'
  // Standard Intel
  | 'core_i3'
  | 'core_i5'
  | 'core_i7'
  // AMD
  | 'amd_low'
  | 'amd_mid'
  | 'amd_high'
  // ARM
  | 'arm64_rpi5'
  | 'arm64_server'
  | 'arm64_rk3588'
  // NVIDIA GPU
  | 'nvidia_small'
  | 'nvidia_medium'
  | 'nvidia_large'
  | 'nvidia_rtx'
  // Apple
  | 'apple_silicon';

/**
 * ScaffoldInput — the canonical input contract for all code-generation tasks.
 * Validated by IntentClarifier before reaching the factory pipeline.
 * Submitted via IntentPipeline — the sole task creation entry point.
 */
export interface ScaffoldInput {
  /** Name of the application to generate */
  readonly appName: string;
  /** Optional workspace identifier for multi-app tenants */
  readonly workspaceId?: string;
  /** Target technology stack */
  readonly stack: 't3' | 'nextjs' | 'express' | 'mern' | 'laravel' | 'django';
  /** Primary database */
  readonly database: 'postgresql' | 'mysql' | 'sqlite';
  /** Feature flags for module activation */
  readonly features: readonly string[];
  /**
   * Auth provider for the generated app. Default: 'betterauth'.
   * See Auth Provider Decision Matrix (§3c) for full stack × provider compatibility.
   *   betterauth    — default for TypeScript stacks; multi-org plugin, typed client
   *   authjs        — next-auth v5; full OAuth provider breadth
   *   zitadel-native — OIDC SDK only; identity managed by self-hosted Zitadel
   *   custom        — placeholder stubs; implementation supplied by tenant
   */
  readonly authProvider?: 'betterauth' | 'authjs' | 'zitadel-native' | 'custom';
  /** Required for Qdrant collection namespacing and ISecurityContext authz */
  readonly tenantId: string;
  /** Hardware profile — controls model selection and concurrency limits */
  readonly hardwareProfile: HardwareProfile;
}
