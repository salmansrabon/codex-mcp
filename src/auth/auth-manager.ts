import type { AuthMode } from '../config/schema.js';
import { CodexMcpError } from '../errors/codex-mcp-error.js';
import { ErrorCodes } from '../errors/codes.js';
import { redactText } from '../util/redact.js';
import { runProcess, type ProcessResult } from '../codex/process-runner.js';
import { parseAuthStatus, type AuthStatus } from './auth-status.js';

export interface AuthManagerOptions {
  codexBinary: string;
  /**
   * Mode the operator configured. A review fails rather than silently running
   * under a different one, so `AUTH_MODE=api` cannot quietly bill a personal
   * ChatGPT subscription (or the reverse).
   */
  expectedMode?: AuthMode;
  /** Injectable for tests; defaults to the real process runner. */
  run?: (args: readonly string[], timeoutMs: number) => Promise<ProcessResult>;
  statusTimeoutMs?: number;
  /** Cache window for `codex login status`; a review should not re-shell every call. */
  cacheTtlMs?: number;
}

export interface CodexInstallation {
  installed: boolean;
  version?: string;
  error?: string;
}

const STATUS_TIMEOUT_MS = 20_000;
const CACHE_TTL_MS = 60_000;

/**
 * Owns everything codex-mcp knows about Codex authentication.
 *
 * The rule from PLAN.md §5: credentials belong to the Codex CLI and the OS.
 * This class only ever *asks* whether the CLI is authenticated — it never
 * reads, stores, or forwards a credential, and never opens a browser during
 * an MCP call.
 */
export class AuthManager {
  private readonly codexBinary: string;
  private readonly expectedMode?: AuthMode;
  private readonly statusTimeoutMs: number;
  private readonly cacheTtlMs: number;
  private readonly runner: (args: readonly string[], timeoutMs: number) => Promise<ProcessResult>;

  private cached?: { at: number; status: AuthStatus };
  private installationCache?: CodexInstallation;

  constructor(options: AuthManagerOptions) {
    this.codexBinary = options.codexBinary;
    if (options.expectedMode) this.expectedMode = options.expectedMode;
    this.statusTimeoutMs = options.statusTimeoutMs ?? STATUS_TIMEOUT_MS;
    this.cacheTtlMs = options.cacheTtlMs ?? CACHE_TTL_MS;
    this.runner =
      options.run ??
      ((args, timeoutMs) =>
        runProcess({
          command: this.codexBinary,
          args,
          timeoutMs,
          maxOutputBytes: 1024 * 1024,
        }));
  }

  invalidate(): void {
    this.cached = undefined;
    this.installationCache = undefined;
  }

  /** Is the `codex` binary present and runnable? */
  async checkInstallation(): Promise<CodexInstallation> {
    if (this.installationCache) return this.installationCache;
    const result = await this.runner(['--version'], this.statusTimeoutMs);
    if (result.spawnFailed) {
      this.installationCache = {
        installed: false,
        error: `Could not execute \`${this.codexBinary}\`: ${redactText(result.spawnError ?? 'unknown error')}`,
      };
    } else if (result.code !== 0) {
      this.installationCache = {
        installed: false,
        error: `\`${this.codexBinary} --version\` exited with code ${result.code}.`,
      };
    } else {
      const version = `${result.stdout}${result.stderr}`.trim().split(/\r?\n/)[0]?.trim();
      this.installationCache = { installed: true, ...(version ? { version } : {}) };
    }
    return this.installationCache;
  }

  async requireInstallation(): Promise<CodexInstallation> {
    const installation = await this.checkInstallation();
    if (!installation.installed) {
      throw new CodexMcpError(
        ErrorCodes.CODEX_NOT_INSTALLED,
        installation.error ?? 'The Codex CLI is not installed or not on PATH.',
      );
    }
    return installation;
  }

  async getStatus(options: { force?: boolean } = {}): Promise<AuthStatus> {
    if (!options.force && this.cached && Date.now() - this.cached.at < this.cacheTtlMs) {
      return this.cached.status;
    }

    const installation = await this.checkInstallation();
    if (!installation.installed) {
      const status: AuthStatus = { authenticated: false, authMode: 'unknown', detail: installation.error };
      this.cached = { at: Date.now(), status };
      return status;
    }

    const result = await this.runner(['login', 'status'], this.statusTimeoutMs);
    if (result.spawnFailed) {
      const status: AuthStatus = {
        authenticated: false,
        authMode: 'unknown',
        detail: redactText(result.spawnError ?? 'spawn failed'),
      };
      this.cached = { at: Date.now(), status };
      return status;
    }

    const parsed = parseAuthStatus(result.stdout, result.stderr, result.code);
    const status: AuthStatus = { ...parsed, ...(parsed.detail ? { detail: redactText(parsed.detail) } : {}) };
    this.cached = { at: Date.now(), status };
    return status;
  }

  /**
   * Assert authentication before a review. Fails with a typed error instead of
   * launching a browser (PLAN.md §5.3).
   */
  async requireAuthenticated(): Promise<AuthStatus> {
    await this.requireInstallation();
    const status = await this.getStatus();
    if (!status.authenticated) {
      throw new CodexMcpError(
        ErrorCodes.CODEX_AUTH_REQUIRED,
        this.expectedMode === 'api'
          ? 'Codex is not authenticated. Run `codex-mcp login --mode api`.'
          : 'Codex is not authenticated. Run `codex-mcp login`.',
      );
    }
    // `unknown` means the CLI did not say which mode it used; that is a parsing
    // gap on our side, not a reason to block a working session.
    if (this.expectedMode && status.authMode !== 'unknown' && status.authMode !== this.expectedMode) {
      throw new CodexMcpError(
        ErrorCodes.CODEX_AUTH_REQUIRED,
        `AUTH_MODE is "${this.expectedMode}" but Codex is authenticated with "${status.authMode}". ` +
          `Run \`codex-mcp login --mode ${this.expectedMode}\` to switch, or change AUTH_MODE to match.`,
      );
    }
    return status;
  }

  /** Status shaped for the `codex_auth_status` tool — never includes raw detail. */
  async publicStatus(): Promise<{
    authenticated: boolean;
    authMode: string;
    configuredAuthMode?: AuthMode;
    modeMatchesConfiguration: boolean;
    codexInstalled: boolean;
    codexVersion?: string;
  }> {
    const installation = await this.checkInstallation();
    const status = await this.getStatus();
    const activeMode = status.authenticated ? status.authMode : 'unknown';
    return {
      authenticated: status.authenticated,
      authMode: activeMode,
      ...(this.expectedMode ? { configuredAuthMode: this.expectedMode } : {}),
      modeMatchesConfiguration:
        !this.expectedMode || activeMode === 'unknown' || activeMode === this.expectedMode,
      codexInstalled: installation.installed,
      ...(installation.version ? { codexVersion: installation.version } : {}),
    };
  }
}
