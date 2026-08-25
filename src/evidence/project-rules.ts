import { readdir, stat } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';

import { readTextFileCapped } from '../util/fs.js';

/**
 * Find the instructions a project wrote for whoever works on it, and load the
 * ones that bear on *this* change.
 *
 * Two failures motivated this, and they pull in opposite directions.
 *
 * The first: the repository sketch used to list six filenames at the root and
 * name `.claude/` as a directory without ever opening it. A project rule that
 * lives in `.claude/rules/api-contracts.md` was therefore invisible, and a
 * finding that the rule would have settled came back unfound — the reviewer had
 * no way to know the project had already decided the question.
 *
 * The second, which is why this is not simply "load everything": a reviewer
 * handed forty rule files reads none of them properly. Rules are retrieved
 * against the change under review, so what arrives is small enough to be read.
 *
 * The compromise on which files are *always* loaded is deliberate. Top-level
 * agent instructions (`CLAUDE.md`, `AGENTS.md`) are a project's charter and
 * apply to everything by construction, so they are never filtered out; the ones
 * nearest the changed files come with them. Everything else — rules, skills,
 * ADRs, architecture notes — must earn its place by matching the change.
 */

export type ProjectRuleKind = 'agent-instructions' | 'rule' | 'skill' | 'adr' | 'architecture' | 'convention';

export interface DiscoveredRule {
  /** Repo-relative path. */
  path: string;
  kind: ProjectRuleKind;
  bytes: number;
}

export interface SelectedRule extends DiscoveredRule {
  content: string;
  truncated: boolean;
  /** Why this file was chosen: matched terms, or the rule that made it unconditional. */
  reason: string;
  score: number;
}

export interface ProjectRules {
  /** Everything found, whether or not it was loaded. Naming the unread ones is what keeps the selection honest. */
  discovered: DiscoveredRule[];
  /** What was actually read into the prompt. */
  selected: SelectedRule[];
  notes: string[];
}

/** Filenames that are a project's instructions to whoever works on it. */
const AGENT_INSTRUCTION_FILES = new Set(['claude.md', 'agents.md', 'agent.md', '.cursorrules', 'copilot-instructions.md']);

/** Filenames that state conventions without being agent-directed. */
const CONVENTION_FILES = new Set(['contributing.md', 'testing.md', 'architecture.md', 'codeowners']);

/** Directories whose contents are rules, keyed by the kind they produce. */
const RULE_DIRECTORIES: { readonly segments: readonly string[]; readonly kind: ProjectRuleKind }[] = [
  { segments: ['.claude', 'rules'], kind: 'rule' },
  { segments: ['.claude', 'skills'], kind: 'skill' },
  { segments: ['.cursor', 'rules'], kind: 'rule' },
  { segments: ['.github', 'instructions'], kind: 'rule' },
  { segments: ['docs', 'adr'], kind: 'adr' },
  { segments: ['docs', 'adrs'], kind: 'adr' },
  { segments: ['docs', 'decisions'], kind: 'adr' },
  { segments: ['doc', 'adr'], kind: 'adr' },
  { segments: ['adr'], kind: 'adr' },
  { segments: ['docs', 'architecture'], kind: 'architecture' },
  { segments: ['docs', 'design'], kind: 'architecture' },
];

const SKIP_DIRECTORIES = new Set([
  'node_modules', 'dist', 'build', 'out', 'coverage', 'target', 'vendor', '.git',
  '.venv', '.tox', '.next', '.nuxt', '.turbo', '.cache', '.yarn', '.pnpm-store',
  '__pycache__', '.gradle', '.idea', '.mypy_cache', '.pytest_cache',
]);

const MAX_WALK_DEPTH = 4;
const MAX_DISCOVERED = 300;
const MAX_RULE_BYTES = 60_000;
/** Total budget across every selected rule. Past this the reviewer skims instead of reading. */
const MAX_TOTAL_RULE_BYTES = 120_000;
const MAX_SELECTED = 12;

export interface RuleQuery {
  /** Paths from the change set. The strongest relevance signal there is. */
  changedFiles: readonly string[];
  /** Candidate titles, requirement text, focus — whatever the review is actually about. */
  terms: readonly string[];
}

