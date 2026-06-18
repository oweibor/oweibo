/**
 * D.1: legal ontology pack — v1 stub.
 */
import type { OntologyPack } from '@oweibo/core-contracts';

export const legalOntologyPack: OntologyPack = {
  domainSlug: 'legal',
  packVersion: '1.0.0-stub',
  registryVersion: '1.0.0',
  glossary: [
    {
      term: 'AC privilege',
      definition: 'Attorney-client privilege; protects communications made for the purpose of obtaining legal advice',
      aliases: ['attorney-client privilege', 'A/C privilege'],
      category: 'privilege',
    },
    {
      term: 'WP doctrine',
      definition: 'Work-product doctrine; protects materials prepared in anticipation of litigation',
      aliases: ['work product doctrine'],
      category: 'privilege',
    },
    {
      term: 'eDiscovery',
      definition: 'Electronic discovery; identification, preservation, collection, and production of ESI in litigation',
      aliases: ['e-discovery', 'electronic discovery'],
      category: 'litigation',
    },
    {
      term: 'COI',
      definition: 'Conflict of interest; situation where representation duties to one client adversely affect another',
      aliases: ['conflict of interest'],
      category: 'ethics',
    },
    {
      term: 'NDA',
      definition: 'Non-disclosure agreement; contract restricting disclosure of confidential information',
      aliases: ['non-disclosure agreement', 'confidentiality agreement'],
      category: 'contracts',
    },
  ],
  namedEntities: [
    {
      canonicalName: 'ABA Model Rules',
      entityType: 'framework',
      aliases: ['ABA Model Rules of Professional Conduct'],
      description: 'American Bar Association model ethics rules adopted in some form by most US state bars',
      jurisdictions: ['US'],
    },
    {
      canonicalName: 'FRCP',
      entityType: 'standard',
      aliases: ['Federal Rules of Civil Procedure'],
      description: 'Procedural rules governing civil suits in US federal district courts',
      jurisdictions: ['US'],
    },
  ],
  terminology: [
    {
      preferred: 'privileged',
      deprecated: ['confidential'],
      reason: '"Privileged" implies legal privilege (non-discoverable); "confidential" only implies restricted distribution. Misuse risks waiver',
      enforcement: 'block',
    },
  ],
  disambiguations: [
    {
      ambiguousTerm: 'matter',
      senses: [
        {
          meaning: 'legal matter (case or representation)',
          contextTriggers: ['client', 'docket', 'opened', 'closed', 'billing'],
          weight: 1.0,
        },
        {
          meaning: 'subject or issue',
          contextTriggers: ['discuss', 'concern', 'topic'],
          weight: 0.5,
        },
      ],
      defaultSense: 'legal matter (case or representation)',
    },
  ],
  metadata: {
    authoredBy: 'platform-domain-team@oweibo (2026-05-28)',
    reviewedBy: [],
    authoredAt: '2026-05-28',
    nextReviewDue: '2026-11-28',
    sourceRefs: ['ABA Model Rules of Professional Conduct (current ed.)'],
  },
};
