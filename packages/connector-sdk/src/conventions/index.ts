/**
 * K.1 convention layer (ADR-012 §3.5) — defaults the SDK provides so
 * authored adapters stay thin. The heavyweight cross-cutting mechanics
 * (retry around every port call, pagination draining with checkpoints,
 * quota accounting, event emission) live in the platform runtime
 * pipeline, built exactly once; these helpers are the author-side
 * conveniences for private composition inside an adapter.
 */
export * from './paginate.js';
export * from './retry.js';
export * from './webhook.js';