/**
 * Walk the project for rule documents.
 *
 * Bounded in depth and count: this runs before every review, and an unbounded
 * walk of a monorepo would cost more than the review it is preparing for.
 */
export async function discoverProjectRules(root: string): Promise<DiscoveredRule[]> {
  const found: DiscoveredRule[] = [];

  async function walk(directory: string, depth: number): Promise<void> {
    if (depth > MAX_WALK_DEPTH || found.length >= MAX_DISCOVERED) return;

    let entries: string[];
    try {
      entries = await readdir(directory);
    } catch {
      return;
    }

    for (const entry of entries) {
      if (found.length >= MAX_DISCOVERED) return;
      const absolute = join(directory, entry);
      let isDirectory: boolean;
      let bytes = 0;
      try {
        const info = await stat(absolute);
        isDirectory = info.isDirectory();
        bytes = info.size;
      } catch {
        continue;
      }

      if (isDirectory) {
        if (SKIP_DIRECTORIES.has(entry)) continue;
        await walk(absolute, depth + 1);
        continue;
      }

      const kind = classify(relative(root, absolute));
      if (kind) found.push({ path: relative(root, absolute), kind, bytes });
    }
  }

  await walk(root, 0);
  return found.sort((a, b) => a.path.localeCompare(b.path));
}

/** Which kind of rule document a repo-relative path is, or undefined if it is not one. */
export function classify(relativePath: string): ProjectRuleKind | undefined {
  const segments = relativePath.split(sep);
  const name = (segments[segments.length - 1] ?? '').toLowerCase();

  for (const directory of RULE_DIRECTORIES) {
    if (containsSequence(segments, directory.segments)) {
      // A skills directory holds a directory per skill; only the manifest is the rule.
      if (directory.kind === 'skill' && name !== 'skill.md') continue;
      if (!name.endsWith('.md') && !name.endsWith('.mdc') && !name.endsWith('.txt')) continue;
      return directory.kind;
    }
  }

  if (AGENT_INSTRUCTION_FILES.has(name)) return 'agent-instructions';
  if (CONVENTION_FILES.has(name)) return 'convention';
  return undefined;
}

function containsSequence(segments: readonly string[], sequence: readonly string[]): boolean {
  for (let index = 0; index + sequence.length <= segments.length; index += 1) {
    if (sequence.every((part, offset) => segments[index + offset]?.toLowerCase() === part)) return true;
  }
  return false;
}

/**
 * Terms worth matching on, pulled out of paths and prose.
 *
 * Short and ubiquitous words are dropped: matching on "the" or "test" would
 * make every rule relevant to every change, which is the same as having no
 * retrieval at all.
 */
export function extractTerms(values: readonly string[]): Set<string> {
  const stop = new Set([
    'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'when', 'then', 'src', 'lib',
    'index', 'main', 'test', 'tests', 'spec', 'app', 'new', 'add', 'fix', 'use', 'get', 'set',
    'file', 'files', 'code', 'should', 'must', 'not', 'via', 'per', 'all', 'any', 'has', 'are',
  ]);
  const terms = new Set<string>();
  for (const value of values) {
    for (const raw of value.split(/[^A-Za-z0-9]+/)) {
      const token = raw.toLowerCase();
      if (token.length < 4 || stop.has(token)) continue;
      terms.add(token);
      // camelCase and kebab pieces carry the domain word more often than the whole.
      for (const piece of raw.split(/(?=[A-Z])/)) {
        const sub = piece.toLowerCase();
        if (sub.length >= 4 && !stop.has(sub)) terms.add(sub);
      }
    }
  }
  return terms;
}

/**
 * Score one rule document against the change.
 *
 * Path proximity is weighted above content overlap on purpose: a rule sitting
 * in the directory being changed is about that directory, and a rule whose
 * *body* happens to mention a common word is usually not.
 */
