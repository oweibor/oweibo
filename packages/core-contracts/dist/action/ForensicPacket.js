"use strict";
/**
 * S.7 (ttv-action-safety-v2): forensic packet + replay contracts.
 *
 * A `ForensicPacket` is the full audit-grade snapshot of a single
 * action plan: the goal that produced it, every agent decision, every
 * gate decision, every adapter call, every verifier result, every
 * rollback. Suitable for delivery to legal counsel, compliance
 * auditors, or internal incident review.
 *
 * Packets are stored in object storage (S3 / MinIO), encrypted at
 * rest, signed at build time with HMAC-SHA256, with a row in
 * oweibo.forensic_packets keyed by storage ref + signature.
 *
 * Replay is a separate concern: an ActionReplayRun re-walks a plan's
 * decision chain *without* invoking real adapter execute() — only
 * preflight + verifier paths. Three replay kinds:
 *   * shadow_full — re-run every step in shadow mode
 *   * shadow_step — re-run a single step
 *   * what_if     — re-run with a single parameter mutated
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.FORENSIC_PACKET_SCHEMA_VERSION = void 0;
exports.severityToAutoTrigger = severityToAutoTrigger;
exports.FORENSIC_PACKET_SCHEMA_VERSION = 1;
// ── Pure helpers ─────────────────────────────────────────────────────────
/**
 * Severity → trigger-kind for auto-fire HITL handoffs. Returns null if
 * the severity doesn't warrant an automatic packet.
 */
function severityToAutoTrigger(severity) {
    if (severity < 3)
        return null;
    return 'auto_drift';
}
//# sourceMappingURL=ForensicPacket.js.map