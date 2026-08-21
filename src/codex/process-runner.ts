import { spawn, type SpawnOptions } from 'node:child_process';

export interface RunProcessOptions {
  command: string;
  args?: readonly string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Written to stdin then closed. Omit to leave stdin empty. */
  stdin?: string;
  timeoutMs?: number;
  /** Abort mid-flight; maps to the same kill path as a timeout. */
  signal?: AbortSignal;
  /** Cap captured output so a runaway process cannot exhaust memory. */
  maxOutputBytes?: number;
  /** Called with each stdout chunk as it arrives, for streaming parsers. */
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
  /** Attach a terminal for interactive flows such as `codex login`. */
  inheritStdio?: boolean;
}

export interface ProcessResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
  durationMs: number;
  /** True when the binary could not be found or started at all. */
  spawnFailed: boolean;
  spawnError?: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}

const DEFAULT_MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
const KILL_GRACE_MS = 5_000;

/**
 * Spawn a child process and collect its output.
 *
 * Never throws for a non-zero exit: callers decide what an exit code means.
 * It only rejects if the runtime itself misbehaves. Timeout and abort escalate
 * SIGTERM -> SIGKILL so a wedged Codex process cannot pin the server.
 */
export function runProcess(options: RunProcessOptions): Promise<ProcessResult> {
  const {
    command,
    args = [],
    cwd,
    env,
    stdin,
    timeoutMs,
    signal,
    maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
    onStdout,
    onStderr,
    inheritStdio = false,
  } = options;

  return new Promise<ProcessResult>((resolve) => {
    const startedAt = Date.now();
    const spawnOptions: SpawnOptions = {
      cwd,
      env: env ?? process.env,
      stdio: inheritStdio ? 'inherit' : ['pipe', 'pipe', 'pipe'],
      // Own process group so we can kill descendants Codex may have spawned.
      detached: !inheritStdio && process.platform !== 'win32',
    };

    const child = spawn(command, [...args], spawnOptions);

    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;
    let aborted = false;
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;
    let timeoutTimer: NodeJS.Timeout | undefined;

    const cleanup = (): void => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      if (signal) signal.removeEventListener('abort', onAbort);
    };

    const finish = (result: Omit<ProcessResult, 'durationMs'>): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ ...result, durationMs: Date.now() - startedAt });
    };

    const killTree = (sig: NodeJS.Signals): void => {
      try {
        if (spawnOptions.detached && typeof child.pid === 'number') {
          process.kill(-child.pid, sig);
        } else {
          child.kill(sig);
        }
      } catch {
        // Process already gone.
      }
    };

    const terminate = (): void => {
      killTree('SIGTERM');
      killTimer = setTimeout(() => killTree('SIGKILL'), KILL_GRACE_MS);
      killTimer.unref?.();
    };

    function onAbort(): void {
      aborted = true;
      terminate();
    }

    if (signal) {
      if (signal.aborted) {
        aborted = true;
        // Terminate on next tick; the child may not exist yet.
        setImmediate(terminate);
      } else {
        signal.addEventListener('abort', onAbort, { once: true });
      }
    }

    if (typeof timeoutMs === 'number' && timeoutMs > 0) {
      timeoutTimer = setTimeout(() => {
        timedOut = true;
        terminate();
      }, timeoutMs);
      timeoutTimer.unref?.();
    }

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      onStdout?.(chunk);
      stdoutBytes += Buffer.byteLength(chunk);
      if (stdoutBytes <= maxOutputBytes) stdout += chunk;
      else stdoutTruncated = true;
    });

    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      onStderr?.(chunk);
      stderrBytes += Buffer.byteLength(chunk);
      if (stderrBytes <= maxOutputBytes) stderr += chunk;
      else stderrTruncated = true;
    });

    child.on('error', (err) => {
      finish({
        code: null,
        signal: null,
        stdout,
        stderr,
        timedOut,
        aborted,
        spawnFailed: true,
        spawnError: err.message,
        stdoutTruncated,
        stderrTruncated,
      });
    });

    child.on('close', (code, sig) => {
      finish({
        code,
        signal: sig,
        stdout,
        stderr,
        timedOut,
        aborted,
        spawnFailed: false,
        stdoutTruncated,
        stderrTruncated,
      });
    });

    if (!inheritStdio) {
      if (child.stdin) {
        child.stdin.on('error', () => {
          // The child may exit before consuming stdin; not our problem.
        });
        if (stdin !== undefined) child.stdin.end(stdin);
        else child.stdin.end();
      }
    }
  });
}
