import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  citationsInProse,
  parseCitation,
  verifyCandidateCitations,
  verifyCitation,
} from '../../src/review/citation-verifier.js';
import type { CandidateBug } from '../../src/schemas/qualify-request.js';

let root: string;

function write(relative: string, content: string): void {
  const path = join(root, relative);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'codex-mcp-cite-'));
  write('src/service.ts', ['export function archive(id) {', '  return db.find(id);', '}', ''].join('\n'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const bug = (overrides: Partial<CandidateBug> = {}): CandidateBug =>
  ({ id: 'BUG-1', title: 'a bug', ...overrides }) as CandidateBug;

describe('parsing the shapes authors actually write', () => {
  it.each([
    ['src/a.ts:42', 'src/a.ts', 42],
    ['src/a.ts#L42', 'src/a.ts', 42],
    ['src/a.ts (line 42)', 'src/a.ts', 42],
    ['src/a.ts:42-58', 'src/a.ts', 42],
  ])('reads %s', (input, path, line) => {
    expect(parseCitation(input)).toMatchObject({ path, line });
  });

  it('accepts a bare path with no line', () => {
    expect(parseCitation('src/a.ts')).toMatchObject({ path: 'src/a.ts' });
  });

  it('refuses to guess at something that is not a citation', () => {
    expect(parseCitation('sometime around v2')).toBeUndefined();
  });
});

describe('a fabricated citation is named as one', () => {
  it('reports a file that does not exist', async () => {
    const check = await verifyCitation('BUG-1', 'src/middleware/auth.js:42', { roots: [root] });

    expect(check.status).toBe('MISSING_FILE');
    expect(check.detail).toMatch(/does not exist/);
  });

  it('reports a line past the end of a file that does exist', async () => {
    const check = await verifyCitation('BUG-1', 'src/service.ts:400', { roots: [root] });

    expect(check.status).toBe('LINE_OUT_OF_RANGE');
    expect(check.fileLines).toBe(4);
    expect(check.detail).toMatch(/past the end of the file/);
  });

  it('resolves a real citation and hands over the line and its surroundings', async () => {
    const check = await verifyCitation('BUG-1', 'src/service.ts:2', { roots: [root] });

    expect(check.status).toBe('VERIFIED');
    expect(check.citedLine).toContain('db.find(id)');
    expect(check.context).toContain('export function archive');
    // Existence is settled; support is explicitly left to the reviewer.
    expect(check.detail).toMatch(/judgment, not a fact/);
  });

  it('refuses a citation that escapes every readable root', async () => {
    const check = await verifyCitation('BUG-1', '/etc/passwd', { roots: [root] });

    expect(check.status).toBe('OUT_OF_SCOPE');
  });

  it('resolves against an additional root when the primary does not have the file', async () => {
    const other = mkdtempSync(join(tmpdir(), 'codex-mcp-cite-other-'));
    writeFileSync(join(other, 'contract.ts'), 'export type Contract = {};\n');

    const check = await verifyCitation('BUG-1', 'contract.ts:1', { roots: [root, other] });

    expect(check.status).toBe('VERIFIED');
    rmSync(other, { recursive: true, force: true });
  });
});

describe('citations in prose count too', () => {
  it('finds a file:line the author wrote into a free-text field', () => {
    const found = citationsInProse(bug({ suspectedCause: 'the guard in src/middleware/auth.js:42 is skipped' }));
    expect(found).toEqual(['src/middleware/auth.js:42']);
  });

  it('does not mistake ordinary prose for a citation', () => {
    const found = citationsInProse(bug({ notes: 'fails about 3:1 of the time on v2.4 builds' }));
    expect(found).toEqual([]);
  });
});

describe('the per-candidate verdict on citations', () => {
  it('marks a candidate broken when any of its citations points at nothing', async () => {
    const result = await verifyCandidateCitations(
      [
        bug({
          id: 'BUG-1',
          evidence: [
            { source: 'code', location: 'src/service.ts:2' },
            { source: 'code', location: 'src/middleware/auth.js:42' },
          ],
        }),
      ],
      { roots: [root] },
    );

    expect(result.present.has('BUG-1')).toBe(true);
    expect(result.broken.has('BUG-1')).toBe(true);
    expect(result.verified.has('BUG-1')).toBe(false);
    expect(result.checks).toHaveLength(2);
  });

  it('leaves a candidate that cited nothing out of every set', async () => {
    const result = await verifyCandidateCitations([bug({ id: 'BUG-2' })], { roots: [root] });

    expect(result.present.has('BUG-2')).toBe(false);
    expect(result.checks).toHaveLength(0);
  });

  it('verifies a candidate whose citations all resolve', async () => {
    const result = await verifyCandidateCitations(
      [bug({ evidence: [{ source: 'code', location: 'src/service.ts:2' }] })],
      { roots: [root] },
    );

    expect(result.verified.has('BUG-1')).toBe(true);
    expect(result.broken.size).toBe(0);
  });
});
