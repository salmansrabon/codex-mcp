import { closeSync, existsSync, openSync, readSync } from 'node:fs';
import { basename, extname } from 'node:path';
import which from 'which';

/**
 * Windows launcher resolution for `runProcess`.
 *
 * On POSIX a CLI installed by npm is an executable script with a shebang, and
 * `child_process.spawn('codex', ...)` finds and runs it. On Windows there is no
 * `codex.exe`: npm installs `codex.cmd` (plus a `.ps1` and an extensionless sh
 * script). `CreateProcess` does not consult PATHEXT, so a bare `codex` fails
 * with ENOENT, and since CVE-2024-27980 Node refuses to run a `.cmd` at all
 * without a shell. Both halves have to be handled here.
 *
 * Nothing in this module runs off Windows -- `resolveInvocation` returns its
 * input untouched -- so the POSIX spawn path is byte-for-byte what it was.
 */

const BATCH_EXTENSIONS = new Set(['.cmd', '.bat']);
const NATIVE_EXTENSIONS = new Set(['.exe', '.com']);
/** A shebang chain longer than this is a loop, not a real interpreter stack. */
const MAX_SHEBANG_DEPTH = 4;

export interface Invocation {
  command: string;
  args: string[];
  /**
   * Set when `args` is a pre-escaped command line that Node must pass through
   * verbatim instead of re-quoting.
   */
  windowsVerbatimArguments?: boolean;
}

/** True when `resolved` is a shim cmd.exe has to interpret. */
export function isBatchLauncher(resolved: string): boolean {
  return BATCH_EXTENSIONS.has(extname(resolved).toLowerCase());
}

/**
 * Quote one argument for a command line that cmd.exe will parse *twice*: once
 * for `cmd /c`, and again when the shim forwards `%*` into the real program.
 *
 * The inner quote is doubled ("") rather than backslash-escaped (\"). cmd.exe
 * does not understand `\"` and would treat it as closing the quoted run,
 * exposing any following `& | < > ^` as syntax on the second parse and
 * truncating the argument list. Doubling keeps cmd.exe inside the quoted run
 * throughout, where those characters are inert, and the MSVCRT parser that
 * finally splits the line decodes "" back to a literal quote.
 *
 * Because the run stays quoted end to end, metacharacters need no caret
 * escaping -- and must not get any, since the caret would be consumed by the
 * first parse and be gone by the time the program sees the argument.
 */
export function escapeCmdArgument(arg: string): string {
  const doubledQuotes = arg.replace(/(\\*)"/g, '$1$1""');
  // A run of backslashes immediately before the closing quote would otherwise
  // escape it, so double those too.
  const doubledTail = doubledQuotes.replace(/(\\*)$/, '$1$1');
  return `"${doubledTail}"`;
}

export interface Shebang {
  interpreter: string;
  args: string[];
}

/**
 * Read the interpreter out of a `#!` line.
 *
 * Windows has no shebang support, so a script that POSIX runs directly has to
 * be handed to its interpreter explicitly. `/usr/bin/env` is a POSIX path that
 * means nothing here, so the real interpreter is the token after it.
 */
export function parseShebang(contents: string): Shebang | null {
  const match = /^#!(.*)/.exec(contents);
  if (!match) return null;

  const tokens = match[1]!.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;

  let [first, ...rest] = tokens as [string, ...string[]];
  if (basename(first) === 'env') {
    // `env -S` splits the remainder itself; the split above already did that.
    if (rest[0] === '-S') rest = rest.slice(1);
    if (rest.length === 0) return null;
    [first, ...rest] = rest as [string, ...string[]];
  }

  return { interpreter: basename(first), args: rest };
}

/** Read just enough of a file to see a shebang, without loading the whole thing. */
function readShebang(file: string): Shebang | null {
  let fd: number | undefined;
  try {
    fd = openSync(file, 'r');
    const buffer = Buffer.alloc(256);
    const bytes = readSync(fd, buffer, 0, 256, 0);
    return parseShebang(buffer.subarray(0, bytes).toString('utf8'));
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function looksLikePath(command: string): boolean {
  return command.includes('/') || command.includes('\\');
}

/**
 * An explicit path is already the answer, so it must not go through `which`:
 * `which` only accepts extensions listed in PATHEXT, and would reject a
 * perfectly runnable `.mjs` or extensionless script that the caller named
 * outright -- which is exactly what `CODEX_BINARY` is for.
 */
function resolveExplicitPath(command: string): string | null {
  return existsSync(command) ? command : null;
}

function resolveOnPath(command: string, env: NodeJS.ProcessEnv): string | null {
  const pathKey = Object.keys(env).find((key) => key.toUpperCase() === 'PATH');
  return which.sync(command, {
    nothrow: true,
    ...(pathKey && env[pathKey] !== undefined ? { path: env[pathKey] } : {}),
    ...(env['PATHEXT'] ? { pathExt: env['PATHEXT'] } : {}),
  });
}

/**
 * Map a command and its arguments onto something `child_process.spawn` can
 * actually start on this platform.
 *
 * An unresolvable command is returned unchanged so the caller still gets the
 * ordinary ENOENT from spawn, rather than a different error from this module.
 */
export function resolveInvocation(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  depth = 0,
): Invocation {
  if (process.platform !== 'win32') {
    return { command, args: [...args] };
  }

  const resolved = looksLikePath(command) ? resolveExplicitPath(command) : resolveOnPath(command, env);

  if (!resolved) return { command, args: [...args] };

  if (isBatchLauncher(resolved)) {
    const line = [resolved, ...args].map(escapeCmdArgument).join(' ');
    return {
      command: env['COMSPEC'] ?? env['ComSpec'] ?? 'cmd.exe',
      // The outer quotes are what `cmd /s /c` strips before parsing the rest.
      args: ['/d', '/s', '/c', `"${line}"`],
      windowsVerbatimArguments: true,
    };
  }

  if (!NATIVE_EXTENSIONS.has(extname(resolved).toLowerCase()) && depth < MAX_SHEBANG_DEPTH) {
    const shebang = readShebang(resolved);
    if (shebang) {
      // The interpreter is itself a bare command -- `node` is `node.exe`, but a
      // shim is possible too -- so resolve it the same way.
      return resolveInvocation(
        shebang.interpreter,
        [...shebang.args, resolved, ...args],
        env,
        depth + 1,
      );
    }
  }

  return { command: resolved, args: [...args] };
}
