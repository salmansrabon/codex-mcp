import { describe, expect, it } from 'vitest';

import { normalizeBugReview } from '../../src/review/bug-reviewer.js';
import { normalizeTestReview } from '../../src/review/test-design-reviewer.js';
import { worstStatus } from '../../src/review/combined-reviewer.js';
import type { BugReviewResult } from '../../src/schemas/bug-review-result.js';
import type { TestReviewResult } from '../../src/schemas/test-review-result.js';

const cleanContext = {
  requirement: { limitations: [] },
  external: { limitations: [] },
  database: { limitations: [] },
} as never;

const testCases = [
  { id: 'TC-1', title: 'a' },
  { id: 'TC-2', title: 'b' },
  { id: 'TC-3', title: 'c' },
];

function testReview(overrides: Partial<TestReviewResult> = {}): TestReviewResult {
  return {
    status: 'PASS',
    accepted: [],
    modify: [],
    remove: [],
    missing: [],
    disagreements: [],
    limitations: [],
    ...overrides,
  };
}

describe('normalizeTestReview', () => {
  it('recomputes the summary from the arrays rather than trusting the model', () => {
    const result = normalizeTestReview(
      testReview({
        accepted: ['TC-1', 'TC-2', 'TC-3'],
        summary: { accepted: 99, modify: 99, remove: 99, missing: 99 },
      }),
      testCases,
      cleanContext,
    );
    expect(result.summary).toEqual({ accepted: 3, modify: 0, remove: 0, missing: 0 });
  });

  it('drops references to candidate ids that were never submitted', () => {
    const result = normalizeTestReview(
      testReview({
        accepted: ['TC-1', 'TC-999'],
        modify: [{ candidateId: 'TC-888', reason: 'r', recommendation: 'x', evidence: [] }],
      }),
      testCases,
      cleanContext,
    );
    expect(result.accepted).toEqual(['TC-1']);
    expect(result.modify).toEqual([]);
    expect(JSON.stringify(result.limitations)).toMatch(/TC-999/);
    expect(JSON.stringify(result.limitations)).toMatch(/TC-888/);
  });

  it('records unmentioned candidates as unreviewed instead of accepting them', () => {
    const result = normalizeTestReview(testReview({ accepted: ['TC-1'] }), testCases, cleanContext);
    expect(result.accepted).toEqual(['TC-1']);
    const text = JSON.stringify(result.limitations);
    expect(text).toMatch(/TC-2/);
    expect(text).toMatch(/TC-3/);
    expect(text).toMatch(/unreviewed/i);
  });

  it('forces CHANGES_REQUIRED when the delta contains work, whatever the model claimed', () => {
    const result = normalizeTestReview(
      testReview({
        status: 'PASS',
        accepted: ['TC-1', 'TC-2', 'TC-3'],
        missing: [{ title: 'cross-tenant access', priority: 'high', reason: 'r', evidence: [] }],
      }),
      testCases,
      cleanContext,
    );
    expect(result.status).toBe('CHANGES_REQUIRED');
  });

  it('downgrades an unjustified CHANGES_REQUIRED to PASS when the delta is empty', () => {
    const result = normalizeTestReview(
      testReview({ status: 'CHANGES_REQUIRED', accepted: ['TC-1', 'TC-2', 'TC-3'] }),
      testCases,
      cleanContext,
    );
    expect(result.status).toBe('PASS');
  });

  it('preserves INCONCLUSIVE, which is a statement about evidence, not about the delta', () => {
    const result = normalizeTestReview(
      testReview({ status: 'INCONCLUSIVE', accepted: ['TC-1', 'TC-2', 'TC-3'] }),
      testCases,
      cleanContext,
    );
    expect(result.status).toBe('INCONCLUSIVE');
  });

  it('folds evidence gaps known to codex-mcp into the limitations', () => {
    const result = normalizeTestReview(testReview({ accepted: ['TC-1', 'TC-2', 'TC-3'] }), testCases, {
      requirement: { limitations: ['No task id was supplied.'] },
      external: { limitations: ['Connector "jira" was unreachable.'] },
      database: { limitations: ['No database connector is configured.'] },
    } as never);
    const areas = result.limitations.map((limitation) => limitation.area);
    expect(areas).toEqual(expect.arrayContaining(['requirement', 'external-evidence', 'database']));
  });
});

