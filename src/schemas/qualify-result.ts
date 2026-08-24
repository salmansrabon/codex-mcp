import { z } from 'zod';

import { BugReviewResultSchema } from './bug-review-result.js';
import { ReviewStatusSchema } from './review-common.js';
import { TestReviewResultSchema } from './test-review-result.js';
import { ReviewTypeSchema } from './qualify-request.js';

/**
 * The envelope `codex_qualify` returns. The review bodies are exactly what the
 * plan specifies; the envelope adds only provenance, so the authoring agent can
 * see what the verdict was actually based on before acting on it.
 */
export const QualifyResultSchema = z.object({
  reviewId: z.string(),
  reviewType: ReviewTypeSchema,
  /** Worst status across the included reviews. */
  status: ReviewStatusSchema,

  testDesign: TestReviewResultSchema.optional(),
  bugs: BugReviewResultSchema.optional(),

  meta: z.object({
    model: z.string().optional(),
    /** The effort actually used, which depth assessment may have lowered. */
    reasoningEffort: z.string(),
    /** How much review the change was judged to be worth, and why. */
    depth: z.enum(['SMALL', 'MEDIUM', 'HIGH']),
    depthSignals: z.array(z.string()).default([]),
    sandbox: z.string(),
    pass: z.number().int().min(1),
    maxPasses: z.number().int().min(1),
    /** True when the caller has spent its pass budget and should stop looping. */
    furtherPassesAllowed: z.boolean(),
    durationMs: z.number().int().min(0),
    startedAt: z.string(),
    completedAt: z.string(),
    /** Whether the reviewer had to be re-prompted for valid structured output. */
    outputRepairAttempts: z.number().int().min(0),
    candidateCounts: z.object({
      testCases: z.number().int().min(0),
      bugs: z.number().int().min(0),
    }),
    evidence: z.object({
      projectRootId: z.string().describe('Hashed project path; the raw path is never logged.'),
      git: z.boolean(),
      blastRadius: z.boolean(),
      testCharter: z.boolean(),
      requirement: z.boolean(),
      connectors: z.array(z.string()),
    }),
  }),

  /** Reminder that the caller, not codex-mcp, owns the final artifact. */
  reconciliation: z.object({
    instruction: z.string(),
    codexIsNotAuthoritative: z.literal(true),
  }),
});

export type QualifyResult = z.infer<typeof QualifyResultSchema>;

export const RECONCILIATION_INSTRUCTION =
  'This is an independent second opinion, not a verdict. Verify each objection against the cited evidence: ' +
  'apply the ones the evidence supports, reject the ones it does not (recording why), and investigate the rest. ' +
  'codex-mcp has not written and must not write your final artifact.';
