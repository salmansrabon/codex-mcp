import { describe, expect, it } from 'vitest';

import { deriveBugReviewStatus } from '../../src/review/bug-reviewer.js';
import { deriveTestReviewStatus } from '../../src/review/test-design-reviewer.js';
import { BugFindingSchema, type BugFinding } from '../../src/schemas/bug-review-result.js';
import { LimitationSchema, type Disagreement, type Limitation } from '../../src/schemas/review-common.js';
import { MissingEntrySchema } from '../../src/schemas/test-review-result.js';

/**
 * Status is derived in code because the reviewer's own grade is unreliable: a
 * model asked whether its output requires action will sometimes say no while
 * handing back a delta that plainly does.
 */

const NO_CHANGES = { modify: [], remove: [], missing: [] };

/**
 * A ranked missing entry. Status derivation reads `objectionPriority`, so a
 * fixture that omitted it would be testing the schema default rather than the
 * rule.
 */
function missing(overrides: Record<string, unknown> = {}) {
  return MissingEntrySchema.parse({
    title: 'cross-tenant read is untested',
    priority: 'high',
    reason: 'no candidate covers it',
    uniqueRisk: 'another tenant can read this record and nothing would catch it',
    objectionPriority: 'MUST_FIX',
    ...overrides,
  });
}

function disagreement(overrides: Partial<Disagreement> = {}): Disagreement {
  return {
    topic: 'queue persistence on session-type change',
    candidatePosition: 'the queue is cleared',
    reviewerPosition: 'the implementation persists it',
    evidence: [],
    material: true,
    ...overrides,
  };
}

function limitation(overrides: Partial<Limitation> = {}): Limitation {
  return { area: 'requirement', detail: 'the ticket could not be read', material: false, ...overrides };
}

function finding(verdict: BugFinding['verdict']): BugFinding {
  return {
    candidateId: 'BUG-1',
    verdict,
    confidence: 'high',
    reason: 'reason',
    evidence: [],
    recommendation: 'keep',
    missingEvidence: [],
  };
}

describe('deriveTestReviewStatus', () => {
  it('never returns PASS while a material disagreement is unresolved', () => {
    // The delta is empty, so the pre-change normalizer would have said PASS and
    // handed back a clean bill of health with an open dispute attached to it.
    const status = deriveTestReviewStatus(
      { status: 'PASS', disagreements: [disagreement()] },
      NO_CHANGES,
      [],
    );
    expect(status).toBe('CHANGES_REQUIRED');
  });

  it('allows PASS when a disagreement is explicitly non-material', () => {
    const status = deriveTestReviewStatus(
      { status: 'PASS', disagreements: [disagreement({ material: false })] },
      NO_CHANGES,
      [],
    );
    expect(status).toBe('PASS');
  });

  it('ignores the reviewer claiming PASS when the delta requires action', () => {
    const status = deriveTestReviewStatus({ status: 'PASS', disagreements: [] }, { ...NO_CHANGES, missing: [missing()] }, []);
    expect(status).toBe('CHANGES_REQUIRED');
  });

  it('does not block acceptance on OPTIONAL observations alone', () => {
    // Ranking exists so a report cannot be padded into significance: an entry
    // the reviewer itself called optional is a note, not required work.
    const status = deriveTestReviewStatus(
      { status: 'CHANGES_REQUIRED', disagreements: [] },
      { ...NO_CHANGES, missing: [missing({ objectionPriority: 'OPTIONAL' })] },
      [],
    );
    expect(status).toBe('PASS');
  });

  it('still blocks when a ranked entry sits alongside optional ones', () => {
    const status = deriveTestReviewStatus(
      { status: 'PASS', disagreements: [] },
      {
        ...NO_CHANGES,
        missing: [missing({ objectionPriority: 'OPTIONAL' }), missing({ objectionPriority: 'SHOULD_FIX' })],
      },
      [],
    );
    expect(status).toBe('CHANGES_REQUIRED');
  });

  it('returns INCONCLUSIVE when a limitation prevented a reliable assessment', () => {
    const status = deriveTestReviewStatus(
      { status: 'PASS', disagreements: [] },
      { ...NO_CHANGES, missing: [missing(), missing(), missing()] },
      [limitation({ material: true })],
    );
    expect(status).toBe('INCONCLUSIVE');
  });

  it('does not let routine evidence gaps make every review INCONCLUSIVE', () => {
    // A skipped connector is the normal state of a partially-connected setup.
    const status = deriveTestReviewStatus({ status: 'PASS', disagreements: [] }, NO_CHANGES, [
      limitation(),
      limitation({ area: 'external-evidence' }),
    ]);
    expect(status).toBe('PASS');
  });

  it('passes ERROR through, since only the reviewer can know it', () => {
    expect(deriveTestReviewStatus({ status: 'ERROR', disagreements: [] }, NO_CHANGES, [])).toBe('ERROR');
  });
});

