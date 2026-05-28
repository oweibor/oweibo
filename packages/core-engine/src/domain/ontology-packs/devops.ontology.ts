/**
 * D.1: devops ontology pack — v1 stub.
 */
import type { OntologyPack } from '@oweibo/core-contracts';

export const devopsOntologyPack: OntologyPack = {
  domainSlug: 'devops',
  packVersion: '1.0.0-stub',
  registryVersion: '1.0.0',
  glossary: [
    {
      term: 'SLO',
      definition: 'Service level objective; internal target for a service quality metric',
      aliases: ['service level objective'],
      category: 'reliability',
    },
    {
      term: 'SLI',
      definition: 'Service level indicator; the measurement underlying an SLO',
      aliases: ['service level indicator'],
      category: 'reliability',
    },
    {
      term: 'SLA',
      definition: 'Service level agreement; contractual commitment, typically with consequences for breach',
      aliases: ['service level agreement'],
      category: 'reliability',
    },
    {
      term: 'MTTR',
      definition: 'Mean time to recovery; average time between incident detection and resolution',
      aliases: ['mean time to recovery', 'mean time to restore'],
      category: 'incident',
    },
    {
      term: 'P0',
      definition: 'Priority 0; highest-severity incident (typically all-hands, all-rest-paged)',
      aliases: ['SEV-0', 'sev0'],
      category: 'incident',
    },
    {
      term: 'Canary',
      definition: 'Deploy strategy that exposes a small traffic slice to a new release for verification before full rollout',
      aliases: ['canary deploy', 'canary release'],
      category: 'deploy',
    },
  ],
  namedEntities: [
    {
      canonicalName: 'Datadog',
      entityType: 'product',
      aliases: [],
      description: 'Observability platform; metrics, traces, logs',
    },
    {
      canonicalName: 'PagerDuty',
      entityType: 'product',
      aliases: [],
      description: 'On-call scheduling and incident-alerting platform',
    },
    {
      canonicalName: 'Kubernetes',
      entityType: 'protocol',
      aliases: ['k8s'],
      description: 'Container orchestration system',
    },
  ],
  terminology: [
    {
      preferred: 'rollback',
      deprecated: ['undo deploy'],
      reason: '"Rollback" is the precise SRE term and aligns with incident-runbook vocabulary; "undo deploy" is imprecise',
      enforcement: 'suggest',
    },
  ],
  disambiguations: [
    {
      ambiguousTerm: 'pod',
      senses: [
        {
          meaning: 'Kubernetes pod',
          contextTriggers: ['kubernetes', 'k8s', 'container', 'namespace', 'deployment'],
          weight: 1.0,
        },
        {
          meaning: 'physical compute pod',
          contextTriggers: ['datacenter', 'rack', 'cage'],
          weight: 0.5,
        },
      ],
      defaultSense: 'Kubernetes pod',
    },
  ],
  metadata: {
    authoredBy: 'platform-domain-team@oweibo (2026-05-28)',
    reviewedBy: [],
    authoredAt: '2026-05-28',
    nextReviewDue: '2026-11-28',
    sourceRefs: ['Google SRE Book (2016)'],
  },
};
