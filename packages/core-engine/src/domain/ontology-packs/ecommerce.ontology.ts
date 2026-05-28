/**
 * D.1: ecommerce ontology pack — v1 stub.
 */
import type { OntologyPack } from '@oweibo/core-contracts';

export const ecommerceOntologyPack: OntologyPack = {
  domainSlug: 'ecommerce',
  packVersion: '1.0.0-stub',
  registryVersion: '1.0.0',
  glossary: [
    {
      term: 'SKU',
      definition: 'Stock-keeping unit; merchant-assigned identifier for a sellable item variant',
      aliases: ['stock keeping unit'],
      category: 'catalog',
    },
    {
      term: 'AOV',
      definition: 'Average order value; total revenue divided by order count over a window',
      aliases: ['average order value'],
      category: 'metrics',
    },
    {
      term: 'GMV',
      definition: 'Gross merchandise value; total sale value of goods sold via the platform',
      aliases: ['gross merchandise value'],
      category: 'metrics',
    },
    {
      term: '3PL',
      definition: 'Third-party logistics; outsourced warehousing and fulfillment provider',
      aliases: ['third party logistics'],
      category: 'fulfillment',
    },
    {
      term: 'BOPIS',
      definition: 'Buy online, pick up in store',
      aliases: ['click and collect'],
      category: 'fulfillment',
    },
  ],
  namedEntities: [
    {
      canonicalName: 'Shopify',
      entityType: 'product',
      aliases: [],
      description: 'E-commerce platform; storefront, payments, and fulfillment toolkit',
    },
  ],
  terminology: [
    {
      preferred: 'inventory',
      deprecated: ['stock'],
      reason: '"Inventory" matches the broader fulfillment/ERP vocabulary; "stock" is colloquial and ambiguous (also a securities term)',
      enforcement: 'suggest',
    },
  ],
  disambiguations: [
    {
      ambiguousTerm: 'cart',
      senses: [
        {
          meaning: 'shopping cart',
          contextTriggers: ['checkout', 'order', 'add', 'abandon'],
          weight: 1.0,
        },
      ],
      defaultSense: 'shopping cart',
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
