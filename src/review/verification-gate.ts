import type { CandidateTestCase } from '../schemas/qualify-request.js';
import type { BugFinding, BugReviewResult, BugVerdict } from '../schemas/bug-review-result.js';
import { RELEASE_BLOCKER_CLASSES } from '../schemas/review-common.js';
import type { Confidence, Limitation, VerificationStatus } from '../schemas/review-common.js';
import type { RiskDiscoveryResult } from '../schemas/risk-discovery-result.js';
import type { MissingEntry, ModifyEntry, RemoveEntry, TestReviewResult } from '../schemas/test-review-result.js';

/**
 * Deterministic confidence and value rules, applied to a review after the
 * schema accepts it and before the caller sees it.
 *
 * Everything here could have been written as prompt text, and some of it also
 * is. The difference is that a prompt asks and this decides. The failure that
 * motivated the file was a reviewer that traced one supporting file, never
 * looked for the guard two hops further along, and returned `CONFIRMED` with
 * `impactConfidence: high` — a claim its own evidence did not support. No
 * wording change makes that impossible; a rule that reads the evidence the
 * reviewer actually recorded does.
 *
 * Two properties are load-bearing:
 *
 *  - **Nothing is ever upgraded.** Every rule can weaken a claim or demote an
 *    objection; none can strengthen one. A reviewer cannot talk its way past
 *    the gate, and the gate cannot manufacture confidence the reviewer did not
 *    claim.
 *  - **Nothing is deleted.** Content stays; only its labels move, and every
 *    move is recorded as a limitation naming what it touched. A silently
 *    dropped finding would be a worse failure than the one being corrected.
 */

/** What `CONFIRMED` costs: a real trace, plus a contradiction search that came back empty. */
export const MIN_TRACE_HOPS_FOR_CONFIRMED = 2;

export interface GateAdjustment {
  /** Finding id or title, so the limitation can name what it touched. */
  subject: string;
  detail: string;
}

interface Verifiable {
  verificationStatus: VerificationStatus;
  verifiedPath: string[];
  contradictionsChecked: {
    outcome: 'no-contradiction-found' | 'weakens' | 'refutes' | 'unresolved';
    checked: string;
    contradictoryEvidence?: { source: string; location: string; note?: string }[];
  }[];
  impactConfidence?: 'low' | 'medium' | 'high';
  scopeCaveat?: string;
}

/**
 * What the review could actually see, assembled by the orchestrator from
 * evidence collection rather than from anything the reviewer said.
 *
 * Confidence is capped from this. A reviewer that could not read a participating
 * repository, or whose subject cited a file that does not exist, has a ceiling
 * on how sure it is allowed to sound — and that ceiling is a fact about the
 * review, not a judgment the reviewer gets to make about itself.
 */
export interface EvidenceCoverage {
  /** False when a discovered related repository, or a narrowed scope, left part of the system unreadable. */
  scopeComplete: boolean;
  /** Candidate ids that cited something at all. A finding with no citations has nothing to verify. */
  citationsPresent: ReadonlySet<string>;
  /** Candidate ids whose author citations were all resolved on disk. */
  citationsVerified: ReadonlySet<string>;
  /** Candidate ids with at least one citation that named a file or line that is not there. */
  brokenCitations: ReadonlySet<string>;
  /** Human-readable reasons scope is incomplete, for the limitation text. */
  scopeGaps: readonly string[];
}

export const FULL_COVERAGE: EvidenceCoverage = {
  scopeComplete: true,
  citationsPresent: new Set(),
  citationsVerified: new Set(),
  brokenCitations: new Set(),
  scopeGaps: [],
};

const CONFIDENCE_RANK: Record<Confidence, number> = { low: 0, medium: 1, high: 2 };

/** Lower a confidence to a ceiling. Never raises — a cap is not a grant. */
function capConfidence(current: Confidence | undefined, ceiling: Confidence): Confidence | undefined {
  if (current === undefined) return undefined;
  return CONFIDENCE_RANK[current] > CONFIDENCE_RANK[ceiling] ? ceiling : current;
}

/**
 * Why a claim may not call itself CONFIRMED, or `undefined` when it may.
 *
 * Ordered by how badly the claim is hurt: an actual refutation outranks a thin
 * trace, because one says the reviewer found contrary evidence and the other
 * only says it did not look far.
 */
