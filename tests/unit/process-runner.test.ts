import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runProcess } from '../../src/codex/process-runner.js';

/**
 * A launcher installed on PATH the way npm installs one: a `.cmd` shim on
 * Windows, an extensionless shebang script on POSIX. Neither is a native
 * executable, and that is the point — `codex` itself is exactly this shape.
 */
const isWindows = process.platform === 'win32';
const LAUNCHER = 'codexmcp-fixture';

let binDir: string;
let env: NodeJS.ProcessEnv;

/** Windows env keys are case-insensitive; reuse whichever casing already exists. */
function withPathPrefix(dir: string): NodeJS.ProcessEnv {
  const next = { ...process.env };
  const key = Object.keys(next).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
  next[key] = `${dir}${isWindows ? ';' : ':'}${next[key] ?? ''}`;
  return next;
}

beforeAll(async () => {
  binDir = await mkdtemp(join(tmpdir(), 'codex-mcp-launcher-'));

  // Echoes argv back as JSON so tests can assert an exact round-trip.
  const scriptPath = join(binDir, 'fixture.js');
  await writeFile(scriptPath, 'console.log(JSON.stringify(process.argv.slice(2)));\n', 'utf8');

  if (isWindows) {
    await writeFile(join(binDir, `${LAUNCHER}.cmd`), `@node "%~dp0fixture.js" %*\n`, 'utf8');
  } else {
    const sh = join(binDir, LAUNCHER);
    await writeFile(sh, `#!/bin/sh\nexec node "$(dirname "$0")/fixture.js" "$@"\n`, 'utf8');
    await chmod(sh, 0o755);
  }

  env = withPathPrefix(binDir);
});

afterAll(async () => {
  await rm(binDir, { recursive: true, force: true });
});

describe('runProcess launcher resolution', () => {
  it('executes a PATH-resolved launcher invoked by bare name', async () => {
    const result = await runProcess({ command: LAUNCHER, args: ['ping'], env });

    expect(result.spawnError).toBeUndefined();
    expect(result.spawnFailed).toBe(false);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(['ping']);
  });

  it('delivers arguments containing shell metacharacters verbatim', async () => {
    // Every shape `buildCodexArgs` actually emits, plus a path with a space.
    const args = [
      'exec',
      '-c',
      'approval_policy="never"',
      '-c',
      'mcp_servers.broker.args=["a","b c"]',
      '-c',
      'mcp_servers.broker.env={KEY="v&v"}',
      '-C',
      'C:\Program Files\my project',
      'a|b',
      '100%',
      '-',
    ];

    const result = await runProcess({ command: LAUNCHER, args, env });

    expect(result.spawnFailed).toBe(false);
    expect(JSON.parse(result.stdout)).toEqual(args);
  });

  it('executes a shebang script given by explicit path', async () => {
    // What `CODEX_BINARY` does when it points at a script rather than an
    // installed CLI -- the shape the integration suite's fake Codex uses.
    const script = join(binDir, 'explicit-script.mjs');
    await writeFile(
      script,
      '#!/usr/bin/env node\nconsole.log(JSON.stringify(process.argv.slice(2)));\n',
      'utf8',
    );
    if (!isWindows) await chmod(script, 0o755);

    const result = await runProcess({ command: script, args: ['ping'], env });

    expect(result.spawnError).toBeUndefined();
    expect(result.spawnFailed).toBe(false);
    expect(JSON.parse(result.stdout)).toEqual(['ping']);
  });

  it('still reports spawnFailed for a launcher that is genuinely absent', async () => {
    const result = await runProcess({ command: 'codexmcp-does-not-exist', env });

    expect(result.spawnFailed).toBe(true);
    expect(result.spawnError).toMatch(/ENOENT/);
  });
});
