import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildCodexArgs } from '../../src/codex/command-builder.js';
import { loadConfig, type Config } from '../../src/config/config.js';

let dir: string;
let config: Config;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'codex-mcp-cmd-'));
  config = loadConfig({ cwd: dir, env: {} });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const build = (overrides: Partial<Config> = {}, extra: Record<string, unknown> = {}) =>
  buildCodexArgs({
    config: { ...config, ...overrides } as Config,
    projectRoot: '/proj',
    lastMessageFile: '/tmp/last.txt',
    ...extra,
  } as Parameters<typeof buildCodexArgs>[0]);

/** Value that follows `flag` in an argv array. */
function valueAfter(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

describe('buildCodexArgs', () => {
  it('runs non-interactively with the prompt on stdin', () => {
    const args = build();
    expect(args[0]).toBe('exec');
    expect(args[args.length - 1]).toBe('-');
  });

  it('pins the sandbox and project root', () => {
    const args = build();
    expect(valueAfter(args, '--sandbox')).toBe('read-only');
    expect(valueAfter(args, '-C')).toBe('/proj');
  });

  it('requests machine-readable output and a last-message file', () => {
    const args = build();
    expect(args).toContain('--json');
    expect(valueAfter(args, '-o')).toBe('/tmp/last.txt');
  });

  it('runs ephemeral by default and honors the setting when disabled', () => {
    expect(build()).toContain('--ephemeral');
    expect(build({ ephemeral: false })).not.toContain('--ephemeral');
  });

  it('passes the configured model explicitly and omits it when unset', () => {
    expect(valueAfter(build({ model: 'some-model' }), '-m')).toBe('some-model');
    expect(build()).not.toContain('-m');
  });

  it('passes reasoning effort as a config override', () => {
    expect(build({ reasoningEffort: 'high' })).toContain('model_reasoning_effort="high"');
  });

  it('never leaves approvals able to block a headless run', () => {
    expect(build()).toContain('approval_policy="never"');
  });

  it('propagates a non-read-only sandbox rather than silently forcing read-only', () => {
    // Configuration warns about this; the builder must not quietly disagree
    // with what `codex_capabilities` reports.
    expect(valueAfter(build({ sandbox: 'workspace-write' }), '--sandbox')).toBe('workspace-write');
  });

  it('registers the evidence broker as an MCP server', () => {
    const args = build({}, { broker: { name: 'evidence', command: '/usr/bin/node', args: ['/x/cli.js', 'broker'] } });
    expect(args).toContain('mcp_servers.evidence.command="/usr/bin/node"');
    expect(args).toContain('mcp_servers.evidence.args=["/x/cli.js","broker"]');
  });

  it('quotes broker arguments so paths with spaces survive TOML parsing', () => {
    const args = build({}, { broker: { name: 'evidence', command: '/a b/node', args: ['/c d/cli.js'] } });
    expect(args).toContain('mcp_servers.evidence.command="/a b/node"');
    expect(args).toContain('mcp_servers.evidence.args=["/c d/cli.js"]');
  });

  it('emits broker env as an inline TOML table', () => {
    const args = build({}, { broker: { name: 'e', command: 'node', args: [], env: { LOG_LEVEL: 'debug' } } });
    expect(args).toContain('mcp_servers.e.env={LOG_LEVEL="debug"}');
  });

  it('omits broker configuration entirely when there is no broker', () => {
    expect(build().join(' ')).not.toContain('mcp_servers');
  });

  it('passes an output schema file when one is supplied', () => {
    expect(valueAfter(build({}, { outputSchemaFile: '/tmp/schema.json' }), '--output-schema')).toBe('/tmp/schema.json');
  });

  it('never includes a write-enabling or approval-bypassing flag', () => {
    const args = build({}, { broker: { name: 'e', command: 'node', args: [] } }).join(' ');
    expect(args).not.toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(args).not.toContain('--add-dir');
    expect(args).not.toContain('danger-full-access');
  });
});
