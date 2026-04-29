/**
 * kilo-pipeline configuration.
 * Validates required environment variables and exports a frozen config object.
 * Fails fast on missing KILO_API_TOKEN (security requirement).
 *
 * @module config
 */

/** @type*/
let _hwProfile = process.env.HARDWARE_PROFILE || 'n100_like';

// Validate hardware profile
const VALID_PROFILES = [
    'n100_like', 'n305', 'celeron',
    'core_i3', 'core_i5', 'core_i7',
    'amd_low', 'amd_mid', 'amd_high',
    'arm64_rpi5', 'arm64_server', 'arm64_rk3588',
    'nvidia_small', 'nvidia_medium', 'nvidia_large',
    'nvidia_rtx', 'apple_silicon'
];

if (!VALID_PROFILES.includes(_hwProfile)) {
    // Creative fallback: pick the most conservative profile but log a detailed warning
    console.warn(`[CONFIG] Unknown HARDWARE_PROFILE="${_hwProfile}". Falling back to "n100_like" (conservative/max compatibility).`);
    _hwProfile = 'n100_like';
}

// Finalize HARDWARE_PROFILE as const after validation
/** @type*/
const HARDWARE_PROFILE = _hwProfile;

/**
 * Hardware-aware circuit breaker threshold.
 * - Low-power (n100_like, celeron, arm64_rpi5): use conservative thresholds
 * - Standard (core_i3, amd_low): standard threshold
 * - Mid-range (core_i5, amd_mid, nvidia_small): higher tolerance
 * - High-performance (core_i7, amd_high, nvidia_medium/large, apple_silicon): maximum tolerance
 * 
 * Note: This threshold matches circuitBreaker.js PROFILE_THRESHOLDS values.
 */

// Direct threshold values matching circuitBreaker.js
const PROFILE_THRESHOLDS = {
    // Low-power Intel
    'n100_like': 0.15,
    'n305': 0.25,
    'celeron': 0.20,

    // Standard Intel
    'core_i3': 0.25,
    'core_i5': 0.30,
    'core_i7': 0.35,

    // AMD
    'amd_low': 0.15,
    'amd_mid': 0.25,
    'amd_high': 0.35,

    // ARM (Raspberry Pi, ARM servers)
    'arm64_rpi5': 0.20,
    'arm64_server': 0.25,
    'arm64_rk3588': 0.30,

    // GPU-accelerated (dedicated VRAM)
    'nvidia_small': 0.30,   // 4GB VRAM
    'nvidia_medium': 0.35,  // 8GB VRAM
    'nvidia_large': 0.40,   // 12-24GB VRAM

    // Apple Silicon
    'apple_silicon': 0.35,
};

// Allow override via environment variable
const _cbEnv = parseFloat(process.env.OLLAMA_CIRCUIT_BREAKER_THRESHOLD);
const CIRCUIT_BREAKER_THRESHOLD = (!isNaN(_cbEnv))
    ? _cbEnv
    : (PROFILE_THRESHOLDS[HARDWARE_PROFILE] ?? 0.15);

// Queue concurrency limits per hardware profile
// Low-power: 1 task (limited RAM)
// Mid-range: 2-3 tasks (moderate RAM)
// High-performance: 4-6 tasks (abundant RAM + GPU)
const PROFILE_CONCURRENCY = {
    // Low-power Intel
    'n100_like': 1,           // 8GB RAM - single task only, safe for N100
    'n305': 2,                // 16GB RAM / 8-core - 2 parallel
    'celeron': 1,

    // Standard Intel
    'core_i3': 1,             // 8-12GB RAM - single task
    'core_i5': 2,             // 16GB RAM - 2 parallel
    'core_i7': 3,             // 32GB RAM - 3 parallel

    // AMD
    'amd_low': 1,
    'amd_mid': 2,
    'amd_high': 4,            // Ryzen 7/9 with 32GB+

    // NVIDIA RTX (dedicated GPU)
    'nvidia_rtx': 4,           // RTX 3060/4070/4090 with 8-24GB VRAM

    // ARM (Raspberry Pi, ARM servers)
    'arm64_rpi5': 1,
    'arm64_server': 2,
    'arm64_rk3588': 2,        // RK3588 with 8-16GB RAM

    // GPU-accelerated (dedicated VRAM helps parallelism)
    'nvidia_small': 2,        // 4GB VRAM
    'nvidia_medium': 4,        // 8GB VRAM
    'nvidia_large': 6,         // 12-24GB VRAM

    // Apple Silicon
    'apple_silicon': 4,
};

