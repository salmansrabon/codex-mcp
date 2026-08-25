import type { CodexRunner } from '../codex/codex-runner.js';
import type { BrokerLaunchSpec } from '../codex/command-builder.js';
import type { PromptContext } from '../prompts/base-reviewer.js';
import { buildBugReviewPrompt } from '../prompts/bug-review.js';
import {
  BugReviewResultSchema,
  UNSETTLED_VERDICTS,
  type BugFinding,
  type BugReviewResult,
} from '../schemas/bug-review-result.js';
import type { CandidateBug } from '../schemas/qualify-request.js';
import type { Limitation } from '../schemas/review-common.js';
import type { Logger } from '../util/logger.js';
import type { CitationCheck } from '../schemas/review-common.js';
import { BROKEN_CITATION_STATUSES } from '../schemas/review-common.js';
import { runStructuredReview } from './structured-review.js';
import { gateBugReview, FULL_COVERAGE, type EvidenceCoverage } from './verification-gate.js';

export interface BugReviewInput {
  context: PromptContext;
  candidates: readonly CandidateBug[];
  runner: CodexRunner;
  logger: Logger;
  broker?: BrokerLaunchSpec;
  timeoutMs: number;
  /** Depth-scaled effort, decided by the orchestrator from the change set. */
  reasoningEffort?: string;
  signal?: AbortSignal;
  coverage?: EvidenceCoverage;
  citationChecks?: readonly CitationCheck[];
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
    ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
    logger: input.logger,
    runner: input.runner,
  });

  return {
    result: normalizeBugReview(outcome.result, input.candidates, input.context, {
      ...(input.coverage ? { coverage: input.coverage } : {}),
      ...(input.citationChecks ? { citationChecks: input.citationChecks } : {}),
    }),
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
  context: Pick<PromptContext, 'requirement' | 'external' | 'database' | 'scopeNotice'>,
  evidence: { coverage?: EvidenceCoverage; citationChecks?: readonly CitationCheck[] } = {},
): BugReviewResult {
  const coverage = evidence.coverage ?? FULL_COVERAGE;
  const citationChecks = evidence.citationChecks ?? [];
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
      affects: [...new Set(unknownReferences)],
    });
  }

  const covered = new Set(findings.map((finding) => finding.candidateId));
  for (const candidate of candidates) {
    if (covered.has(candidate.id)) continue;
    findings.push({
      candidateId: candidate.id,
      // No verdict came back at all, so nothing was established either way.
      // INSUFFICIENT_SCOPE, not REFUTED: silence never overturns the author.
      verdict: 'INSUFFICIENT_SCOPE',
      confidence: 'low',
      severityAssessment: null,
      reason: 'The reviewer returned no verdict for this candidate.',
      evidence: [],
      recommendation: 'Treat this finding as unverified and verify it independently before publishing.',
      missingEvidence: [],
      refutedBy: [],
      severityStatus: 'CONFIRMED',
      // Nothing was traced and nothing was falsified, because no verdict was
      // returned at all. PROVISIONAL is the only honest label for a placeholder.
      verificationStatus: 'PROVISIONAL',
      verifiedPath: [],
      contradictionsChecked: [],
    });
  }

  // Not material: these constrain the review without invalidating it. Only the
  // reviewer can say a gap actually blocked a verdict.
  for (const detail of context.requirement.limitations) limitations.push({ area: 'requirement', detail, material: false, affects: [] });
  for (const detail of context.external.limitations) limitations.push({ area: 'external-evidence', detail, material: false, affects: [] });
  for (const detail of context.database.limitations) limitations.push({ area: 'database', detail, material: false, affects: [] });

  if (context.scopeNotice) {
    limitations.push({
      area: 'review-scope',
      detail:
        `The review was rooted at "${context.scopeNotice.scopedTo}", below the workspace. ` +
        `Not visible to the reviewer: ${context.scopeNotice.unreachableSiblings.join(', ')}.`,
      impact:
        'A defect that depends on a sibling directory could not be confirmed or refuted from this root.',
      material: false,
      affects: [],
    });
  }

  // A citation that points at nothing is reported as its own fact, separately
  // from any verdict. It says the author's write-up is wrong about where the
  // evidence is; it says nothing about whether the defect exists, and reading it
  // as a refutation is the exact error this whole path exists to prevent.
  const broken = citationChecks.filter((check) => (BROKEN_CITATION_STATUSES as readonly string[]).includes(check.status));
  if (broken.length > 0) {
    limitations.push({
      area: 'author-citation',
      detail:
        `${broken.length} citation(s) supplied with these findings do not resolve: ` +
        broken.map((check) => `${check.candidateId} cites ${check.cited} — ${check.detail}`).join(' '),
      impact:
        'The cited evidence could not be located, so it supports nothing as written. Correct or replace the citation. ' +
        'This does not by itself make the finding false.',
      material: false,
      affects: [...new Set(broken.map((check) => check.candidateId))],
    });
  }

  const unsupported = (result.citationAssessments ?? []).filter(
    (assessment) => assessment.supportsClaim === 'DOES_NOT_SUPPORT' || assessment.supportsClaim === 'CONTRADICTS',
  );
  if (unsupported.length > 0) {
    limitations.push({
      area: 'author-citation',
      detail: unsupported
        .map((assessment) => `${assessment.candidateId} cites ${assessment.cited}, which ${assessment.supportsClaim === 'CONTRADICTS' ? 'contradicts' : 'does not support'} the claim: ${assessment.detail}`)
        .join(' '),
      impact: 'The citation resolves but does not carry the claim attached to it. The claim needs different evidence, or withdrawal.',
      material: false,
      affects: [...new Set(unsupported.map((assessment) => assessment.candidateId))],
    });
  }

  if (!coverage.scopeComplete) {
    limitations.push({
      area: 'review-scope',
      detail: `The review could not read part of the system it depends on: ${coverage.scopeGaps.join('; ')}.`,
      impact:
        'Confidence is capped for every verdict in this review. A finding that turns on the unread code can be neither confirmed nor refuted from here.',
      material: false,
      affects: [],
    });
  }

  // Confirmation, refutation, and confidence discipline all run before the
  // summary and the status: a verdict the gate changes must be counted as changed.
  const gated = gateBugReview({ findings, additionalFindings: result.additionalFindings, coverage });
  limitations.push(...gated.limitations);

  const count = (verdict: string): number => gated.findings.filter((finding) => finding.verdict === verdict).length;
  const summary = {
    confirmed: count('CONFIRMED'),
    refuted: count('REFUTED'),
    unproven: count('UNPROVEN'),
    conflictingEvidence: count('CONFLICTING_EVIDENCE'),
    insufficientScope: count('INSUFFICIENT_SCOPE'),
    other: gated.findings.filter(
      (finding) =>
        !['CONFIRMED', 'REFUTED', 'UNPROVEN', 'CONFLICTING_EVIDENCE', 'INSUFFICIENT_SCOPE'].includes(finding.verdict),
    ).length,
  };

  return {
    ...result,
    status: deriveBugReviewStatus({ ...result, additionalFindings: gated.additionalFindings }, gated.findings, limitations),
    findings: gated.findings,
    additionalFindings: gated.additionalFindings,
    summary,
    citationChecks: [...citationChecks],
    limitations,
  };
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
  // Every verdict that did not settle the claim leaves the picture incomplete.
  // CONFLICTING_EVIDENCE counts here too: the review found both sides and
  // deliberately declined to pick, which a human still has to resolve.
  const unresolved = findings.some((finding) => UNSETTLED_VERDICTS.includes(finding.verdict));
  if (result.status === 'INCONCLUSIVE' || unresolved || limitations.some((limitation) => limitation.material)) {
    return 'INCONCLUSIVE';
  }

  // An `OPTIONAL` additional finding is an observation the reviewer itself said
  // the artifact survives without; counting it as required action is what turns
  // a padded list into a blocked review.
  const blockingAdditions = result.additionalFindings.filter((finding) => finding.objectionPriority !== 'OPTIONAL');

  const needsAction =
    findings.some((finding) =>
      ['REFUTED', 'SEVERITY_DISAGREEMENT', 'DUPLICATE_OR_ALREADY_COVERED'].includes(finding.verdict),
    ) ||
    blockingAdditions.length > 0 ||
    result.disagreements.some((disagreement) => disagreement.material);

  return needsAction ? 'CHANGES_REQUIRED' : 'PASS';
}
