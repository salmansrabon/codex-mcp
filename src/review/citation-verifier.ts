import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';

import { isInside } from '../util/fs.js';

import type { CandidateBug } from '../schemas/qualify-request.js';
import {
  BROKEN_CITATION_STATUSES,
  type CitationCheck,
  type CitationStatus,
} from '../schemas/review-common.js';

/**
 * Check every `file:line` the *author* cited, against the files that are
 * actually there.
 *
 * This runs in codex-mcp, in ordinary code, before the reviewer prompt is
 * built. That placement is the point. An author's citation is not an opinion —
 * it is a factual claim about the repository, and it is the one part of a
 * submitted finding that can be settled without judgment. Asking a model to
 * check it costs a round trip and returns a probability; asking the filesystem
 * costs a `stat` and returns an answer.
 *
 * It also closes a specific failure: a fabricated citation used to travel into
 * the prompt as ordinary context, and a reviewer that could not find the cited
 * code had no way to distinguish "the author invented this" from "I looked in
 * the wrong place". Now the reviewer is *told*, and the gate knows too — a
 * refutation resting on unverified citations cannot be high-confidence.
 *
 * What it deliberately does not do: conclude anything about the finding. A
 * fabricated citation is a defect in the write-up. The defect it describes may
 * still be real, and the reviewer is told so in as many words.
 */

/** Lines of surrounding context handed to the reviewer so "nearby code contradicts it" is answerable. */
const CONTEXT_RADIUS = 6;

/** Cap per file read. Citations point at source, and a citation into a 5 MB bundle is not a citation. */
const MAX_FILE_BYTES = 2_000_000;

/** A citation is only followed if it resolves inside a root the review may read. */
export interface CitationScope {
  /** Roots the review is allowed to resolve citations inside, primary first. */
  roots: readonly string[];
}

export interface CitationVerification {
  checks: CitationCheck[];
  /** Candidate ids that cited anything at all. */
  present: Set<string>;
  /** Candidate ids whose every citation resolved. Candidates with no citations are not included. */
  verified: Set<string>;
  /** Candidate ids with at least one citation naming a file or line that is not there. */
  broken: Set<string>;
}

interface ParsedCitation {
  path: string;
  line?: number;
  endLine?: number;
}

/**
 * Pull a path and optional line or range out of a citation string.
 *
 * Accepts the forms authors actually write: `src/a.ts:42`, `src/a.ts:42-58`,
 * `src/a.ts#L42`, `src/a.ts (line 42)`, and a bare path. Anything else is
 * reported `UNPARSEABLE` rather than guessed at — a citation nobody can follow
 * is already a problem worth naming.
 */
