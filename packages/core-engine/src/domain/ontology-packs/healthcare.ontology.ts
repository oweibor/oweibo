/**
 * D.1: healthcare ontology pack — v1 stub.
 * Full SME-curated pack (target ~400 glossary entries per
 * ttv-domain-depth.md §D.1) lands incrementally.
 */
import type { OntologyPack } from '@oweibo/core-contracts';

export const healthcareOntologyPack: OntologyPack = {
  domainSlug: 'healthcare',
  packVersion: '1.0.0-stub',
  registryVersion: '1.0.0',
  glossary: [
    {
      term: 'PHI',
      definition: 'Protected health information; individually identifiable health data covered by HIPAA',
      aliases: ['protected health information'],
      category: 'compliance',
    },
    {
      term: 'BAA',
      definition: 'Business associate agreement; HIPAA-required contract for vendors handling PHI on a covered entity\'s behalf',
      aliases: ['business associate agreement'],
      category: 'compliance',
    },
    {
      term: 'EHR',
      definition: 'Electronic health record; longitudinal patient chart maintained by a provider',
      aliases: ['electronic health record', 'EMR', 'electronic medical record'],
      category: 'clinical-systems',
    },
    {
      term: 'MRN',
      definition: 'Medical record number; provider-issued patient identifier',
      aliases: ['medical record number'],
      category: 'identifiers',
    },
    {
      term: 'ICD-10',
      definition: 'International Classification of Diseases, 10th revision; diagnostic coding standard',
      aliases: ['ICD10'],
      category: 'coding',
    },
    {
      term: 'HL7',
      definition: 'Health Level Seven; family of standards for clinical data exchange (HL7 v2 messages, FHIR, CDA)',
      aliases: [],
      category: 'interop',
    },
    {
      term: 'FHIR',
      definition: 'Fast Healthcare Interoperability Resources; modern REST/JSON standard from HL7 for clinical data exchange',
      aliases: [],
      category: 'interop',
    },
    {
      term: 'CPT',
      definition: 'Current Procedural Terminology; AMA-maintained procedure-coding standard',
      aliases: [],
      category: 'coding',
    },
  ],
  namedEntities: [
    {
      canonicalName: 'HIPAA',
      entityType: 'framework',
      aliases: ['Health Insurance Portability and Accountability Act'],
      description: 'US federal law setting privacy, security, and breach-notification standards for PHI',
      jurisdictions: ['US'],
    },
    {
      canonicalName: 'HHS',
      entityType: 'regulator',
      aliases: ['Department of Health and Human Services'],
      description: 'US cabinet department; enforces HIPAA via the Office for Civil Rights',
      jurisdictions: ['US'],
    },
    {
      canonicalName: 'CMS',
      entityType: 'regulator',
      aliases: ['Centers for Medicare and Medicaid Services'],
      description: 'US agency administering Medicare, Medicaid, and the Health Insurance Marketplace',
      jurisdictions: ['US'],
    },
    {
      canonicalName: 'Epic',
      entityType: 'product',
      aliases: [],
      description: 'Widely deployed EHR system; common integration target for healthcare connectors',
    },
    {
      canonicalName: 'OCR',
      entityType: 'regulator',
      aliases: ['Office for Civil Rights'],
      description: 'HHS office responsible for HIPAA enforcement and breach investigations',
      jurisdictions: ['US'],
    },
  ],
  terminology: [
    {
      preferred: 'protected health information',
      deprecated: ['personal health data', 'medical data'],
      reason: 'HIPAA defines "PHI" precisely; lay synonyms blur the regulatory scope',
      enforcement: 'warn',
    },
    {
      preferred: 'de-identified',
      deprecated: ['anonymized'],
      reason: 'HIPAA Safe Harbor and Expert Determination use "de-identified"; "anonymized" carries different meaning under GDPR',
      enforcement: 'warn',
    },
    {
      preferred: 'covered entity',
      deprecated: ['HIPAA org'],
      reason: '"Covered entity" is the regulatory term; alternatives obscure scope (a vendor is a business associate, not a covered entity)',
      enforcement: 'block',
    },
  ],
  disambiguations: [
    {
      ambiguousTerm: 'OCR',
      senses: [
        {
          meaning: 'Office for Civil Rights',
          contextTriggers: ['hipaa', 'enforcement', 'breach', 'audit', 'investigation'],
          weight: 1.0,
        },
        {
          meaning: 'optical character recognition',
          contextTriggers: ['scan', 'image', 'pdf', 'extract', 'text'],
          weight: 1.0,
        },
      ],
      defaultSense: 'Office for Civil Rights',
    },
  ],
  metadata: {
    authoredBy: 'platform-domain-team@oweibo (2026-05-28)',
    reviewedBy: [],
    authoredAt: '2026-05-28',
    nextReviewDue: '2026-11-28',
    sourceRefs: [
      '45 CFR Parts 160 and 164 (HIPAA Privacy & Security Rules)',
      'HL7 FHIR R4 (2019)',
    ],
  },
};
