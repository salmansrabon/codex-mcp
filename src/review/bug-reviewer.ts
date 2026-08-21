import type { CodexRunner } from '../codex/codex-runner.js';
import type { BrokerLaunchSpec } from '../codex/command-builder.js';
import type { PromptContext } from '../prompts/base-reviewer.js';
import { buildBugReviewPrompt } from '../prompts/bug-review.js';
import { BugReviewResultSchema, type BugFinding, type BugReviewResult } from '../schemas/bug-review-result.js';
import type { CandidateBug } from '../schemas/qualify-request.js';
import type { Limitation } from '../schemas/review-common.js';
import type { Logger } from '../util/logger.js';
import { runStructuredReview } from './structured-review.js';

export interface BugReviewInput {
  context: PromptContext;
  candidates: readonly CandidateBug[];
  runner: CodexRunner;
  logger: Logger;
  broker?: BrokerLaunchSpec;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface BugReviewOutput {
  result: BugReviewResult;
  repairAttempts: number;
  attemptedCommands: string[];
  usage?: { inputTokens?: number; outputTokens?: number };
}

/** Phase 3: bug qualification (PLAN.md §10.2). */
export async function reviewBugs(input: BugReviewInput): Promise<BugReviewOutput> {
  const prompt = buildBugReviewPrompt(input.context, input.candidates);

  const outcome = await runStructuredReview({
    prompt,
    schema: BugReviewResultSchema,
    schemaName: 'BugReviewVerdicts',
    projectRoot: input.context.projectRoot,
    ...(input.broker ? { broker: input.broker } : {}),
    timeoutMs: input.timeoutMs,
    ...(input.signal ? { signal: input.signal } : {}),
    logger: input.logger,
    runner: input.runner,
  });

  return {
    result: normalizeBugReview(outcome.result, input.candidates, input.context),
    repairAttempts: outcome.repairAttempts,
    attemptedCommands: outcome.run.attemptedCommands,
    ...(outcome.run.usage ? { usage: outcome.run.usage } : {}),
  };
}

/**
 * Reconcile verdicts against the candidates that were actually submitted.
 *
 * A candidate with no verdict is explicitly marked `INCONCLUSIVE` rather than
 * omitted: silence would read as tacit approval, and the authoring agent would
 * ship an unverified finding.
 */
export function normalizeBugReview(
  result: BugReviewResult,
  candidates: readonly CandidateBug[],
  context: Pick<PromptContext, 'requirement' | 'external' | 'database'>,
): BugReviewResult {
  const knownIds = new Set(candidates.map((candidate) => candidate.id));
  const limitations = [...result.limitations];

  const unknownReferences: string[] = [];
  const findings = result.findings.filter((finding) => {
    if (knownIds.has(finding.candidateId)) return true;
    unknownReferences.push(finding.candidateId);
    return false;
  });

  if (unknownReferences.length > 0) {
    limitations.push({
      area: 'review-integrity',
      detail: `The reviewer returned verdicts for ids that were not submitted and they were dropped: ${[...new Set(unknownReferences)].join(', ')}.`,
      material: false,
    });
  }

  const covered = new Set(findings.map((finding) => finding.candidateId));
  for (const candidate of candidates) {
    if (covered.has(candidate.id)) continue;
    findings.push({
      candidateId: candidate.id,
      verdict: 'INCONCLUSIVE',
      confidence: 'low',
      severityAssessment: null,
      reason: 'The reviewer returned no verdict for this candidate.',
      evidence: [],
      recommendation: 'Treat this finding as unverified and verify it independently before publishing.',
      missingEvidence: [],
    });
  }

  // Not material: these constrain the review without invalidating it. Only the
  // reviewer can say a gap actually blocked a verdict.
  for (const detail of context.requirement.limitations) limitations.push({ area: 'requirement', detail, material: false });
  for (const detail of context.external.limitations) limitations.push({ area: 'external-evidence', detail, material: false });
  for (const detail of context.database.limitations) limitations.push({ area: 'database', detail, material: false });

  const summary = {
    verified: findings.filter((f) => f.verdict === 'VERIFIED').length,
    falsePositive: findings.filter((f) => f.verdict === 'FALSE_POSITIVE').length,
    needsMoreEvidence: findings.filter((f) => f.verdict === 'NEEDS_MORE_EVIDENCE').length,
    other: findings.filter(
      (f) => !['VERIFIED', 'FALSE_POSITIVE', 'NEEDS_MORE_EVIDENCE'].includes(f.verdict),
    ).length,
  };

  return { ...result, status: deriveBugReviewStatus(result, findings, limitations), findings, summary, limitations };
}

/**
 * The final status, derived here rather than taken from the reviewer.
 *
 * `INCONCLUSIVE` outranks `CHANGES_REQUIRED`: if any material verdict could not
 * be reached, the set of findings that *were* reached is an incomplete picture,
 * and reporting it as a settled list of required changes overstates it.
 */
export function deriveBugReviewStatus(
  result: Pick<BugReviewResult, 'status' | 'additionalFindings' | 'disagreements'>,
  findings: readonly BugFinding[],
  limitations: readonly Limitation[],
): BugReviewResult['status'] {
  if (result.status === 'ERROR') return 'ERROR';

  // Any verdict the reviewer could not reach makes the whole set provisional:
  // the findings that *were* reached are an incomplete picture, and reporting
  // them as a settled list of required changes overstates it. A material
  // limitation, or an explicit INCONCLUSIVE, says the same thing.
  const unresolved = findings.some(
    (finding) => finding.verdict === 'NEEDS_MORE_EVIDENCE' || finding.verdict === 'INCONCLUSIVE',
  );
  if (result.status === 'INCONCLUSIVE' || unresolved || limitations.some((limitation) => limitation.material)) {
    return 'INCONCLUSIVE';
  }

  const needsAction =
    findings.some((finding) =>
      ['FALSE_POSITIVE', 'SEVERITY_DISAGREEMENT', 'DUPLICATE_OR_ALREADY_COVERED'].includes(finding.verdict),
    ) ||
    result.additionalFindings.length > 0 ||
    result.disagreements.some((disagreement) => disagreement.material);

  return needsAction ? 'CHANGES_REQUIRED' : 'PASS';
}
