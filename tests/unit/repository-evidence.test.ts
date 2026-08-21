import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { collectRepositoryEvidence } from '../../src/evidence/repository.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'codex-mcp-repo-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function dirs(...names: string[]): void {
  for (const name of names) mkdirSync(join(root, name), { recursive: true });
}

function files(...names: string[]): void {
  for (const name of names) writeFileSync(join(root, name), 'x');
}

describe('dot-directory visibility', () => {
  it('reports every dot-directory, not an allowlisted few', async () => {
    dirs('.claude', '.cursor', '.qa-standards', '.git', '.venv', 'src');
    const evidence = await collectRepositoryEvidence(root);

    expect(evidence.hiddenDirectories).toEqual(
      expect.arrayContaining(['.claude', '.cursor', '.qa-standards', '.git', '.venv']),
    );
  });

  it('includes dot-entries in the top-level listing', async () => {
    dirs('.claude', 'src');
    files('.env.example', 'package.json');
    const evidence = await collectRepositoryEvidence(root);

    expect(evidence.topLevelEntries).toEqual(expect.arrayContaining(['.claude', '.env.example', 'src', 'package.json']));
  });

  it('recommends known agent-config directories', async () => {
    dirs('.claude', '.cursor', '.github');
    const evidence = await collectRepositoryEvidence(root);
    expect(evidence.agentConfigDirs).toEqual(expect.arrayContaining(['.claude', '.cursor', '.github']));
  });

  it('recommends an unfamiliar dot-directory rather than assuming it is noise', async () => {
    // A team can put its testing rules anywhere; guessing generously costs one
    // extra line in the prompt, guessing narrowly loses the standards entirely.
    dirs('.house-rules');
    const evidence = await collectRepositoryEvidence(root);
    expect(evidence.agentConfigDirs).toContain('.house-rules');
  });

  it('keeps tool state out of the recommendation while still listing it', async () => {
    dirs('.git', '.venv', '.mypy_cache', '.turbo', '.build-cache');
    const evidence = await collectRepositoryEvidence(root);

    for (const noisy of ['.git', '.venv', '.mypy_cache', '.turbo', '.build-cache']) {
      expect(evidence.hiddenDirectories).toContain(noisy);
      expect(evidence.agentConfigDirs).not.toContain(noisy);
    }
  });

  it('does not mistake a dot-file for a directory', async () => {
    files('.env', '.gitignore');
    const evidence = await collectRepositoryEvidence(root);

    expect(evidence.hiddenDirectories).toEqual([]);
    expect(evidence.topLevelEntries).toEqual(expect.arrayContaining(['.env', '.gitignore']));
  });

  it('finds convention files', async () => {
    files('CLAUDE.md', 'TESTING.md', '.cursorrules', 'README.md');
    const evidence = await collectRepositoryEvidence(root);

    expect(evidence.conventionFiles).toEqual(expect.arrayContaining(['CLAUDE.md', 'TESTING.md', '.cursorrules']));
    expect(evidence.conventionFiles).not.toContain('README.md');
  });

  it('returns empty evidence for an unreadable root instead of throwing', async () => {
    const evidence = await collectRepositoryEvidence(join(root, 'does-not-exist'));
    expect(evidence.hiddenDirectories).toEqual([]);
    expect(evidence.hasGit).toBe(false);
  });
});
