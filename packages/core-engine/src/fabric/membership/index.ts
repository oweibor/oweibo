/**
 * K.2 membership sync (ADR-010 §3.2): PrincipalsPort → kf_principal_seeds
 * + kf_membership_records raw edges, MembershipChanged via the
 * transactional outbox, delta polls in the class-1 lane.
 */
export * from './MembershipSyncService.js';