// Allow override via environment variable
const MAX_CONCURRENCY = parseInt(process.env.MAX_CONCURRENCY, 10)
    || PROFILE_CONCURRENCY[HARDWARE_PROFILE]
    || 1;

/** @type*/
const TRUST_MODE = process.env.TRUST_MODE || 'supervised';
if (!['supervised', 'graduated', 'autonomous'].includes(TRUST_MODE)) {
    console.error(`[CONFIG] Invalid TRUST_MODE="${TRUST_MODE}". Must be supervised|graduated|autonomous.`);
    process.exit(1);
}

/** @type*/
const KILO_API_TOKEN = process.env.KILO_API_TOKEN;

/**
 * JSON map of per-tenant API tokens: { "<token>": "<tenantId>" }.
 * When set, takes precedence over KILO_API_TOKEN for multi-tenant deployments.
 * At least one of TENANT_TOKENS or KILO_API_TOKEN must be provided.
 * @type
 */
const TENANT_TOKENS = process.env.TENANT_TOKENS;

/**
 * Bearer token required to scrape /metrics. When unset, /metrics is bound
 * to localhost only via reverse-proxy config; this header is the application-
 * layer fallback for when the proxy is not present (e.g. local dev, Docker).
 * Production deployments must set this — Prometheus dumps leak per-tenant
 * counters and queue contents.
 * @type
 */
const METRICS_TOKEN = process.env.METRICS_TOKEN;

if (!KILO_API_TOKEN && !TENANT_TOKENS) {
    console.error('[CONFIG] At least one of KILO_API_TOKEN or TENANT_TOKENS is required.');
    process.exit(1);
}

/**
 * Base directory for tenant workspace isolation.
 * workspace_path values submitted by clients must be children of this path.
 * Defaults to /var/kilo/workspaces (must be a shared volume root).
 * @type
 */
const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT || '/var/kilo/workspaces';

/**
 * Per-tenant maximum concurrent tasks (hard cap; overrides hardware profile).
 * Set to 0 to use only hardware-profile-derived MAX_CONCURRENCY per tenant.
 * @type
 */
const TENANT_MAX_CONCURRENCY = parseInt(process.env.TENANT_MAX_CONCURRENCY, 10) || 2;

