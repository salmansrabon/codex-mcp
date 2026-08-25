import type { CodexRunner } from '../codex/codex-runner.js';
import type { BrokerLaunchSpec } from '../codex/command-builder.js';
import { buildRiskDiscoveryPrompt } from '../prompts/risk-discovery.js';
import type { PromptContext } from '../prompts/base-reviewer.js';
import type { CandidateBug, CandidateTestCase } from '../schemas/qualify-request.js';
import type { Limitation } from '../schemas/review-common.js';
import {
  RiskDiscoveryResultSchema,
  type RiskDiscoveryResult,
  type RiskOverlap,
} from '../schemas/risk-discovery-result.js';
import type { Logger } from '../util/logger.js';
import { runStructuredReview } from './structured-review.js';
import { gateRiskDiscovery, type EvidenceCoverage } from './verification-gate.js';

/**
 * The independent half of the review.
 *
 * Runs as its own Codex invocation with its own prompt, and is never handed the
 * candidate set. Comparison against what the author already found happens here,
 * in code, after the run returns — which is the only ordering that produces an
 * unanchored answer.
 */

export interface RiskDiscoveryInput {
  context: PromptContext;
  runner: CodexRunner;
  logger: Logger;
  broker?: BrokerLaunchSpec;
  timeoutMs: number;
  reasoningEffort?: string;
  signal?: AbortSignal;
  coverage?: EvidenceCoverage;
}

export interface RiskDiscoveryOutput {
  result: RiskDiscoveryResult;
  repairAttempts: number;
  attemptedCommands: string[];
  usage?: { inputTokens?: number; outputTokens?: number };
}

export async function reviewRiskDiscovery(input: RiskDiscoveryInput): Promise<RiskDiscoveryOutput> {
  const prompt = buildRiskDiscoveryPrompt(input.context);

  const outcome = await runStructuredReview({
    prompt,
    schema: RiskDiscoveryResultSchema,
    schemaName: 'IndependentRiskDiscovery',
    projectRoot: input.context.projectRoot,
    ...(input.broker ? { broker: input.broker } : {}),
    timeoutMs: input.timeoutMs,
    ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
    logger: input.logger,
    runner: input.runner,
  });

  return {
    result: normalizeRiskDiscovery(outcome.result, {
      blastRadiusSupplied: input.context.artifacts.blastRadius.present,
      ...(input.coverage ? { coverage: input.coverage } : {}),
    }),
    repairAttempts: outcome.repairAttempts,
    attemptedCommands: outcome.run.attemptedCommands,
    ...(outcome.run.usage ? { usage: outcome.run.usage } : {}),
  };
}

export function normalizeRiskDiscovery(
  result: RiskDiscoveryResult,
  options: { blastRadiusSupplied: boolean; coverage?: EvidenceCoverage },
): RiskDiscoveryResult {
  const gated = gateRiskDiscovery({
    findings: result.findings,
    blockerSweep: result.blockerSweep,
    coverageMap: result.coverageMap,
    blastRadiusSupplied: options.blastRadiusSupplied,
    ...(options.coverage ? { coverage: options.coverage } : {}),
  });

  const limitations = [...result.limitations, ...gated.limitations];

  return {
    ...result,
    status: deriveRiskDiscoveryStatus(result.status, gated.findings, limitations),
    findings: gated.findings,
    blockerSweep: gated.blockerSweep,
    coverageMap: gated.coverageMap,
    limitations,
  };
}

/**
 * Status for the discovery path.
 *
 * A release blocker is `CHANGES_REQUIRED` whatever else the review says — that
 * is what the flag means. `OPTIONAL` findings still do not block, for the same
 * reason they do not on the audit path: a review made of observations is a pass
 * with notes.
 */
export function deriveRiskDiscoveryStatus(
  reported: RiskDiscoveryResult['status'],
  findings: readonly RiskDiscoveryResult['findings'][number][],
  limitations: readonly Limitation[],
): RiskDiscoveryResult['status'] {
  if (reported === 'ERROR') return 'ERROR';

  if (findings.some((finding) => finding.releaseBlocking)) return 'CHANGES_REQUIRED';

  if (reported === 'INCONCLUSIVE' || limitations.some((limitation) => limitation.material)) return 'INCONCLUSIVE';

  return findings.some((finding) => finding.objectionPriority !== 'OPTIONAL') ? 'CHANGES_REQUIRED' : 'PASS';
}

/**
 * Which discovered risks the author already had, and which are new.
 *
 * Matched on shared significant terms rather than anything cleverer, and
 * deliberately biased towards calling things `NEW`: a false `NEW` costs a reader
 * one moment of "we knew that", while a false `OVERLAPS_CANDIDATE` quietly
 * buries the finding the whole independent path existed to surface.
 */
export function compareWithCandidates(
  findings: readonly RiskDiscoveryResult['findings'][number][],
  candidates: { testCases: readonly CandidateTestCase[]; bugs: readonly CandidateBug[] },
): RiskOverlap[] {
  const candidateTerms = [
    ...candidates.bugs.map((bug) => ({ id: bug.id, terms: significantTerms(`${bug.title} ${bug.component ?? ''} ${bug.suspectedCause ?? ''}`) })),
    ...candidates.testCases.map((testCase) => ({ id: testCase.id, terms: significantTerms(`${testCase.title} ${testCase.type ?? ''}`) })),
  ];

  return findings.map((finding) => {
    const terms = significantTerms(`${finding.title} ${finding.area}`);
    const overlapping = candidateTerms
      .filter((candidate) => sharedTermCount(terms, candidate.terms) >= 2)
      .map((candidate) => candidate.id);

    return {
      title: finding.title,
      relation: overlapping.length > 0 ? ('OVERLAPS_CANDIDATE' as const) : ('NEW' as const),
      candidateIds: overlapping,
      releaseBlocking: finding.releaseBlocking,
      severity: finding.severity,
    };
  });
}

function significantTerms(text: string): Set<string> {
  const stop = new Set([
    'the', 'and', 'for', 'with', 'that', 'this', 'from', 'when', 'test', 'tests',
    'case', 'bug', 'issue', 'should', 'must', 'not', 'missing', 'invalid', 'error',
  ]);
  const terms = new Set<string>();
  for (const raw of text.split(/[^A-Za-z0-9]+/)) {
    const token = raw.toLowerCase();
    if (token.length < 4 || stop.has(token)) continue;
    terms.add(token);
  }
  return terms;
}

function sharedTermCount(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  let count = 0;
  for (const term of left) if (right.has(term)) count += 1;
  return count;
}
