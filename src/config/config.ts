import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';

import { CodexMcpError } from '../errors/codex-mcp-error.js';
import { ErrorCodes } from '../errors/codes.js';
import { parseLogLevel, type LogLevel } from '../util/logger.js';
import { envBoolean, envInteger, envString, findForbiddenEnvKeys, loadEnv } from './env.js';
import {
  FileConfigSchema,
  type ApprovalMode,
  type AuthMode,
  type ConnectorConfigInput,
  type FileConfig,
  type ReasoningEffort,
  type SandboxMode,
} from './schema.js';

export const DEFAULTS = {
  authMode: 'chatgpt' as AuthMode,
  codexBinary: 'codex',
  sandbox: 'read-only' as SandboxMode,
  reasoningEffort: 'high' as ReasoningEffort,
  ephemeral: true,
  maxPasses: 2,
  reviewTimeoutMs: 900_000,
  maxConcurrentReviews: 2,
  maxArtifactBytes: 200_000,
  maxCandidateItems: 500,
  dbMaxRows: 500,
  dbTimeoutMs: 10_000,
  connectorStartupTimeoutMs: 30_000,
  connectorCallTimeoutMs: 60_000,
  logLevel: 'info' as LogLevel,
} as const;

export interface ConnectorConfig {
  readonly name: string;
  readonly kind: string;
  readonly enabled: boolean;
  /** Human approval required before a review may reach this connector. */
  readonly approval: ApprovalMode;
  readonly transport: 'stdio' | 'http';
  readonly command?: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly cwd?: string;
  readonly url?: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly allowTools: readonly string[];
  readonly denyTools: readonly string[];
  readonly startupTimeoutMs: number;
  readonly callTimeoutMs: number;
  readonly maxRows: number;
  readonly timeoutMs: number;
}

export interface Config {
  readonly authMode: AuthMode;
  readonly codexBinary: string;

  /** Undefined means "let Codex choose its default"; never silently substituted. */
  readonly model?: string;
  /** When true, a review with no pinned model is an error rather than a default. */
  readonly requireModel: boolean;
  readonly reasoningEffort: ReasoningEffort;
  readonly sandbox: SandboxMode;
  readonly ephemeral: boolean;

  readonly maxPasses: number;
  readonly reviewTimeoutMs: number;
  readonly maxConcurrentReviews: number;
  readonly maxArtifactBytes: number;
  readonly maxCandidateItems: number;

  readonly permissions: {
    readonly projectRead: boolean;
    readonly projectWrite: boolean;
    readonly gitRead: boolean;
    readonly gitWrite: boolean;
    readonly allowUnknownDownstreamTools: boolean;
  };

  readonly connectors: Readonly<Record<string, ConnectorConfig>>;
  readonly logLevel: LogLevel;

  /** Non-fatal problems found while loading; surfaced by `doctor`. */
  readonly warnings: readonly string[];
  readonly sources: {
    readonly configFile?: string;
    readonly cwd: string;
  };
}

export interface LoadConfigOptions {
  cwd?: string;
  /** Explicit config file path. When set and unreadable, loading fails. */
  configPath?: string;
  env?: NodeJS.ProcessEnv;
}

const CONFIG_FILE_CANDIDATES = ['codex-mcp.yaml', 'codex-mcp.yml', '.codex-mcp.yaml', '.codex-mcp.yml'];

/**
 * User-level configuration directory.
 *
 * An MCP client launches the server with the *consuming project* as its working
 * directory, so a cwd-only search would make the server's own configuration
 * depend on wherever it happened to be started — usually meaning it silently
 * found nothing and ran with no connectors. The server's configuration belongs
 * to the operator, not to the project under review.
 */
export function userConfigDir(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const xdg = env['XDG_CONFIG_HOME'];
  if (xdg && xdg.trim() !== '') return resolve(xdg, 'codex-mcp');
  const home = env['HOME'] ?? env['USERPROFILE'];
  if (home && home.trim() !== '') return resolve(home, '.config', 'codex-mcp');
  return undefined;
}

/**
 * Search order for the configuration file:
 *
 *   1. `--config <path>`            explicit; a miss is a hard error
 *   2. `CODEX_MCP_CONFIG`           explicit; a miss is a hard error
 *   3. the working directory        keeps repo-local development working
 *   4. the user config directory    what a real installation uses
 *
 * Absence of all four is still a fully supported state.
 */
