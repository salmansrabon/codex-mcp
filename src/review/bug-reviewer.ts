import type { CodexRunner } from '../codex/codex-runner.js';
import type { BrokerLaunchSpec } from '../codex/command-builder.js';
import type { PromptContext } from '../prompts/base-reviewer.js';
import { buildBugReviewPrompt } from '../prompts/bug-review.js';
import { BugReviewResultSchema, type BugReviewResult } from '../schemas/bug-review-result.js';
import type { CandidateBug } from '../schemas/qualify-request.js';
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

  for (const detail of context.requirement.limitations) limitations.push({ area: 'requirement', detail });
  for (const detail of context.external.limitations) limitations.push({ area: 'external-evidence', detail });
  for (const detail of context.database.limitations) limitations.push({ area: 'database', detail });

  const summary = {
    verified: findings.filter((f) => f.verdict === 'VERIFIED').length,
    falsePositive: findings.filter((f) => f.verdict === 'FALSE_POSITIVE').length,
    needsMoreEvidence: findings.filter((f) => f.verdict === 'NEEDS_MORE_EVIDENCE').length,
    other: findings.filter(
      (f) => !['VERIFIED', 'FALSE_POSITIVE', 'NEEDS_MORE_EVIDENCE'].includes(f.verdict),
    ).length,
  };

  const needsAction = findings.some((finding) => finding.verdict !== 'VERIFIED') || result.additionalFindings.length > 0;
  const inconclusiveOnly = findings.length > 0 && findings.every((finding) => finding.verdict === 'INCONCLUSIVE');
  const status = result.status === 'ERROR' ? 'ERROR' : inconclusiveOnly ? 'INCONCLUSIVE' : needsAction ? 'CHANGES_REQUIRED' : 'PASS';

  return { ...result, status, findings, summary, limitations };
}
