import { describe, expect, it } from 'vitest';
import { zodToJsonSchema } from 'zod-to-json-schema';

import { stripNulls, toStrictJsonSchema } from '../../src/codex/output-schema.js';
import { BugReviewResultSchema } from '../../src/schemas/bug-review-result.js';
import { TestReviewResultSchema } from '../../src/schemas/test-review-result.js';

type JsonObject = Record<string, unknown>;

function walk(node: unknown, visit: (object: JsonObject) => void): void {
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
    return;
  }
  if (typeof node !== 'object' || node === null) return;
  visit(node as JsonObject);
  for (const child of Object.values(node as JsonObject)) walk(child, visit);
}

const RESULT_SCHEMAS = [
  ['TestReviewResult', TestReviewResultSchema],
  ['BugReviewResult', BugReviewResultSchema],
] as const;

describe('strict output schema', () => {
  it.each(RESULT_SCHEMAS)('makes every property of %s required and closed', (_name, schema) => {
    const strict = toStrictJsonSchema(zodToJsonSchema(schema, { $refStrategy: 'none' }));

    walk(strict, (node) => {
      if (!node.properties || typeof node.properties !== 'object') return;
      expect(node.additionalProperties).toBe(false);
      expect(new Set(node.required as string[])).toEqual(new Set(Object.keys(node.properties as JsonObject)));
    });
  });

  it.each(RESULT_SCHEMAS)('strips the validation keywords the API refuses from %s', (_name, schema) => {
    const strict = toStrictJsonSchema(zodToJsonSchema(schema, { $refStrategy: 'none' }));

    walk(strict, (node) => {
      for (const keyword of ['default', 'minItems', 'minLength', 'minimum', 'maxItems', '$schema']) {
        expect(node).not.toHaveProperty(keyword);
      }
    });
  });

  it('keeps descriptions, because they are reviewer guidance rather than validation', () => {
    const strict = toStrictJsonSchema(zodToJsonSchema(TestReviewResultSchema, { $refStrategy: 'none' }));
    let described = 0;
    walk(strict, (node) => {
      if (typeof node.description === 'string' && node.description.length > 0) described += 1;
    });
    expect(described).toBeGreaterThan(10);
  });

  it('lets a previously optional field decline by widening it to null', () => {
    const strict = toStrictJsonSchema({
      type: 'object',
      properties: { kept: { type: 'string' }, optional: { type: 'string' } },
      required: ['kept'],
    }) as JsonObject;

    const properties = strict.properties as JsonObject;
    expect((properties.kept as JsonObject).type).toBe('string');
    expect((properties.optional as JsonObject).type).toEqual(['string', 'null']);
  });

  it('admits null into an enum it widened, so the union is satisfiable', () => {
    const strict = toStrictJsonSchema({
      type: 'object',
      properties: { status: { type: 'string', enum: ['PASS', 'FAIL'] } },
      required: [],
    }) as JsonObject;

    const status = (strict.properties as JsonObject).status as JsonObject;
    expect(status.type).toEqual(['string', 'null']);
    expect(status.enum).toEqual(['PASS', 'FAIL', null]);
  });

  it('widens a union by adding a null member rather than nesting it', () => {
    const strict = toStrictJsonSchema({
      type: 'object',
      properties: { either: { anyOf: [{ type: 'string' }, { type: 'number' }] } },
      required: [],
    }) as JsonObject;

    const either = (strict.properties as JsonObject).either as JsonObject;
    expect(either.anyOf).toEqual([{ type: 'string' }, { type: 'number' }, { type: 'null' }]);
  });
});

describe('stripNulls', () => {
  it('turns a declined field back into an absent one, so the Zod default applies', () => {
    const cleaned = stripNulls({
      status: 'CHANGES_REQUIRED',
      summary: null,
      findings: [{ id: 'BUG-1', verificationStatus: null, evidence: null }],
    });

    expect(cleaned).toEqual({ status: 'CHANGES_REQUIRED', findings: [{ id: 'BUG-1' }] });
  });

  it('restores the defaults that make silence buy nothing', () => {
    const raw = {
      status: 'CHANGES_REQUIRED',
      summary: { verified: 1, falsePositive: 0, needsMoreEvidence: 0, other: 0 },
      findings: [
        {
          candidateId: 'BUG-1',
          verdict: 'VERIFIED',
          confidence: 'medium',
          reason: 'because',
          recommendation: 'fix it',
          severityAssessment: null,
          verificationStatus: null,
          severityStatus: null,
          evidence: null,
          verifiedPath: null,
          contradictionsChecked: null,
        },
      ],
    };

    const parsed = BugReviewResultSchema.safeParse(stripNulls(raw));
    expect(parsed.success).toBe(true);
    const finding = parsed.success ? parsed.data.findings[0] : undefined;
    expect(finding?.verificationStatus).toBe('PROVISIONAL');
    expect(finding?.evidence).toEqual([]);
  });

  it('leaves nulls inside arrays alone, because position is meaningful there', () => {
    expect(stripNulls({ values: [1, null, 3] })).toEqual({ values: [1, null, 3] });
  });
});
