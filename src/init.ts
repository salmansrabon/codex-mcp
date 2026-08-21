import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { userConfigDir } from './config/config.js';
import { CodexMcpError } from './errors/codex-mcp-error.js';
import { ErrorCodes } from './errors/codes.js';
import { isReadableDirectory, isReadableFile, pathExists } from './util/fs.js';

/**
 * `codex-mcp init` — write codex-mcp's own configuration.
 *
 * One of only two places codex-mcp writes at all — the other being the
 * project-memory store — and both write exclusively to codex-mcp's own
 * directories. Nothing here, and nothing during a review, touches the target
 * project or a connected source system. This is the operator asking the CLI to
 * set itself up, in the operator's own config directory, before any review
 * exists.
 *
 * It refuses to overwrite without `--force`, so re-running it cannot silently
 * discard a configuration someone has tuned.
 */

export interface DetectedConnector {
  name: string;
  kind: 'jira' | 'database';
  path: string;
  entrypoint: string;
  envVar: string;
}

export interface InitPlan {
  configDir: string;
  configPath: string;
  envPath: string;
  configExists: boolean;
  envExists: boolean;
  detected: DetectedConnector[];
  model?: string;
}

export interface InitResult extends InitPlan {
  written: string[];
  skipped: string[];
}

/** Where a downstream MCP might live, relative to the user's home. */
const CONNECTOR_CANDIDATES: readonly { name: string; kind: 'jira' | 'database'; dirs: string[]; entrypoints: string[]; envVar: string }[] = [
  {
    name: 'jira-mcp',
    kind: 'jira',
    dirs: ['jira-mcp', 'mcp/jira-mcp', 'src/jira-mcp', 'projects/jira-mcp'],
    entrypoints: ['src/index.js', 'dist/index.js', 'index.js'],
    envVar: 'JIRA_MCP_PATH',
  },
  {
    name: 'db-mcp',
    kind: 'database',
    dirs: ['db-mcp', 'mcp/db-mcp', 'src/db-mcp', 'projects/db-mcp'],
    entrypoints: ['dist/index.js', 'src/index.js', 'index.js'],
    envVar: 'DB_MCP_PATH',
  },
];

/**
 * Look for downstream MCP servers in conventional places.
 *
 * Detection only ever *proposes* a path into the generated config; nothing is
 * connected or launched here.
 */
export async function detectConnectors(home: string): Promise<DetectedConnector[]> {
  const found: DetectedConnector[] = [];

  for (const candidate of CONNECTOR_CANDIDATES) {
    for (const dir of candidate.dirs) {
      const full = resolve(home, dir);
      if (!(await isReadableDirectory(full))) continue;

      const entrypoint = await firstReadable(full, candidate.entrypoints);
      if (!entrypoint) continue;

      found.push({
        name: candidate.name,
        kind: candidate.kind,
        path: full,
        entrypoint,
        envVar: candidate.envVar,
      });
      break;
    }
  }

  return found;
}

async function firstReadable(base: string, relatives: readonly string[]): Promise<string | undefined> {
  for (const relative of relatives) {
    if (await isReadableFile(join(base, relative))) return relative;
  }
  return undefined;
}

/** Work out what `init` would do, without touching the filesystem. */
export async function planInit(options: { env?: NodeJS.ProcessEnv; model?: string } = {}): Promise<InitPlan> {
  const env = options.env ?? process.env;
  const configDir = userConfigDir(env);
  if (!configDir) {
    throw new CodexMcpError(
      ErrorCodes.INTERNAL_ERROR,
      'Could not determine a config directory: neither XDG_CONFIG_HOME nor HOME is set.',
    );
  }

  const home = env['HOME'] ?? env['USERPROFILE'] ?? '';
  const detected = home ? await detectConnectors(home) : [];

  return {
    configDir,
    configPath: join(configDir, 'codex-mcp.yaml'),
    envPath: join(configDir, '.env'),
    configExists: await pathExists(join(configDir, 'codex-mcp.yaml')),
    envExists: await pathExists(join(configDir, '.env')),
    detected,
    ...(options.model ? { model: options.model } : {}),
  };
}