function readFileConfig(
  cwd: string,
  explicitPath: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  warnings: string[] = [],
): { config: FileConfig; path?: string } {
  const fromEnv = envString(env, 'CODEX_MCP_CONFIG');
  const explicit = explicitPath ?? fromEnv;

  const searchDirs = [cwd, userConfigDir(env)].filter((dir): dir is string => Boolean(dir));
  const candidates = explicit
    ? [resolve(cwd, explicit)]
    : searchDirs.flatMap((dir) => CONFIG_FILE_CANDIDATES.map((file) => resolve(dir, file)));

  for (const candidate of candidates) {
    let raw: string;
    try {
      raw = readFileSync(candidate, 'utf8');
    } catch {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = parseYaml(raw) ?? {};
    } catch (err) {
      throw new CodexMcpError(ErrorCodes.INTERNAL_ERROR, `Failed to parse config file ${candidate}: ${(err as Error).message}`);
    }

    const unresolved = unresolvedVariables(raw, env);
    if (unresolved.length > 0) {
      warnings.push(
        `Config references unset variable(s): ${unresolved.join(', ')}. ` +
          'Set them in the environment or ~/.config/codex-mcp/.env, or give them a ${VAR:-fallback}.',
      );
    }

    const result = FileConfigSchema.safeParse(expandTree(parsed, env));
    if (!result.success) {
      throw new CodexMcpError(ErrorCodes.INTERNAL_ERROR, `Invalid config file ${candidate}: ${formatZodIssues(result.error.issues)}`);
    }
    return { config: result.data, path: candidate };
  }

  if (explicit) {
    throw new CodexMcpError(
      ErrorCodes.INTERNAL_ERROR,
      `Config file not found: ${resolve(cwd, explicit)}` +
        (explicitPath ? '' : ' (from CODEX_MCP_CONFIG)'),
    );
  }
  // Absence of a config file is a normal, fully-supported state, not a warning.
  return { config: {} };
}

