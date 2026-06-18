/**
 * D.1: media / publishing ontology pack — v1 minimal stub.
 */
import type { OntologyPack } from '@oweibo/core-contracts';

export const mediaOntologyPack: OntologyPack = {
  domainSlug: 'media',
  packVersion: '1.0.0-stub',
  registryVersion: '1.0.0',
  glossary: [
    {
      term: 'CMS',
      definition: 'Content management system; software for authoring and publishing editorial content',
      aliases: ['content management system'],
      category: 'tooling',
    },
    {
      term: 'CDN',
      definition: 'Content delivery network; geographically distributed cache for asset serving',
      aliases: ['content delivery network'],
      category: 'distribution',
    },
    {
      term: 'Embargo',
      definition: 'Time-restriction on publication or distribution agreed with a source',
      aliases: [],
      category: 'editorial',
    },
  ],
  namedEntities: [],
  terminology: [],
  disambiguations: [
    {
      ambiguousTerm: 'CMS',
      senses: [
        {
          meaning: 'content management system',
          contextTriggers: ['publish', 'editor', 'cms', 'wordpress', 'headless'],
          weight: 1.0,
        },
        {
          meaning: 'Centers for Medicare and Medicaid Services',
          contextTriggers: ['medicare', 'medicaid', 'cms.gov'],
          weight: 1.0,
        },
      ],
      defaultSense: 'content management system',
    },
  ],
  metadata: {
    authoredBy: 'platform-domain-team@oweibo (2026-05-28)',
    reviewedBy: [],
    authoredAt: '2026-05-28',
    nextReviewDue: '2026-11-28',
    sourceRefs: [],
  },
};
