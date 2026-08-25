import { readFile, readdir, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

/**
 * Find the other repositories this change actually depends on, before deciding
 * what the review can see.
 *
 * `project.root` was being treated as the source of truth for the whole system.
 * In a single repository that is true by accident; in every arrangement people
 * actually use — a monorepo package with siblings, an API whose contract lives
 * in a shared schema repo, a service with a linked SDK — it is false, and the
 * review comes back looking complete because nothing said otherwise.
 *
 * The discovery here is deliberately evidence-based rather than heuristic: each
 * relation is something a file in the repository *says*. A `file:` dependency,
 * a workspace glob, a submodule, a `replace` directive, a compose build context.
 * Guessing that a nearby directory is related would produce confident noise;
 * reading a declaration produces a citation.
 *
 * Nothing here decides access. Discovery says what participates; the permission
 * engine says what may be read; anything discovered and unreadable becomes a
 * recorded scope gap that caps confidence. That split matters — an undiscovered
 * dependency is invisible, while a discovered-and-refused one is a known
 * unknown the reader can act on.
 */

export type RelationKind =
  | 'workspace-member'
  | 'linked-dependency'
  | 'git-submodule'
  | 'go-replace'
  | 'compose-build-context'
  | 'sibling-repository'
  | 'caller-declared';

export interface RelatedRepository {
  /** Absolute path. */
  path: string;
  kind: RelationKind;
  /** The file that declares the relation, repo-relative. Empty for caller-declared roots. */
  declaredBy: string;
  detail: string;
}

export interface RelatedRepositoryEvidence {
  discovered: RelatedRepository[];
  notes: string[];
}

const MAX_DISCOVERED = 40;
const MAX_MANIFEST_BYTES = 400_000;

const SKIP_DIRECTORIES = new Set([
  'node_modules', 'dist', 'build', 'out', 'coverage', 'target', 'vendor', '.git',
  '.venv', '.next', '.turbo', '.cache', '.yarn',
]);

/** Marker files that mean a directory is a project in its own right. */
const PROJECT_MARKERS = [
  'package.json', 'go.mod', 'Cargo.toml', 'pyproject.toml', 'pom.xml',
  'build.gradle', 'build.gradle.kts', 'composer.json', 'Gemfile', '.git',
];

export async function collectRelatedRepositories(
  projectRoot: string,
  options: { workspaceRoot?: string; declaredRoots?: readonly string[] } = {},
): Promise<RelatedRepositoryEvidence> {
  const notes: string[] = [];
  const found = new Map<string, RelatedRepository>();

  const add = (repository: RelatedRepository): void => {
    const key = resolve(repository.path);
    if (key === resolve(projectRoot)) return;
    if (found.size >= MAX_DISCOVERED) return;
    if (!found.has(key)) found.set(key, { ...repository, path: key });
  };

  for (const declared of options.declaredRoots ?? []) {
    add({
      path: resolve(declared),
      kind: 'caller-declared',
      declaredBy: '',
      detail: 'Named by the caller as participating in this change.',
    });
  }

  await fromNodeManifest(projectRoot, add, notes);
  await fromGitModules(projectRoot, add);
  await fromGoMod(projectRoot, add);
  await fromCompose(projectRoot, add);
  if (options.workspaceRoot) await fromWorkspaceSiblings(projectRoot, options.workspaceRoot, add);

  const discovered: RelatedRepository[] = [];
  for (const repository of found.values()) {
    if (await isDirectory(repository.path)) discovered.push(repository);
  }
  discovered.sort((a, b) => a.path.localeCompare(b.path));

  if (found.size >= MAX_DISCOVERED) {
    notes.push(`Related-repository discovery stopped at ${MAX_DISCOVERED} entries; there may be more.`);
  }

  return { discovered, notes };
}

/** `file:`/`link:` dependencies and workspace globs, from `package.json`. */
async function fromNodeManifest(
  projectRoot: string,
  add: (repository: RelatedRepository) => void,
  notes: string[],
): Promise<void> {
  const manifest = await readJson(join(projectRoot, 'package.json'));
  if (!manifest) return;

  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    const section = manifest[field];
    if (typeof section !== 'object' || section === null) continue;
    for (const [name, spec] of Object.entries(section as Record<string, unknown>)) {
      if (typeof spec !== 'string') continue;
      const match = /^(?:file|link):(.+)$/.exec(spec);
      if (!match) continue;
      add({
        path: resolve(projectRoot, match[1] as string),
        kind: 'linked-dependency',
        declaredBy: 'package.json',
        detail: `${field}.${name} resolves to a local path (${spec}), so its source participates in this change.`,
      });
    }
  }

  const workspaces = Array.isArray(manifest['workspaces'])
    ? (manifest['workspaces'] as unknown[])
    : Array.isArray((manifest['workspaces'] as Record<string, unknown> | undefined)?.['packages'])
      ? ((manifest['workspaces'] as Record<string, unknown>)['packages'] as unknown[])
      : [];

  for (const pattern of workspaces) {
    if (typeof pattern !== 'string') continue;
    const expanded = await expandWorkspaceGlob(projectRoot, pattern);
    if (expanded.length === 0) continue;
    for (const path of expanded) {
      add({
        path,
        kind: 'workspace-member',
        declaredBy: 'package.json',
        detail: `Workspace member matching "${pattern}". Siblings in one workspace share contracts and break together.`,
      });
    }
  }

  if (workspaces.length > 0) notes.push('This root declares a workspace, so sibling packages are part of the same build.');
}

