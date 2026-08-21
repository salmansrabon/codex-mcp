import { allow, deny, type PolicyDecision } from './types.js';

/**
 * SQL statement policy (PLAN.md §7.3).
 *
 * Requirements enforced here:
 *  - single statement only (multi-statement payloads refused);
 *  - SELECT / SHOW / DESCRIBE / EXPLAIN / WITH-into-SELECT only;
 *  - no data- or schema-mutating keywords anywhere in the statement;
 *  - no side-effecting functions;
 *  - a row cap is applied when the statement has no LIMIT of its own.
 *
 * The parser is intentionally conservative. It strips strings and comments
 * first so that keywords hidden in literals cannot trip it, then refuses
 * anything it does not positively recognize.
 */

export const ALLOWED_STATEMENT_HEADS = ['select', 'show', 'describe', 'desc', 'explain', 'with', 'table', 'values'] as const;

/** Keywords that mutate data, schema, or session/server state. */
const FORBIDDEN_KEYWORDS = [
  'insert', 'update', 'delete', 'drop', 'alter', 'truncate', 'create',
  'replace', 'merge', 'upsert', 'grant', 'revoke', 'commit', 'rollback',
  'savepoint', 'lock', 'unlock', 'call', 'exec', 'execute', 'do', 'handler',
  'vacuum', 'analyze', 'reindex', 'cluster', 'copy', 'load', 'import',
  'attach', 'detach', 'pragma', 'set', 'reset', 'begin', 'start',
  'prepare', 'deallocate', 'listen', 'notify', 'refresh', 'rename',
  'shutdown', 'kill', 'flush', 'purge', 'optimize', 'repair', 'backup',
  'restore', 'checkpoint', 'discard', 'reassign', 'comment', 'security',
];

/** Functions with side effects, even inside an otherwise-read-only SELECT. */
const FORBIDDEN_FUNCTIONS = [
  'pg_read_file', 'pg_read_binary_file', 'pg_ls_dir', 'pg_stat_file',
  'pg_sleep', 'pg_terminate_backend', 'pg_cancel_backend', 'pg_reload_conf',
  'pg_rotate_logfile', 'lo_import', 'lo_export', 'dblink', 'dblink_exec',
  'load_file', 'sleep', 'benchmark', 'sys_exec', 'sys_eval', 'xp_cmdshell',
  'openrowset', 'opendatasource', 'utl_file', 'utl_http', 'dbms_lob',
  'dbms_scheduler', 'readfile', 'writefile', 'into_outfile', 'nextval',
  'setval', 'random_bytes', 'gen_random_uuid',
];

