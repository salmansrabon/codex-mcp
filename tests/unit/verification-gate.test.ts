import { describe, expect, it } from 'vitest';

import { gateBugReview, gateTestReview } from '../../src/review/verification-gate.js';
import { BugFindingSchema } from '../../src/schemas/bug-review-result.js';
import { MissingEntrySchema, ModifyEntrySchema } from '../../src/schemas/test-review-result.js';

/**
 * The gate is the answer to the failure the evaluation exposed: a reviewer that
 * traced one supporting file, never looked for the guard further along the
 * chain, and returned `CONFIRMED` with `impactConfidence: high`.
 *
 * Every case here is written from the reviewer's side of that mistake — the
 * output it would actually produce — because the rule has to hold against
 * plausible-looking output, not against obviously broken output.
 */

const candidates = Array.from({ length: 12 }, (_, index) => ({
  id: `TC-${String(index + 1).padStart(2, '0')}`,
  title: `candidate ${index + 1}`,
}));

function missing(overrides: Record<string, unknown> = {}) {
  return MissingEntrySchema.parse({
    title: 'stale response is applied after a newer one',
    priority: 'high',
    reason: 'two requests can resolve out of order and the later render wins',
    uniqueRisk: 'a user sees data from a superseded request, which no other case would catch',
    objectionPriority: 'MUST_FIX',
    coverageChecked: ['test/unit/list.spec.ts'],
    ...overrides,
  });
}

function modify(overrides: Record<string, unknown> = {}) {
  return ModifyEntrySchema.parse({
    candidateId: 'TC-01',
    reason: 'the expected result restates the implementation',
    recommendation: 'assert the business rule instead',
    ...overrides,
  });
}

function bugFinding(overrides: Record<string, unknown> = {}) {
  return BugFindingSchema.parse({
    candidateId: 'BUG-1',
    verdict: 'CONFIRMED',
    confidence: 'high',
    reason: 'the handler performs no ownership check',
    recommendation: 'keep the finding',
    ...overrides,
  });
}

const noCeiling = { candidates, knownCoverageDeclared: false };

describe('Scenario A — a claim that looks supported does not become CONFIRMED', () => {
  it('downgrades CONFIRMED when no contradiction search was recorded', () => {
    // The evaluation's exact shape: real evidence, a plausible mechanism, and no
    // attempt to find the thing that would disprove it.
    const outcome = gateTestReview({
      ...noCeiling,
      modify: [],
      remove: [],
      missing: [
        missing({
          verificationStatus: 'CONFIRMED',
          impactConfidence: 'high',
          verifiedPath: ['src/routes/peripheral.ts:12', 'src/services/peripheral.ts:40'],
          contradictionsChecked: [],
        }),
      ],
    });

    expect(outcome.missing[0]?.verificationStatus).toBe('PROVISIONAL');
    expect(outcome.missing[0]?.impactConfidence).toBe('medium');
    expect(outcome.missing[0]?.scopeCaveat).toMatch(/no completed contradiction search/);
    expect(JSON.stringify(outcome.limitations)).toMatch(/verification-discipline/);
  });

  it('downgrades CONFIRMED when the trace is a single file rather than a path', () => {
    const outcome = gateTestReview({
      ...noCeiling,
      modify: [
        modify({
          verificationStatus: 'CONFIRMED',
          verifiedPath: ['src/controllers/thing.ts:31'],
          contradictionsChecked: [{ checked: 'a guard on the parent resource', outcome: 'no-contradiction-found' }],
        }),
      ],
      remove: [],
      missing: [],
    });

    expect(outcome.modify[0]?.verificationStatus).toBe('PROVISIONAL');
    expect(outcome.modify[0]?.scopeCaveat).toMatch(/only one inspected hop/);
  });

  it('drops a claim to HYPOTHESIS when its own contradiction search refuted the mechanism', () => {
    // This is the authorization case from the evaluation: the route resolved
    // through a parent that already enforced access, so the stated mechanism
    // was wrong even though the coverage concern was reasonable.
    const outcome = gateTestReview({
      ...noCeiling,
      modify: [],
      remove: [],
      missing: [
        missing({
          verificationStatus: 'CONFIRMED',
          impactConfidence: 'high',
          verifiedPath: ['src/routes/child.ts:9', 'src/services/child.ts:22', 'src/policy/parent.ts:54'],
          contradictionsChecked: [
            {
              checked: 'whether the parent resource resolution already enforces access',
              where: 'src/policy/parent.ts',
              outcome: 'refutes',
              detail: 'access is decided when the parent is resolved, before this code runs',
            },
          ],
        }),
      ],
    });

    expect(outcome.missing[0]?.verificationStatus).toBe('HYPOTHESIS');
    expect(outcome.missing[0]?.impactConfidence).toBe('medium');
    expect(JSON.stringify(outcome.limitations)).toMatch(/refuted the stated mechanism/);
  });

  it('keeps CONFIRMED when the reviewer actually traced and actually falsified', () => {
    // The gate must not be a blanket hedge: a finding that did the work keeps
    // its label, or the label stops meaning anything.
    const outcome = gateTestReview({
      ...noCeiling,
      modify: [],
      remove: [],
      missing: [
        missing({
          verificationStatus: 'CONFIRMED',
          impactConfidence: 'high',
          verifiedPath: ['src/routes/x.ts:4', 'src/services/x.ts:31', 'src/policy/x.ts:12'],
          contradictionsChecked: [
            { checked: 'a middleware that already rejects this input', where: 'src/middleware', outcome: 'no-contradiction-found' },
          ],
        }),
      ],
    });

    expect(outcome.missing[0]?.verificationStatus).toBe('CONFIRMED');
    expect(outcome.missing[0]?.impactConfidence).toBe('high');
    expect(outcome.limitations).toEqual([]);
  });

  it('never upgrades a claim the reviewer itself hedged', () => {
    const outcome = gateTestReview({
      ...noCeiling,
      modify: [],
      remove: [],
      missing: [
        missing({
          verificationStatus: 'HYPOTHESIS',
          verifiedPath: ['a.ts:1', 'b.ts:2', 'c.ts:3'],
          contradictionsChecked: [{ checked: 'everything', outcome: 'no-contradiction-found' }],
        }),
      ],
    });
    expect(outcome.missing[0]?.verificationStatus).toBe('HYPOTHESIS');
  });
});