function confirmationBlocker(entry: Verifiable): { status: VerificationStatus; reason: string } | undefined {
  const refuted = entry.contradictionsChecked.find((check) => check.outcome === 'refutes');
  if (refuted) {
    return {
      // Its own contradiction search refuted it. That is not a weaker version
      // of the same claim, it is a lead at best — and the reviewer should
      // normally have withdrawn it rather than downgraded it.
      status: 'HYPOTHESIS',
      reason: `its own contradiction search refuted the stated mechanism ("${refuted.checked}")`,
    };
  }

  const weakened = entry.contradictionsChecked.find((check) => check.outcome === 'weakens');
  if (weakened) {
    return { status: 'PROVISIONAL', reason: `a contradiction check partly undermined it ("${weakened.checked}")` };
  }

  const cleared = entry.contradictionsChecked.some((check) => check.outcome === 'no-contradiction-found');
  if (!cleared) {
    const unresolved = entry.contradictionsChecked.some((check) => check.outcome === 'unresolved');
    return {
      status: 'PROVISIONAL',
      reason: unresolved
        ? 'every contradiction check it recorded was left unresolved'
        : 'it recorded no completed contradiction search',
    };
  }

  if (entry.verifiedPath.length < MIN_TRACE_HOPS_FOR_CONFIRMED) {
    return {
      status: 'PROVISIONAL',
      // The evaluation's actual failure mode: one file that appears to support
      // the claim, treated as a traced path. A mechanism is a chain.
      reason: `it names ${entry.verifiedPath.length === 0 ? 'no' : 'only one'} inspected hop, which is not a traced path`,
    };
  }

  return undefined;
}

/**
 * Apply the confirmation rule to one entry, in place of trusting its label.
 *
 * `impactConfidence` is capped alongside the downgrade because the two travel
 * together: a mechanism the reviewer could not establish cannot support a
 * high-confidence claim about that mechanism's blast radius.
 */
function gateEntry<T extends Verifiable>(entry: T, subject: string, adjustments: GateAdjustment[]): T {
  if (entry.verificationStatus !== 'CONFIRMED') return entry;

  const blocker = confirmationBlocker(entry);
  if (!blocker) return entry;

  adjustments.push({
    subject,
    detail: `CONFIRMED was downgraded to ${blocker.status} because ${blocker.reason}.`,
  });

  return {
    ...entry,
    verificationStatus: blocker.status,
    ...(entry.impactConfidence === 'high' ? { impactConfidence: 'medium' as const } : {}),
    scopeCaveat:
      entry.scopeCaveat ??
      `Unverified: ${blocker.reason}. The concern may still be valid; the stated mechanism is not established.`,
  };
}

/** One limitation per gate pass, listing what moved. Not material: the findings survive, their labels changed. */
function adjustmentLimitation(area: string, adjustments: readonly GateAdjustment[]): Limitation | undefined {
  if (adjustments.length === 0) return undefined;
  return {
    area,
    detail: adjustments.map((adjustment) => `${adjustment.subject}: ${adjustment.detail}`).join(' '),
    impact:
      'These entries claimed more certainty than the evidence they recorded supports. Treat them as concerns to investigate, not as established facts.',
    material: false,
    affects: [...new Set(adjustments.map((adjustment) => adjustment.subject))],
  };
}

export interface TestGateOutcome {
  modify: ModifyEntry[];
  remove: RemoveEntry[];
  missing: MissingEntry[];
  portfolio?: TestReviewResult['portfolio'];
  limitations: Limitation[];
}

export interface TestGateInput {
  modify: readonly ModifyEntry[];
  remove: readonly RemoveEntry[];
  missing: readonly MissingEntry[];
  candidates: readonly CandidateTestCase[];
  /** Declared hard ceiling on the final artifact, when the caller set one. */
  maxTestCases?: number;
  /** True when the caller declared coverage that exists outside this artifact. */
  knownCoverageDeclared: boolean;
}

/**
 * Gate a test-design delta: confirmation discipline, the value threshold, the
 * coverage-search requirement, and the portfolio arithmetic.
 */