function formatZodIssues(issues: { path: (string | number | symbol)[]; message: string }[]): string {
  return issues.map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`).join('; ');
}

/**
 * Expand `${VAR}`, `${VAR:-fallback}`, and a leading `~` in configuration
 * strings.
 *
 * Connector commands are absolute paths, and those differ on every machine.
 * Without expansion the same YAML cannot be shared across a team or moved to a
 * new laptop — the file has to be hand-edited, which is how a checked-in config
 * ends up with someone's home directory in it.
 *
 * An undefined variable with no fallback is left verbatim rather than replaced
 * with an empty string: `/src/index.js` is a confusing "file not found", while
 * `${JIRA_MCP_PATH}/src/index.js` in the error message says exactly what is
 * unset.
 */
export function expandConfigValue(value: string, env: NodeJS.ProcessEnv): string {
  let out = value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (match, name: string, fallback?: string) => {
    const resolved = env[name];
    if (resolved !== undefined && resolved !== '') return resolved;
    if (fallback !== undefined) return fallback;
    return match;
  });

  if (out === '~' || out.startsWith('~/')) {
    const home = env['HOME'] ?? env['USERPROFILE'];
    if (home) out = out === '~' ? home : resolve(home, out.slice(2));
  }
  return out;
}

/** Recursively expand every string in the parsed YAML, before validation. */
function expandTree(node: unknown, env: NodeJS.ProcessEnv): unknown {
  if (typeof node === 'string') return expandConfigValue(node, env);
  if (Array.isArray(node)) return node.map((item) => expandTree(item, env));
  if (node && typeof node === 'object') {
    return Object.fromEntries(Object.entries(node as Record<string, unknown>).map(([k, v]) => [k, expandTree(v, env)]));
  }
  return node;
}

/** Variables referenced in the config that are not set anywhere. */
function unresolvedVariables(raw: string, env: NodeJS.ProcessEnv): string[] {
  const found = new Set<string>();
  for (const match of raw.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g)) {
    const name = match[1] as string;
    const hasFallback = match[2] !== undefined;
    if (!hasFallback && (env[name] === undefined || env[name] === '')) found.add(name);
  }
  return [...found];
}

/**
 * Well-known connectors get sensible env toggles so a user can enable Jira or a
 * database without writing YAML — the command still has to come from YAML.
 */
function envConnectorToggle(env: NodeJS.ProcessEnv, name: string): boolean | undefined {
  switch (name) {
    case 'jira':
      return envBoolean(env, 'JIRA_ENABLED');
    case 'database':
    case 'db':
      return envBoolean(env, 'DATABASE_ENABLED');
    default:
      return envBoolean(env, 'CUSTOM_MCPS_ENABLED');
  }
}

function inferKind(name: string, declared?: string): string {
  if (declared) return declared.toLowerCase();
  const normalized = name.toLowerCase();
  if (normalized.includes('jira') || normalized.includes('issue')) return 'jira';
  if (normalized.includes('db') || normalized.includes('database') || normalized.includes('sql')) return 'database';
  if (normalized.includes('testrail') || normalized.includes('qase') || normalized.includes('testmanagement')) {
    return 'testmanagement';
  }
  if (normalized.includes('ftp') || normalized.includes('sftp') || normalized.includes('file')) return 'external_file';
  return 'custom';
}

function buildConnector(
  name: string,
  input: ConnectorConfigInput,
  env: NodeJS.ProcessEnv,
  warnings: string[],
): ConnectorConfig {
  const kind = inferKind(name, input.kind);
  const transport = input.transport ?? (input.url ? 'http' : 'stdio');
  const envToggle = envConnectorToggle(env, name);
  // YAML is explicit intent and outranks the coarse env toggle.
  const enabled = input.enabled ?? envToggle ?? false;

  if (enabled && transport === 'stdio' && !input.command) {
    warnings.push(`Connector "${name}" is enabled but has no \`command\`; it will be unavailable.`);
  }
  if (enabled && transport === 'http' && !input.url) {
    warnings.push(`Connector "${name}" is enabled but has no \`url\`; it will be unavailable.`);
  }

  const connector: ConnectorConfig = {
    name,
    kind,
    enabled,
    // Reaching outside the project is opt-in per session by default; a config
    // file written weeks ago is not informed consent for today's review.
    approval: input.approval ?? 'once',
    transport,
    args: input.args ?? [],
    env: input.env ?? {},
    headers: input.headers ?? {},
    allowTools: input.allowTools ?? [],
    denyTools: input.denyTools ?? [],
    startupTimeoutMs: input.startupTimeoutMs ?? DEFAULTS.connectorStartupTimeoutMs,
    callTimeoutMs: input.callTimeoutMs ?? DEFAULTS.connectorCallTimeoutMs,
    maxRows: input.maxRows ?? envInteger(env, 'DB_MAX_ROWS') ?? DEFAULTS.dbMaxRows,
    timeoutMs: input.timeoutMs ?? envInteger(env, 'DB_TIMEOUT_MS') ?? DEFAULTS.dbTimeoutMs,
    ...(input.command ? { command: input.command } : {}),
    ...(input.cwd ? { cwd: input.cwd } : {}),
    ...(input.url ? { url: input.url } : {}),
  };
  return connector;
}

/**
 * Resolve configuration from defaults < `codex-mcp.yaml` < environment.
 *
 * Environment wins so an operator can override a checked-in file without
 * editing it. Sandbox is the one place we clamp: anything other than
 * `read-only` is a deliberate, warned-about downgrade of the safety boundary.
 */
