import { z } from 'zod';

import {
  ConfidenceSchema,
  DisagreementSchema,
  EvidenceSchema,
  LimitationSchema,
  MemoryFactSchema,
  ObjectionShape,
  SeverityQualifierShape,
  ReviewStatusSchema,
  VerificationShape,
} from './review-common.js';

/** Bug review verdicts (PLAN.md §13.2, §13.4). */

export const BugVerdictSchema = z.enum([
  'VERIFIED',
  'FALSE_POSITIVE',
  'NEEDS_MORE_EVIDENCE',
  'SEVERITY_DISAGREEMENT',
  'DUPLICATE_OR_ALREADY_COVERED',
  'INCONCLUSIVE',
]);
export type BugVerdict = z.infer<typeof BugVerdictSchema>;

export const BugFindingSchema = z.object({
  candidateId: z.string().min(1),
  verdict: BugVerdictSchema,
  confidence: ConfidenceSchema,
  severityAssessment: z.string().nullable().optional(),
  reason: z.string().min(1),
  evidence: z.array(EvidenceSchema).default([]),
  recommendation: z.string().min(1),
  missingEvidence: z.array(z.string()).default([]),
  duplicateOf: z.string().optional(),
  ...SeverityQualifierShape,
  ...VerificationShape,
});
export type BugFinding = z.infer<typeof BugFindingSchema>;

/** A defect the reviewer found that the candidate set did not report. */
export const AdditionalBugSchema = z.object({
  title: z.string().min(1),
  severity: z.string().optional(),
  reason: z.string().min(1),
  evidence: z.array(EvidenceSchema).default([]),
  ...SeverityQualifierShape,
  ...VerificationShape,
  ...ObjectionShape,
});

export const BugReviewResultSchema = z
  .object({
    status: ReviewStatusSchema,
    summary: z
      .object({
        verified: z.number().int().min(0),
        falsePositive: z.number().int().min(0),
        needsMoreEvidence: z.number().int().min(0),
        other: z.number().int().min(0),
      })
      .optional(),
    findings: z.array(BugFindingSchema).default([]),
    additionalFindings: z.array(AdditionalBugSchema).default([]),
    disagreements: z.array(DisagreementSchema).default([]),
    limitations: z.array(LimitationSchema).default([]),
    /** Durable facts the server should remember for the next review of this project. */
    projectMemory: z.array(MemoryFactSchema).default([]),
    reviewerNotes: z.string().optional(),
  })
  .strip();

export type BugReviewResult = z.infer<typeof BugReviewResultSchema>;