describe('deriveBugReviewStatus', () => {
  const clean = { status: 'PASS' as const, additionalFindings: [], disagreements: [] };

  it('returns PASS when every candidate is verified and nothing else is pending', () => {
    expect(deriveBugReviewStatus(clean, [finding('CONFIRMED')], [])).toBe('PASS');
  });

  it.each(['REFUTED', 'SEVERITY_DISAGREEMENT', 'DUPLICATE_OR_ALREADY_COVERED'] as const)(
    'returns CHANGES_REQUIRED for a %s verdict',
    (verdict) => {
      expect(deriveBugReviewStatus(clean, [finding(verdict)], [])).toBe('CHANGES_REQUIRED');
    },
  );

  // Every verdict that leaves the claim unsettled, including the one where the
  // reviewer found both sides and deliberately declined to pick.
  it.each(['UNPROVEN', 'CONFLICTING_EVIDENCE', 'INSUFFICIENT_SCOPE'] as const)(
    'returns INCONCLUSIVE for a %s verdict',
    (verdict) => {
      expect(deriveBugReviewStatus(clean, [finding(verdict)], [])).toBe('INCONCLUSIVE');
    },
  );

  it('lets an unreached verdict outrank an actionable one', () => {
    // The findings that were reached are an incomplete picture; calling that a
    // settled list of required changes overstates what the review established.
    const status = deriveBugReviewStatus(clean, [finding('REFUTED'), finding('UNPROVEN')], []);
    expect(status).toBe('INCONCLUSIVE');
  });

  it('returns CHANGES_REQUIRED when the reviewer found a bug the candidates missed', () => {
    const status = deriveBugReviewStatus(
      { ...clean, additionalFindings: [{ title: 'cross-tenant read', reason: 'no ownership check', evidence: [] }] },
      [finding('CONFIRMED')],
      [],
    );
    expect(status).toBe('CHANGES_REQUIRED');
  });

  it('never returns PASS while a material disagreement is unresolved', () => {
    const status = deriveBugReviewStatus({ ...clean, disagreements: [disagreement()] }, [finding('CONFIRMED')], []);
    expect(status).toBe('CHANGES_REQUIRED');
  });
});

describe('severity qualifiers', () => {
  it('defaults a finding to CONFIRMED so silence never reads as provisional', () => {
    const parsed = BugFindingSchema.parse({
      candidateId: 'BUG-1',
      verdict: 'CONFIRMED',
      confidence: 'high',
      reason: 'r',
      recommendation: 'keep',
    });
    expect(parsed.severityStatus).toBe('CONFIRMED');
    expect(parsed.impactConfidence).toBeUndefined();
  });

  it('keeps a critical severity while marking the impact provisional', () => {
    // The point of the split: incomplete scope must not downgrade a defect that
    // the reachable evidence already establishes as critical.
    const parsed = MissingEntrySchema.parse({
      title: 'Unauthenticated access to the admin endpoint',
      priority: 'critical',
      reason: 'No auth middleware on the route.',
      severityStatus: 'PROVISIONAL',
      impactConfidence: 'low',
      scopeCaveat: 'sharebox-webadmin was outside the review root; its callers were not inspected.',
    });
    expect(parsed.priority).toBe('critical');
    expect(parsed.severityStatus).toBe('PROVISIONAL');
    expect(parsed.impactConfidence).toBe('low');
  });

  it('lets a limitation name the findings it undermines', () => {
    const parsed = LimitationSchema.parse({
      area: 'review-scope',
      detail: 'sharebox-webadmin was not visible.',
      affects: ['TC-04', 'BUG-02'],
    });
    expect(parsed.affects).toEqual(['TC-04', 'BUG-02']);
  });

  it('defaults affects to empty rather than undefined, so callers can iterate', () => {
    expect(LimitationSchema.parse({ area: 'requirement', detail: 'x' }).affects).toEqual([]);
  });
});
