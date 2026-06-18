/**
 * D.1: education ontology pack — v1 minimal stub.
 */
import type { OntologyPack } from '@oweibo/core-contracts';

export const educationOntologyPack: OntologyPack = {
  domainSlug: 'education',
  packVersion: '1.0.0-stub',
  registryVersion: '1.0.0',
  glossary: [
    {
      term: 'LMS',
      definition: 'Learning management system; software for delivering, tracking, and reporting on educational content',
      aliases: ['learning management system'],
      category: 'tooling',
    },
    {
      term: 'SIS',
      definition: 'Student information system; system of record for enrollment, grades, and demographic data',
      aliases: ['student information system'],
      category: 'tooling',
    },
    {
      term: 'FERPA',
      definition: 'Family Educational Rights and Privacy Act; US federal law protecting student education records',
      aliases: [],
      category: 'compliance',
      jurisdictions: ['US'],
    },
  ],
  namedEntities: [
    {
      canonicalName: 'FERPA',
      entityType: 'framework',
      aliases: ['Family Educational Rights and Privacy Act'],
      description: 'US federal law (20 U.S.C. § 1232g) governing student education records',
      jurisdictions: ['US'],
    },
  ],
  terminology: [],
  disambiguations: [],
  metadata: {
    authoredBy: 'platform-domain-team@oweibo (2026-05-28)',
    reviewedBy: [],
    authoredAt: '2026-05-28',
    nextReviewDue: '2026-11-28',
    sourceRefs: ['20 U.S.C. § 1232g (FERPA)'],
  },
};
