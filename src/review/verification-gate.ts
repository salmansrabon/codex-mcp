import type { CandidateTestCase } from '../schemas/qualify-request.js';
import type { BugFinding, BugReviewResult } from '../schemas/bug-review-result.js';
import type { Limitation, VerificationStatus } from '../schemas/review-common.js';
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
  contradictionsChecked: { outcome: 'no-contradiction-found' | 'weakens' | 'refutes' | 'unresolved'; checked: string }[];
  impactConfidence?: 'low' | 'medium' | 'high';
  scopeCaveat?: string;
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
 * Gate bug verdicts.
 *
 * The extra rule here is that `VERIFIED` plus `confidence: high` is itself a
 * confirmation claim, whatever `verificationStatus` says. A verdict that
 * asserts a defect is real at high confidence, without a recorded contradiction
 * search, is the same failure in a different field — so the confidence follows
 * the verification status down.
 */
export function gateBugReview(input: {
  findings: readonly BugFinding[];
  additionalFindings: BugReviewResult['additionalFindings'];
}): BugGateOutcome {
  const adjustments: GateAdjustment[] = [];

  const findings = input.findings.map((finding) => {
    const gated = gateEntry(finding, finding.candidateId, adjustments);
    const downgraded = gated.verificationStatus !== finding.verificationStatus;

    if (downgraded && finding.verdict === 'VERIFIED' && finding.confidence === 'high') {
      adjustments.push({
        subject: finding.candidateId,
        detail: 'confidence was lowered from high to medium: a VERIFIED verdict at high confidence is itself a confirmation claim.',
      });
      return { ...gated, confidence: 'medium' as const };
    }
    return gated;
  });

  const additionalFindings = input.additionalFindings.map((finding) => gateEntry(finding, finding.title, adjustments));

  const limitations: Limitation[] = [];
  const note = adjustmentLimitation('verification-discipline', adjustments);
  if (note) limitations.push(note);

  return { findings, additionalFindings, limitations };
}
