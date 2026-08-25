import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { collectGitEvidence } from '../../src/evidence/git.js';
import { collectRepositoryEvidence } from '../../src/evidence/repository.js';
import { renderContext, type PromptContext } from '../../src/prompts/base-reviewer.js';
import { Logger } from '../../src/util/logger.js';

const silentLogger = new Logger('error', {}, { write: () => {} });

let root: string;

function git(...args: string[]): void {
  execFileSync('git', args, { cwd: root, stdio: 'pipe' });
}

function write(relative: string, content: string): void {
  const path = join(root, relative);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'codex-mcp-git-'));
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  write('src/app.ts', 'export const value = 1;\n');
  git('add', '-A');
  git('commit', '-qm', 'initial');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('embedded diff body', () => {
  it('carries the uncommitted diff so the reviewer does not have to fetch it', async () => {
    write('src/app.ts', 'export const value = 2;\n');

    const evidence = await collectGitEvidence(root, silentLogger);

    expect(evidence.diffBody).toContain('diff --git a/src/app.ts b/src/app.ts');
    expect(evidence.diffBody).toContain('-export const value = 1;');
    expect(evidence.diffBody).toContain('+export const value = 2;');
    expect(evidence.diffOmittedFiles ?? []).toEqual([]);
  });

  it('labels committed and uncommitted hunks separately', async () => {
    git('checkout', '-qb', 'feature');
    write('src/committed.ts', 'export const committed = true;\n');
    git('add', '-A');
    git('commit', '-qm', 'add committed');
    write('src/working.ts', 'export const working = true;\n');
    git('add', '-A');

    const evidence = await collectGitEvidence(root, silentLogger, 'main');

    expect(evidence.diffBody).toContain('Committed changes (main...HEAD)');
    expect(evidence.diffBody).toContain('src/committed.ts');
    expect(evidence.diffBody).toContain('Uncommitted changes (working tree vs HEAD)');
    expect(evidence.diffBody).toContain('src/working.ts');
  });

  it('names the files it could not fit rather than truncating a hunk', async () => {
    // One file large enough to consume the whole budget, and a small one after
    // it in path order, so the cap is reached with files still to place.
    write('src/huge.ts', `export const blob = '${'x'.repeat(200_000)}';\n`);
    write('src/small.ts', 'export const small = true;\n');
    git('add', '-A');

    const evidence = await collectGitEvidence(root, silentLogger);

    expect(evidence.diffOmittedFiles).toContain('src/huge.ts');
    expect(evidence.diffBody).not.toContain('xxxxxxxxxx');
    // A named omission, not a silent one.
    expect(evidence.notes.join(' ')).toMatch(/capped at \d+ bytes/);
  });

  it('never emits a half-file section', async () => {
    write('src/huge.ts', `export const blob = '${'y'.repeat(200_000)}';\n`);
    git('add', '-A');

    const evidence = await collectGitEvidence(root, silentLogger);
    const headers = (evidence.diffBody ?? '').match(/^diff --git /gm) ?? [];
    const hunks = (evidence.diffBody ?? '').match(/^@@ /gm) ?? [];
    // Nothing was kept at all here, so neither should appear.
    expect(headers).toHaveLength(0);
    expect(hunks).toHaveLength(0);
  });
});

describe('diff in the prompt', () => {
  async function context(git: PromptContext['git']): Promise<PromptContext> {
    return {
      projectRoot: root,
      repository: await collectRepositoryEvidence(root),
      git,
      requirement: { supplied: false, independentlyReadable: false, acceptanceCriteria: [], limitations: [] },
      artifacts: { blastRadius: { present: false }, testCharter: { present: false }, additional: [] },
      database: { available: false, guidance: [], limitations: [] },
      external: { connectors: [], usable: [], limitations: [] },
      pass: 1,
      maxPasses: 1,
    };
  }

  it('embeds the diff and still tells the reviewer the diff is not the whole story', async () => {
    write('src/app.ts', 'export const value = 3;\n');
    const evidence = await collectGitEvidence(root, silentLogger);

    const rendered = renderContext(await context(evidence));

    expect(rendered).toContain('+export const value = 3;');
    expect(rendered).toContain('Read the');
    expect(rendered).toMatch(/surrounding files/);
  });

  it('falls back to telling the reviewer to fetch the diff when none was captured', async () => {
    const rendered = renderContext(await context({ available: true, changedFiles: ['src/app.ts'], notes: [] }));

    expect(rendered).toContain('No diff body was captured');
    expect(rendered).toContain('`git diff`');
  });
});