export function gateTestReview(input: TestGateInput): TestGateOutcome {
  const confirmation: GateAdjustment[] = [];
  const value: GateAdjustment[] = [];

  const modify = input.modify.map((entry) => gateEntry(entry, entry.candidateId, confirmation));
  const remove = input.remove.map((entry) => gateEntry(entry, entry.candidateId, confirmation));

  const missing = input.missing.map((entry) => {
    let gated = gateEntry(entry, entry.title, confirmation);

    // The value threshold. An addition that cannot name a risk nothing else
    // covers is a coverage count, and a reviewer optimizing for finding count
    // produces these in bulk. Demoted, not dropped: it may still be a fair
    // observation, it just must not read as required work.
    if (!gated.uniqueRisk?.trim() && gated.objectionPriority !== 'OPTIONAL') {
      value.push({
        subject: gated.title,
        detail: `demoted from ${gated.objectionPriority} to OPTIONAL because it names no unique risk that existing coverage misses.`,
      });
      gated = { ...gated, objectionPriority: 'OPTIONAL' };
    }

    // "Absent from this artifact" is not "untested". When the caller went to
    // the trouble of declaring existing coverage, a MUST_FIX that never
    // searched it is the exact error this rule exists for.
    if (gated.objectionPriority === 'MUST_FIX' && gated.coverageChecked.length === 0 && input.knownCoverageDeclared) {
      value.push({
        subject: gated.title,
        detail:
          'demoted from MUST_FIX to SHOULD_FIX because it names no existing test or declared coverage it searched before calling the scenario untested.',
      });
      gated = { ...gated, objectionPriority: 'SHOULD_FIX' };
    }

    return gated;
  });

  const limitations: Limitation[] = [];
  const confirmationNote = adjustmentLimitation('verification-discipline', confirmation);
  if (confirmationNote) limitations.push(confirmationNote);
  const valueNote = adjustmentLimitation('objection-value', value);
  if (valueNote) limitations.push(valueNote);

  const portfolio = computePortfolio(input, remove, missing);
  if (portfolio && portfolio.unresolvedOverflow.length > 0) {
    limitations.push({
      area: 'case-ceiling',
      detail:
        `The artifact declares a ceiling of ${portfolio.ceiling} test cases and ${portfolio.retained} would be retained, ` +
        `leaving room for ${Math.max(0, portfolio.headroom)}. These additions exceed it without naming what they displace: ` +
        `${portfolio.unresolvedOverflow.join(', ')}.`,
      impact:
        'The final artifact cannot hold every proposed addition. Treat the unresolved ones as ranked candidates and displace weaker cases, or leave them out.',
      material: false,
      affects: [...portfolio.unresolvedOverflow],
    });
  }

  return { modify, remove, missing, ...(portfolio ? { portfolio } : {}), limitations };
}

/**
 * Portfolio arithmetic under a declared ceiling.
 *
 * Computed here rather than asked of the reviewer for the same reason status is:
 * it is a count over the delta, and a count is not a judgment. `OPTIONAL`
 * additions are excluded — they were explicitly marked as not blocking
 * acceptance, so charging them against a hard ceiling would manufacture an
 * overflow out of observations.
 */
function computePortfolio(
  input: TestGateInput,
  remove: readonly RemoveEntry[],
  missing: readonly MissingEntry[],
): TestReviewResult['portfolio'] | undefined {
  const ceiling = input.maxTestCases;
  if (ceiling === undefined) return undefined;

  const retained = Math.max(0, input.candidates.length - remove.length);
  const required = missing.filter((entry) => entry.objectionPriority !== 'OPTIONAL');
  const headroom = ceiling - retained;

  // Free slots are taken in the reviewer's own order, so the entries that
  // overflow are the ones it ranked last rather than an arbitrary slice.
  const overflow = required.slice(Math.max(0, headroom));
  const unresolvedOverflow = overflow.filter((entry) => entry.displaces.length === 0).map((entry) => entry.title);

  return {
    ceiling,
    retained,
    proposedAdditions: required.length,
    headroom,
    withinCeiling: retained + required.length <= ceiling,
    unresolvedOverflow,
  };
}

export interface BugGateOutcome {
  findings: BugFinding[];
  additionalFindings: BugReviewResult['additionalFindings'];
  limitations: Limitation[];
}

/**
 * Why a `REFUTED` verdict may not stand, or `undefined` when it may.
 *
 * This is the single most important rule in the file. Overturning somebody
 * else's finding is the most destructive thing this reviewer can do — the
 * author drops a real defect and ships — and it is also the easiest conclusion
 * to reach badly, because "I searched and found nothing" feels identical from
 * the inside to "I searched and found the thing that makes this impossible".
 *
 * So a refutation must produce something. A contradiction check with
 * `outcome: 'refutes'` and at least one piece of cited contradictory evidence
 * is the price. Everything short of it lands on a verdict that leaves the
 * author's finding standing:
 *
 *  - nothing was reachable            -> `INSUFFICIENT_SCOPE`
 *  - looked, found nothing either way -> `UNPROVEN`
 *  - found support *and* contradiction -> `CONFLICTING_EVIDENCE`
 */
