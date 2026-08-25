import { constants } from 'node:fs';
import { access, readFile, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';

export async function pathExists(target: string): Promise<boolean> {
  try {
    await access(target, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function isReadableDirectory(target: string): Promise<boolean> {
  try {
    const info = await stat(target);
    if (!info.isDirectory()) return false;
    await access(target, constants.R_OK | constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function isReadableFile(target: string): Promise<boolean> {
  try {
    const info = await stat(target);
    if (!info.isFile()) return false;
    await access(target, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read a UTF-8 file, truncating at `maxBytes` so a huge artifact cannot blow up
 * the prompt. Returns null when the file is missing or unreadable.
 */
export async function readTextFileCapped(
  target: string,
  maxBytes: number,
): Promise<{ content: string; truncated: boolean; bytes: number } | null> {
  try {
    const buffer = await readFile(target);
    const truncated = buffer.byteLength > maxBytes;
    const slice = truncated ? buffer.subarray(0, maxBytes) : buffer;
    return { content: slice.toString('utf8'), truncated, bytes: buffer.byteLength };
  } catch {
    return null;
  }
}

/** Resolve `candidate` relative to `base` when it is not already absolute. */
export function resolveAgainst(base: string, candidate: string): string {
  return isAbsolute(candidate) ? resolve(candidate) : resolve(base, candidate);
}

/** True when `child` is inside `parent` (or equal to it). */
/**
 * Whether `child` resolves to `parent` or somewhere underneath it.
 *
 * Built on `path.relative`, not string prefixing: a hardcoded `/` separator
 * never matches a real nested path on Windows (paths resolve with `\`), and
 * a plain `startsWith` would wrongly accept a sibling like `/project-other`
 * for a parent `/project`. `relative` also gives the cross-drive case away for
 * free -- on Windows, relative() between two drives returns the absolute
 * target rather than a `..`-prefixed path, which is exactly what the
 * `isAbsolute` check below catches.
 */
export function isInside(parent: string, child: string): boolean {
  const p = resolve(parent);
  const c = resolve(child);
  if (c === p) return true;
  const rel = relative(p, c);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}
