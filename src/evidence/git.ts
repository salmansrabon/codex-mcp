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
  /**
   * The unified diff itself, truncated at whole-file boundaries.
   *
   * Carried in the prompt rather than left for the reviewer to fetch: every
   * `git diff` it has to run is a round trip plus a re-prefill of a growing
   * context, and the diff is the one piece of evidence every review needs.
   */
  diffBody?: string;
  /** Files whose hunks did not fit, so the reviewer knows to read them itself. */
  diffOmittedFiles?: string[];
  recentCommits?: string[];
  baseRef?: string;
  notes: string[];
}

const GIT_TIMEOUT_MS = 20_000;
const MAX_CHANGED_FILES = 400;

/**
 * Byte ceiling on the embedded diff.
 *
 * Input tokens are cheap and cache well; reviewer turns are neither. The cap
 * exists so a vendored-dependency bump cannot push the change set out of the
 * context window, not to ration evidence — anything dropped is named in
 * `diffOmittedFiles` and the reviewer is told to read it directly.
 */
const MAX_DIFF_BYTES = 160_000;

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
  let committedDiff = '';
  if (baseRef) {
    const nameOnly = await git(projectRoot, ['diff', '--name-only', `${baseRef}...HEAD`]);
    if (nameOnly.ok) {
      changedFiles = nameOnly.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
    }
    const stat = await git(projectRoot, ['diff', '--stat', `${baseRef}...HEAD`]);
    if (stat.ok) diffStat = stat.stdout.trim();
    const body = await git(projectRoot, ['diff', '--no-color', `${baseRef}...HEAD`]);
    if (body.ok) committedDiff = body.stdout;
  }

  // Uncommitted work matters as much as committed work for a pre-merge review.
  const workingChanges = await git(projectRoot, ['diff', '--name-only', 'HEAD']);
  if (workingChanges.ok) {
    for (const file of workingChanges.stdout.split('\n').map((l) => l.trim()).filter(Boolean)) {
      if (!changedFiles.includes(file)) changedFiles.push(file);
    }
  }

  const workingDiffResult = await git(projectRoot, ['diff', '--no-color', 'HEAD']);
  const workingDiff = workingDiffResult.ok ? workingDiffResult.stdout : '';

  const diff = buildDiffBody(committedDiff, workingDiff, baseRef);
  for (const note of diff.notes) notes.push(note);

  if (changedFiles.length > MAX_CHANGED_FILES) {
    notes.push(`Changed-file list truncated to ${MAX_CHANGED_FILES} of ${changedFiles.length} entries.`);
    changedFiles = changedFiles.slice(0, MAX_CHANGED_FILES);
  }

  const statusText = status.ok ? status.stdout.trim() : undefined;

  logger.debug('git evidence collected', {
    changedFiles: changedFiles.length,
    baseRef: baseRef ?? null,
    diffBytes: Buffer.byteLength(diff.body, 'utf8'),
    diffOmittedFiles: diff.omittedFiles.length,
  });

  return {
    available: true,
    ...(branch.ok ? { branch: branch.stdout.trim() } : {}),
    ...(head.ok ? { headCommit: head.stdout.trim() } : {}),
    ...(statusText !== undefined ? { status: statusText, dirty: statusText.length > 0 } : {}),
    changedFiles,
    ...(diffStat ? { diffStat } : {}),
    ...(diff.body ? { diffBody: diff.body } : {}),
    ...(diff.omittedFiles.length > 0 ? { diffOmittedFiles: diff.omittedFiles } : {}),
    ...(log.ok ? { recentCommits: log.stdout.split('\n').filter(Boolean) } : {}),
    ...(baseRef ? { baseRef } : {}),
    notes,
  };
}

interface DiffBody {
  body: string;
  omittedFiles: string[];
  notes: string[];
}

/**
 * Assemble the committed and uncommitted diffs into one budgeted block.
 *
 * The two are kept separate and labelled rather than merged: for a pre-merge
 * review they answer different questions, and a hunk that exists only in the
 * working tree is a different fact about the change than one that is committed.
 */
function buildDiffBody(committed: string, working: string, baseRef: string | undefined): DiffBody {
  const parts: { heading: string; text: string }[] = [];
  if (committed.trim()) {
    parts.push({ heading: `Committed changes (${baseRef ?? 'base'}...HEAD)`, text: committed });
  }
  if (working.trim()) {
    parts.push({ heading: 'Uncommitted changes (working tree vs HEAD)', text: working });
  }
  if (parts.length === 0) return { body: '', omittedFiles: [], notes: [] };

  const omittedFiles: string[] = [];
  const notes: string[] = [];
  const rendered: string[] = [];
  let budget = MAX_DIFF_BYTES;

  for (const part of parts) {
    const sections = splitDiffSections(part.text);
    const kept: string[] = [];
    for (const section of sections) {
      const cost = Buffer.byteLength(section.text, 'utf8');
      // Whole files, never half a hunk: a diff cut mid-context reads as a
      // complete change that it is not, which is worse than a named omission.
      if (cost > budget) {
        if (section.file && !omittedFiles.includes(section.file)) omittedFiles.push(section.file);
        continue;
      }
      budget -= cost;
      kept.push(section.text);
    }
    if (kept.length > 0) rendered.push(`--- ${part.heading} ---\n${kept.join('')}`);
  }

  if (omittedFiles.length > 0) {
    notes.push(
      `The embedded diff was capped at ${MAX_DIFF_BYTES} bytes; ${omittedFiles.length} file(s) were left out and must be read with \`git diff\`.`,
    );
  }

  return { body: rendered.join('\n\n'), omittedFiles, notes };
}

/** Split a unified diff into per-file sections, keeping each `diff --git` header. */
function splitDiffSections(text: string): { file: string | undefined; text: string }[] {
  const lines = text.split('\n');
  const sections: { file: string | undefined; text: string }[] = [];
  let current: string[] = [];
  let file: string | undefined;

  const flush = (): void => {
    if (current.length === 0) return;
    sections.push({ file, text: `${current.join('\n')}\n` });
    current = [];
  };

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      flush();
      file = parseDiffGitPath(line);
    }
    current.push(line);
  }
  flush();
  return sections;
}

/** `diff --git a/path b/path` -> `path`. Undefined when the header is unusual. */
function parseDiffGitPath(line: string): string | undefined {
  const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
  return match?.[2] ?? match?.[1];
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
