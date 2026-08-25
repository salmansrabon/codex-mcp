import { describe, expect, it } from 'vitest';

import {
  escapeCmdArgument,
  isBatchLauncher,
  parseShebang,
} from '../../src/codex/windows-launcher.js';

/**
 * `escapeCmdArgument` exists because the obvious escaping is wrong.
 *
 * An npm-installed launcher on Windows is a `.cmd` shim that forwards `%*`, so
 * every argument is parsed by cmd.exe twice. The usual MSVCRT convention of
 * backslash-escaping an inner quote is invisible to cmd.exe, which counts
 * quotes naively: the escaped quote closes its quote context and any
 * `& | < > ^` after it is then read as syntax. `buildCodexArgs` emits
 * `env={KEY="..."}`, so that is a live corruption path, not a hypothetical one.
 *
 * Doubling the inner quotes instead keeps cmd.exe inside the quoted run for
 * both parses, and MSVCRT still decodes a doubled quote as a literal one.
 */
describe('escapeCmdArgument', () => {
  it('wraps a plain argument in quotes', () => {
    expect(escapeCmdArgument('exec')).toBe('"exec"');
  });

  it('doubles an inner quote rather than backslash-escaping it', () => {
    expect(escapeCmdArgument('approval_policy="never"')).toBe('"approval_policy=""never"""');
  });

  it('leaves shell metacharacters unescaped inside the quoted run', () => {
    // No carets: a caret would be consumed by the first parse and then be
    // missing -- as a literal -- from the argument the launcher finally sees.
    expect(escapeCmdArgument('R&D|x<y>z^w')).toBe('"R&D|x<y>z^w"');
  });

  it('doubles trailing backslashes so the closing quote stays a delimiter', () => {
    expect(escapeCmdArgument('C:\\path\\')).toBe('"C:\\path\\\\"');
  });

  it('doubles backslashes that precede an inner quote', () => {
    expect(escapeCmdArgument('a\\"b')).toBe('"a\\\\""b"');
  });

  it('represents an empty argument as an empty quoted run', () => {
    expect(escapeCmdArgument('')).toBe('""');
  });
});

describe('isBatchLauncher', () => {
  it('recognises the shim extensions that need cmd.exe', () => {
    expect(isBatchLauncher('C:\\bin\\codex.cmd')).toBe(true);
    expect(isBatchLauncher('C:\\bin\\codex.BAT')).toBe(true);
  });

  it('does not route a native executable through cmd.exe', () => {
    expect(isBatchLauncher('C:\\bin\\codex.exe')).toBe(false);
    expect(isBatchLauncher('/usr/local/bin/codex')).toBe(false);
  });
});

/**
 * Windows has no shebang support, so a script POSIX can execute directly --
 * the `fake-codex.mjs` the integration suite points `CODEX_BINARY` at, or any
 * script an operator points it at -- has to be handed to its interpreter.
 */
describe('parseShebang', () => {
  it('takes the interpreter named after /usr/bin/env', () => {
    expect(parseShebang('#!/usr/bin/env node\nconsole.log(1);\n')).toEqual({
      interpreter: 'node',
      args: [],
    });
  });

  it('keeps an argument passed to the interpreter through env', () => {
    expect(parseShebang('#!/usr/bin/env -S node --no-warnings\n')).toEqual({
      interpreter: 'node',
      args: ['--no-warnings'],
    });
  });

  it('reduces an absolute interpreter path to its command name', () => {
    expect(parseShebang('#!/bin/sh\n')).toEqual({ interpreter: 'sh', args: [] });
  });

  it('returns null when the file has no shebang', () => {
    expect(parseShebang('console.log(1);\n')).toBeNull();
  });
});
