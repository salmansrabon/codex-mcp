import { runProcess } from '../codex/process-runner.js';
import type { AuthMode } from '../config/schema.js';
import { CodexMcpError } from '../errors/codex-mcp-error.js';
import { ErrorCodes } from '../errors/codes.js';
import { AuthManager } from './auth-manager.js';

export interface LoginResult {
  authenticated: boolean;
  alreadyAuthenticated: boolean;
  authMode: AuthMode | 'unknown';
  message: string;
  exitCode: number | null;
}

export interface LoginOptions {
  codexBinary: string;
  /**
   * `chatgpt` runs the browser OAuth flow; `api` hands an OpenAI API key to the
   * Codex CLI over stdin. Defaults to `chatgpt`.
   */
  mode?: AuthMode;
  /** API key for `api` mode. Falls back to OPENAI_API_KEY, then to stdin. */
  apiKey?: string;
  timeoutMs?: number;
  /** Re-authenticate even when credentials already exist. */
  force?: boolean;
  env?: NodeJS.ProcessEnv;
  /** Read a key typed into the terminal. Injectable for tests. */
  readSecretFromStdin?: () => Promise<string | undefined>;
}

/**
 * `codex-mcp login` (PLAN.md §5.2, §5.5).
 *
 * Both modes delegate to the Codex CLI, which owns the browser flow, the
 * callback listener, and credential storage. codex-mcp never writes a
 * credential to disk, never puts one in `.env`, and never keeps one in memory
 * beyond the single write to the child's stdin.
 *
 * Interactive by design: only the CLI reaches this. An MCP review that finds
 * itself unauthenticated fails with `CODEX_AUTH_REQUIRED` instead.
 */
export async function login(options: LoginOptions): Promise<LoginResult> {
  const mode: AuthMode = options.mode ?? 'chatgpt';
  const env = options.env ?? process.env;

  const authManager = new AuthManager({ codexBinary: options.codexBinary });
  const installation = await authManager.checkInstallation();
  if (!installation.installed) {
    return {
      authenticated: false,
      alreadyAuthenticated: false,
      authMode: 'unknown',
      message: installation.error ?? 'The Codex CLI is not installed or not on PATH.',
      exitCode: null,
    };
  }

  if (!options.force) {
    const status = await authManager.getStatus({ force: true });
    // Only short-circuit when the existing session is already in the requested
    // mode; otherwise the user asked to switch and we should honor that.
    if (status.authenticated && (status.authMode === mode || status.authMode === 'unknown')) {
      return {
        authenticated: true,
        alreadyAuthenticated: true,
        authMode: status.authMode,
        message: `Already authenticated with Codex (mode: ${status.authMode}).`,
        exitCode: 0,
      };
    }
  }

  const result = mode === 'api' ? await loginWithApiKey(options, env) : await loginWithBrowser(options);

  authManager.invalidate();
  const status = await authManager.getStatus({ force: true });

  return {
    authenticated: status.authenticated,
    alreadyAuthenticated: false,
    authMode: status.authMode,
    message: status.authenticated
      ? `Authenticated with Codex (mode: ${status.authMode}).`
      : mode === 'api'
        ? 'Codex rejected the API key. Check the key and re-run `codex-mcp login --mode api`.'
        : 'Codex login did not complete. Re-run `codex-mcp login`.',
    exitCode: result.code,
  };
}

/** ChatGPT subscription flow: `codex login` opens a browser and waits. */
async function loginWithBrowser(options: LoginOptions): Promise<{ code: number | null }> {
  const result = await runProcess({
    command: options.codexBinary,
    args: ['login'],
    inheritStdio: true,
    timeoutMs: options.timeoutMs ?? 10 * 60_000,
  });
  return { code: result.code };
}

/**
 * API-key flow: `codex login --with-api-key` reads the key from stdin.
 *
 * stdin rather than an argv element or an exported variable, so the key never
 * appears in the process table or in shell history.
 */
async function loginWithApiKey(options: LoginOptions, env: NodeJS.ProcessEnv): Promise<{ code: number | null }> {
  const supplied = options.apiKey ?? env['OPENAI_API_KEY'] ?? (await readKey(options));
  const apiKey = supplied?.trim();

  if (!apiKey) {
    throw new CodexMcpError(
      ErrorCodes.CODEX_AUTH_REQUIRED,
      'No API key was supplied. Set OPENAI_API_KEY, pipe the key on stdin, or type it when prompted.',
    );
  }

  const result = await runProcess({
    command: options.codexBinary,
    args: ['login', '--with-api-key'],
    stdin: apiKey,
    timeoutMs: options.timeoutMs ?? 60_000,
    maxOutputBytes: 1024 * 1024,
  });

  if (result.spawnFailed) {
    throw new CodexMcpError(
      ErrorCodes.CODEX_NOT_INSTALLED,
      `Could not execute \`${options.codexBinary}\`: ${result.spawnError ?? 'unknown error'}`,
    );
  }

  return { code: result.code };
}

async function readKey(options: LoginOptions): Promise<string | undefined> {
  if (options.readSecretFromStdin) return options.readSecretFromStdin();
  return readStdin();
}

const CTRL_C = '';
const DELETE = '';

/**
 * Read a key from a pipe, or prompt for one with terminal echo disabled so it
 * never reaches the screen or scrollback.
 */
async function readStdin(): Promise<string | undefined> {
  const stdin = process.stdin;

  if (!stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of stdin) chunks.push(Buffer.from(chunk));
    const value = Buffer.concat(chunks).toString('utf8').trim();
    return value === '' ? undefined : value;
  }

  process.stderr.write('OpenAI API key (input hidden): ');
  const previouslyRaw = stdin.isRaw ?? false;
  stdin.setRawMode?.(true);
  stdin.resume();
  stdin.setEncoding('utf8');

  return new Promise<string | undefined>((resolvePromise) => {
    let buffer = '';
    const finish = (value: string | undefined): void => {
      stdin.removeListener('data', onData);
      stdin.setRawMode?.(previouslyRaw);
      stdin.pause();
      process.stderr.write('\n');
      resolvePromise(value);
    };
    const onData = (chunk: string): void => {
      for (const char of chunk) {
        if (char === '\r' || char === '\n') {
          finish(buffer.trim() === '' ? undefined : buffer.trim());
          return;
        }
        if (char === CTRL_C) {
          finish(undefined);
          return;
        }
        if (char === DELETE || char === '\b') {
          buffer = buffer.slice(0, -1);
          continue;
        }
        buffer += char;
      }
    };
    stdin.on('data', onData);
  });
}
