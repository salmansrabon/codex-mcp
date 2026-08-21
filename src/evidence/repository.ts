import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { isReadableFile } from '../util/fs.js';

export interface RepositoryEvidence {
  /** Top-level entries, so the reviewer knows the shape before it starts reading. */
  topLevelEntries: string[];
  /** Detected stack hints, e.g. "node", "python", "maven". */
  stackHints: string[];
  /** Directories that look like they hold tests. */
  testDirectories: string[];
  hasGit: boolean;
  /**
   * Every dot-directory in the project root.
   *
   * These are listed in full rather than allowlisted: a team's testing rules
   * can live in `.claude`, `.cursor`, `.qa`, `.ci`, or anything else they chose,
   * and a reviewer that cannot see a directory will not read what is in it.
   */
  hiddenDirectories: string[];
  /** The subset of those recognized as agent/AI configuration. */
  agentConfigDirs: string[];
  /** Convention files worth reading before forming a view. */
  conventionFiles: string[];
}

const STACK_MARKERS: Record<string, string> = {
  'package.json': 'node',
  'pnpm-workspace.yaml': 'node/pnpm',
  'tsconfig.json': 'typescript',
  'pyproject.toml': 'python',
  'requirements.txt': 'python',
  'go.mod': 'go',
  'Cargo.toml': 'rust',
  'pom.xml': 'maven',
  'build.gradle': 'gradle',
  'build.gradle.kts': 'gradle',
  'composer.json': 'php',
  Gemfile: 'ruby',
  'Dockerfile': 'docker',
  '*.csproj': 'dotnet',
  'mix.exs': 'elixir',
};

const TEST_DIR_NAMES = new Set(['test', 'tests', '__tests__', 'spec', 'specs', 'e2e', 'integration-tests', 'it']);

const MAX_TOP_LEVEL_ENTRIES = 80;

/** Dot-directories known to hold agent instructions, rules, and project agents. */
const KNOWN_AGENT_CONFIG_DIRS = new Set([
  '.claude', '.cursor', '.github', '.windsurf', '.aider', '.codex', '.continue',
  '.gemini', '.copilot', '.roo', '.cline', '.agent', '.ai', '.qa',
]);

/**
 * Dot-directories that are machine state rather than project intent. Their
 * names are still reported, so nothing is hidden from the reviewer — they are
 * only kept out of the "read these first" recommendation.
 */
const NOISE_DIRS = new Set([
  '.git', '.svn', '.hg', '.venv', '.tox', '.mypy_cache', '.pytest_cache',
  '.ruff_cache', '.gradle', '.idea', '.vscode-test', '.next', '.nuxt',
  '.turbo', '.cache', '.parcel-cache', '.yarn', '.pnpm-store', '.terraform',
  '.DS_Store', '.nyc_output', '.angular',
]);

/** Files that state how this project expects work to be done. */
const CONVENTION_FILES = [
  'CLAUDE.md',
  'AGENTS.md',
  'CONTRIBUTING.md',
  'TESTING.md',
  '.cursorrules',
  'CODEOWNERS',
];

/**
 * A cheap structural sketch of the repository.
 *
 * This is not an attempt to analyze the project for Codex — Codex does that
 * itself inside the sandbox. It exists so the prompt can orient the reviewer
 * and so `doctor` can confirm the path really is a project.
 */
export async function collectRepositoryEvidence(projectRoot: string): Promise<RepositoryEvidence> {
  let entries: string[] = [];
  try {
    entries = await readdir(projectRoot);
  } catch {
    return {
      topLevelEntries: [],
      stackHints: [],
      testDirectories: [],
      hasGit: false,
      hiddenDirectories: [],
      agentConfigDirs: [],
      conventionFiles: [],
    };
  }

  // Dot-entries are included: hiding them from the listing is how a reviewer
  // ends up ignoring the very rules the project wrote down for it.
  const visible = [...entries].sort();
  const stackHints = new Set<string>();
  for (const [marker, hint] of Object.entries(STACK_MARKERS)) {
    if (marker.startsWith('*')) {
      const suffix = marker.slice(1);
      if (entries.some((entry) => entry.endsWith(suffix))) stackHints.add(hint);
    } else if (entries.includes(marker) && (await isReadableFile(join(projectRoot, marker)))) {
      stackHints.add(hint);
    }
  }

  const testDirectories: string[] = [];
  for (const entry of visible) {
    if (!TEST_DIR_NAMES.has(entry.toLowerCase())) continue;
    try {
      if ((await stat(join(projectRoot, entry))).isDirectory()) testDirectories.push(entry);
    } catch {
      // Unreadable entry; skip.
    }
  }

  const hiddenDirectories: string[] = [];
  for (const entry of visible) {
    if (!entry.startsWith('.')) continue;
    try {
      if ((await stat(join(projectRoot, entry))).isDirectory()) hiddenDirectories.push(entry);
    } catch {
      // Unreadable; skip.
    }
  }
  const agentConfigDirs = hiddenDirectories.filter(
    (dir) => KNOWN_AGENT_CONFIG_DIRS.has(dir) || (!NOISE_DIRS.has(dir) && looksLikeConfigDir(dir)),
  );

  const conventionFiles: string[] = [];
  for (const candidate of CONVENTION_FILES) {
    if (entries.includes(candidate) && (await isReadableFile(join(projectRoot, candidate)))) {
      conventionFiles.push(candidate);
    }
  }

  return {
    topLevelEntries: visible.slice(0, MAX_TOP_LEVEL_ENTRIES),
    stackHints: [...stackHints],
    testDirectories,
    hasGit: entries.includes('.git'),
    hiddenDirectories,
    agentConfigDirs,
    conventionFiles,
  };
}

/**
 * A dot-directory nobody has heard of is more likely to be project intent than
 * tool cache, provided it is not on the noise list. Guessing generously here is
 * cheap — the cost of a wrong guess is one extra directory named in the prompt.
 */
function looksLikeConfigDir(name: string): boolean {
  return !NOISE_DIRS.has(name) && !name.endsWith('-cache') && !name.endsWith('_cache');
}
