import { z } from 'zod';

import {
  DisagreementSchema,
  EvidenceSchema,
  LimitationSchema,
  MemoryFactSchema,
  SeverityQualifierShape,
  PrioritySchema,
  ReviewStatusSchema,
} from './review-common.js';

/** Test-design review delta (PLAN.md §13.1). */

export const ModifyEntrySchema = z.object({
  candidateId: z.string().min(1),
  reason: z.string().min(1),
  evidence: z.array(EvidenceSchema).default([]),
  recommendation: z.string().min(1),
  severity: PrioritySchema.optional(),
  ...SeverityQualifierShape,
});

export const RemoveEntrySchema = z.object({
  candidateId: z.string().min(1),
  reason: z.string().min(1),
  evidence: z.array(EvidenceSchema).default([]),
  supersededBy: z.string().optional().describe('Candidate id that already covers this scenario.'),
});

export const MissingEntrySchema = z.object({
  title: z.string().min(1),
  priority: PrioritySchema,
  reason: z.string().min(1),
  evidence: z.array(EvidenceSchema).default([]),
  suggestedAssertion: z.string().optional(),
  dimension: z.string().optional().describe('Coverage dimension: boundary, authorization, concurrency, persistence, ...'),
  ...SeverityQualifierShape,
});

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
    disagreements: z.array(DisagreementSchema).default([]),
    limitations: z.array(LimitationSchema).default([]),
    /** Durable facts the server should remember for the next review of this project. */
    projectMemory: z.array(MemoryFactSchema).default([]),
    /** Short narrative for a human skimming the result. Never a rewritten report. */
    reviewerNotes: z.string().optional(),
  })
  .strip();

export type TestReviewResult = z.infer<typeof TestReviewResultSchema>;
