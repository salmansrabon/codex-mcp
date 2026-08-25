import { describe, expect, it } from 'vitest';

import { gateBugReview, FULL_COVERAGE, type EvidenceCoverage } from '../../src/review/verification-gate.js';
import type { BugFinding } from '../../src/schemas/bug-review-result.js';

/**
 * The rule this file exists for: codex-mcp never overturns a submitted finding
 * because it failed to find the evidence. Only positive contradictory evidence
 * overturns anything.
 */

function finding(overrides: Partial<BugFinding> = {}): BugFinding {
  return {
    candidateId: 'BUG-1',
    verdict: 'REFUTED',
    confidence: 'high',
    reason: 'I went looking and did not find the described behavior.',
    evidence: [{ source: 'code', location: 'src/routes/a.ts:1' }],
    recommendation: 'Withdraw the finding.',
    missingEvidence: [],
    refutedBy: [],
    severityStatus: 'CONFIRMED',
    verificationStatus: 'PROVISIONAL',
    verifiedPath: [],
    contradictionsChecked: [],
    ...overrides,
  } as BugFinding;
}

const coverage = (overrides: Partial<EvidenceCoverage> = {}): EvidenceCoverage => ({
  ...FULL_COVERAGE,
  ...overrides,
});

describe('a refutation must produce contradictory evidence', () => {
  it('downgrades REFUTED to UNPROVEN when nothing was found that contradicts the claim', () => {
    const outcome = gateBugReview({ findings: [finding()], additionalFindings: [] });

    expect(outcome.findings[0]?.verdict).toBe('UNPROVEN');
    expect(JSON.stringify(outcome.limitations)).toMatch(/refutation-discipline/);
    expect(JSON.stringify(outcome.limitations)).toMatch(/failing to find support is not contradiction/);
  });

  it('tells the author their finding stands, in the recommendation they will actually read', () => {
    const outcome = gateBugReview({ findings: [finding()], additionalFindings: [] });

    expect(outcome.findings[0]?.recommendation).toMatch(/did not overturn this finding/);
    // The reviewer's own words survive; they are not replaced.
    expect(outcome.findings[0]?.recommendation).toMatch(/Withdraw the finding/);
  });

  it('holds REFUTED when the reviewer cites what it found', () => {
    const outcome = gateBugReview({
      findings: [
        finding({
          refutedBy: [{ source: 'code', location: 'src/middleware/guard.ts:11' }],
          contradictionsChecked: [{ checked: 'a route that skips the guard', outcome: 'no-contradiction-found' }],
        }),
      ],
      additionalFindings: [],
    });

    expect(outcome.findings[0]?.verdict).toBe('REFUTED');
  });

  it('reports INSUFFICIENT_SCOPE when every check was unresolved rather than empty', () => {
    const outcome = gateBugReview({
      findings: [
        finding({
          contradictionsChecked: [
            { checked: 'the caller in the other repository', outcome: 'unresolved' },
            { checked: 'the runtime behavior', outcome: 'unresolved' },
          ],
        }),
      ],
      additionalFindings: [],
    });

    expect(outcome.findings[0]?.verdict).toBe('INSUFFICIENT_SCOPE');
  });

  it('reports CONFLICTING_EVIDENCE when the reviewer refuted its own refutation', () => {
    const outcome = gateBugReview({
      findings: [
        finding({
          refutedBy: [{ source: 'code', location: 'src/middleware/guard.ts:11' }],
          contradictionsChecked: [
            { checked: 'a second route bypassing the guard', outcome: 'refutes' },
          ],
        }),
      ],
      additionalFindings: [],
    });

    expect(outcome.findings[0]?.verdict).toBe('CONFLICTING_EVIDENCE');
  });

  it('does not touch a verdict that was never a refutation', () => {
    const outcome = gateBugReview({
      findings: [finding({ verdict: 'DUPLICATE_OR_ALREADY_COVERED', duplicateOf: 'BUG-9' })],
      additionalFindings: [],
    });

    expect(outcome.findings[0]?.verdict).toBe('DUPLICATE_OR_ALREADY_COVERED');
  });

  it('never invents a stronger verdict than the reviewer claimed', () => {
    // The gate only ever weakens. An UNPROVEN with contradictory evidence
    // attached stays UNPROVEN — the reviewer declined to refute, and that
    // restraint is not the gate's to overrule.
    const outcome = gateBugReview({
      findings: [
        finding({
          verdict: 'UNPROVEN',
          refutedBy: [{ source: 'code', location: 'src/middleware/guard.ts:11' }],
        }),
      ],
      additionalFindings: [],
    });

    expect(outcome.findings[0]?.verdict).toBe('UNPROVEN');
  });
});

describe('confidence is capped by evidence coverage, not by tone', () => {
  it('caps a refutation whose subject cited files that do not exist', () => {
    const outcome = gateBugReview({
      findings: [
        finding({
          refutedBy: [{ source: 'code', location: 'src/middleware/guard.ts:11' }],
          verificationStatus: 'CONFIRMED',
          verifiedPath: ['a.ts:1', 'b.ts:2'],
          contradictionsChecked: [{ checked: 'a bypass', outcome: 'no-contradiction-found' }],
        }),
      ],
      additionalFindings: [],
      coverage: coverage({ citationsPresent: new Set(['BUG-1']), brokenCitations: new Set(['BUG-1']) }),
    });

    expect(outcome.findings[0]?.confidence).toBe('medium');
    expect(JSON.stringify(outcome.limitations)).toMatch(/did not resolve/);
  });

  it('does not penalise a finding that cited nothing at all', () => {
    const outcome = gateBugReview({
      findings: [
        finding({
          refutedBy: [{ source: 'code', location: 'src/middleware/guard.ts:11' }],
          verificationStatus: 'CONFIRMED',
          verifiedPath: ['a.ts:1', 'b.ts:2'],
          contradictionsChecked: [{ checked: 'a bypass', outcome: 'no-contradiction-found' }],
        }),
      ],
      additionalFindings: [],
      coverage: coverage(),
    });

    expect(outcome.findings[0]?.confidence).toBe('high');
  });

  it('caps every verdict when a participating repository could not be read', () => {
    const outcome = gateBugReview({
      findings: [
        finding({
          verdict: 'CONFIRMED',
          verificationStatus: 'CONFIRMED',
          verifiedPath: ['a.ts:1', 'b.ts:2'],
          contradictionsChecked: [{ checked: 'a guard', outcome: 'no-contradiction-found' }],
        }),
      ],
      additionalFindings: [],
      coverage: coverage({ scopeComplete: false, scopeGaps: ['the shared contract repository could not be read'] }),
    });

    expect(outcome.findings[0]?.confidence).toBe('medium');
    expect(JSON.stringify(outcome.limitations)).toMatch(/shared contract repository/);
  });

  it('floors an unsettled verdict at low confidence however sure it sounds', () => {
    const outcome = gateBugReview({
      findings: [finding({ verdict: 'UNPROVEN', confidence: 'high' })],
      additionalFindings: [],
    });

    expect(outcome.findings[0]?.confidence).toBe('low');
  });
});
