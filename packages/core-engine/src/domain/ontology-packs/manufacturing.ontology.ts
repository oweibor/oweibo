/**
 * D.1: manufacturing ontology pack — v1 minimal stub.
 */
import type { OntologyPack } from '@oweibo/core-contracts';

export const manufacturingOntologyPack: OntologyPack = {
  domainSlug: 'manufacturing',
  packVersion: '1.0.0-stub',
  registryVersion: '1.0.0',
  glossary: [
    {
      term: 'MRP',
      definition: 'Material requirements planning; production-planning system that schedules raw-material orders against build forecasts',
      aliases: ['material requirements planning'],
      category: 'planning',
    },
    {
      term: 'BOM',
      definition: 'Bill of materials; hierarchical list of raw materials and sub-assemblies required to manufacture an item',
      aliases: ['bill of materials'],
      category: 'planning',
    },
    {
      term: 'WIP',
      definition: 'Work-in-progress; partially completed items currently being produced',
      aliases: ['work in progress'],
      category: 'production',
    },
    {
      term: 'OEE',
      definition: 'Overall equipment effectiveness; composite metric for production-line productivity (availability × performance × quality)',
      aliases: ['overall equipment effectiveness'],
      category: 'metrics',
    },
  ],
  namedEntities: [],
  terminology: [],
  disambiguations: [],
  metadata: {
    authoredBy: 'platform-domain-team@oweibo (2026-05-28)',
    reviewedBy: [],
    authoredAt: '2026-05-28',
    nextReviewDue: '2026-11-28',
    sourceRefs: [],
  },
};
