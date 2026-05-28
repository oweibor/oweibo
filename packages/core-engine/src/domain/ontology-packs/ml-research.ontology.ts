/**
 * D.1: ml-research ontology pack — v1 stub.
 */
import type { OntologyPack } from '@oweibo/core-contracts';

export const mlResearchOntologyPack: OntologyPack = {
  domainSlug: 'ml-research',
  packVersion: '1.0.0-stub',
  registryVersion: '1.0.0',
  glossary: [
    {
      term: 'LR',
      definition: 'Learning rate; hyperparameter controlling step size in gradient-based optimization',
      aliases: ['learning rate'],
      category: 'optimization',
    },
    {
      term: 'CE loss',
      definition: 'Cross-entropy loss; standard classification objective',
      aliases: ['cross-entropy', 'cross entropy loss'],
      category: 'losses',
    },
    {
      term: 'IID',
      definition: 'Independent and identically distributed; assumption that samples are drawn independently from the same distribution',
      aliases: ['i.i.d.', 'iid'],
      category: 'stats',
    },
    {
      term: 'OOD',
      definition: 'Out-of-distribution; data drawn from a different distribution than training (often used in eval)',
      aliases: ['out of distribution'],
      category: 'eval',
    },
    {
      term: 'SOTA',
      definition: 'State-of-the-art; the best-known result on a benchmark at a given time',
      aliases: ['state of the art'],
      category: 'eval',
    },
    {
      term: 'FLOPs',
      definition: 'Floating-point operations; a compute-cost unit (distinct from FLOPS, ops per second)',
      aliases: ['flops'],
      category: 'compute',
    },
  ],
  namedEntities: [
    {
      canonicalName: 'arXiv',
      entityType: 'product',
      aliases: [],
      description: 'Open-access preprint server widely used for ML research distribution',
    },
    {
      canonicalName: 'Weights & Biases',
      entityType: 'product',
      aliases: ['W&B', 'wandb'],
      description: 'Experiment-tracking and ML-Ops platform',
    },
    {
      canonicalName: 'Hugging Face',
      entityType: 'product',
      aliases: ['HF'],
      description: 'Model and dataset hub plus inference platform; canonical Transformers library maintainer',
    },
  ],
  terminology: [
    {
      preferred: 'reproducibility',
      deprecated: ['replication'],
      reason: 'In ML "reproducibility" denotes obtaining the same result with the same code+data; "replication" is the broader statistical concept. Use the precise term in code/docs',
      enforcement: 'suggest',
    },
  ],
  disambiguations: [
    {
      ambiguousTerm: 'embedding',
      senses: [
        {
          meaning: 'vector representation',
          contextTriggers: ['vector', 'dimension', 'cosine', 'index', 'retrieval'],
          weight: 1.0,
        },
        {
          meaning: 'embedded system',
          contextTriggers: ['firmware', 'mcu', 'arm', 'rtos'],
          weight: 1.0,
        },
      ],
      defaultSense: 'vector representation',
    },
  ],
  metadata: {
    authoredBy: 'platform-domain-team@oweibo (2026-05-28)',
    reviewedBy: [],
    authoredAt: '2026-05-28',
    nextReviewDue: '2026-11-28',
    sourceRefs: ['Goodfellow, Bengio, Courville (2016), Deep Learning'],
  },
};
