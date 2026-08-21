import { describe, expect, it } from 'vitest';

import { deriveBugReviewStatus } from '../../src/review/bug-reviewer.js';
import { deriveTestReviewStatus } from '../../src/review/test-design-reviewer.js';
import type { BugFinding } from '../../src/schemas/bug-review-result.js';
import type { Disagreement, Limitation } from '../../src/schemas/review-common.js';

/**
 * Status is derived in code because the reviewer's own grade is unreliable: a
 * model asked whether its output requires action will sometimes say no while
 * handing back a delta that plainly does.
 */

const NO_CHANGES = { modify: 0, remove: 0, missing: 0 };

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
    const status = deriveTestReviewStatus({ status: 'PASS', disagreements: [] }, { ...NO_CHANGES, missing: 1 }, []);
    expect(status).toBe('CHANGES_REQUIRED');
  });

  it('returns INCONCLUSIVE when a limitation prevented a reliable assessment', () => {
    const status = deriveTestReviewStatus(
      { status: 'PASS', disagreements: [] },
      { ...NO_CHANGES, missing: 3 },
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
    expect(deriveBugReviewStatus(clean, [finding('VERIFIED')], [])).toBe('PASS');
  });

  it.each(['FALSE_POSITIVE', 'SEVERITY_DISAGREEMENT', 'DUPLICATE_OR_ALREADY_COVERED'] as const)(
    'returns CHANGES_REQUIRED for a %s verdict',
    (verdict) => {
      expect(deriveBugReviewStatus(clean, [finding(verdict)], [])).toBe('CHANGES_REQUIRED');
    },
  );

  it.each(['NEEDS_MORE_EVIDENCE', 'INCONCLUSIVE'] as const)('returns INCONCLUSIVE for a %s verdict', (verdict) => {
    expect(deriveBugReviewStatus(clean, [finding(verdict)], [])).toBe('INCONCLUSIVE');
  });

  it('lets an unreached verdict outrank an actionable one', () => {
    // The findings that were reached are an incomplete picture; calling that a
    // settled list of required changes overstates what the review established.
    const status = deriveBugReviewStatus(clean, [finding('FALSE_POSITIVE'), finding('NEEDS_MORE_EVIDENCE')], []);
    expect(status).toBe('INCONCLUSIVE');
  });

  it('returns CHANGES_REQUIRED when the reviewer found a bug the candidates missed', () => {
    const status = deriveBugReviewStatus(
      { ...clean, additionalFindings: [{ title: 'cross-tenant read', reason: 'no ownership check', evidence: [] }] },
      [finding('VERIFIED')],
      [],
    );
    expect(status).toBe('CHANGES_REQUIRED');
  });

  it('never returns PASS while a material disagreement is unresolved', () => {
    const status = deriveBugReviewStatus({ ...clean, disagreements: [disagreement()] }, [finding('VERIFIED')], []);
    expect(status).toBe('CHANGES_REQUIRED');
  });
});
