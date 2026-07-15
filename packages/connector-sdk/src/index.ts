/**
 * @oweibo/connector-sdk — connector author SDK (D.4 surface + K.1 fabric
 * extension, ADR-012).
 *
 * Public surface for connector authors:
 *   - declareConnector(): build a typed bundle from the spec
 *   - validateBundle():    schema + invariant check
 *   - runCertificationSuite(): tier-appropriate certification harness,
 *     including the K.1 port contract tests + INV-15 manifest truthfulness
 *   - DomainCertificationBattery: per-domain assertion contract
 *   - ports/: the six source-adapter port interfaces (ADR-012 §3.2)
 *   - conventions/: pagination, retry, webhook-verification helpers
 *   - testing/: MockSourceAdapter fixture set for batteries and authors
 */
export * from './context.js';
export * from './declareConnector.js';
export * from './contractValidator.js';
export * from './certificationRunner.js';
export * from './domainBattery.js';
export * from './version.js';
// ADR-012 contract predicate (INV-15) + the K.1 harness that feeds it.
export * from './contract/manifestTruthfulness.js';
export * from './portContracts.js';
export * from './ports/index.js';
export * from './conventions/index.js';
export * from './testing/mockSource.js';
export * from './testing/connectorSimulator.js';