function scoreRule(rule: DiscoveredRule, content: string, query: RuleQuery, queryTerms: ReadonlySet<string>): { score: number; matched: string[] } {
  const matched = new Set<string>();
  let score = 0;

  const ruleDirectory = dirname(rule.path);
  for (const changed of query.changedFiles) {
    if (ruleDirectory !== '.' && changed.startsWith(`${ruleDirectory}${sep}`)) {
      score += 6;
      matched.add(`applies to ${ruleDirectory}/`);
    }
  }

  // Headings and the filename say what a rule is about far more reliably than
  // its body, so they are scored separately and more heavily.
  const headings = content
    .split('\n')
    .filter((line) => line.startsWith('#'))
    .join(' ');
  const headingTerms = extractTerms([rule.path, headings]);
  for (const term of headingTerms) {
    if (queryTerms.has(term)) {
      score += 3;
      matched.add(term);
    }
  }

  const bodyTerms = extractTerms([content.slice(0, 20_000)]);
  for (const term of bodyTerms) {
    if (queryTerms.has(term) && !matched.has(term)) {
      score += 1;
      matched.add(term);
    }
  }

  return { score, matched: [...matched].slice(0, 8) };
}

/**
 * Discover, then retrieve.
 *
 * Returns both the full discovered list and the selected subset, because the
 * unselected names are themselves useful: a reviewer that can see there are
 * eleven ADRs it did not read knows to go looking when a judgment turns on
 * architecture, and a reader can tell retrieval from absence.
 */
export async function collectProjectRules(root: string, query: RuleQuery): Promise<ProjectRules> {
  const notes: string[] = [];
  const discovered = await discoverProjectRules(root);
  if (discovered.length === 0) {
    return { discovered, selected: [], notes: ['No project rule or architecture documents were found.'] };
  }
  if (discovered.length >= MAX_DISCOVERED) {
    notes.push(`Rule discovery stopped at ${MAX_DISCOVERED} documents; deeper or later ones were not considered.`);
  }

  const queryTerms = extractTerms([...query.changedFiles, ...query.terms]);
  const changedDirectories = new Set(query.changedFiles.map((file) => dirname(file)));

  const scored: { rule: DiscoveredRule; content: string; truncated: boolean; score: number; reason: string }[] = [];

  for (const rule of discovered) {
    const read = await readTextFileCapped(join(root, rule.path), MAX_RULE_BYTES);
    if (!read) {
      notes.push(`${rule.path} was found but could not be read.`);
      continue;
    }

    // A project's charter applies whatever the change is, so it is never
    // filtered out — that is what makes it a charter rather than a rule.
    const isRootCharter = rule.kind === 'agent-instructions' && !rule.path.includes(sep);
    const isNearbyCharter = rule.kind === 'agent-instructions' && changedDirectories.has(dirname(rule.path));

    const { score, matched } = scoreRule(rule, read.content, query, queryTerms);

    if (isRootCharter || isNearbyCharter) {
      scored.push({
        rule,
        content: read.content,
        truncated: read.truncated,
        score: 1000 + score,
        reason: isRootCharter
          ? 'project-level agent instructions; they apply to every change'
          : `agent instructions in a directory this change touches (${dirname(rule.path)}/)`,
      });
      continue;
    }

    if (score <= 0) continue;
    scored.push({
      rule,
      content: read.content,
      truncated: read.truncated,
      score,
      reason: `matched the change on: ${matched.join(', ')}`,
    });
  }

  scored.sort((a, b) => b.score - a.score || a.rule.path.localeCompare(b.rule.path));

  const selected: SelectedRule[] = [];
  let budget = MAX_TOTAL_RULE_BYTES;
  for (const entry of scored) {
    if (selected.length >= MAX_SELECTED) break;
    const cost = Buffer.byteLength(entry.content, 'utf8');
    if (cost > budget) {
      notes.push(`${entry.rule.path} was relevant but did not fit the rule budget; it is listed as discovered only.`);
      continue;
    }
    budget -= cost;
    selected.push({
      ...entry.rule,
      content: entry.content,
      truncated: entry.truncated,
      reason: entry.reason,
      score: entry.score,
    });
  }

  const unread = discovered.length - selected.length;
  if (unread > 0) {
    notes.push(
      `${unread} further rule or architecture document(s) were found and not loaded. ` +
        'They are listed by path; read one directly if a judgment turns on it.',
    );
  }

  return { discovered, selected, notes };
}