export function loadConfig(options: LoadConfigOptions = {}): Config {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? loadEnv(cwd);
  const warnings: string[] = [];

  const forbidden = findForbiddenEnvKeys(env);
  if (forbidden.length > 0) {
    warnings.push(
      `Ignoring credential-looking environment variables (${forbidden.join(', ')}). ` +
        'codex-mcp never reads or forwards these; authentication belongs to the Codex CLI.',
    );
  }

  const { config: file, path: configFile } = readFileConfig(cwd, options.configPath, env, warnings);

  const authMode = (envString(env, 'AUTH_MODE') as AuthMode | undefined) ?? file.auth?.mode ?? DEFAULTS.authMode;
  if (authMode !== 'chatgpt' && authMode !== 'api') {
    throw new CodexMcpError(ErrorCodes.INTERNAL_ERROR, `Unsupported AUTH_MODE "${authMode}". Use "chatgpt" or "api".`);
  }

  const sandbox = (envString(env, 'CODEX_SANDBOX') as SandboxMode | undefined) ?? file.review?.sandbox ?? DEFAULTS.sandbox;
  if (sandbox !== 'read-only') {
    warnings.push(
      `Codex sandbox is "${sandbox}" rather than "read-only". ` +
        'The reviewer is only guaranteed non-mutating under `read-only`.',
    );
  }

  const reasoningEffort =
    (envString(env, 'CODEX_REASONING_EFFORT') as ReasoningEffort | undefined) ??
    file.review?.reasoningEffort ??
    DEFAULTS.reasoningEffort;

  // Env outranks the file so a single project can pin a model via `.mcp.json`.
  // When both name a model and they disagree, the file's value is discarded
  // silently — someone editing the YAML would see no effect and no reason why.
  const envModel = envString(env, 'CODEX_MODEL');
  const model = envModel ?? file.review?.model;
  if (envModel && file.review?.model && envModel !== file.review.model) {
    warnings.push(
      `Model is set in two places and they disagree: CODEX_MODEL=${envModel} (in use) ` +
        `overrides review.model: ${file.review.model}. Keep the model in one place — ` +
        'the config file — and use the environment only to override it deliberately.',
    );
  }

  const connectorInputs = file.connectors ?? {};
  const connectors: Record<string, ConnectorConfig> = {};
  for (const [name, input] of Object.entries(connectorInputs)) {
    connectors[name] = buildConnector(name, input, env, warnings);
  }

  const projectRead = envBoolean(env, 'PROJECT_READ_ENABLED') ?? file.permissions?.project?.read ?? true;
  const gitRead = envBoolean(env, 'GIT_READ_ENABLED') ?? file.permissions?.git?.read ?? true;
  const projectWrite = file.permissions?.project?.write ?? false;
  const gitWrite = file.permissions?.git?.write ?? false;
  if (projectWrite || gitWrite) {
    warnings.push('Write permissions are enabled in configuration; codex-mcp still refuses to issue mutating operations.');
  }

  return {
    authMode,
    codexBinary: envString(env, 'CODEX_BINARY') ?? file.auth?.codexBinary ?? DEFAULTS.codexBinary,
    ...(model ? { model } : {}),
    requireModel: envBoolean(env, 'CODEX_REQUIRE_MODEL') ?? file.review?.requireModel ?? false,
    reasoningEffort,
    sandbox,
    ephemeral: envBoolean(env, 'CODEX_EPHEMERAL') ?? file.review?.ephemeral ?? DEFAULTS.ephemeral,
    maxPasses: envInteger(env, 'MAX_REVIEW_PASSES') ?? file.review?.maxPasses ?? DEFAULTS.maxPasses,
    reviewTimeoutMs: envInteger(env, 'REVIEW_TIMEOUT_MS') ?? file.review?.timeoutMs ?? DEFAULTS.reviewTimeoutMs,
    maxConcurrentReviews:
      envInteger(env, 'MAX_CONCURRENT_REVIEWS') ?? file.review?.maxConcurrentReviews ?? DEFAULTS.maxConcurrentReviews,
    maxArtifactBytes: envInteger(env, 'MAX_ARTIFACT_BYTES') ?? file.review?.maxArtifactBytes ?? DEFAULTS.maxArtifactBytes,
    maxCandidateItems:
      envInteger(env, 'MAX_CANDIDATE_ITEMS') ?? file.review?.maxCandidateItems ?? DEFAULTS.maxCandidateItems,
    permissions: {
      projectRead,
      projectWrite,
      gitRead,
      gitWrite,
      allowUnknownDownstreamTools: file.permissions?.allowUnknownDownstreamTools ?? false,
    },
    connectors,
    logLevel: parseLogLevel(envString(env, 'LOG_LEVEL') ?? file.logging?.level, DEFAULTS.logLevel),
    warnings,
    sources: { ...(configFile ? { configFile } : {}), cwd },
  };
}

/** Connectors that are enabled and actually reachable-looking. */
export function usableConnectors(config: Config): ConnectorConfig[] {
  return Object.values(config.connectors).filter(
    (c) => c.enabled && (c.transport === 'stdio' ? Boolean(c.command) : Boolean(c.url)),
  );
}
