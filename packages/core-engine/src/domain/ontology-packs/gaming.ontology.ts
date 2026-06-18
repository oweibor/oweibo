/**
 * D.1: gaming ontology pack — v1 minimal stub.
 */
import type { OntologyPack } from '@oweibo/core-contracts';

export const gamingOntologyPack: OntologyPack = {
  domainSlug: 'gaming',
  packVersion: '1.0.0-stub',
  registryVersion: '1.0.0',
  glossary: [
    {
      term: 'DAU',
      definition: 'Daily active users; unique users who interacted with the game in a 24-hour window',
      aliases: ['daily active users'],
      category: 'metrics',
    },
    {
      term: 'ARPPU',
      definition: 'Average revenue per paying user',
      aliases: [],
      category: 'monetization',
    },
    {
      term: 'D1 retention',
      definition: 'Share of new users still active 1 day after install',
      aliases: ['day-1 retention'],
      category: 'metrics',
    },
    {
      term: 'Live-ops',
      definition: 'Ongoing operation of a live game: events, content drops, balance changes, monetization tweaks',
      aliases: ['live operations', 'liveops'],
      category: 'operations',
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
