import { relative, resolve } from 'node:path';

import type { RelatedRepository, RelatedRepositoryEvidence } from '../evidence/related-repositories.js';
import { isReadableDirectory } from '../util/fs.js';

/**
 * Turn discovered repositories into a decided review scope.
 *
 * Discovery and access are separated deliberately. `related-repositories` says
 * what participates; this says what may be read, and the difference between the
 * two is the most useful thing the review can report. A dependency nobody
 * discovered is invisible and produces a confidently incomplete review; a
 * dependency that was discovered and refused is a *named* gap that caps
 * confidence and lands in `limitations` with the repository's name on it.
 *
 * The access rule is the same trust boundary the artifact loader already uses,
 * widened by exactly one step: a root is readable if it sits inside the
 * workspace the client opened, or inside the project root itself. That keeps the
 * reviewer from being turned into a read primitive for arbitrary filesystem
 * paths by a crafted `package.json`, while letting an ordinary monorepo or a
 * `file:` dependency resolve the way everyone expects.
 *
 * A caller-declared root is held to the same rule. The caller is not more
 * trusted than the repository here — a request arrives over MCP, and "the
 * caller asked for it" is exactly the argument an exfiltration attempt makes.
 */

export interface ScopedRoot extends RelatedRepository {
  /** Absolute, verified readable. */
  path: string;
}

export interface UnreachableRoot extends RelatedRepository {
  reason: string;
}

export interface ReviewScope {
  /** The root the review is anchored at. */
  primaryRoot: string;
  /** Additional roots the reviewer may read. */
  additionalRoots: ScopedRoot[];
  /** Roots that participate in the change and could not be opened. */
  unreachableRoots: UnreachableRoot[];
  /** True when nothing discovered was refused or unreadable. */
  complete: boolean;
  /** One line per gap, for the confidence cap and the limitation text. */
  gaps: string[];
}

export interface ResolveScopeInput {
  projectRoot: string;
  /** The directory the MCP client launched this server from. The outer boundary. */
  workspaceRoot: string;
  related: RelatedRepositoryEvidence;
  /** Set false to keep every review single-root, whatever discovery found. */
  allowExpansion: boolean;
}

export async function resolveReviewScope(input: ResolveScopeInput): Promise<ReviewScope> {
  const primaryRoot = resolve(input.projectRoot);
  const workspace = resolve(input.workspaceRoot);

  const additionalRoots: ScopedRoot[] = [];
  const unreachableRoots: UnreachableRoot[] = [];

  for (const repository of input.related.discovered) {
    const path = resolve(repository.path);
    if (path === primaryRoot) continue;

    if (!input.allowExpansion) {
      unreachableRoots.push({ ...repository, path, reason: 'scope expansion is disabled by configuration' });
      continue;
    }

    if (!inside(workspace, path) && !inside(primaryRoot, path)) {
      unreachableRoots.push({
        ...repository,
        path,
        reason:
          'it sits outside the workspace this server was launched in, and codex-mcp will not read arbitrary filesystem paths on a request',
      });
      continue;
    }

    if (!(await isReadableDirectory(path))) {
      unreachableRoots.push({ ...repository, path, reason: 'the directory is not readable' });
      continue;
    }

    additionalRoots.push({ ...repository, path });
  }

  const gaps = unreachableRoots.map(
    (root) => `${root.kind} at ${root.path} could not be read (${root.reason})`,
  );

  return {
    primaryRoot,
    additionalRoots,
    unreachableRoots,
    complete: unreachableRoots.length === 0,
    gaps,
  };
}

function inside(parent: string, child: string): boolean {
  if (parent === child) return true;
  const rel = relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !rel.startsWith('/');
}

/** Every root a citation or a file read may resolve against, primary first. */
export function readableRoots(scope: ReviewScope): string[] {
  return [scope.primaryRoot, ...scope.additionalRoots.map((root) => root.path)];
}
