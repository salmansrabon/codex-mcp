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
 * They run sequentially: concurrent Codex processes in the same project root
 * contend for the same sandbox and inflate wall-clock more than they save.
 */
export async function reviewCombined(input: CombinedReviewInput): Promise<CombinedReviewOutput> {
  let repairAttempts = 0;
  const attemptedCommands: string[] = [];
  let inputTokens = 0;
  let outputTokens = 0;
  let sawUsage = false;
  let testDesign: TestReviewResult | undefined;
  let bugs: BugReviewResult | undefined;

  if (input.testCases.length > 0) {
    const outcome = await reviewTestDesign({
      context: input.context,
      candidates: input.testCases,
      runner: input.runner,
      logger: input.logger,
      ...(input.broker ? { broker: input.broker } : {}),
      timeoutMs: input.timeoutMs,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    testDesign = outcome.result;
    repairAttempts += outcome.repairAttempts;
    attemptedCommands.push(...outcome.attemptedCommands);
    if (outcome.usage) {
      sawUsage = true;
      inputTokens += outcome.usage.inputTokens ?? 0;
      outputTokens += outcome.usage.outputTokens ?? 0;
    }
  }

  if (input.bugs.length > 0) {
    const outcome = await reviewBugs({
      context: input.context,
      candidates: input.bugs,
      runner: input.runner,
      logger: input.logger,
      ...(input.broker ? { broker: input.broker } : {}),
      timeoutMs: input.timeoutMs,
      ...(input.signal ? { signal: input.signal } : {}),
    });
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