/**
 * Expand one workspace pattern.
 *
 * Only the shapes people actually write: a single star segment such as
 * `packages` followed by a star, the same with a trailing slash, or a literal
 * path. A general glob engine here would be a dependency and a source of
 * surprises for one line of value.
 */
async function expandWorkspaceGlob(root: string, pattern: string): Promise<string[]> {
  const clean = pattern.replace(/\/+$/, '');
  if (!clean.includes('*')) {
    const path = resolve(root, clean);
    return (await isDirectory(path)) ? [path] : [];
  }

  const starIndex = clean.indexOf('*');
  const prefix = clean.slice(0, starIndex).replace(/\/+$/, '');
  const suffix = clean.slice(starIndex + 1).replace(/^\/+/, '');
  const base = resolve(root, prefix);

  let entries: string[];
  try {
    entries = await readdir(base);
  } catch {
    return [];
  }

  const results: string[] = [];
  for (const entry of entries) {
    if (SKIP_DIRECTORIES.has(entry)) continue;
    const path = suffix ? resolve(base, entry, suffix) : resolve(base, entry);
    if (await isDirectory(path)) results.push(path);
  }
  return results;
}

async function fromGitModules(projectRoot: string, add: (repository: RelatedRepository) => void): Promise<void> {
  const content = await readCapped(join(projectRoot, '.gitmodules'));
  if (!content) return;
  for (const match of content.matchAll(/^\s*path\s*=\s*(.+)$/gm)) {
    const path = (match[1] ?? '').trim();
    if (!path) continue;
    add({
      path: resolve(projectRoot, path),
      kind: 'git-submodule',
      declaredBy: '.gitmodules',
      detail: `Submodule at ${path}; its code is compiled into this project's behavior.`,
    });
  }
}

async function fromGoMod(projectRoot: string, add: (repository: RelatedRepository) => void): Promise<void> {
  const content = await readCapped(join(projectRoot, 'go.mod'));
  if (!content) return;
  for (const match of content.matchAll(/^\s*(?:replace\s+)?\S+\s+=>\s+(\.\S+|\/\S+)/gm)) {
    const target = (match[1] ?? '').trim();
    if (!target) continue;
    add({
      path: isAbsolute(target) ? target : resolve(projectRoot, target),
      kind: 'go-replace',
      declaredBy: 'go.mod',
      detail: `A replace directive points this module at ${target}, so that source is what actually builds.`,
    });
  }
}

async function fromCompose(projectRoot: string, add: (repository: RelatedRepository) => void): Promise<void> {
  for (const name of ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml']) {
    const content = await readCapped(join(projectRoot, name));
    if (!content) continue;
    for (const match of content.matchAll(/^\s*(?:context:\s*|build:\s*)(\.\.?\/[^\s#]+)\s*$/gm)) {
      const target = (match[1] ?? '').trim();
      if (!target) continue;
      add({
        path: resolve(projectRoot, target),
        kind: 'compose-build-context',
        declaredBy: name,
        detail: `Compose builds a service from ${target}, so it deploys together with this one.`,
      });
    }
  }
}

/**
 * Sibling directories that are projects in their own right.
 *
 * The weakest signal here, and it is reported as such: living beside something
 * is not a dependency on it. It is included because the narrowed-scope case is
 * common enough to be worth naming — a review rooted at one service of a
 * checked-out workspace should at least say which other services exist.
 */
async function fromWorkspaceSiblings(
  projectRoot: string,
  workspaceRoot: string,
  add: (repository: RelatedRepository) => void,
): Promise<void> {
  const root = resolve(projectRoot);
  const workspace = resolve(workspaceRoot);
  if (root === workspace) return;
  if (relative(workspace, root).startsWith('..')) return;

  const parent = dirname(root);
  let entries: string[];
  try {
    entries = await readdir(parent);
  } catch {
    return;
  }

  for (const entry of entries) {
    if (SKIP_DIRECTORIES.has(entry) || entry.startsWith('.')) continue;
    const path = resolve(parent, entry);
    if (path === root) continue;
    if (!(await isDirectory(path))) continue;
    if (!(await hasProjectMarker(path))) continue;
    add({
      path,
      kind: 'sibling-repository',
      declaredBy: '',
      detail: 'A separate project beside this one in the same workspace. Related by layout, which is weaker than a declaration.',
    });
  }
}

async function hasProjectMarker(path: string): Promise<boolean> {
  for (const marker of PROJECT_MARKERS) {
    try {
      await stat(join(path, marker));
      return true;
    } catch {
      // Next marker.
    }
  }
  return false;
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function readCapped(path: string): Promise<string | undefined> {
  try {
    const info = await stat(path);
    if (info.size > MAX_MANIFEST_BYTES) return undefined;
    return await readFile(path, 'utf8');
  } catch {
    return undefined;
  }
}

async function readJson(path: string): Promise<Record<string, unknown> | undefined> {
  const content = await readCapped(path);
  if (!content) return undefined;
  try {
    const parsed: unknown = JSON.parse(content);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}
