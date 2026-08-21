import { describe, expect, it } from 'vitest';

import { QualifyRequestSchema, validateCandidateShape } from '../../src/schemas/qualify-request.js';

const minimal = {
  reviewType: 'test-design' as const,
  project: { root: '/proj' },
  candidate: { testCases: [{ id: 'TC-1', title: 'happy path' }] },
};

describe('QualifyRequestSchema', () => {
  it('accepts the minimal required shape', () => {
    expect(QualifyRequestSchema.safeParse(minimal).success).toBe(true);
  });

  it('requires reviewType, project.root, and a candidate', () => {
    expect(QualifyRequestSchema.safeParse({ project: { root: '/p' }, candidate: {} }).success).toBe(false);
    expect(QualifyRequestSchema.safeParse({ reviewType: 'bugs', project: {}, candidate: {} }).success).toBe(false);
  });

  it('rejects an unsupported review type', () => {
    expect(QualifyRequestSchema.safeParse({ ...minimal, reviewType: 'security-finding' }).success).toBe(false);
  });

  it('defaults the candidate object so an empty candidate is a semantic error, not a parse error', () => {
    const parsed = QualifyRequestSchema.safeParse({ reviewType: 'bugs', project: { root: '/p' } });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.candidate).toEqual({});
  });

  it('treats all context as optional', () => {
    expect(QualifyRequestSchema.safeParse({ ...minimal, task: undefined, artifacts: undefined }).success).toBe(true);
  });

  it('keeps unrecognized candidate fields so project-specific shapes survive', () => {
    const parsed = QualifyRequestSchema.parse({
      ...minimal,
      candidate: { testCases: [{ id: 'TC-1', title: 't', customField: { risk: 9 } }] },
    });
    expect(parsed.candidate.testCases?.[0]).toMatchObject({ customField: { risk: 9 } });
  });

  it('rejects unknown top-level keys so a typo is not silently ignored', () => {
    expect(QualifyRequestSchema.safeParse({ ...minimal, candidates: {} }).success).toBe(false);
  });

  it('accepts steps as either a string or a list', () => {
    const asList = { ...minimal, candidate: { testCases: [{ id: 'TC-1', title: 't', steps: ['a', 'b'] }] } };
    const asString = { ...minimal, candidate: { testCases: [{ id: 'TC-1', title: 't', steps: 'a then b' }] } };
    expect(QualifyRequestSchema.safeParse(asList).success).toBe(true);
    expect(QualifyRequestSchema.safeParse(asString).success).toBe(true);
  });
});

describe('validateCandidateShape', () => {
  const parse = (input: unknown) => QualifyRequestSchema.parse(input);

  it('passes for a well-formed test-design request', () => {
    expect(validateCandidateShape(parse(minimal))).toEqual([]);
  });

  it('requires test cases for a test-design review', () => {
    const problems = validateCandidateShape(parse({ ...minimal, candidate: { bugs: [{ id: 'B-1', title: 'b' }] } }));
    expect(problems.join(' ')).toMatch(/candidate.testCases/);
  });

  it('requires bugs for a bugs review', () => {
    const problems = validateCandidateShape(parse({ ...minimal, reviewType: 'bugs' }));
    expect(problems.join(' ')).toMatch(/candidate.bugs/);
  });

  it('accepts either kind for a combined review', () => {
    expect(validateCandidateShape(parse({ ...minimal, reviewType: 'combined' }))).toEqual([]);
  });

  it('rejects a combined review with nothing to review', () => {
    const problems = validateCandidateShape(parse({ reviewType: 'combined', project: { root: '/p' }, candidate: {} }));
    expect(problems).toHaveLength(1);
  });

  it('reports duplicate candidate ids, which would make the delta ambiguous', () => {
    const problems = validateCandidateShape(
      parse({
        ...minimal,
        candidate: { testCases: [{ id: 'TC-1', title: 'a' }, { id: 'TC-1', title: 'b' }] },
      }),
    );
    expect(problems.join(' ')).toMatch(/duplicate ids: TC-1/);
  });
});