describe('Scenario F — behavior that depends on another repository', () => {
  it('leaves PROVISIONAL and its scope caveat intact', () => {
    const entry = missing({
      verificationStatus: 'PROVISIONAL',
      evidenceConfidence: 'high',
      impactConfidence: 'low',
      scopeConfidence: 'low',
      scopeCaveat: 'the consuming service lives in another repository that was not part of this review root',
      verifiedPath: ['src/api/handler.ts:20'],
      contradictionsChecked: [{ checked: 'whether the caller validates first', outcome: 'unresolved' }],
    });

    const outcome = gateTestReview({ ...noCeiling, modify: [], remove: [], missing: [entry] });

    expect(outcome.missing[0]?.verificationStatus).toBe('PROVISIONAL');
    expect(outcome.missing[0]?.evidenceConfidence).toBe('high');
    expect(outcome.missing[0]?.impactConfidence).toBe('low');
    expect(outcome.missing[0]?.scopeCaveat).toMatch(/another repository/);
    // Nothing to correct, so nothing is reported: the reviewer was already honest.
    expect(outcome.limitations).toEqual([]);
  });
});

describe('value threshold — additions must name a unique risk', () => {
  it('demotes an addition that names no unique risk', () => {
    const outcome = gateTestReview({
      ...noCeiling,
      modify: [],
      remove: [],
      missing: [missing({ uniqueRisk: undefined, objectionPriority: 'MUST_FIX' })],
    });

    expect(outcome.missing[0]?.objectionPriority).toBe('OPTIONAL');
    expect(JSON.stringify(outcome.limitations)).toMatch(/names no unique risk/);
  });

  it('keeps an addition that names one', () => {
    const outcome = gateTestReview({ ...noCeiling, modify: [], remove: [], missing: [missing()] });
    expect(outcome.missing[0]?.objectionPriority).toBe('MUST_FIX');
  });
});

describe('Scenario C — coverage that already exists elsewhere', () => {
  it('demotes a MUST_FIX that never searched the coverage the caller declared', () => {
    const outcome = gateTestReview({
      candidates,
      knownCoverageDeclared: true,
      modify: [],
      remove: [],
      missing: [missing({ coverageChecked: [], objectionPriority: 'MUST_FIX' })],
    });

    expect(outcome.missing[0]?.objectionPriority).toBe('SHOULD_FIX');
    expect(JSON.stringify(outcome.limitations)).toMatch(/before calling the scenario untested/);
  });

  it('leaves it alone when the reviewer says where it looked', () => {
    const outcome = gateTestReview({
      candidates,
      knownCoverageDeclared: true,
      modify: [],
      remove: [],
      missing: [missing({ coverageChecked: ['test/unit/validation.spec.js', 'declared: schema boundary coverage'] })],
    });
    expect(outcome.missing[0]?.objectionPriority).toBe('MUST_FIX');
  });
});