function refutationBlocker(finding: BugFinding): { verdict: BugVerdict; reason: string } | undefined {
  if (finding.verdict !== 'REFUTED') return undefined;

  // Read defensively: a caller constructing a finding by hand must get a
  // downgrade rather than a crash — a thrown gate would fail the review open.
  const checks = finding.contradictionsChecked ?? [];
  const refutedBy = finding.refutedBy ?? [];

  // The whole rule, in one condition. `evidence` is what the reviewer looked
  // at, and a failed search has plenty of that; `refutedBy` is what it found
  // that makes the claim impossible, and an empty search cannot produce any.
  if (refutedBy.length === 0) {
    const everythingUnresolved = checks.length > 0 && checks.every((check) => check.outcome === 'unresolved');
    return {
      verdict: everythingUnresolved ? 'INSUFFICIENT_SCOPE' : 'UNPROVEN',
      reason: everythingUnresolved
        ? 'every check it ran was left unresolved, so nothing was established either way'
        : 'it cites nothing in `refutedBy` that makes the claim impossible — failing to find support is not contradiction',
    };
  }

  // The reviewer's own falsification of its refutation came back against it:
  // it found the guard, and then found a path around the guard. Both sides are
  // now on the table and one reviewer does not get to pick.
  const selfRefuted = checks.find((check) => check.outcome === 'refutes' || check.outcome === 'weakens');
  if (selfRefuted) {
    return {
      verdict: 'CONFLICTING_EVIDENCE',
      reason: `it cites contradicting evidence but its own check ("${selfRefuted.checked}") came back against the refutation`,
    };
  }

  return undefined;
}

/**
 * The confidence ceiling this finding has earned, given what the review could
 * see.
 *
 * Confidence is meant to describe how certain the *mechanism* is, and left to
 * itself a model reports how certain its prose sounds. These caps re-anchor it
 * to evidence coverage. Each returns a ceiling and a reason; the lowest wins.
 */
function confidenceCeiling(
  finding: BugFinding,
  coverage: EvidenceCoverage,
): { ceiling: Confidence; reason: string } | undefined {
  const caps: { ceiling: Confidence; reason: string }[] = [];

  if (!coverage.scopeComplete) {
    caps.push({
      ceiling: 'medium',
      reason: `part of the system could not be read (${coverage.scopeGaps.join('; ') || 'incomplete repository scope'})`,
    });
  }

  // Overturning a finding whose evidence you never managed to check is the
  // fabricated-citation failure in reverse: the citation being broken says
  // something about the author's write-up, not about whether the defect exists.
  // Only when the author actually cited something that failed to resolve. A
  // finding that cited nothing has no unchecked premise — it has no premise,
  // which the other rules already handle.
  if (
    finding.verdict === 'REFUTED' &&
    coverage.citationsPresent.has(finding.candidateId) &&
    !coverage.citationsVerified.has(finding.candidateId)
  ) {
    caps.push({
      ceiling: 'medium',
      reason: "the author's own citations for this finding did not resolve, so the refutation rests on an unchecked premise",
    });
  }

  if (finding.verdict === 'CONFLICTING_EVIDENCE') {
    caps.push({ ceiling: 'medium', reason: 'the evidence points both ways' });
  }

  if (finding.verdict === 'UNPROVEN' || finding.verdict === 'INSUFFICIENT_SCOPE') {
    caps.push({ ceiling: 'low', reason: 'nothing was established either way' });
  }

  if (finding.verificationStatus !== 'CONFIRMED') {
    caps.push({ ceiling: 'medium', reason: `the mechanism is only ${finding.verificationStatus}` });
  }

  if (caps.length === 0) return undefined;
  return caps.reduce((lowest, current) => (CONFIDENCE_RANK[current.ceiling] < CONFIDENCE_RANK[lowest.ceiling] ? current : lowest));
}

/**
 * Gate bug verdicts.
 *
 * Three rules, in order: a refutation must have produced contradictory
 * evidence; a claim may not call itself CONFIRMED without a trace and a
 * completed contradiction search; and confidence may not exceed what the
 * review's evidence coverage supports.
 */
