import { z } from 'zod';
import { CANONICAL_ROLES } from '@oweibo/core-contracts';

export const LessonV1Schema = z.object({
  schemaVersion:       z.literal('1'),
  taskId:              z.string().uuid(),
  tenantId:            z.string().uuid(),
  role:                z.enum(CANONICAL_ROLES as [string, ...string[]]),
  slotId:              z.string().min(1).max(100),
  channel:             z.string().min(1).max(100),
  outcome:             z.enum(['success', 'failure', 'recovery']),
  abstractPattern:     z.string().min(10).max(2_000),
  toolSequence:        z.array(z.string()).optional(),
  errorClass:          z.string().optional(),
  subgoalCount:        z.number().optional(),
  dependencyEdgeCount: z.number().optional(),
  estimatedComplexity: z.number().optional(),
  confidence:          z.number().min(0).max(1),
  novel:               z.boolean(),
  fingerprint:         z.string().length(64),
  generatedAt:         z.string().datetime(),
  signature:           z.string().optional(),
});
