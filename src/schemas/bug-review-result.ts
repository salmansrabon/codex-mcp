import { z } from 'zod';

import {
  CitationAssessmentSchema,
  CitationCheckSchema,
  ConfidenceSchema,
  DisagreementSchema,
  EvidenceSchema,
  LimitationSchema,
  MemoryFactSchema,
  ObjectionShape,
  RefutationShape,
  SeverityQualifierShape,
  ReviewStatusSchema,
  VerificationShape,
} from './review-common.js';

/** Bug review verdicts (PLAN.md §13.2, §13.4). */

/**
 * What the audit established about a submitted bug.
 *
 * Five of these are the claim taxonomy from `review-common`; two are
 * dispositions that are not about whether the defect is real at all — a
 * duplicate is a true finding somebody already has, and a severity
 * disagreement accepts the defect and argues about its weight.
 *
 * The important change from the earlier enum is that `FALSE_POSITIVE` is gone.
 * It was a single word for two different outcomes — "I found the guard that
 * makes this impossible" and "I went looking and came back empty" — and a
 * reviewer with incomplete access could overturn a correct finding with the
 * second while sounding like the first. `REFUTED` now means only the first, and
 * `verification-gate` demands the contradictory evidence to back it.
 */
export const BUG_VERDICTS = [
  'CONFIRMED',
  'REFUTED',
  'UNPROVEN',
  'CONFLICTING_EVIDENCE',
  'INSUFFICIENT_SCOPE',
  'SEVERITY_DISAGREEMENT',
  'DUPLICATE_OR_ALREADY_COVERED',
] as const;

/**
 * Verdicts from before the taxonomy split, and where they land now.
 *
 * Kept because a caller or a stored review may still speak the old vocabulary,
 * and because the mapping is the honest one in every case but `FALSE_POSITIVE`
 * — which maps to `REFUTED` and is then re-examined by the gate, so a legacy
 * refutation with no contradictory evidence is demoted exactly like a new one.
 */
const LEGACY_VERDICTS: Record<string, (typeof BUG_VERDICTS)[number]> = {
  VERIFIED: 'CONFIRMED',
  FALSE_POSITIVE: 'REFUTED',
  NEEDS_MORE_EVIDENCE: 'UNPROVEN',
  INCONCLUSIVE: 'INSUFFICIENT_SCOPE',
};

export const BugVerdictSchema = z.preprocess(
  (value) => (typeof value === 'string' && LEGACY_VERDICTS[value] ? LEGACY_VERDICTS[value] : value),
  z.enum(BUG_VERDICTS),
);
export type BugVerdict = (typeof BUG_VERDICTS)[number];

/** Verdicts that leave the author's finding standing rather than overturning it. */
export const NON_OVERTURNING_VERDICTS: readonly BugVerdict[] = ['UNPROVEN', 'CONFLICTING_EVIDENCE', 'INSUFFICIENT_SCOPE'];

/** Verdicts that mean the audit could not settle the claim. */
export const UNSETTLED_VERDICTS: readonly BugVerdict[] = ['UNPROVEN', 'CONFLICTING_EVIDENCE', 'INSUFFICIENT_SCOPE'];

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
  ...RefutationShape,
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
        confirmed: z.number().int().min(0),
        refuted: z.number().int().min(0),
        unproven: z.number().int().min(0),
        conflictingEvidence: z.number().int().min(0),
        insufficientScope: z.number().int().min(0),
        other: z.number().int().min(0),
      })
      .optional(),
    findings: z.array(BugFindingSchema).default([]),
    additionalFindings: z.array(AdditionalBugSchema).default([]),
    disagreements: z.array(DisagreementSchema).default([]),
    limitations: z.array(LimitationSchema).default([]),
    /**
     * Whether each *author* citation actually supports the claim it was attached
     * to.
     *
     * codex-mcp has already checked whether the cited file and line exist and
     * handed the answers to the reviewer; this is the part that needs judgment.
     * The two are kept apart so "the file exists" can never be reported as "the
     * evidence holds".
     */
    citationAssessments: z.array(CitationAssessmentSchema).default([]),
    /**
     * Whether each author citation resolves on disk.
     *
     * Overwritten by codex-mcp after the review returns — it is a filesystem
     * fact, not a judgment, and it was already established before the prompt was
     * built. It appears in the schema so the shape is complete for a reader;
     * anything the reviewer puts here is discarded.
     */
    citationChecks: z.array(CitationCheckSchema).default([]),
    /** Durable facts the server should remember for the next review of this project. */
    projectMemory: z.array(MemoryFactSchema).default([]),
    reviewerNotes: z.string().optional(),
  })
  .strip();

export type BugReviewResult = z.infer<typeof BugReviewResultSchema>;
