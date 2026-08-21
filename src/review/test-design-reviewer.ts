import type { CodexRunner } from '../codex/codex-runner.js';
import type { BrokerLaunchSpec } from '../codex/command-builder.js';
import { buildTestDesignPrompt } from '../prompts/test-design.js';
import type { PromptContext } from '../prompts/base-reviewer.js';
import type { CandidateTestCase } from '../schemas/qualify-request.js';
import { TestReviewResultSchema, type TestReviewResult } from '../schemas/test-review-result.js';
import type { Logger } from '../util/logger.js';
import { runStructuredReview } from './structured-review.js';

export interface TestDesignReviewInput {
  context: PromptContext;
  candidates: readonly CandidateTestCase[];
  runner: CodexRunner;
  logger: Logger;
  broker?: BrokerLaunchSpec;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface TestDesignReviewOutput {
  result: TestReviewResult;
  repairAttempts: number;
  attemptedCommands: string[];
  usage?: { inputTokens?: number; outputTokens?: number };
}

/** Phase 2: test-design qualification (PLAN.md §10.1). */
export async function reviewTestDesign(input: TestDesignReviewInput): Promise<TestDesignReviewOutput> {
  const prompt = buildTestDesignPrompt(input.context, input.candidates);

  const outcome = await runStructuredReview({
    prompt,
    schema: TestReviewResultSchema,
    schemaName: 'TestDesignReviewDelta',
    projectRoot: input.context.projectRoot,
    ...(input.broker ? { broker: input.broker } : {}),
    timeoutMs: input.timeoutMs,
    ...(input.signal ? { signal: input.signal } : {}),
    logger: input.logger,
    runner: input.runner,
  });

  return {
    result: normalizeTestReview(outcome.result, input.candidates, input.context),
    repairAttempts: outcome.repairAttempts,
    attemptedCommands: outcome.run.attemptedCommands,
    ...(outcome.run.usage ? { usage: outcome.run.usage } : {}),
  };
}

/**
 * Reconcile the model's delta with the candidate set it was given.
 *
 * Two failure modes are corrected here rather than trusted:
 *  - ids the reviewer invented or misremembered are dropped, since the authoring
 *    agent cannot act on a reference to a test case that does not exist;
 *  - a candidate the reviewer never mentioned is *not* silently promoted to
 *    accepted; it is recorded as unreviewed in `limitations`.
 */
export function normalizeTestReview(
  result: TestReviewResult,
  candidates: readonly CandidateTestCase[],
  context: Pick<PromptContext, 'requirement' | 'external' | 'database'>,
): TestReviewResult {
  const knownIds = new Set(candidates.map((candidate) => candidate.id));
  const limitations = [...result.limitations];

  const unknownReferences: string[] = [];
  const keepKnown = <T extends { candidateId: string }>(entries: T[]): T[] =>
    entries.filter((entry) => {
      if (knownIds.has(entry.candidateId)) return true;
      unknownReferences.push(entry.candidateId);
      return false;
    });

  const accepted = result.accepted.filter((id) => {
    if (knownIds.has(id)) return true;
    unknownReferences.push(id);
    return false;
  });
  const modify = keepKnown(result.modify);
  const remove = keepKnown(result.remove);

  if (unknownReferences.length > 0) {
    limitations.push({
      area: 'review-integrity',
      detail: `The reviewer referenced candidate ids that were not supplied and they were dropped: ${[...new Set(unknownReferences)].join(', ')}.`,
      impact: 'Those references could not be acted on; the corresponding candidates may be unreviewed.',
    });
  }

  const mentioned = new Set([...accepted, ...modify.map((e) => e.candidateId), ...remove.map((e) => e.candidateId)]);
  const unreviewed = [...knownIds].filter((id) => !mentioned.has(id));
  if (unreviewed.length > 0) {
    limitations.push({
      area: 'coverage-of-review',
      detail: `The reviewer returned no verdict for: ${unreviewed.join(', ')}.`,
      impact: 'Treat these as unreviewed rather than accepted.',
    });
  }

  limitations.push(...inheritedLimitations(context));

  const summary = {
    accepted: accepted.length,
    modify: modify.length,
    remove: remove.length,
    missing: result.missing.length,
  };

  // The reviewer's own status is advisory; the delta itself is authoritative.
  const hasChanges = summary.modify + summary.remove + summary.missing > 0;
  const status =
    result.status === 'INCONCLUSIVE' || result.status === 'ERROR'
      ? result.status
      : hasChanges
        ? 'CHANGES_REQUIRED'
        : 'PASS';

  return { ...result, status, accepted, modify, remove, summary, limitations };
}

/** Evidence gaps codex-mcp already knows about, folded into the result. */
function inheritedLimitations(
  context: Pick<PromptContext, 'requirement' | 'external' | 'database'>,
): { area: string; detail: string }[] {
  const entries: { area: string; detail: string }[] = [];
  for (const detail of context.requirement.limitations) entries.push({ area: 'requirement', detail });
  for (const detail of context.external.limitations) entries.push({ area: 'external-evidence', detail });
  for (const detail of context.database.limitations) entries.push({ area: 'database', detail });
  return entries;
}
