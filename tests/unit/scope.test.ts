import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { detectNarrowedScope, renderScopeNotice } from '../../src/evidence/scope.js';

/**
 * Modeled on a real miss: a monorepo whose API route and the UI component
 * gating it live in sibling packages. Rooted at the API, the reviewer correctly
 * refused to look outside — and the resulting finding was wrong, because the
 * component it needed was one directory over.
 */

let workspace: string;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'codex-mcp-scope-'));
  for (const pkg of ['sharebox-api', 'sharebox-webadmin', 'sharebox-weblink', 'node_modules', '.git']) {
    mkdirSync(join(workspace, pkg), { recursive: true });
  }
  writeFileSync(join(workspace, '.mcp.json'), '{}');
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

describe('detectNarrowedScope', () => {
  it('reports the siblings a subdirectory root cannot reach', () => {
    const notice = detectNarrowedScope(join(workspace, 'sharebox-api'), workspace);
    expect(notice?.scopedTo).toBe('sharebox-api');
    expect(notice?.unreachableSiblings).toEqual(['sharebox-webadmin', 'sharebox-weblink']);
  });

  it('stays quiet when the root is the workspace', () => {
    expect(detectNarrowedScope(workspace, workspace)).toBeUndefined();
  });

  it('stays quiet for a root outside the workspace entirely', () => {
    // A different project is a deliberate choice, not an accidental narrowing.
    expect(detectNarrowedScope(tmpdir(), join(workspace, 'sharebox-api'))).toBeUndefined();
  });

  it('ignores build output and VCS directories as "siblings"', () => {
    const notice = detectNarrowedScope(join(workspace, 'sharebox-api'), workspace);
    expect(notice?.unreachableSiblings).not.toContain('node_modules');
    expect(notice?.unreachableSiblings).not.toContain('.git');
  });

  it('stays quiet when the subdirectory has no siblings to miss', () => {
    const solo = mkdtempSync(join(tmpdir(), 'codex-mcp-solo-'));
    mkdirSync(join(solo, 'only-package'));
    expect(detectNarrowedScope(join(solo, 'only-package'), solo)).toBeUndefined();
    rmSync(solo, { recursive: true, force: true });
  });

  it('handles a nested root, naming the top-level segment', () => {
    const notice = detectNarrowedScope(join(workspace, 'sharebox-api', 'routes', 'auth'), workspace);
    expect(notice?.scopedTo).toBe(join('sharebox-api', 'routes', 'auth'));
    expect(notice?.unreachableSiblings).toContain('sharebox-webadmin');
  });

  it('does not throw on an unreadable workspace', () => {
    expect(detectNarrowedScope('/nope/child', '/nope')).toBeUndefined();
  });
});

describe('renderScopeNotice', () => {
  it('renders nothing when scope was not narrowed', () => {
    expect(renderScopeNotice(undefined)).toBe('');
  });

  it('names the siblings and tells the reviewer to record the gap', () => {
    const rendered = renderScopeNotice(detectNarrowedScope(join(workspace, 'sharebox-api'), workspace));
    expect(rendered).toContain('sharebox-webadmin/');
    // The point is not to send it outside the root — it is to stop it from
    // reporting a confident finding that a sibling would have refuted.
    expect(rendered).toContain('Do not read them');
    expect(rendered).toContain('`limitations`');
    expect(rendered).toMatch(/wrong once a sibling is\s+considered/);
  });
});
