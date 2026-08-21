import type { RiskClass } from '../policy/types.js';

/**
 * Risk classification for downstream MCP tools (PLAN.md §8.3).
 *
 * Downstream tools are untrusted input: their names and descriptions are
 * written by third parties and can be misleading. So the classifier is
 * asymmetric on purpose —
 *
 *   - any hint of mutation wins over any hint of reading;
 *   - a tool must look *positively* read-only to be classified `read`;
 *   - everything else is `unknown`, which the policy layer denies.
 *
 * A tool that sounds safe but is not costs the user data integrity; a tool that
 * sounds unsafe but is not costs them one line of `allowTools` config.
 */

const DESTRUCTIVE_TERMS = [
  'delete', 'destroy', 'drop', 'purge', 'truncate', 'wipe', 'erase', 'remove',
  'uninstall', 'revoke', 'terminate', 'kill', 'reset', 'restore', 'rollback',
  'format', 'shutdown', 'unlink', 'rmdir', 'expire', 'archive',
];

const WRITE_TERMS = [
  'create', 'write', 'update', 'edit', 'modify', 'patch', 'put', 'post',
  'insert', 'upsert', 'merge', 'set', 'add', 'append', 'upload', 'push',
  'commit', 'transition', 'assign', 'comment', 'send', 'submit', 'apply',
  'move', 'rename', 'copy', 'clone', 'import', 'sync', 'save', 'store',
  'register', 'enable', 'disable', 'start', 'stop', 'restart', 'run',
  'execute', 'invoke', 'trigger', 'schedule', 'approve', 'reject', 'close',
  'reopen', 'link', 'attach', 'grant', 'provision', 'deploy', 'publish',
  'mutate', 'change', 'replace', 'increment', 'decrement', 'upvote',
];

const READ_TERMS = [
  'get', 'read', 'list', 'search', 'find', 'fetch', 'query', 'lookup',
  'describe', 'show', 'view', 'inspect', 'browse', 'retrieve', 'download',
  'count', 'exists', 'check', 'status', 'info', 'detail', 'details',
  'schema', 'metadata', 'summary', 'history', 'log', 'logs', 'diff',
  'sample', 'preview', 'explain', 'resolve', 'expand', 'enumerate',
];

/**
 * Explicit self-declarations of mutation. These are statements *about* the
 * tool, so they outrank a read verb in its name.
 */
const DESCRIPTION_MUTATION_DECLARATIONS = [
  /\bmutat(e|es|ing)\b/i,
  /\bside[- ]effects?\b/i,
  /\bnot\s+read[- ]only\b/i,
  /\bdestructive\b/i,
  /\bthis\s+tool\s+(creates?|updates?|deletes?|modifies|writes?)\b/i,
];

/**
 * Weak mutation signals: a mutating verb somewhere in the prose.
 *
 * These decide the classification only for a tool whose *name* says nothing
 * either way. A description is free text — it quotes examples, lists search
 * synonyms, describes the domain — so an incidental "delete" in it is not
 * evidence of mutation, and treating it as such refuses read-only tools.
 */
const DESCRIPTION_MUTATION_HINTS = [/\b(creates?|updates?|deletes?|modifies|writes?|inserts?|removes?)\b/i];

/** Descriptions that positively assert read-only behavior. */
const DESCRIPTION_READONLY_PATTERNS = [
  /\bread[- ]only\b/i,
  /\bdoes\s+not\s+(modify|mutate|change|write)\b/i,
  /\bnon[- ]mutating\b/i,
];

export interface ToolDescriptor {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export interface Classification {
  risk: RiskClass;
  /** Why the classifier landed here; recorded in the capability report. */
  rationale: string;
}

/** Split a tool name into lowercase word tokens across snake/kebab/camel case. */
export function tokenizeToolName(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((token) => token.toLowerCase());
}

export function classifyTool(tool: ToolDescriptor): Classification {
  const tokens = tokenizeToolName(tool.name);
  const description = tool.description ?? '';

  const destructiveHit = tokens.find((token) => DESTRUCTIVE_TERMS.includes(token));
  if (destructiveHit) {
    return { risk: 'destructive', rationale: `Name contains destructive verb "${destructiveHit}".` };
  }

  // Checked before the write terms: `execute_query` and `run_sql` contain a
  // neutral execution verb, but what they actually do is decided by the
  // statement, so they belong to the DB policy rather than to name matching.
  if (looksLikeGenericSqlTool(tool.name)) {
    return {
      risk: 'unknown',
      rationale: 'Generic SQL execution tool: the statement, not the tool name, determines risk.',
    };
  }

  const writeHit = tokens.find((token) => WRITE_TERMS.includes(token));
  if (writeHit) {
    return { risk: 'write', rationale: `Name contains mutating verb "${writeHit}".` };
  }

  // An explicit self-declaration of mutation beats everything below it.
  for (const pattern of DESCRIPTION_MUTATION_DECLARATIONS) {
    if (pattern.test(description)) {
      return { risk: 'write', rationale: 'Description explicitly declares mutating behavior.' };
    }
  }

  // A read verb in the name is strong evidence, and stronger than a mutating
  // word appearing somewhere in free-text prose.
  const readHit = tokens.find((token) => READ_TERMS.includes(token));
  if (readHit) {
    return { risk: 'read', rationale: `Name contains read verb "${readHit}".` };
  }

  for (const pattern of DESCRIPTION_MUTATION_HINTS) {
    if (pattern.test(description)) {
      return { risk: 'write', rationale: 'Name is ambiguous and the description mentions mutating behavior.' };
    }
  }

  for (const pattern of DESCRIPTION_READONLY_PATTERNS) {
    if (pattern.test(description)) {
      return { risk: 'read', rationale: 'Description asserts read-only behavior.' };
    }
  }

  return { risk: 'unknown', rationale: 'No read-only signal in the tool name or description.' };
}

/** Neutral execution verbs that say nothing about whether a statement mutates. */
const NEUTRAL_SQL_VERBS = ['execute', 'exec', 'run', 'invoke', 'send', 'submit'];

/** Verbs that name a mutation outright, so the tool is a writer regardless of SQL. */
const EXPLICIT_SQL_MUTATION_VERBS = ['update', 'insert', 'delete', 'drop', 'create', 'write', 'alter', 'truncate', 'upsert'];

function looksLikeGenericSqlTool(name: string): boolean {
  const tokens = tokenizeToolName(name);
  const hasSqlToken = tokens.some((token) => ['sql', 'query', 'statement'].includes(token));
  if (!hasSqlToken) return false;
  // `update_query` is a writer, not an ambiguous executor.
  if (tokens.some((token) => EXPLICIT_SQL_MUTATION_VERBS.includes(token))) return false;
  // `query_readonly`, `select_query`, `read_query` are already scoped to reads.
  if (tokens.some((token) => ['readonly', 'read', 'select', 'schema'].includes(token))) return false;
  // A bare `query` with no verb at all is equally unconstrained.
  return tokens.some((token) => NEUTRAL_SQL_VERBS.includes(token)) || tokens.every((token) => !WRITE_TERMS.includes(token));
}