export function gateBugReview(input: {
  findings: readonly BugFinding[];
  additionalFindings: BugReviewResult['additionalFindings'];
  coverage?: EvidenceCoverage;
}): BugGateOutcome {
  const coverage = input.coverage ?? FULL_COVERAGE;
  const adjustments: GateAdjustment[] = [];
  const refutations: GateAdjustment[] = [];
  const confidenceCaps: GateAdjustment[] = [];

  const findings = input.findings.map((finding) => {
    let current: BugFinding = finding;

    // 1. Refutation discipline, before anything else: the verdict decides which
    //    confidence rules apply, so it has to be settled first.
    const blocked = refutationBlocker(current);
    if (blocked) {
      refutations.push({
        subject: current.candidateId,
        detail: `REFUTED was changed to ${blocked.verdict} because ${blocked.reason}. The author's finding stands until contradicted.`,
      });
      current = {
        ...current,
        verdict: blocked.verdict,
        recommendation:
          `codex-mcp did not overturn this finding: ${blocked.reason}. ` +
          `Original reviewer recommendation: ${current.recommendation}`,
      };
    }

    // 2. Confirmation discipline on the mechanism.
    current = gateEntry(current, current.candidateId, adjustments);

    // 3. Confidence, capped by evidence coverage rather than by tone.
    const ceiling = confidenceCeiling(current, coverage);
    if (ceiling) {
      const capped = capConfidence(current.confidence, ceiling.ceiling);
      if (capped && capped !== current.confidence) {
        confidenceCaps.push({
          subject: current.candidateId,
          detail: `confidence was capped from ${current.confidence} to ${capped} because ${ceiling.reason}.`,
        });
        current = { ...current, confidence: capped };
      }
    }

    return current;
  });

  const additionalFindings = input.additionalFindings.map((finding) => {
    const gated = gateEntry(finding, finding.title, adjustments);
    if (coverage.scopeComplete || gated.impactConfidence !== 'high') return gated;
    confidenceCaps.push({
      subject: gated.title,
      detail: `impact confidence was capped from high to medium because ${coverage.scopeGaps.join('; ') || 'repository scope was incomplete'}.`,
    });
    return { ...gated, impactConfidence: 'medium' as const };
  });

  const limitations: Limitation[] = [];
  const note = adjustmentLimitation('verification-discipline', adjustments);
  if (note) limitations.push(note);

  if (refutations.length > 0) {
    limitations.push({
      area: 'refutation-discipline',
      detail: refutations.map((adjustment) => `${adjustment.subject}: ${adjustment.detail}`).join(' '),
      impact:
        'A finding is only overturned by evidence that contradicts it. These were downgraded rather than refuted, ' +
        'which means the author keeps them and must resolve them another way.',
      material: false,
      affects: [...new Set(refutations.map((adjustment) => adjustment.subject))],
    });
  }

  const capNote = adjustmentLimitation('confidence-calibration', confidenceCaps);
  if (capNote) limitations.push(capNote);

  return { findings, additionalFindings, limitations };
}

export interface RiskGateOutcome {
  findings: RiskDiscoveryResult['findings'];
  blockerSweep: RiskDiscoveryResult['blockerSweep'];
  coverageMap: RiskDiscoveryResult['coverageMap'];
  limitations: Limitation[];
}

export interface RiskGateInput {
  findings: RiskDiscoveryResult['findings'];
  blockerSweep: RiskDiscoveryResult['blockerSweep'];
  coverageMap: RiskDiscoveryResult['coverageMap'];
  coverage?: EvidenceCoverage;
  /** True when a blast-radius artifact was supplied, which is what makes an unvisited node a real gap. */
  blastRadiusSupplied: boolean;
}

/**
 * Gate independent discovery.
 *
 * Confirmation discipline applies to discovered findings exactly as it does to
 * verdicts. Two rules are specific to this path, and both exist because their
 * failure mode is a review that looks finished:
 *
 *  - **An unanswered blocker class is reported, not assumed clear.** Silence
 *    about backward compatibility is indistinguishable from a clean bill of
 *    health unless something writes down which one happened.
 *  - **An uninspected high-risk blast-radius node makes the review material.**
 *    Not a note in the margin — `material: true`, which drives the whole review
 *    to `INCONCLUSIVE`. Concluding while a high-risk component sits unopened is
 *    the specific thing a coverage map exists to prevent, so it has to cost
 *    something.
 */
