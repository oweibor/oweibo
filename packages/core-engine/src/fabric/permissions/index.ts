/**
 * ADR-010 permission contracts (K.2/K.3 substrate).
 *
 * Shipped at ADR-010 ratification as executable contract: the §3.5
 * withholding decision, the §3.1 snapshot-freshness gate, and the §3.3
 * closure algorithm. The retrieval storage gate and membership sync that
 * consume these are K.2/K.3 machinery.
 */
export * from './contract.js';
export * from './groupClosure.js';
