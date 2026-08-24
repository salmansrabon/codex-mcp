import { z } from 'zod';

import {
  DisagreementSchema,
  EvidenceSchema,
  LimitationSchema,
  MemoryFactSchema,
  ObjectionShape,
  SeverityQualifierShape,
  PrioritySchema,
  ReviewStatusSchema,
  VerificationShape,
} from './review-common.js';

/** Test-design review delta (PLAN.md §13.1). */

export const ModifyEntrySchema = z.object({
  candidateId: z.string().min(1),
  reason: z.string().min(1),
  evidence: z.array(EvidenceSchema).default([]),
  recommendation: z.string().min(1),
  severity: PrioritySchema.optional(),
  ...SeverityQualifierShape,
  ...VerificationShape,
  ...ObjectionShape,
});

export const RemoveEntrySchema = z.object({
  candidateId: z.string().min(1),
  reason: z.string().min(1),
  evidence: z.array(EvidenceSchema).default([]),
  supersededBy: z.string().optional().describe('Candidate id that already covers this scenario.'),
  ...VerificationShape,
  ...ObjectionShape,
});

/**
 * A candidate this addition would displace, when the artifact has a hard case
 * ceiling.
 *
 * Without this, a reviewer that finds three good additions to a twelve-case
 * artifact hands the optimization problem back to the authoring agent — which
 * is the part the authoring agent is worst at, because it is the party that
 * chose the twelve.
 */
export const DisplacementSchema = z.object({
  candidateId: z.string().min(1),
  action: z
    .enum(['REMOVE', 'MERGE', 'DEMOTE'])
    .describe('REMOVE: drop it. MERGE: fold it into another case, named in reason. DEMOTE: keep as lower priority outside the ceiling.'),
  reason: z.string().min(1).describe('Why the addition carries more unique risk coverage than this candidate does.'),
  mergeInto: z.string().optional().describe('For MERGE, the candidate id that absorbs it.'),
});

export const MissingEntrySchema = z.object({
  title: z.string().min(1),
  priority: PrioritySchema,
  reason: z.string().min(1),
  evidence: z.array(EvidenceSchema).default([]),
  suggestedAssertion: z.string().optional(),
  dimension: z.string().optional().describe('Coverage dimension: boundary, authorization, concurrency, persistence, ...'),
  /**
   * The value threshold, as a field rather than an exhortation.
   *
   * A proposed test that cannot name a risk no other test covers is a coverage
   * count, not coverage. The gate demotes entries that leave this empty instead
   * of trusting a reviewer's own restraint.
   */
  uniqueRisk: z
    .string()
    .optional()
    .describe('The distinct risk this scenario covers that no existing or candidate test covers. What breaks in production if only this is untested.'),
  /**
   * Where the reviewer looked before calling the coverage missing.
   *
   * "Absent from this artifact" and "untested anywhere" are different claims.
   * Requesting a test that the existing suite already runs is the most
   * expensive kind of noise, because it is confidently wrong about the project.
   */
  coverageChecked: z
    .array(z.string())
    .default([])
    .describe('Test files, suites, test-management ids, or declared known coverage you searched before calling this missing.'),
  displaces: z
    .array(DisplacementSchema)
    .default([])
    .describe('Under a hard case ceiling, what this addition should replace. Required when the additions exceed the ceiling.'),
  ...SeverityQualifierShape,
  ...VerificationShape,
  ...ObjectionShape,
});

export type ModifyEntry = z.infer<typeof ModifyEntrySchema>;
export type RemoveEntry = z.infer<typeof RemoveEntrySchema>;
export type MissingEntry = z.infer<typeof MissingEntrySchema>;
export type Displacement = z.infer<typeof DisplacementSchema>;

export const TestReviewResultSchema = z
  .object({
    status: ReviewStatusSchema,
    summary: z
      .object({
        accepted: z.number().int().min(0),
        modify: z.number().int().min(0),
        remove: z.number().int().min(0),
        missing: z.number().int().min(0),
      })
      .optional(),
    accepted: z.array(z.string()).default([]),
    modify: z.array(ModifyEntrySchema).default([]),
    remove: z.array(RemoveEntrySchema).default([]),
    missing: z.array(MissingEntrySchema).default([]),
    /**
     * Portfolio arithmetic under a declared case ceiling.
     *
     * Computed by codex-mcp from the delta, never taken from the reviewer: the
     * point is to make an over-ceiling recommendation impossible to return
     * silently, and a reviewer that miscounts is exactly the case this catches.
     */
    portfolio: z
      .object({
        ceiling: z.number().int().min(0),
        retained: z.number().int().min(0).describe('Candidates surviving after proposed removals.'),
        proposedAdditions: z.number().int().min(0),
        headroom: z.number().int().describe('Ceiling minus retained; negative when the candidate set already exceeds it.'),
        withinCeiling: z.boolean(),
        unresolvedOverflow: z
          .array(z.string())
          .default([])
          .describe('Additions that exceed the ceiling without naming what they displace.'),
      })
      .optional(),
    disagreements: z.array(DisagreementSchema).default([]),
    limitations: z.array(LimitationSchema).default([]),
    /** Durable facts the server should remember for the next review of this project. */
    projectMemory: z.array(MemoryFactSchema).default([]),
    /** Short narrative for a human skimming the result. Never a rewritten report. */
    reviewerNotes: z.string().optional(),
  })
  .strip();

export type TestReviewResult = z.infer<typeof TestReviewResultSchema>;
