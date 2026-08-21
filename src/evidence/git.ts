import { runProcess } from '../codex/process-runner.js';
import { evaluateCommand } from '../policy/command-policy.js';
import type { Logger } from '../util/logger.js';

export interface GitEvidence {
  available: boolean;
  branch?: string;
  headCommit?: string;
  /** `git status --porcelain`, truncated. Empty string means a clean tree. */
  status?: string;
  dirty?: boolean;
  /** Names of files changed against the merge base, not the diff body. */
  changedFiles?: string[];
  diffStat?: string;
  recentCommits?: string[];
  baseRef?: string;
  notes: string[];
}

const GIT_TIMEOUT_MS = 20_000;
const MAX_CHANGED_FILES = 400;

/**
 * Read-only git facts about the working tree (PLAN.md §7.1).
 *
 * Every command goes through the command policy first. That is redundant with
 * the hardcoded argv here, and deliberately so: if someone later makes these
 * arguments dynamic, the policy is already in the path.
 */
export async function collectGitEvidence(projectRoot: string, logger: Logger, preferredBase?: string): Promise<GitEvidence> {
  const notes: string[] = [];

  const inRepo = await git(projectRoot, ['rev-parse', '--is-inside-work-tree']);
  if (!inRepo.ok || inRepo.stdout.trim() !== 'true') {
    return { available: false, notes: ['Project root is not inside a git work tree; git evidence is unavailable.'] };
  }

  const [branch, head, status, log] = await Promise.all([
    git(projectRoot, ['rev-parse', '--abbrev-ref', 'HEAD']),
    git(projectRoot, ['rev-parse', 'HEAD']),
    git(projectRoot, ['status', '--porcelain']),
    git(projectRoot, ['log', '-n', '10', '--pretty=format:%h %ad %an %s', '--date=short']),
  ]);

  const baseRef = await resolveBaseRef(projectRoot, preferredBase, notes);

  let changedFiles: string[] = [];
  let diffStat: string | undefined;
  if (baseRef) {
    const nameOnly = await git(projectRoot, ['diff', '--name-only', `${baseRef}...HEAD`]);
    if (nameOnly.ok) {
      changedFiles = nameOnly.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
    }
    const stat = await git(projectRoot, ['diff', '--stat', `${baseRef}...HEAD`]);
    if (stat.ok) diffStat = stat.stdout.trim();
  }

  // Uncommitted work matters as much as committed work for a pre-merge review.
  const workingChanges = await git(projectRoot, ['diff', '--name-only', 'HEAD']);
  if (workingChanges.ok) {
    for (const file of workingChanges.stdout.split('\n').map((l) => l.trim()).filter(Boolean)) {
      if (!changedFiles.includes(file)) changedFiles.push(file);
    }
  }

  if (changedFiles.length > MAX_CHANGED_FILES) {
    notes.push(`Changed-file list truncated to ${MAX_CHANGED_FILES} of ${changedFiles.length} entries.`);
    changedFiles = changedFiles.slice(0, MAX_CHANGED_FILES);
  }

  const statusText = status.ok ? status.stdout.trim() : undefined;

  logger.debug('git evidence collected', { changedFiles: changedFiles.length, baseRef: baseRef ?? null });

  return {
    available: true,
    ...(branch.ok ? { branch: branch.stdout.trim() } : {}),
    ...(head.ok ? { headCommit: head.stdout.trim() } : {}),
    ...(statusText !== undefined ? { status: statusText, dirty: statusText.length > 0 } : {}),
    changedFiles,
    ...(diffStat ? { diffStat } : {}),
    ...(log.ok ? { recentCommits: log.stdout.split('\n').filter(Boolean) } : {}),
    ...(baseRef ? { baseRef } : {}),
    notes,
  };
}

/** Find something sensible to diff against without guessing a branch name wrong. */
async function resolveBaseRef(projectRoot: string, preferred: string | undefined, notes: string[]): Promise<string | undefined> {
  const candidates = [preferred, 'origin/HEAD', 'origin/main', 'origin/master', 'main', 'master'].filter(
    (value): value is string => Boolean(value),
  );

  for (const candidate of candidates) {
    const verified = await git(projectRoot, ['rev-parse', '--verify', '--quiet', `${candidate}^{commit}`]);
    if (!verified.ok || verified.stdout.trim() === '') continue;
    const mergeBase = await git(projectRoot, ['merge-base', candidate, 'HEAD']);
    if (mergeBase.ok && mergeBase.stdout.trim()) return candidate;
  }

  notes.push('No base branch could be resolved; the change set is derived from the working tree only.');
  return undefined;
}

async function git(cwd: string, args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const decision = evaluateCommand(['git', ...args]);
  if (decision.effect !== 'allow') {
    return { ok: false, stdout: '', stderr: `Refused by policy: ${decision.reason}` };
  }
  const result = await runProcess({
    command: 'git',
    args,
    cwd,
    timeoutMs: GIT_TIMEOUT_MS,
    maxOutputBytes: 4 * 1024 * 1024,
    env: { ...process.env, GIT_PAGER: 'cat', GIT_TERMINAL_PROMPT: '0' },
  });
  return { ok: !result.spawnFailed && result.code === 0, stdout: result.stdout, stderr: result.stderr };
}