export async function runInit(options: {
  env?: NodeJS.ProcessEnv;
  model?: string;
  /** Overwrite existing files. Without it, existing files are left alone. */
  force?: boolean;
}): Promise<InitResult> {
  const plan = await planInit(options);
  const written: string[] = [];
  const skipped: string[] = [];

  await mkdir(plan.configDir, { recursive: true });

  if (plan.configExists && !options.force) {
    skipped.push(plan.configPath);
  } else {
    await writeFile(plan.configPath, renderYaml(plan), 'utf8');
    written.push(plan.configPath);
  }

  if (plan.envExists && !options.force) {
    skipped.push(plan.envPath);
  } else {
    await writeFile(plan.envPath, renderEnv(plan), 'utf8');
    // The file holds machine paths rather than secrets, but it is the file a
    // user will reach for when they do have one to set.
    await chmod(plan.envPath, 0o600);
    written.push(plan.envPath);
  }

  return { ...plan, written, skipped };
}

function renderYaml(plan: InitPlan): string {
  const lines: string[] = [
    '# Written by `codex-mcp init`. Safe to edit; re-running init will not',
    '# overwrite it unless you pass --force.',
    '',
    'review:',
    '  maxPasses: 1',
    '  sandbox: read-only',
    plan.model ? `  model: ${plan.model}` : '  # model: gpt-5.6-sol',
    plan.model ? '  requireModel: true' : '  # requireModel: true',
    '  reasoningEffort: high',
    '  ephemeral: true',
    '',
    'auth:',
    '  mode: chatgpt',
    '',
    'permissions:',
    '  project:',
    '    read: true',
    '    write: false',
    '  git:',
    '    read: true',
    '    write: false',
    '  allowUnknownDownstreamTools: false',
    '',
    'logging:',
    '  level: info',
    '',
  ];

  if (plan.detected.length === 0) {
    lines.push(
      '# No downstream MCP servers were detected. Add them here when you have',
      '# them; see codex-mcp.example.yaml for the full shape.',
      '# connectors: {}',
      '',
    );
    return lines.join('\n');
  }

  lines.push(
    '# Detected on this machine. Paths come from the variables in .env, so this',
    '# file stays portable across machines.',
    '#',
    '# approval: always | once | trusted',
    '#   always  — ask before every review',
    '#   once    — ask once per session (default)',
    '#   trusted — never ask',
    'connectors:',
  );

  for (const connector of plan.detected) {
    lines.push(
      `  ${connector.name}:`,
      '    enabled: true',
      `    kind: ${connector.kind}`,
      '    approval: once',
      '    transport: stdio',
      '    command: node',
      '    args:',
      `      - \${${connector.envVar}}/${connector.entrypoint}`,
      `    cwd: \${${connector.envVar}}`,
    );
    if (connector.kind === 'database') {
      lines.push(
        '    # A generic SQL executor is withheld by default because its name says',
        '    # nothing about what a caller may pass it. Allowlisting it is safe:',
        '    # every statement still goes through the read-only SQL policy.',
        '    allowTools:',
        '      - execute_query',
        '    denyTools:',
        '      - update_query',
        '    maxRows: 500',
        '    timeoutMs: 10000',
      );
    }
    lines.push('');
  }

  return lines.join('\n');
}

function renderEnv(plan: InitPlan): string {
  // Settings live in the YAML, not here. Writing the same key to both files
  // makes the YAML copy dead: this file wins, so editing the YAML would appear
  // to do nothing. Only values that genuinely differ per machine belong here.
  const lines: string[] = [
    '# Written by `codex-mcp init`. Machine-specific values live here; the YAML',
    '# references them, so codex-mcp.yaml stays portable.',
    '#',
    '# Values here OVERRIDE codex-mcp.yaml. Keep settings in the YAML and use',
    '# this file for per-machine paths and deliberate temporary overrides, e.g.',
    '#   CODEX_MODEL=gpt-5.6-sol',
    '#   LOG_LEVEL=debug',
    '#',
    '# Never put credentials in this file. Codex authentication belongs to the',
    '# Codex CLI and your OS credential store.',
    '',
  ];

  if (plan.detected.length > 0) {
    lines.push('# Where the downstream MCP servers live on this machine.');
    for (const connector of plan.detected) {
      lines.push(`${connector.envVar}=${connector.path}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

/** Locate the packaged example files, for `init --show`. */
export async function exampleFilePath(name: string): Promise<string | undefined> {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const candidate of [resolve(here, '..', '..', name), resolve(here, '..', name)]) {
    try {
      await stat(candidate);
      await readFile(candidate, 'utf8');
      return candidate;
    } catch {
      continue;
    }
  }
  return undefined;
}
