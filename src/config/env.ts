import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Minimal `.env` parser. Deliberately dependency-free and deliberately dumb:
 * codex-mcp must never hold credentials in `.env` (PLAN.md §5.4), so this only
 * needs to handle plain `KEY=value` lines.
 */
export function parseDotEnv(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const withoutExport = line.startsWith('export ') ? line.slice(7).trim() : line;
    const eq = withoutExport.indexOf('=');
    if (eq <= 0) continue;
    const key = withoutExport.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = withoutExport.slice(eq + 1).trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.endsWith(quote) && value.length >= 2) {
      value = value.slice(1, -1);
      if (quote === '"') value = value.replace(/\\n/g, '\n').replace(/\\t/g, '\t');
    } else {
      const hash = value.indexOf(' #');
      if (hash >= 0) value = value.slice(0, hash).trim();
    }
    out[key] = value;
  }
  return out;
}

/**
 * Load `.env` into a plain object without clobbering real environment
 * variables (process env always wins).
 */
export function loadEnv(cwd: string = process.cwd(), base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  // Same reasoning as the YAML search: an MCP client starts the server in the
  // consuming project's directory, so a cwd-only lookup finds nothing in a real
  // installation. The working directory still wins, so a repo checkout keeps
  // overriding the user-level file during development.
  const searchDirs = [userEnvDir(base), cwd].filter((dir): dir is string => Boolean(dir));

  let fileValues: Record<string, string> = {};
  for (const dir of searchDirs) {
    try {
      fileValues = { ...fileValues, ...parseDotEnv(readFileSync(resolve(dir, '.env'), 'utf8')) };
    } catch {
      // No .env in this directory; that is the normal case for one of them.
    }
  }
  return { ...fileValues, ...base };
}

/** Mirrors `userConfigDir` in config.ts, kept here to avoid a circular import. */
function userEnvDir(env: NodeJS.ProcessEnv): string | undefined {
  const xdg = env['XDG_CONFIG_HOME'];
  if (xdg && xdg.trim() !== '') return resolve(xdg, 'codex-mcp');
  const home = env['HOME'] ?? env['USERPROFILE'];
  if (home && home.trim() !== '') return resolve(home, '.config', 'codex-mcp');
  return undefined;
}

/** Credential names that must never appear in codex-mcp configuration (PLAN.md §5.4). */
export const FORBIDDEN_ENV_KEYS = [
  'CHATGPT_TOKEN',
  'SESSION_TOKEN',
  'ACCESS_TOKEN',
  'REFRESH_TOKEN',
] as const;

/**
 * Report forbidden credential keys present in the environment. Reported, not
 * thrown: the user may have these set for unrelated reasons, but codex-mcp
 * still refuses to read or forward them.
 */
export function findForbiddenEnvKeys(env: NodeJS.ProcessEnv): string[] {
  return FORBIDDEN_ENV_KEYS.filter((key) => typeof env[key] === 'string' && env[key] !== '');
}

export function envString(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = env[key];
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

export function envBoolean(env: NodeJS.ProcessEnv, key: string): boolean | undefined {
  const value = envString(env, key);
  if (value === undefined) return undefined;
  if (/^(1|true|yes|on)$/i.test(value)) return true;
  if (/^(0|false|no|off)$/i.test(value)) return false;
  return undefined;
}

export function envInteger(env: NodeJS.ProcessEnv, key: string): number | undefined {
  const value = envString(env, key);
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}