export function gateRiskDiscovery(input: RiskGateInput): RiskGateOutcome {
  const coverage = input.coverage ?? FULL_COVERAGE;
  const adjustments: GateAdjustment[] = [];
  const confidenceCaps: GateAdjustment[] = [];
  const limitations: Limitation[] = [];

  const findings = input.findings.map((finding) => {
    let gated = gateEntry(finding, finding.title, adjustments);

    if (!coverage.scopeComplete && gated.impactConfidence === 'high') {
      confidenceCaps.push({
        subject: gated.title,
        detail: `impact confidence was capped from high to medium because ${coverage.scopeGaps.join('; ')}.`,
      });
      gated = { ...gated, impactConfidence: 'medium' as const };
    }

    // A release-blocking claim is the strongest thing this path can say, and an
    // untraced one is an alarm rather than a finding. It keeps the finding and
    // loses the claim to block.
    if (gated.releaseBlocking && gated.verificationStatus === 'HYPOTHESIS') {
      adjustments.push({
        subject: gated.title,
        detail: 'releaseBlocking was withdrawn: a blocker whose mechanism is only a hypothesis is a lead to investigate, not a stop-ship.',
      });
      gated = { ...gated, releaseBlocking: false };
    }

    return gated;
  });

  const answered = new Set(input.blockerSweep.map((entry) => entry.blockerClass));
  const unanswered = RELEASE_BLOCKER_CLASSES.filter((blockerClass) => !answered.has(blockerClass));
  const notInspected = input.blockerSweep.filter((entry) => entry.applicable && entry.outcome === 'not-inspected');

  if (unanswered.length > 0 || notInspected.length > 0) {
    const parts: string[] = [];
    if (unanswered.length > 0) parts.push(`never considered: ${unanswered.join(', ')}`);
    if (notInspected.length > 0) {
      parts.push(`considered but not inspected: ${notInspected.map((entry) => entry.blockerClass).join(', ')}`);
    }
    limitations.push({
      area: 'release-blocker-sweep',
      detail: `The release-blocker sweep is incomplete — ${parts.join('; ')}.`,
      impact:
        'A blocker class nobody inspected has not been cleared. Do not read the absence of a finding in these classes as their absence in the change.',
      material: false,
      affects: [...unanswered, ...notInspected.map((entry) => entry.blockerClass)],
    });
  }

  // A sweep that says it found a blocker and names no finding has lost it
  // somewhere between the two fields; that is worth saying out loud.
  const danglingBlockers = input.blockerSweep.filter(
    (entry) => entry.outcome === 'blocker-found' && entry.findings.length === 0,
  );
  if (danglingBlockers.length > 0) {
    limitations.push({
      area: 'release-blocker-sweep',
      detail: `These classes reported a blocker without naming the finding that carries it: ${danglingBlockers
        .map((entry) => entry.blockerClass)
        .join(', ')}.`,
      impact: 'The blocker was asserted but not written up. Treat the class as unresolved.',
      material: false,
      affects: danglingBlockers.map((entry) => entry.blockerClass),
    });
  }

  const unvisitedHighRisk = input.coverageMap.filter(
    (node) => node.risk === 'high' && (!node.inspected || node.outcome === 'not-inspected' || node.outcome === 'unreachable'),
  );
  if (unvisitedHighRisk.length > 0) {
    limitations.push({
      area: 'blast-radius-coverage',
      detail: `High-risk components in the blast radius were not inspected: ${unvisitedHighRisk
        .map((node) => `${node.component} (${node.outcome})`)
        .join(', ')}.`,
      impact:
        'The review reached a conclusion with high-risk affected components unopened. Its silence about them is not a clean result.',
      // Material only when a blast radius was actually supplied: inventing an
      // INCONCLUSIVE out of a coverage map the reviewer volunteered would
      // punish the reviewer for being thorough about its own gaps.
      material: input.blastRadiusSupplied,
      affects: unvisitedHighRisk.map((node) => node.component),
    });
  }

  const note = adjustmentLimitation('verification-discipline', adjustments);
  if (note) limitations.push(note);
  const capNote = adjustmentLimitation('confidence-calibration', confidenceCaps);
  if (capNote) limitations.push(capNote);

  return { findings, blockerSweep: input.blockerSweep, coverageMap: input.coverageMap, limitations };
}
