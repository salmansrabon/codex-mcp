import { relative } from 'node:path';

import type { PermissionEngine } from '../policy/permission-engine.js';
import { readTextFileCapped } from '../util/fs.js';

export interface ArtifactEvidence {
  /** Logical name: blast-radius, test-charter, or a caller-supplied path. */
  name: string;
  path?: string;
  present: boolean;
  content?: string;
  truncated?: boolean;
  /** Why the artifact is absent, when it is. Never fatal (PLAN.md §11.3–§11.4). */
  note?: string;
}

export interface ArtifactCollection {
  blastRadius: ArtifactEvidence;
  testCharter: ArtifactEvidence;
  additional: ArtifactEvidence[];
}

/**
 * Load optional supporting artifacts.
 *
 * These are *supplemental*: a missing blast-radius or test-charter must never
 * block a review, and a present one is treated as a claim to verify, not as
 * ground truth (PLAN.md §11.3).
 */
export async function collectArtifacts(
  projectRoot: string,
  permissions: PermissionEngine,
  input: {
    blastRadiusPath?: string;
    testCharterPath?: string;
    blastRadius?: string;
    testCharter?: string;
    additionalPaths?: string[];
  } = {},
  maxBytes = 200_000,
): Promise<ArtifactCollection> {
  const blastRadius = await loadOne('blast-radius', projectRoot, permissions, input.blastRadiusPath, input.blastRadius, maxBytes);
  const testCharter = await loadOne('test-charter', projectRoot, permissions, input.testCharterPath, input.testCharter, maxBytes);

  const additional: ArtifactEvidence[] = [];
  for (const path of input.additionalPaths ?? []) {
    additional.push(await loadOne(path, projectRoot, permissions, path, undefined, maxBytes));
  }

  return { blastRadius, testCharter, additional };
}

async function loadOne(
  name: string,
  projectRoot: string,
  permissions: PermissionEngine,
  path: string | undefined,
  inline: string | undefined,
  maxBytes: number,
): Promise<ArtifactEvidence> {
  if (inline !== undefined && inline.trim() !== '') {
    const truncated = Buffer.byteLength(inline) > maxBytes;
    return {
      name,
      present: true,
      content: truncated ? inline.slice(0, maxBytes) : inline,
      truncated,
      note: 'Supplied inline by the authoring agent.',
    };
  }

  if (!path) {
    return { name, present: false, note: `No ${name} supplied; coverage dimensions are derived independently.` };
  }

  let resolved: string;
  try {
    resolved = permissions.assertArtifactPathAllowed(projectRoot, path);
  } catch (err) {
    return { name, present: false, path, note: (err as Error).message };
  }

  const read = await readTextFileCapped(resolved, maxBytes);
  if (!read) {
    return {
      name,
      present: false,
      path: relative(projectRoot, resolved),
      note: `${name} path was supplied but the file is missing or unreadable; continuing without it.`,
    };
  }

  return {
    name,
    present: true,
    path: relative(projectRoot, resolved),
    content: read.content,
    truncated: read.truncated,
    ...(read.truncated ? { note: `Truncated to ${maxBytes} bytes of ${read.bytes}.` } : {}),
  };
}
