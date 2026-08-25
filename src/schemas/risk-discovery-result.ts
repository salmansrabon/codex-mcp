import { z } from 'zod';

import {
  BlockerSweepEntrySchema,
  CoverageNodeSchema,
  EvidenceSchema,
  LimitationSchema,
  MemoryFactSchema,
  ObjectionShape,
  PrioritySchema,
  ReleaseBlockerClassSchema,
  ReviewStatusSchema,
  SeverityQualifierShape,
  VerificationShape,
} from './review-common.js';

/**
 * Independent risk discovery: what the change puts at risk, derived without
 * seeing what the author already found.
 *
 * This is a separate result shape because it answers a separate question. The
 * audit path asks "is this submitted claim true"; anchored on a list of claims,
 * a reviewer spends its budget adjudicating them and returns a handful of
 * afterthoughts under `additionalFindings`. The failure that motivated the split
 * was a release blocker sitting in plain sight in the diff, unmentioned, while
 * the review carefully adjudicated three cosmetic test-case wordings.
 *
 * The run that produces this is given the requirement, the diff, the rules, and
 * the blast radius — and *not* the candidate set. Comparison happens afterwards,
 * in code, once both sides exist.
 */

export const RiskFindingSchema = z.object({
  title: z.string().min(1),
  area: z.string().min(1).describe('Component, module, endpoint, table, or contract the risk lives in.'),
  reason: z.string().min(1).describe('What breaks, under what conditions, by what mechanism.'),
  evidence: z.array(EvidenceSchema).default([]),
  recommendation: z.string().min(1),
  severity: PrioritySchema,
  /**
   * Which release-blocker class this belongs to, when it belongs to one.
   *
   * Set alongside `releaseBlocking` rather than derived from it: a critical
   * severity is a judgment about impact, and whether something can ship is a
   * different judgment that a release manager makes on different grounds.
   */
  blockerClass: ReleaseBlockerClassSchema.optional(),
  releaseBlocking: z
    .boolean()
    .default(false)
    .describe('True only if shipping the change as it stands would cause this failure in production.'),
  ...SeverityQualifierShape,
  ...VerificationShape,
  ...ObjectionShape,
});
export type RiskFinding = z.infer<typeof RiskFindingSchema>;

export const RiskDiscoveryResultSchema = z
  .object({
    status: ReviewStatusSchema,
    findings: z.array(RiskFindingSchema).default([]),
    /**
     * The explicit per-class answer to "what could make this unreleasable".
     *
     * Required as structured output rather than requested in prose, because the
     * failure being prevented is silence: a class nobody considered and a class
     * considered and cleared produce identical reports otherwise.
     */
    blockerSweep: z.array(BlockerSweepEntrySchema).default([]),
    /**
     * The blast radius, turned into a checklist with an inspection state.
     *
     * Empty when no blast-radius artifact was supplied; when one was, an
     * unvisited high-risk node is a reportable gap rather than a silent one.
     */
    coverageMap: z.array(CoverageNodeSchema).default([]),
    /** Project rules the reviewer actually applied, so rule-based findings are traceable to the rule. */
    rulesApplied: z
      .array(
        z.object({
          rule: z.string().min(1).describe('Path of the rule document, as given to you.'),
          appliedTo: z.string().min(1).describe('What you checked against it.'),
          outcome: z.enum(['compliant', 'violated', 'not-applicable', 'could-not-assess']),
          detail: z.string().min(1),
        }),
      )
      .default([]),
    limitations: z.array(LimitationSchema).default([]),
    projectMemory: z.array(MemoryFactSchema).default([]),
    reviewerNotes: z.string().optional(),
  })
  .strip();

export type RiskDiscoveryResult = z.infer<typeof RiskDiscoveryResultSchema>;

/**
 * How an independently-discovered risk relates to what the author already had.
 *
 * Computed in code after both paths finish. `NEW` is the number that matters:
 * it is what the author missed, and it is the thing an anchored review
 * structurally cannot report.
 */
export const RiskOverlapSchema = z.object({
  title: z.string().min(1),
  relation: z.enum(['NEW', 'OVERLAPS_CANDIDATE']),
  /** Candidate ids this appears to overlap, when it overlaps. */
  candidateIds: z.array(z.string()).default([]),
  releaseBlocking: z.boolean(),
  severity: PrioritySchema,
});
export type RiskOverlap = z.infer<typeof RiskOverlapSchema>;