/** @type*/
const config = Object.freeze({
    /** Hardware profile: n100_like | celeron | core_i3 | core_i5 | amd_low | amd_mid */
    HARDWARE_PROFILE,

    /** Pipeline HTTP port */
    PORT: parseInt(process.env.KILO_PIPELINE_PORT, 10) || 3100,

    /** Trust mode: supervised | graduated | autonomous */
    TRUST_MODE,

    /** Qdrant vector DB endpoint */
    QDRANT_HOST: process.env.QDRANT_HOST || 'http://qdrant:6333',

    /** Bearer token for kilo-pipeline API auth (legacy single-tenant) */
    KILO_API_TOKEN,

    /** Per-tenant token map JSON string (multi-tenant) */
    TENANT_TOKENS,

    /** Bearer token required to scrape /metrics (defence-in-depth over network policy) */
    METRICS_TOKEN,

    /** Base path under which all tenant workspaces must reside */
    WORKSPACE_ROOT,

    /** Per-tenant concurrency cap (prevents one tenant starving others) */
    TENANT_MAX_CONCURRENCY,

    /** Docker socket proxy endpoint for sandbox spawning */
    DOCKER_HOST: process.env.DOCKER_HOST || 'tcp://kilo-proxy:2375',

    /** Ollama inference endpoint */
    OLLAMA_HOST: process.env.OLLAMA_HOST || 'http://ollama:11434',

    /** Checkpoint base path on host volume */
    CHECKPOINT_DIR: '/var/kilo/checkpoints',

    /** Failure ledger path */
    FAILURE_LEDGER_DIR: '/var/kilo/failure_ledger',

    /** .kilo project directory (mounted from repo) */
    KILO_PROJECT_DIR: '/app/.kilo',

    /** MiniLM model cache dir */
    MODEL_CACHE_DIR: '/app/models',

    /** Sandbox memory limit */
    SANDBOX_MEM_LIMIT: '2g',

    /** Sandbox image */
    SANDBOX_IMAGE: 'node:20-slim',

    /** Memory retrieval timeout (ms) */
    MEMORY_TIMEOUT_MS: 90_000,

    /** Health check downstream timeout (ms) */
    HEALTH_CHECK_TIMEOUT_MS: 2_000,

    // -------------------------------------------------------------------------
    // Multi-provider LLM configuration
    // -------------------------------------------------------------------------

    /** Active LLM provider: ollama | openai | anthropic | openrouter | deepseek */
    LLM_PROVIDER: process.env.LLM_PROVIDER || 'ollama',

    /** Per-call LLM deadline in ms. Applies to all providers. */
    LLM_TIMEOUT_MS: parseInt(process.env.LLM_TIMEOUT_MS, 10) || 120_000,

    /** Model override. When empty each provider uses its built-in default. */
    LLM_MODEL: process.env.LLM_MODEL || '',

    // Cloud provider endpoints — override only if using a proxy or custom deployment
    OPENAI_BASE_URL:     process.env.OPENAI_BASE_URL     || 'https://api.openai.com',
    ANTHROPIC_BASE_URL:  process.env.ANTHROPIC_BASE_URL  || 'https://api.anthropic.com',
    OPENROUTER_BASE_URL: process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api',
    DEEPSEEK_BASE_URL:   process.env.DEEPSEEK_BASE_URL   || 'https://api.deepseek.com',

    // API keys — required only when the matching provider is active
    OPENAI_API_KEY:     process.env.OPENAI_API_KEY     || '',
    ANTHROPIC_API_KEY:  process.env.ANTHROPIC_API_KEY  || '',
    OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY || '',
    DEEPSEEK_API_KEY:   process.env.DEEPSEEK_API_KEY   || '',

    /** Watcher reconciliation interval (cron) */
    RECONCILIATION_CRON: '*/5 * * * *',

    /** Circuit breaker threshold - hardware-aware based on HARDWARE_PROFILE */
    CIRCUIT_BREAKER_THRESHOLD,

    /** Maximum parallel tasks - hardware-aware based on HARDWARE_PROFILE */
    MAX_CONCURRENCY,

    // -------------------------------------------------------------------------
    // Self-improvement cron schedules & thresholds
    // -------------------------------------------------------------------------

    /** Memory Decay: cron schedule for weekly invariant demotion (default: Sunday 03:00) */
    DECAY_CRON: process.env.DECAY_CRON || '0 3 * * 0',

    /** Memory Decay: days without use before an invariant is considered stale */
    DECAY_STALE_DAYS: parseInt(process.env.DECAY_STALE_DAYS, 10) || 90,

    /** Memory Decay: false-positive rate above which a rule is demoted (0–1) */
    DECAY_FP_THRESHOLD: parseFloat(process.env.DECAY_FP_THRESHOLD) || 0.30,

    /** Idle Reflection: cron schedule for quarantine analysis (default: every hour) */
    IDLE_REFLECTION_CRON: process.env.IDLE_REFLECTION_CRON || '0 * * * *',

    /** Idle Reflection: max quarantine tasks to include in a single LLM batch */
    REFLECTION_BATCH_SIZE: parseInt(process.env.REFLECTION_BATCH_SIZE, 10) || 10,

    /** Curriculum Learning: cron schedule for dep changelog scraping (default: Monday 06:00) */
    CURRICULUM_CRON: process.env.CURRICULUM_CRON || '0 6 * * 1',

    /** Curriculum Learning: max packages to check per run (rate-limit for low-power nodes) */
    CURRICULUM_MAX_PKGS: parseInt(process.env.CURRICULUM_MAX_PKGS, 10) || 20,

    // ── Phase 2: identity / JWT config ──────────────────────────────────────
    /** URL to the identity service JWKS endpoint for JWT verification */
    IDENTITY_JWKS_URI: process.env.IDENTITY_JWKS_URI || 'http://localhost:3110/.well-known/jwks.json',
    /** JWT issuer claim expected in access tokens */
    JWT_ISSUER: process.env.JWT_ISSUER || 'https://identity.oweibo.io',
    /** JWT audience claim expected in access tokens */
    JWT_AUDIENCE: process.env.JWT_AUDIENCE || 'oweibo-api',
});

module.exports = config;

export {};
