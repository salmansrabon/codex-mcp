import { readdirSync, statSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';

/**
 * Detect a review scoped to a subdirectory of the workspace the client opened.
 *
 * An MCP client launches this server with its workspace as the working
 * directory, so `process.cwd()` is the folder the user is actually working in —
 * the one holding `.mcp.json` and `.claude`. When the caller then passes a
 * `project.root` *below* that, everything beside it becomes invisible: the
 * reviewer is told to stay inside the root, so a sibling package is out of
 * scope even though the user would expect it to be in.
 *
 * That is a reasonable thing to want — reviewing one service of a monorepo
 * gives sharper git evidence. It is only a problem when nobody notices, which
 * is what this exists to prevent. A finding that spans an API route and the UI
 * component gating it cannot be reached from inside the API alone, and the
 * review comes back looking complete.
 */

export interface ScopeNotice {
  /** The workspace the client opened, when the review was scoped below it. */
  workspaceRoot: string;
  /** Path of the review root relative to the workspace. */
  scopedTo: string;
  /** Sibling directories the reviewer therefore cannot see. */
  unreachableSiblings: string[];
}

/** Directories that are never interesting as "siblings you are missing". */
const IGNORED_SIBLINGS = new Set([
  'node_modules', 'dist', 'build', 'out', 'coverage', 'target', 'vendor',
  '.git', '.idea', '.vscode', '.cache', '.turbo', '.next', '.venv',
]);

const MAX_REPORTED_SIBLINGS = 12;

export function detectNarrowedScope(projectRoot: string, workspaceCwd: string): ScopeNotice | undefined {
  const root = resolve(projectRoot);
  const workspace = resolve(workspaceCwd);
  if (root === workspace) return undefined;

  const rel = relative(workspace, root);
  // Only a strict descendant counts. A root elsewhere on the filesystem is a
  // deliberate choice about a different project, not a narrowed workspace.
  if (rel === '' || rel.startsWith('..') || rel.startsWith(sep)) return undefined;

  const topLevel = rel.split(sep)[0];
  let siblings: string[];
  try {
    siblings = readdirSync(workspace)
      .filter((entry) => entry !== topLevel && !IGNORED_SIBLINGS.has(entry))
      .filter((entry) => {
        try {
          return statSync(resolve(workspace, entry)).isDirectory();
        } catch {
          return false;
        }
      })
      .sort();
  } catch {
    return undefined;
  }

  if (siblings.length === 0) return undefined;

  return {
    workspaceRoot: workspace,
    scopedTo: rel,
    unreachableSiblings: siblings.slice(0, MAX_REPORTED_SIBLINGS),
  };
}

/** Prompt section telling the reviewer what it cannot reach, and what to do about it. */
export function renderScopeNotice(notice: ScopeNotice | undefined): string {
  if (!notice) return '';

  return `## Scope is narrower than the workspace

This review is rooted at \`${notice.scopedTo}\`, a subdirectory of the workspace
the caller has open. These sit beside it and are **outside your root**:

${notice.unreachableSiblings.map((name) => `- ${name}/`).join('\n')}

Do not read them — the root is the boundary for this review. But do not pretend
they are irrelevant either. If a judgment depends on one of them — a caller, a
consumer, a UI that gates the endpoint you are looking at, a shared contract —
say so in \`limitations\`, name the directory, and state what you could not
verify because of it.

A finding that is correct inside this root and wrong once a sibling is
considered is worse than no finding at all.`;
}
