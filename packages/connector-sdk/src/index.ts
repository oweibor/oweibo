/**
 * @oweibo/connector-sdk — D.4 (domain-depth) author SDK.
 *
 * Public surface for connector authors:
 *   - declareConnector(): build a typed bundle from the spec
 *   - validateBundle():    schema + invariant check
 *   - runCertificationSuite(): tier-appropriate certification harness
 *   - DomainCertificationBattery: per-domain assertion contract
 */
export * from './declareConnector.js';
export * from './contractValidator.js';
export * from './certificationRunner.js';
export * from './domainBattery.js';
// ADR-012 contract predicate (INV-15). Ports + certification harness land at K.1.
export * from './contract/manifestTruthfulness.js';
