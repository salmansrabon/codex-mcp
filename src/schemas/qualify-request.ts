import { z } from 'zod';

/**
 * `codex_qualify` request contract (PLAN.md §9).
 *
 * Required: `reviewType`, `project.root`, `candidate`.
 * Everything else is optional and must never block a review.
 */

export const ReviewTypeSchema = z.enum(['test-design', 'bugs', 'combined']);
export type ReviewType = z.infer<typeof ReviewTypeSchema>;

export const EvidenceRefSchema = z
  .object({
    source: z.string().min(1).describe('Evidence origin: code, git, requirement, database, test, artifact, runtime, external.'),
    location: z.string().min(1).describe('Where to find it, e.g. "src/session/service.ts:143" or "DEV-123#AC2".'),
    note: z.string().optional(),
  })
  .describe('A pointer to source evidence.');
export type EvidenceRef = z.infer<typeof EvidenceRefSchema>;

/**
 * Candidate test case. Only `id` and `title` are required: authoring agents
 * model test cases very differently, and rejecting an unfamiliar shape would
 * make the gate project-specific.
 */
export const CandidateTestCaseSchema = z
  .object({
    id: z.string().min(1).describe('Stable identifier the review delta refers back to, e.g. "TC-014".'),
    title: z.string().min(1),
    priority: z.string().optional(),
    type: z.string().optional().describe('functional, negative, boundary, security, integration, ...'),
    preconditions: z.union([z.string(), z.array(z.string())]).optional(),
    steps: z.union([z.string(), z.array(z.string())]).optional(),
    expectedResult: z.union([z.string(), z.array(z.string())]).optional(),
    testData: z.unknown().optional(),
    requirementRefs: z.array(z.string()).optional(),
    tags: z.array(z.string()).optional(),
    notes: z.string().optional(),
  })
  .passthrough();
export type CandidateTestCase = z.infer<typeof CandidateTestCaseSchema>;

export const CandidateBugSchema = z
  .object({
    id: z.string().min(1).describe('Stable identifier, e.g. "BUG-003".'),
    title: z.string().min(1),
    severity: z.string().optional(),
    priority: z.string().optional(),
    component: z.string().optional(),
    environment: z.string().optional(),
    preconditions: z.union([z.string(), z.array(z.string())]).optional(),
    stepsToReproduce: z.union([z.string(), z.array(z.string())]).optional(),
    expectedBehavior: z.string().optional(),
    actualBehavior: z.string().optional(),
    evidence: z.array(EvidenceRefSchema).optional(),
    suspectedCause: z.string().optional(),
    requirementRefs: z.array(z.string()).optional(),
    notes: z.string().optional(),
  })
  .passthrough();
export type CandidateBug = z.infer<typeof CandidateBugSchema>;

export const QualifyRequestSchema = z
  .object({
    reviewType: ReviewTypeSchema,

    project: z.object({
      root: z.string().min(1).describe('Absolute path to the repository or workspace Codex should inspect.'),
      /**
       * The ref to diff *against*, not the branch under review — the reviewer
       * always reads the checked-out working tree. Set it to the PR's base
       * (`origin/main`, a release branch, a tag) when the default resolution
       * order would pick the wrong one.
       */
      branch: z.string().optional().describe('Base ref to diff HEAD against, e.g. "origin/main". Not the branch to review.'),
      /** Optional free-text note about the working state, e.g. "uncommitted changes". */
      note: z.string().optional(),
    }),

    task: z
      .object({
        id: z.string().optional().describe('Requirement/ticket id, e.g. "DEV-123".'),
        source: z.string().optional().describe('Where the requirement lives: jira, github, confluence, inline, ...'),
        title: z.string().optional(),
        description: z.string().optional(),
        acceptanceCriteria: z.array(z.string()).optional(),
        links: z.array(z.string()).optional(),
      })
      .optional(),

    artifacts: z
      .object({
        blastRadiusPath: z.string().optional(),
        testCharterPath: z.string().optional(),
        /** Inline alternatives when the artifact is not on disk. */
        blastRadius: z.string().optional(),
        testCharter: z.string().optional(),
        /** Extra supporting files inside the project root. */
        additionalPaths: z.array(z.string()).optional(),
      })
      .optional(),

    candidate: z
      .object({
        testCases: z.array(CandidateTestCaseSchema).optional(),
        bugs: z.array(CandidateBugSchema).optional(),
        /** Free-text context about how the candidate was produced. */
        notes: z.string().optional(),
      })
      .default({}),

    options: z
      .object({
        useJira: z.boolean().optional(),
        useDatabase: z.boolean().optional(),
        useExternalMcps: z.boolean().optional(),
        /** Which pass this is; used only for loop protection and logging. */
        pass: z.number().int().min(1).optional(),
        /** Per-call override, clamped by the configured review timeout. */
        timeoutMs: z.number().int().positive().optional(),
        /** Extra instruction appended to the reviewer prompt. Never grants permissions. */
        focus: z.string().optional(),
      })
      .optional(),
  })
  .strict();

export type QualifyRequest = z.input<typeof QualifyRequestSchema>;
export type ParsedQualifyRequest = z.output<typeof QualifyRequestSchema>;

/**
 * Cross-field rules the zod shape cannot express: the candidate must actually
 * contain the material the review type is about.
 */
export function validateCandidateShape(request: ParsedQualifyRequest): string[] {
  const problems: string[] = [];
  const testCases = request.candidate.testCases ?? [];
  const bugs = request.candidate.bugs ?? [];

  if (request.reviewType === 'test-design' && testCases.length === 0) {
    problems.push('reviewType "test-design" requires at least one entry in `candidate.testCases`.');
  }
  if (request.reviewType === 'bugs' && bugs.length === 0) {
    problems.push('reviewType "bugs" requires at least one entry in `candidate.bugs`.');
  }
  if (request.reviewType === 'combined' && testCases.length === 0 && bugs.length === 0) {
    problems.push('reviewType "combined" requires at least one candidate test case or bug.');
  }

  problems.push(...duplicateIds(testCases.map((t) => t.id), 'candidate.testCases'));
  problems.push(...duplicateIds(bugs.map((b) => b.id), 'candidate.bugs'));

  return problems;
}

function duplicateIds(ids: string[], label: string): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) duplicates.add(id);
    seen.add(id);
  }
  return duplicates.size > 0 ? [`${label} contains duplicate ids: ${[...duplicates].join(', ')}.`] : [];
}
