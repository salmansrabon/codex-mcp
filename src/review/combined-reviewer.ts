import type { CodexRunner } from '../codex/codex-runner.js';
import type { BrokerLaunchSpec } from '../codex/command-builder.js';
import type { PromptContext } from '../prompts/base-reviewer.js';
import type { BugReviewResult } from '../schemas/bug-review-result.js';
import type { CandidateBug, CandidateTestCase } from '../schemas/qualify-request.js';
import type { ReviewStatus } from '../schemas/review-common.js';
import type { TestReviewResult } from '../schemas/test-review-result.js';
import type { Logger } from '../util/logger.js';
import { reviewBugs } from './bug-reviewer.js';
import { reviewTestDesign } from './test-design-reviewer.js';

export interface CombinedReviewInput {
  context: PromptContext;
  testCases: readonly CandidateTestCase[];
  bugs: readonly CandidateBug[];
  runner: CodexRunner;
  logger: Logger;
  broker?: BrokerLaunchSpec;
  timeoutMs: number;
  /** Depth-scaled effort; both runs of a combined review share it. */
  reasoningEffort?: string;
  signal?: AbortSignal;
}

export interface CombinedReviewOutput {
  testDesign?: TestReviewResult;
  bugs?: BugReviewResult;
  repairAttempts: number;
  attemptedCommands: string[];
  /** Summed across both runs, when the CLI reports token usage. */
  usage?: { inputTokens: number; outputTokens: number };
}

/**
 * `combined` review type.
 *
 * The two reviews run as separate Codex invocations rather than one merged
 * prompt. Test design asks "what should be covered"; bug verification asks "is
 * this claim true". Fusing them measurably degrades both, and separate runs also
 * mean a schema failure in one does not discard the other.
 *
 * They run concurrently. Nothing is shared between them — separate processes,
 * separate prompts, separate temp directories, and a read-only sandbox that
 * takes no lock — so the two reviews are byte-for-byte what they would have
 * been in sequence, and wall-clock becomes the slower of the two rather than
 * the sum. What concurrency does cost is real but is not quality: both runs
 * bill tokens at once, and the second no longer gets a warm prefix cache from
 * the first.
 *
 * Both are awaited even when one fails, so a rejection cannot leave the other
 * Codex process running unattended. The first failure is then rethrown, which
 * keeps the existing contract that a review is returned whole or not at all.
 */
export async function reviewCombined(input: CombinedReviewInput): Promise<CombinedReviewOutput> {
  let repairAttempts = 0;
  const attemptedCommands: string[] = [];
  let inputTokens = 0;
  let outputTokens = 0;
  let sawUsage = false;
  let testDesign: TestReviewResult | undefined;
  let bugs: BugReviewResult | undefined;

  const shared = {
    context: input.context,
    runner: input.runner,
    logger: input.logger,
    ...(input.broker ? { broker: input.broker } : {}),
    timeoutMs: input.timeoutMs,
    ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
  };

  const [testOutcome, bugOutcome] = await Promise.allSettled([
    input.testCases.length > 0 ? reviewTestDesign({ ...shared, candidates: input.testCases }) : Promise.resolve(undefined),
    input.bugs.length > 0 ? reviewBugs({ ...shared, candidates: input.bugs }) : Promise.resolve(undefined),
  ]);

  // Report the first failure, but only once both processes have settled.
  for (const settled of [testOutcome, bugOutcome]) {
    if (settled.status === 'rejected') throw settled.reason;
  }

  if (testOutcome.status === 'fulfilled' && testOutcome.value) {
    const outcome = testOutcome.value;
    testDesign = outcome.result;
    repairAttempts += outcome.repairAttempts;
    attemptedCommands.push(...outcome.attemptedCommands);
    if (outcome.usage) {
      sawUsage = true;
      inputTokens += outcome.usage.inputTokens ?? 0;
      outputTokens += outcome.usage.outputTokens ?? 0;
    }
  }

  if (bugOutcome.status === 'fulfilled' && bugOutcome.value) {
    const outcome = bugOutcome.value;
    bugs = outcome.result;
    repairAttempts += outcome.repairAttempts;
    attemptedCommands.push(...outcome.attemptedCommands);
    if (outcome.usage) {
      sawUsage = true;
      inputTokens += outcome.usage.inputTokens ?? 0;
      outputTokens += outcome.usage.outputTokens ?? 0;
    }
  }

  return {
    ...(testDesign ? { testDesign } : {}),
    ...(bugs ? { bugs } : {}),
    repairAttempts,
    attemptedCommands,
    ...(sawUsage ? { usage: { inputTokens, outputTokens } } : {}),
  };
}

const STATUS_SEVERITY: Record<ReviewStatus, number> = {
  PASS: 0,
  INCONCLUSIVE: 1,
  CHANGES_REQUIRED: 2,
  ERROR: 3,
};

/** Worst status wins, so a caller can branch on the envelope alone. */
export function worstStatus(statuses: readonly ReviewStatus[]): ReviewStatus {
  if (statuses.length === 0) return 'INCONCLUSIVE';
  return statuses.reduce((worst, current) =>
    (STATUS_SEVERITY[current] ?? 0) > (STATUS_SEVERITY[worst] ?? 0) ? current : worst,
  );
}