const bugs = [
  { id: 'BUG-1', title: 'a' },
  { id: 'BUG-2', title: 'b' },
];

function bugReview(overrides: Partial<BugReviewResult> = {}): BugReviewResult {
  return {
    status: 'PASS',
    findings: [],
    additionalFindings: [],
    disagreements: [],
    limitations: [],
    ...overrides,
  };
}

const finding = (id: string, verdict: BugReviewResult['findings'][number]['verdict']) => ({
  candidateId: id,
  verdict,
  confidence: 'high' as const,
  reason: 'r',
  evidence: [],
  recommendation: 'x',
  missingEvidence: [],
});

describe('normalizeBugReview', () => {
  it('marks a candidate with no verdict INCONCLUSIVE rather than leaving it out', () => {
    const result = normalizeBugReview(bugReview({ findings: [finding('BUG-1', 'VERIFIED')] }), bugs, cleanContext);
    expect(result.findings).toHaveLength(2);
    const missing = result.findings.find((f) => f.candidateId === 'BUG-2');
    expect(missing?.verdict).toBe('INCONCLUSIVE');
    expect(missing?.recommendation).toMatch(/unverified/i);
  });

  it('drops verdicts for ids that were never submitted', () => {
    const result = normalizeBugReview(
      bugReview({ findings: [finding('BUG-1', 'VERIFIED'), finding('BUG-9', 'FALSE_POSITIVE')] }),
      bugs,
      cleanContext,
    );
    expect(result.findings.map((f) => f.candidateId).sort()).toEqual(['BUG-1', 'BUG-2']);
    expect(JSON.stringify(result.limitations)).toMatch(/BUG-9/);
  });

  it('counts verdicts into the summary', () => {
    const result = normalizeBugReview(
      bugReview({ findings: [finding('BUG-1', 'VERIFIED'), finding('BUG-2', 'FALSE_POSITIVE')] }),
      bugs,
      cleanContext,
    );
    expect(result.summary).toEqual({ verified: 1, falsePositive: 1, needsMoreEvidence: 0, other: 0 });
  });

  it('passes only when every candidate is verified', () => {
    const allVerified = normalizeBugReview(
      bugReview({ findings: [finding('BUG-1', 'VERIFIED'), finding('BUG-2', 'VERIFIED')] }),
      bugs,
      cleanContext,
    );
    expect(allVerified.status).toBe('PASS');

    const oneRejected = normalizeBugReview(
      bugReview({ status: 'PASS', findings: [finding('BUG-1', 'VERIFIED'), finding('BUG-2', 'FALSE_POSITIVE')] }),
      bugs,
      cleanContext,
    );
    expect(oneRejected.status).toBe('CHANGES_REQUIRED');
  });

  it('treats an all-inconclusive review as INCONCLUSIVE, not as changes required', () => {
    const result = normalizeBugReview(bugReview({ findings: [] }), bugs, cleanContext);
    expect(result.status).toBe('INCONCLUSIVE');
  });

  it('requires action when the reviewer found a defect the candidate set missed', () => {
    const result = normalizeBugReview(
      bugReview({
        findings: [finding('BUG-1', 'VERIFIED'), finding('BUG-2', 'VERIFIED')],
        additionalFindings: [{ title: 'unchecked tenant id', reason: 'r', evidence: [] }],
      }),
      bugs,
      cleanContext,
    );
    expect(result.status).toBe('CHANGES_REQUIRED');
  });
});

describe('worstStatus', () => {
  it('ranks ERROR above CHANGES_REQUIRED above INCONCLUSIVE above PASS', () => {
    expect(worstStatus(['PASS', 'INCONCLUSIVE'])).toBe('INCONCLUSIVE');
    expect(worstStatus(['PASS', 'CHANGES_REQUIRED', 'INCONCLUSIVE'])).toBe('CHANGES_REQUIRED');
    expect(worstStatus(['CHANGES_REQUIRED', 'ERROR'])).toBe('ERROR');
    expect(worstStatus(['PASS', 'PASS'])).toBe('PASS');
  });

  it('reports INCONCLUSIVE when nothing was reviewed', () => {
    expect(worstStatus([])).toBe('INCONCLUSIVE');
  });
});
