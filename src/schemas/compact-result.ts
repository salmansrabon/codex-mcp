import { z } from 'zod';

import { ReviewStatusSchema } from './review-common.js';
import { ReviewTypeSchema } from './qualify-request.js';

/**
 * The decision-shaped view of a review.
 *
 * A full result runs to tens of kilobytes because every entry carries the
 * apparatus that earned its label: the traced path, the contradiction searches,
 * three confidence dimensions, a scope caveat, the basis for any asserted
 * behavior. All of that is load-bearing — the gates read it, and without it the
 * labels would be assertions rather than conclusions.
 *
 * None of it is what the author needs in order to act. They need to know what
 * to change, why, where the evidence is, and what is still open. Handing them
 * the audit trail instead means the answer arrives buried in its own
 * justification, and a review nobody finishes reading is a review that did not
 * happen.
 *
 * So the apparatus is computed, applied, and then set aside rather than
 * deleted: `view: "full"` returns it verbatim, the same object the gates ran
 * on. This shape carries every *decision* — nothing here is a summary of
 * something the caller cannot get back.
 */

const EvidenceLine = z
  .string()
  .describe('Flattened evidence pointer, "source:location" — e.g. "code:src/routes/a.ts:12".');

export const CompactActionSchema = z.object({
  /** Candidate id when the entry is about a submitted item; absent for discovered risks. */
  id: z.string().optional(),
  subject: z.string().min(1).describe('What this is about: the candidate title, or the risk.'),
  problem: z.string().min(1),
  evidence: z.array(EvidenceLine).default([]),
  action: z.string().min(1).describe('What to actually do.'),
});

export const CompactMissingSchema = z.object({
  risk: z.string().min(1),
  priority: z.string(),
  evidence: z.array(EvidenceLine).default([]),
  /** Where this could fold into coverage that already exists, when the reviewer named one. */
  mergeInto: z.string().optional(),
});

export const CompactNoteSchema = z.object({
  subject: z.string().min(1),
  reason: z.string().min(1),
});

export const CompactVerdictSchema = z.object({
  id: z.string().min(1),
  verdict: z.string(),
  confidence: z.string(),
  action: z.string().min(1),
});

export const CompactResultSchema = z.object({
  reviewId: z.string(),
  reviewType: ReviewTypeSchema,
  status: ReviewStatusSchema,

  /** Blocking work: material problems with submitted items, and release blockers. */
  mustChange: z.array(CompactActionSchema).default([]),
  /** Coverage the reviewer says is required and absent. */
  missing: z.array(CompactMissingSchema).default([]),
  /** Per-candidate bug verdicts. Needed for reconciliation, so never summarized away. */
  verdicts: z.array(CompactVerdictSchema).optional(),
  /**
   * Things the reviewer could not establish.
   *
   * Kept distinct from `mustChange` because that distinction is the product:
   * an UNPROVEN verdict, an ungrounded assertion, and a disagreement with no
   * decisive source are all "look at this", none of them are "fix this".
   */
  investigate: z.array(CompactNoteSchema).default([]),
  /** Non-blocking observations. */
  optional: z.array(CompactNoteSchema).default([]),
  /** Only limitations that change what the author should do. */
  limitations: z.array(z.object({ area: z.string(), detail: z.string(), material: z.boolean() })).default([]),
  /** Portfolio arithmetic, when a case ceiling was declared. Carried verbatim; it is already compact. */
  portfolio: z.unknown().optional(),

  meta: z.object({
    depth: z.string(),
    reasoningEffort: z.string(),
    durationMs: z.number().int().min(0),
    /** Which review paths actually ran, so a cheap review is visibly cheap. */
    pathsRun: z.array(z.string()).default([]),
    scopeComplete: z.boolean(),
    model: z.string().optional(),
    /** Byte size of the full result this was derived from, so the trade is visible. */
    fullResultBytes: z.number().int().min(0),
  }),

  reconciliation: z.object({
    instruction: z.string(),
    codexIsNotAuthoritative: z.literal(true),
    /** How to get everything that was set aside. */
    fullResult: z.string(),
  }),
});

export type CompactResult = z.infer<typeof CompactResultSchema>;
