import { describe, expect, it } from 'vitest';

import { assessReviewDepth, planFor, type DepthInput } from '../../src/review/review-depth.js';

/**
 * The plan is the cost lever, and it has to be decided from the change rather
 * than from the reviewer's opinion of the change — the same reason the depth
 * itself is mechanical.
 */

function input(overrides: Partial<DepthInput> = {}): DepthInput {
  return {
    git: { available: true, changedFiles: ['src/ui/labels.ts'], notes: [] },
    artifacts: { blastRadius: { name: 'blast-radius', present: false }, testCharter: { name: 'test-charter', present: false }, additional: [] },
    candidateCount: 2,
    connectors: [],
    narrowedScope: false,
    configuredEffort: 'high',
    ...overrides,
  } as DepthInput;
}

describe('what each depth is worth running', () => {
  it('runs the audit alone for a small, low-risk change', () => {
    const assessment = assessReviewDepth(input());

    expect(assessment.depth).toBe('SMALL');
    expect(assessment.plan.independentDiscovery).toBe(false);
    expect(assessment.plan.blockerSweep).toBe(false);
    expect(assessment.plan.multiRoot).toBe(false);
    // Rules survive even here: they are cheap, and they are the one thing that
    // can make a small change wrong.
    expect(assessment.plan.ruleRetrieval).toBe('targeted');
  });

  it('buys discovery back as soon as the change touches a risk class', () => {
    const assessment = assessReviewDepth(input({ git: { available: true, changedFiles: ['src/auth/guard.ts'], notes: [] } }));

    expect(assessment.depth).not.toBe('SMALL');
    expect(assessment.plan.independentDiscovery).toBe(true);
    expect(assessment.plan.blockerSweep).toBe(true);
  });

  it('runs everything for a broad change', () => {
    const assessment = assessReviewDepth(
      input({
        git: { available: true, changedFiles: Array.from({ length: 30 }, (_, index) => `src/module${index}/file.ts`), notes: [] },
      }),
    );

    expect(assessment.depth).toBe('HIGH');
    expect(assessment.plan).toMatchObject({
      independentDiscovery: true,
      blockerSweep: true,
      coverageMap: true,
      ruleRetrieval: 'full',
      multiRoot: true,
    });
  });

  it('runs everything when the change set could not be resolved at all', () => {
    const assessment = assessReviewDepth(input({ git: { available: false, notes: [] } }));

    expect(assessment.depth).toBe('HIGH');
    expect(assessment.plan.independentDiscovery).toBe(true);
  });

  it('checks a supplied blast radius even on an otherwise small change', () => {
    const assessment = assessReviewDepth(
      input({
        artifacts: {
          blastRadius: { name: 'blast-radius', present: true, content: '- billing' },
          testCharter: { name: 'test-charter', present: false },
          additional: [],
        },
      }),
    );

    // Depth still rises because a supplied artifact must be verified, but the
    // load-bearing part is that the map is required whatever the depth says.
    expect(planFor('SMALL', { blastRadiusSupplied: true })).toMatchObject({
      coverageMap: true,
      independentDiscovery: true,
    });
    expect(assessment.plan.coverageMap).toBe(true);
  });

  it('reports the plan decision to the caller and not to the reviewer', () => {
    const assessment = assessReviewDepth(input());

    expect(assessment.planNotes.join(' ')).toMatch(/independent risk discovery skipped/);
    // `signals` is rendered into the prompt; telling an audit run that nothing
    // else will look for what it misses invites overreach.
    expect(assessment.signals.join(' ')).not.toMatch(/independent risk discovery/);
  });

  it('never raises the configured effort, only lowers it', () => {
    const lowered = assessReviewDepth(input({ configuredEffort: 'high' }));
    const floor = assessReviewDepth(input({ configuredEffort: 'medium' }));

    // One step down for a SMALL change, and never below medium.
    expect(lowered.reasoningEffort).toBe('medium');
    expect(floor.reasoningEffort).toBe('medium');
  });
});