export function parseCitation(raw: string): ParsedCitation | undefined {
  const text = raw.trim();
  if (text === '') return undefined;

  const patterns: RegExp[] = [
    /^(?<path>[^\s:]+):(?<start>\d+)(?:[-–:](?<end>\d+))?$/,
    /^(?<path>[^\s#]+)#L(?<start>\d+)(?:[-–]L?(?<end>\d+))?$/,
    /^(?<path>[^\s(]+)\s*\(\s*lines?\s*(?<start>\d+)(?:\s*[-–]\s*(?<end>\d+))?\s*\)$/i,
  ];

  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (!match?.groups) continue;
    const start = Number.parseInt(match.groups['start'] as string, 10);
    const end = match.groups['end'] ? Number.parseInt(match.groups['end'], 10) : undefined;
    return {
      path: match.groups['path'] as string,
      ...(Number.isFinite(start) ? { line: start } : {}),
      ...(end !== undefined && Number.isFinite(end) ? { endLine: end } : {}),
    };
  }

  // A bare path, with no line. Still worth checking that the file exists.
  if (/^[^\s]+\.[A-Za-z0-9]+$/.test(text) || text.includes('/')) return { path: text };

  return undefined;
}

/**
 * Resolve a cited path against the readable roots.
 *
 * Tried in order, primary root first, so a monorepo citation that is ambiguous
 * between two packages resolves the way the caller scoped the review. An
 * absolute path is accepted only if it lands inside one of the roots — a
 * citation is not a way to ask codex-mcp to read `/etc/shadow`.
 */
async function resolveCited(path: string, scope: CitationScope): Promise<{ absolute: string; root: string } | 'out-of-scope' | undefined> {
  if (isAbsolute(path)) {
    const absolute = resolve(path);
    // `isInside` (not a `relative().startsWith('..')` check) is what actually
    // catches a path that escaped onto a different filesystem root: on
    // Windows, `relative()` between two drives returns the absolute target
    // rather than a `..`-prefixed one, so a bare prefix check would silently
    // accept a citation on the wrong drive as "inside".
    const root = scope.roots.find((candidate) => isInside(candidate, absolute));
    if (!root) return 'out-of-scope';
    return (await isFile(absolute)) ? { absolute, root } : undefined;
  }

  for (const root of scope.roots) {
    const absolute = resolve(root, path);
    if (!isInside(root, absolute)) continue;
    if (await isFile(absolute)) return { absolute, root };
  }
  return undefined;
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/** Verify one citation string attached to one candidate. */
export async function verifyCitation(candidateId: string, cited: string, scope: CitationScope): Promise<CitationCheck> {
  const parsed = parseCitation(cited);
  if (!parsed) {
    return {
      candidateId,
      cited,
      status: 'UNPARSEABLE',
      detail: 'No file path could be read out of this citation, so nothing about it could be checked.',
    };
  }

  const resolved = await resolveCited(parsed.path, scope);

  if (resolved === 'out-of-scope') {
    return {
      candidateId,
      cited,
      status: 'OUT_OF_SCOPE',
      detail: `"${parsed.path}" resolves outside every root this review may read, so it could not be checked.`,
    };
  }

  if (!resolved) {
    return {
      candidateId,
      cited,
      status: 'MISSING_FILE',
      // Stated flatly, because this is the fabrication signature and hedging it
      // is how it gets skimmed past.
      detail: `"${parsed.path}" does not exist in any root this review can read. The citation points at nothing.`,
    };
  }

  const content = await readCapped(resolved.absolute);
  const relativePath = relative(resolved.root, resolved.absolute);
  if (content === undefined) {
    return {
      candidateId,
      cited,
      status: 'CONTENT_MISMATCH',
      resolvedPath: relativePath,
      detail: `"${relativePath}" exists but could not be read as text, so the cited line could not be shown.`,
    };
  }

  const lines = content.split('\n');
  if (parsed.line === undefined) {
    return {
      candidateId,
      cited,
      status: 'VERIFIED',
      resolvedPath: relativePath,
      fileLines: lines.length,
      detail: `"${relativePath}" exists (${lines.length} lines). The citation names no line, so only the file was checked.`,
    };
  }

  if (parsed.line > lines.length) {
    return {
      candidateId,
      cited,
      status: 'LINE_OUT_OF_RANGE',
      resolvedPath: relativePath,
      line: parsed.line,
      fileLines: lines.length,
      detail: `"${relativePath}" has ${lines.length} lines; the citation points at line ${parsed.line}, past the end of the file.`,
    };
  }

  const citedLine = lines[parsed.line - 1] ?? '';
  const from = Math.max(0, parsed.line - 1 - CONTEXT_RADIUS);
  const to = Math.min(lines.length, (parsed.endLine ?? parsed.line) + CONTEXT_RADIUS);
  const context = lines
    .slice(from, to)
    .map((text, index) => `${String(from + index + 1).padStart(5)} | ${text}`)
    .join('\n');

  return {
    candidateId,
    cited,
    status: 'VERIFIED',
    resolvedPath: relativePath,
    line: parsed.line,
    fileLines: lines.length,
    citedLine,
    context,
    detail: `"${relativePath}:${parsed.line}" exists. Whether it supports the claim is a judgment, not a fact, and is left to the reviewer.`,
  };
}

async function readCapped(path: string): Promise<string | undefined> {
  try {
    const info = await stat(path);
    if (info.size > MAX_FILE_BYTES) return undefined;
    return await readFile(path, 'utf8');
  } catch {
    return undefined;
  }
}

/**
 * Every citation on every submitted bug, checked.
 *
 * Also pulls citations out of free-text fields (`suspectedCause`,
 * `actualBehavior`, and friends), because authors put `file.ts:42` in prose at
 * least as often as they fill in the structured field — and a fabricated
 * citation in prose is exactly as misleading as one in `evidence[]`.
 */
export async function verifyCandidateCitations(
  candidates: readonly CandidateBug[],
  scope: CitationScope,
): Promise<CitationVerification> {
  const checks: CitationCheck[] = [];
  const present = new Set<string>();
  const verified = new Set<string>();
  const broken = new Set<string>();

  for (const candidate of candidates) {
    const cited = new Set<string>();
    for (const evidence of candidate.evidence ?? []) {
      if (evidence.location?.trim()) cited.add(evidence.location.trim());
    }
    for (const found of citationsInProse(candidate)) cited.add(found);

    if (cited.size === 0) continue;
    present.add(candidate.id);

    let allResolved = true;
    for (const citation of cited) {
      const check = await verifyCitation(candidate.id, citation, scope);
      checks.push(check);
      if ((BROKEN_CITATION_STATUSES as readonly CitationStatus[]).includes(check.status)) {
        broken.add(candidate.id);
        allResolved = false;
      } else if (check.status !== 'VERIFIED') {
        allResolved = false;
      }
    }
    if (allResolved) verified.add(candidate.id);
  }

  return { checks, present, verified, broken };
}

/**
 * `path/to/file.ext:123` occurrences in the free-text fields of a candidate.
 *
 * Deliberately narrow: it requires an extension and a line number, so ordinary
 * prose, version strings, and timestamps are not mistaken for citations. A
 * missed prose citation costs one unchecked reference; a false one would
 * accuse an author of fabricating something they never wrote.
 */
export function citationsInProse(candidate: CandidateBug): string[] {
  const fields = [
    candidate.suspectedCause,
    candidate.actualBehavior,
    candidate.expectedBehavior,
    candidate.notes,
    ...(Array.isArray(candidate.stepsToReproduce) ? candidate.stepsToReproduce : [candidate.stepsToReproduce]),
  ];

  const pattern = /(?<![\w/.])((?:[\w.-]+\/)*[\w.-]+\.[A-Za-z]{1,8}):(\d+)(?![\w.])/g;
  const found = new Set<string>();
  for (const field of fields) {
    if (typeof field !== 'string') continue;
    for (const match of field.matchAll(pattern)) found.add(`${match[1]}:${match[2]}`);
  }
  return [...found];
}
