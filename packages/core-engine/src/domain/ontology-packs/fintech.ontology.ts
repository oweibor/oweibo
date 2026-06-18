/**
 * D.1: fintech ontology pack — v1 stub.
 *
 * v1 ships a representative ~15 entries per category as the initial seed.
 * The full SME-curated pack (per ttv-domain-depth.md §D.1 sizing table:
 * ~300 glossary, ~80 named entities, ~40 terminology, ~30 disambiguations)
 * is filled in by the domain specialist team in follow-up commits; the
 * pack shape is stable so adding entries is non-breaking.
 */
import type { OntologyPack } from '@oweibo/core-contracts';

export const fintechOntologyPack: OntologyPack = {
  domainSlug: 'fintech',
  packVersion: '1.0.0-stub',
  registryVersion: '1.0.0',
  glossary: [
    {
      term: 'EOD',
      definition: 'End-of-day; cutoff time for batch processing of trades and reconciliation',
      aliases: ['end of day', 'EoD'],
      category: 'trading',
    },
    {
      term: 'BPS',
      definition: 'Basis points; 1 bps = 0.01% (one hundredth of a percentage point)',
      aliases: ['bp', 'basis points', 'bips'],
      category: 'rates',
    },
    {
      term: 'NAV',
      definition: 'Net asset value; per-share value of a fund computed as (assets − liabilities) / shares outstanding',
      aliases: ['net asset value'],
      category: 'funds',
    },
    {
      term: 'KYC',
      definition: 'Know-your-customer; identity verification required by AML regulations',
      aliases: ['know your customer'],
      category: 'compliance',
    },
    {
      term: 'AML',
      definition: 'Anti-money-laundering; the regulatory regime requiring transaction monitoring and reporting',
      aliases: ['anti money laundering'],
      category: 'compliance',
    },
    {
      term: 'PnL',
      definition: 'Profit and loss; the running tally of realized + unrealized gains/losses for a position or book',
      aliases: ['P&L', 'pnl', 'profit and loss'],
      category: 'accounting',
    },
    {
      term: 'T+2',
      definition: 'Trade date plus two business days; the standard settlement window for US equities',
      aliases: ['T+2 settlement', 't plus 2'],
      category: 'settlement',
    },
    {
      term: 'FX',
      definition: 'Foreign exchange; currency conversion or the markets in which it trades',
      aliases: ['forex'],
      category: 'trading',
    },
    {
      term: 'ACH',
      definition: 'Automated Clearing House; the US batch electronic payments network',
      aliases: [],
      category: 'payments',
      jurisdictions: ['US'],
    },
    {
      term: 'SWIFT',
      definition: 'Society for Worldwide Interbank Financial Telecommunication; the dominant cross-border interbank messaging network',
      aliases: [],
      category: 'payments',
    },
  ],
  namedEntities: [
    {
      canonicalName: 'Federal Reserve',
      entityType: 'regulator',
      aliases: ['Fed', 'FRB', 'Federal Reserve Board'],
      description: 'US central bank; sets monetary policy and supervises depository institutions',
      jurisdictions: ['US'],
    },
    {
      canonicalName: 'Securities and Exchange Commission',
      entityType: 'regulator',
      aliases: ['SEC'],
      description: 'US federal agency that enforces securities laws and oversees the securities industry',
      jurisdictions: ['US'],
    },
    {
      canonicalName: 'FinCEN',
      entityType: 'regulator',
      aliases: ['Financial Crimes Enforcement Network'],
      description: 'US Treasury bureau that collects and analyzes BSA reports on financial transactions',
      jurisdictions: ['US'],
    },
    {
      canonicalName: 'PCI-DSS',
      entityType: 'standard',
      aliases: ['PCI Data Security Standard'],
      description: 'Payment Card Industry Data Security Standard; cardholder data protection requirements',
    },
    {
      canonicalName: 'SOC 2',
      entityType: 'standard',
      aliases: ['SOC2', 'Service Organization Control 2'],
      description: 'AICPA reporting framework on security, availability, processing integrity, confidentiality, and privacy controls',
    },
  ],
  terminology: [
    {
      preferred: 'cardholder data',
      deprecated: ['card data', 'CC data'],
      reason: 'PCI-DSS uses "cardholder data" as the canonical scoped term; mixing variants causes compliance ambiguity',
      enforcement: 'warn',
    },
    {
      preferred: 'wire transfer',
      deprecated: ['bank wire'],
      reason: '"wire transfer" is the universally recognized term across SWIFT and Fedwire documentation',
      enforcement: 'suggest',
    },
    {
      preferred: 'settlement',
      deprecated: ['clearing'],
      reason: 'Clearing and settlement are distinct phases — clearing produces obligations; settlement extinguishes them. Use the precise term',
      enforcement: 'warn',
    },
  ],
  disambiguations: [
    {
      ambiguousTerm: 'NAV',
      senses: [
        {
          meaning: 'net asset value',
          contextTriggers: ['fund', 'price', 'share', 'mutual', 'etf'],
          weight: 1.0,
        },
        {
          meaning: 'navigation',
          contextTriggers: ['route', 'gps', 'map', 'direction'],
          weight: 0.5,
        },
      ],
      defaultSense: 'net asset value',
    },
    {
      ambiguousTerm: 'EOD',
      senses: [
        {
          meaning: 'end-of-day',
          contextTriggers: ['cutoff', 'batch', 'reconcile', 'price', 'snapshot'],
          weight: 1.0,
        },
        {
          meaning: 'end of discussion',
          contextTriggers: ['conversation', 'thread', 'meeting'],
          weight: 0.5,
        },
      ],
      defaultSense: 'end-of-day',
    },
  ],
  metadata: {
    authoredBy: 'platform-domain-team@oweibo (2026-05-28)',
    reviewedBy: [],
    authoredAt: '2026-05-28',
    nextReviewDue: '2026-11-28',
    sourceRefs: [
      'FFIEC IT Examination Handbook (2024)',
      'PCI-DSS v4.0 (2022)',
    ],
  },
};