describe('Scenario D — a hard test-case ceiling', () => {
  it('reports additions that overflow the ceiling without naming a displacement', () => {
    const outcome = gateTestReview({
      candidates,
      knownCoverageDeclared: false,
      maxTestCases: 12,
      modify: [],
      remove: [],
      missing: [missing({ title: 'stale response sequencing' }), missing({ title: 'partial write on retry' })],
    });

    expect(outcome.portfolio).toMatchObject({
      ceiling: 12,
      retained: 12,
      proposedAdditions: 2,
      headroom: 0,
      withinCeiling: false,
    });
    expect(outcome.portfolio?.unresolvedOverflow).toEqual(['stale response sequencing', 'partial write on retry']);
    expect(JSON.stringify(outcome.limitations)).toMatch(/without naming what they displace/);
  });

  it('accepts additions that displace weaker cases, and stays inside the ceiling', () => {
    const outcome = gateTestReview({
      candidates,
      knownCoverageDeclared: false,
      maxTestCases: 12,
      modify: [],
      remove: [
        { candidateId: 'TC-08', reason: 'schema boundary already covered by unit tests', evidence: [], verificationStatus: 'PROVISIONAL', verifiedPath: [], contradictionsChecked: [], objectionPriority: 'SHOULD_FIX' },
      ],
      missing: [
        missing({
          title: 'stale response sequencing',
          displaces: [
            {
              candidateId: 'TC-08',
              action: 'REMOVE',
              reason: 'it protects a distinct user-visible race, while TC-08 duplicates lower-level coverage',
            },
          ],
        }),
      ],
    });

    expect(outcome.portfolio).toMatchObject({ retained: 11, proposedAdditions: 1, withinCeiling: true });
    expect(outcome.portfolio?.unresolvedOverflow).toEqual([]);
  });

  it('does not charge OPTIONAL observations against the ceiling', () => {
    // Otherwise the reviewer is punished for mentioning something it explicitly
    // said was not required, and an overflow appears out of nothing.
    const outcome = gateTestReview({
      candidates,
      knownCoverageDeclared: false,
      maxTestCases: 12,
      modify: [],
      remove: [],
      missing: [missing({ objectionPriority: 'OPTIONAL' })],
    });

    expect(outcome.portfolio).toMatchObject({ proposedAdditions: 0, withinCeiling: true });
    expect(outcome.portfolio?.unresolvedOverflow).toEqual([]);
  });

  it('computes nothing when the caller declared no ceiling', () => {
    const outcome = gateTestReview({ ...noCeiling, modify: [], remove: [], missing: [missing()] });
    expect(outcome.portfolio).toBeUndefined();
  });
});

describe('bug verdicts carry the same confirmation cost', () => {
  it('lowers a high-confidence CONFIRMED that recorded no contradiction search', () => {
    const outcome = gateBugReview({
      findings: [
        bugFinding({
          verificationStatus: 'CONFIRMED',
          confidence: 'high',
          verifiedPath: ['src/routes/a.ts:1', 'src/services/a.ts:2'],
          contradictionsChecked: [],
        }),
      ],
      additionalFindings: [],
    });

    expect(outcome.findings[0]?.verificationStatus).toBe('PROVISIONAL');
    expect(outcome.findings[0]?.confidence).toBe('medium');
    expect(outcome.findings[0]?.verdict).toBe('CONFIRMED');
    // The confidence cap is now derived from evidence coverage rather than
    // spelled as a special case for one verdict, so it is reported that way.
    expect(JSON.stringify(outcome.limitations)).toMatch(/confidence was capped from high to medium/);
  });

  it('holds a CONFIRMED verdict that traced the path and looked for a guard', () => {
    const outcome = gateBugReview({
      findings: [
        bugFinding({
          verificationStatus: 'CONFIRMED',
          confidence: 'high',
          verifiedPath: ['src/routes/a.ts:1', 'src/services/a.ts:2', 'src/policy/a.ts:9'],
          contradictionsChecked: [
            { checked: 'an ownership guard on the parent object', where: 'src/policy', outcome: 'no-contradiction-found' },
          ],
        }),
      ],
      additionalFindings: [],
    });

    expect(outcome.findings[0]?.verificationStatus).toBe('CONFIRMED');
    expect(outcome.findings[0]?.confidence).toBe('high');
    expect(outcome.limitations).toEqual([]);
  });

  it('applies the same rule to defects the reviewer found itself', () => {
    const outcome = gateBugReview({
      findings: [],
      additionalFindings: [
        {
          title: 'retry can double-charge',
          reason: 'no idempotency key is stored',
          evidence: [],
          severityStatus: 'CONFIRMED',
          verificationStatus: 'CONFIRMED',
          verifiedPath: ['src/payments/retry.ts:44'],
          contradictionsChecked: [],
          objectionPriority: 'MUST_FIX',
        },
      ],
    });

    expect(outcome.additionalFindings[0]?.verificationStatus).toBe('PROVISIONAL');
  });
});
