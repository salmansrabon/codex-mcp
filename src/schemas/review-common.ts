import { z } from 'zod';

/** Shared vocabulary for both review result shapes (PLAN.md §13.3). */
export const ReviewStatusSchema = z.enum(['PASS', 'CHANGES_REQUIRED', 'INCONCLUSIVE', 'ERROR']);
export type ReviewStatus = z.infer<typeof ReviewStatusSchema>;

export const ConfidenceSchema = z.enum(['low', 'medium', 'high']);
export const PrioritySchema = z.enum(['low', 'medium', 'high', 'critical']);

export const EvidenceSchema = z.object({
  source: z.string().min(1),
  location: z.string().min(1),
  note: z.string().optional(),
});
export type Evidence = z.infer<typeof EvidenceSchema>;

/**
 * A gap in what the reviewer could actually inspect. Recording these is what
 * keeps an under-informed review honest instead of confidently wrong.
 */
export const LimitationSchema = z.object({
  area: z.string().min(1).describe('What could not be verified: requirement, database, runtime, external-system, ...'),
  detail: z.string().min(1),
  impact: z.string().optional(),
});
export type Limitation = z.infer<typeof LimitationSchema>;

/** A point where the reviewer and the authoring agent genuinely disagree. */
export const DisagreementSchema = z.object({
  candidateId: z.string().optional(),
  topic: z.string().min(1),
  candidatePosition: z.string().min(1),
  reviewerPosition: z.string().min(1),
  evidence: z.array(EvidenceSchema).default([]),
  resolutionHint: z.string().optional(),
});
export type Disagreement = z.infer<typeof DisagreementSchema>;
