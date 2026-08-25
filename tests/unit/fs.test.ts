import { join as pathJoin, parse } from 'node:path';

import { describe, expect, it } from 'vitest';

import { isInside } from '../../src/util/fs.js';

/**
 * `isInside` is the containment check behind `assertArtifactPathAllowed` — the
 * one place that decides whether a path a reviewer names is actually within
 * `project.root`. It has to be right on every platform: a version that
 * hardcodes `/` as the separator never matches a real nested path on Windows,
 * and a version that only checks for a leading `..` never catches a path that
 * escaped onto a different drive.
 */
const ROOT = parse(process.cwd()).root;

describe('isInside', () => {
  it('accepts a direct child', () => {
    expect(isInside(join('project'), join('project', 'file.txt'))).toBe(true);
  });

  it('accepts a deeply nested descendant', () => {
    expect(isInside(join('project'), join('project', 'docs', 'blast-radius.md'))).toBe(true);
  });

  it('treats the parent itself as inside', () => {
    expect(isInside(join('project'), join('project'))).toBe(true);
  });

  it('refuses a sibling directory with a matching name prefix', () => {
    // `/project-other` starts with the string `/project` but is not inside it;
    // a naive `startsWith` check would wrongly accept this.
    expect(isInside(join('project'), join('project-other', 'file.txt'))).toBe(false);
  });

  it('refuses a path that walks back out via ..', () => {
    expect(isInside(join('project'), join('project', '..', 'other', 'file.txt'))).toBe(false);
  });

  it('refuses a path on a different root entirely', () => {
    // On Windows this is the cross-drive case: `relative()` between two drives
    // returns the absolute target rather than a `..`-prefixed path, so a check
    // that only looks for a leading `..` misses it.
    const parent = join('project');
    const other = ROOT === '/' ? '/etc/passwd' : otherDrive() + '\\etc\\passwd';
    expect(isInside(parent, other)).toBe(false);
  });
});

function join(...segments: string[]): string {
  return pathJoin(ROOT, ...segments);
}

/** A drive letter that differs from the one `process.cwd()` is on, for the cross-drive case. */
function otherDrive(): string {
  const current = ROOT[0];
  return current === 'C' ? 'D:' : 'C:';
}