/** Clauses that write to disk from inside a SELECT. */
const FORBIDDEN_CLAUSES = [
  /\binto\s+outfile\b/,
  /\binto\s+dumpfile\b/,
  /\bselect\b[\s\S]*\binto\s+(?!strict\b)[a-z_"`[]/,
  /\bfor\s+update\b/,
  /\bfor\s+no\s+key\s+update\b/,
  /\bfor\s+share\b/,
  /\breturning\b/,
];

export interface DbPolicyOptions {
  maxRows?: number;
  /** Append a LIMIT when the statement has none. Off for dialects lacking LIMIT. */
  enforceRowLimit?: boolean;
}

export interface DbPolicyResult extends PolicyDecision {
  /** The statement to actually execute; may carry an injected LIMIT. */
  sanitizedSql?: string;
  /** Row cap the caller must apply to the result set regardless of SQL. */
  maxRows?: number;
}

/** Remove comments and string/identifier literals so keyword scanning is safe. */
export function stripSqlNoise(sql: string): string {
  let out = '';
  let index = 0;
  const length = sql.length;

  while (index < length) {
    const char = sql[index] as string;
    const next = sql[index + 1];

    if (char === '-' && next === '-') {
      while (index < length && sql[index] !== '\n') index += 1;
      out += ' ';
      continue;
    }
    if (char === '#' && (index === 0 || sql[index - 1] === '\n')) {
      while (index < length && sql[index] !== '\n') index += 1;
      out += ' ';
      continue;
    }
    if (char === '/' && next === '*') {
      index += 2;
      while (index < length && !(sql[index] === '*' && sql[index + 1] === '/')) index += 1;
      index += 2;
      out += ' ';
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      const quote = char;
      index += 1;
      while (index < length) {
        if (sql[index] === '\\') {
          index += 2;
          continue;
        }
        if (sql[index] === quote) {
          if (sql[index + 1] === quote) {
            index += 2;
            continue;
          }
          index += 1;
          break;
        }
        index += 1;
      }
      // Preserve a placeholder so `into 'x'` cannot become `into x`.
      out += quote === '"' || quote === '`' ? ' _ident_ ' : " '_lit_' ";
      continue;
    }
    out += char;
    index += 1;
  }
  return out;
}

/** Split on top-level semicolons; a payload with more than one statement is refused. */
export function splitStatements(strippedSql: string): string[] {
  return strippedSql
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

export function evaluateSqlStatement(sql: string, options: DbPolicyOptions = {}): DbPolicyResult {
  const maxRows = options.maxRows ?? 500;
  const enforceRowLimit = options.enforceRowLimit ?? true;

  if (typeof sql !== 'string' || sql.trim() === '') {
    return { ...deny('unknown', 'Empty SQL statement.', 'db.empty'), maxRows };
  }

  const stripped = stripSqlNoise(sql);
  const statements = splitStatements(stripped);

  if (statements.length === 0) {
    return { ...deny('unknown', 'SQL contains no executable statement.', 'db.empty'), maxRows };
  }
  if (statements.length > 1) {
    return {
      ...deny('write', 'Multi-statement payloads are refused; send exactly one statement.', 'db.multi-statement'),
      maxRows,
    };
  }

  const normalized = (statements[0] as string).toLowerCase().replace(/\s+/g, ' ').trim();
  const head = normalized.split(/[\s(]/)[0] ?? '';

  if (!(ALLOWED_STATEMENT_HEADS as readonly string[]).includes(head)) {
    return {
      ...deny(
        head === 'insert' || head === 'update' || head === 'delete' ? 'write' : 'destructive',
        `Statement type "${head.toUpperCase()}" is not permitted. Only SELECT / SHOW / DESCRIBE / EXPLAIN are allowed.`,
        'db.statement-type',
      ),
      maxRows,
    };
  }

  // EXPLAIN ANALYZE actually executes the plan, including any mutation beneath it.
  if (head === 'explain' && /\banalyz[es]e?\b/.test(normalized)) {
    return { ...deny('write', 'EXPLAIN ANALYZE executes the statement and is refused.', 'db.explain-analyze'), maxRows };
  }

  for (const keyword of FORBIDDEN_KEYWORDS) {
    // `with` and `table` are legal heads; only flag them when they appear as a
    // statement verb elsewhere. Word-boundary match keeps `created_at` safe.
    if (keyword === head) continue;
    const pattern = new RegExp(`\\b${keyword}\\b`);
    if (pattern.test(normalized)) {
      if (isBenignKeywordUse(keyword, normalized)) continue;
      return {
        ...deny(
          ['drop', 'truncate', 'alter'].includes(keyword) ? 'destructive' : 'write',
          `Statement contains the forbidden keyword "${keyword.toUpperCase()}".`,
          'db.forbidden-keyword',
        ),
        maxRows,
      };
    }
  }

  for (const fn of FORBIDDEN_FUNCTIONS) {
    if (new RegExp(`\\b${fn}\\s*\\(`).test(normalized)) {
      return { ...deny('write', `Statement calls the side-effecting function "${fn}".`, 'db.forbidden-function'), maxRows };
    }
  }

  for (const clause of FORBIDDEN_CLAUSES) {
    if (clause.test(normalized)) {
      return { ...deny('write', 'Statement contains a clause that writes or locks rows.', 'db.forbidden-clause'), maxRows };
    }
  }

  const sanitizedSql = enforceRowLimit ? applyRowLimit(sql.trim().replace(/;\s*$/, ''), normalized, maxRows) : sql.trim();

  return {
    ...allow('read', 'Read-only statement within policy.', 'db.read'),
    sanitizedSql,
    maxRows,
  };
}

/** Only SELECT-shaped statements get a LIMIT; SHOW/DESCRIBE reject it. */
function applyRowLimit(originalSql: string, normalized: string, maxRows: number): string {
  const isSelectShaped = /^(select|with|table|values)\b/.test(normalized);
  if (!isSelectShaped) return originalSql;
  if (/\blimit\b/.test(normalized) || /\bfetch\s+(first|next)\b/.test(normalized) || /\btop\s+\d/.test(normalized)) {
    return originalSql;
  }
  return `${originalSql} LIMIT ${maxRows}`;
}

/**
 * A few forbidden words appear harmlessly inside read-only SQL. Keep this list
 * short and specific — every entry is a hole in the keyword filter.
 */
function isBenignKeywordUse(keyword: string, normalized: string): boolean {
  switch (keyword) {
    // `SET` in `GROUPING SETS`, and MySQL's `SET` data type in DESCRIBE output.
    case 'set':
      return /\bgrouping sets\b/.test(normalized) && !/\bset\s+[a-z_]+\s*=/.test(normalized);
    // `ANALYZE` as a column/table name is possible but not worth the risk.
    default:
      return false;
  }
}
