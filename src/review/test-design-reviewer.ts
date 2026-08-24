import type { CodexRunner } from '../codex/codex-runner.js';
import type { BrokerLaunchSpec } from '../codex/command-builder.js';
import { buildTestDesignPrompt } from '../prompts/test-design.js';
import type { PromptContext } from '../prompts/base-reviewer.js';
import type { CandidateTestCase } from '../schemas/qualify-request.js';
import type { Limitation } from '../schemas/review-common.js';
import { TestReviewResultSchema, type TestReviewResult } from '../schemas/test-review-result.js';
import type { Logger } from '../util/logger.js';
import { runStructuredReview } from './structured-review.js';
import { gateTestReview } from './verification-gate.js';

export interface TestDesignReviewInput {
  context: PromptContext;
  candidates: readonly CandidateTestCase[];
  runner: CodexRunner;
  logger: Logger;
  broker?: BrokerLaunchSpec;
  timeoutMs: number;
  /** Depth-scaled effort, decided by the orchestrator from the change set. */
  reasoningEffort?: string;
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
    ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
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
  context: Pick<PromptContext, 'requirement' | 'external' | 'database' | 'scopeNotice' | 'constraints' | 'knownCoverage'>,
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
      material: false,
      affects: [...new Set(unknownReferences)],
    });
  }

  const mentioned = new Set([...accepted, ...modify.map((e) => e.candidateId), ...remove.map((e) => e.candidateId)]);
  const unreviewed = [...knownIds].filter((id) => !mentioned.has(id));
  if (unreviewed.length > 0) {
    limitations.push({
      area: 'coverage-of-review',
      detail: `The reviewer returned no verdict for: ${unreviewed.join(', ')}.`,
      impact: 'Treat these as unreviewed rather than accepted.',
      material: false,
      affects: unreviewed,
    });
  }

  limitations.push(...inheritedLimitations(context));

  // Confidence, value, and ceiling rules are applied to the delta before the
  // status is derived: a claim the gate downgrades must not have already been
  // counted as required work on its way through.
  const gated = gateTestReview({
    modify,
    remove,
    missing: result.missing,
    candidates,
    ...(context.constraints?.maxTestCases !== undefined ? { maxTestCases: context.constraints.maxTestCases } : {}),
    knownCoverageDeclared: (context.knownCoverage?.length ?? 0) > 0,
  });
  limitations.push(...gated.limitations);

  const summary = {
    accepted: accepted.length,
    modify: gated.modify.length,
    remove: gated.remove.length,
    missing: gated.missing.length,
  };

  return {
    ...result,
    status: deriveTestReviewStatus(result, gated, limitations),
    accepted,
    modify: gated.modify,
    remove: gated.remove,
    missing: gated.missing,
    ...(gated.portfolio ? { portfolio: gated.portfolio } : {}),
    summary,
    limitations,
  };
}

/** Evidence gaps codex-mcp already knows about, folded into the result. */
function inheritedLimitations(
  context: Pick<PromptContext, 'requirement' | 'external' | 'database' | 'scopeNotice'>,
): Limitation[] {
  // Not material: a skipped connector or an unread ticket constrains the review
  // without invalidating it. Only the reviewer can say a gap actually prevented
  // a judgment, and it does that by setting `material` itself.
  const entries: Limitation[] = [];
  for (const detail of context.requirement.limitations) entries.push({ area: 'requirement', detail, material: false, affects: [] });
  for (const detail of context.external.limitations) entries.push({ area: 'external-evidence', detail, material: false, affects: [] });
  for (const detail of context.database.limitations) entries.push({ area: 'database', detail, material: false, affects: [] });

  // Recorded whether or not the reviewer noticed: the caller chose a root below
  // its own workspace, and a silent blind spot is the failure mode here.
  if (context.scopeNotice) {
    entries.push({
      area: 'review-scope',
      detail:
        `The review was rooted at "${context.scopeNotice.scopedTo}", below the workspace. ` +
        `Not visible to the reviewer: ${context.scopeNotice.unreachableSiblings.join(', ')}.`,
      impact:
        'Findings that depend on a sibling directory could not be checked. Re-run with the workspace root if any of them consume or gate this code.',
      material: false,
      affects: [],
    });
  }

  return entries;
}

/**
 * The final status, derived here rather than taken from the reviewer.
 *
 * A model asked to grade its own output will sometimes return `PASS` alongside
 * a delta that plainly requires action, so its self-assessment of *the delta*
 * is advisory and the content decides.
 *
 * `ERROR` and `INCONCLUSIVE` are the exceptions, and they pass through. Both are
 * statements about what the reviewer was able to do rather than about the delta,
 * and nothing in the returned arrays can establish either one — a reviewer that
 * could not assess reliably has no way to say so except by saying so.
 */
export function deriveTestReviewStatus(
  result: Pick<TestReviewResult, 'status' | 'disagreements'>,
  delta: Pick<TestReviewResult, 'modify' | 'remove' | 'missing'>,
  limitations: readonly Limitation[],
): TestReviewResult['status'] {
  if (result.status === 'ERROR') return 'ERROR';

  // A gap the reviewer marked material means it could not assess reliably —
  // that outranks the delta, because the delta may be incomplete for the same
  // reason. An explicit INCONCLUSIVE says the same thing directly.
  if (result.status === 'INCONCLUSIVE' || limitations.some((limitation) => limitation.material)) {
    return 'INCONCLUSIVE';
  }

  // Only ranked work blocks acceptance. An `OPTIONAL` entry is by definition
  // something the artifact survives without, so a review made only of
  // observations is a pass with notes — otherwise every refinement the reviewer
  // was invited to mention would read as a required change, which is the
  // pressure that inflates these reports in the first place.
  const blocking = [...delta.modify, ...delta.remove, ...delta.missing].filter(
    (entry) => entry.objectionPriority !== 'OPTIONAL',
  );
  const hasChanges = blocking.length > 0;
  // An unresolved material disagreement is work the authoring agent must do,
  // even when no delta entry accompanies it. Letting that normalize to PASS
  // would hand back a clean bill of health with an open dispute attached.
  const hasDisagreement = result.disagreements.some((disagreement) => disagreement.material);

  return hasChanges || hasDisagreement ? 'CHANGES_REQUIRED' : 'PASS';
}
