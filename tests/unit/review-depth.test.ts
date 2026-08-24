import { describe, expect, it } from 'vitest';

import { assessReviewDepth } from '../../src/review/review-depth.js';
import type { ArtifactCollection } from '../../src/evidence/artifacts.js';
import type { GitEvidence } from '../../src/evidence/git.js';

/**
 * Depth exists to stop a small change costing what a two-repository
 * authorization change costs. The rules that matter most are the ones that
 * refuse to go cheap: a risk marker, an unknown surface, or a narrowed root
 * must not buy a discount, because a shallow review of those produces
 * confident wrong answers rather than fewer answers.
 */

const noArtifacts = {
  blastRadius: { name: 'blast-radius', present: false },
  testCharter: { name: 'test-charter', present: false },
  additional: [],
} as unknown as ArtifactCollection;

const withArtifacts = {
  blastRadius: { name: 'blast-radius', present: true, content: 'x' },
  testCharter: { name: 'test-charter', present: false },
  additional: [],
} as unknown as ArtifactCollection;

function git(changedFiles: string[]): GitEvidence {
  return { available: true, notes: [], changedFiles } as unknown as GitEvidence;
}

function assess(changedFiles: string[], overrides: Partial<Parameters<typeof assessReviewDepth>[0]> = {}) {
  return assessReviewDepth({
    git: git(changedFiles),
    artifacts: noArtifacts,
    candidateCount: 4,
    connectors: [],
    narrowedScope: false,
    configuredEffort: 'high',
    ...overrides,
  });
}

describe('assessReviewDepth', () => {
  it('calls a small, contained, risk-free change SMALL and spends less on it', () => {
    const outcome = assess(['src/ui/label.tsx', 'src/ui/label.test.tsx']);
    expect(outcome.depth).toBe('SMALL');
    expect(outcome.reasoningEffort).toBe('medium');
  });

  it('never lowers effort below medium, whatever the change looks like', () => {
    // A cheap run that still has to trace a path and falsify a claim cannot be
    // done at minimal effort; that combination is what the gate exists to catch.
    expect(assess(['README.md'], { configuredEffort: 'medium' }).reasoningEffort).toBe('medium');
    expect(assess(['README.md'], { configuredEffort: 'low' }).reasoningEffort).toBe('low');
  });

  it('treats an unresolvable change set as HIGH, not as small', () => {
    const outcome = assessReviewDepth({
      git: { available: false, notes: ['not a git work tree'] } as unknown as GitEvidence,
      artifacts: noArtifacts,
      candidateCount: 3,
      connectors: [],
      narrowedScope: false,
      configuredEffort: 'high',
    });
    expect(outcome.depth).toBe('HIGH');
    expect(outcome.signals.join(' ')).toMatch(/unknown/);
    expect(outcome.reasoningEffort).toBe('high');
  });

  it('escalates on a single risk marker in a larger diff', () => {
    const outcome = assess([
      'src/auth/session.ts',
      'src/api/a.ts',
      'src/api/b.ts',
      'src/api/c.ts',
      'src/api/d.ts',
      'src/api/e.ts',
    ]);
    expect(outcome.depth).toBe('HIGH');
    expect(outcome.signals.join(' ')).toMatch(/authorization or authentication/);
  });

  it('escalates when two risk classes are involved at any size', () => {
    const outcome = assess(['src/policy/access.ts', 'db/migrations/003_add_column.sql']);
    expect(outcome.depth).toBe('HIGH');
  });

  it('escalates a multi-package change', () => {
    const outcome = assess(['packages/api/src/handler.ts', 'packages/web/src/view.tsx']);
    expect(outcome.depth).toBe('HIGH');
    expect(outcome.signals.join(' ')).toMatch(/multi-package/);
  });

  it('escalates when the review root is narrower than the workspace', () => {
    // Cross-directory effects are unverifiable from here, so the findings that
    // remain need more support, not less.
    expect(assess(['src/ui/label.tsx'], { narrowedScope: true }).depth).toBe('HIGH');
  });

  it('lands on MEDIUM for a contained change that still carries one risk marker', () => {
    const outcome = assess(['src/models/user.ts']);
    expect(outcome.depth).toBe('MEDIUM');
    expect(outcome.reasoningEffort).toBe('high');
  });

  it('lands on MEDIUM when supplied analysis artifacts have to be verified', () => {
    const outcome = assess(['src/ui/label.tsx'], { artifacts: withArtifacts });
    expect(outcome.depth).toBe('MEDIUM');
    expect(outcome.signals.join(' ')).toMatch(/verified rather than trusted/);
  });

  it('matches risk markers on path segments, not on substrings', () => {
    // "author.ts" is not authorization code, and treating it as such would make
    // every review HIGH by accident.
    expect(assess(['src/blog/author.ts', 'src/blog/post.ts']).depth).toBe('SMALL');
  });
});
