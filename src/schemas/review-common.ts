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
  /**
   * Whether this gap prevented a reliable assessment. Defaults to false: a
   * skipped connector or an unread ticket is a recorded fact about the review,
   * not a failed review, and defaulting the other way would make INCONCLUSIVE
   * the normal outcome of any partially-connected setup.
   */
  material: z.boolean().default(false),
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
  /**
   * Defaults to true, the opposite of `Limitation.material`: the reviewer is
   * told to raise material findings only, so a disagreement it bothered to
   * record is one the authoring agent has to adjudicate.
   */
  material: z.boolean().default(true),
});
export type Disagreement = z.infer<typeof DisagreementSchema>;

/**
 * A durable, verified fact about the project, proposed by the reviewer and
 * persisted by codex-mcp between reviews.
 *
 * The Codex run itself is stateless and cannot remember anything; this is the
 * reviewer handing a fact back for the server to keep. Only verified, durable
 * knowledge belongs here — never an open question, a speculative finding, or
 * anything read out of a credential.
 */
export const MemoryFactSchema = z.object({
  topic: z.string().min(1).describe('Short subject line, e.g. "tenant ownership enforcement".'),
  fact: z.string().min(1).describe('The durable knowledge, stated concisely.'),
  evidence: z.array(EvidenceSchema).min(1).describe('What establishes it. A fact with no evidence is not verified.'),
  implication: z.string().optional().describe('Why it matters for future changes or testing.'),
});
export type MemoryFact = z.infer<typeof MemoryFactSchema>;
