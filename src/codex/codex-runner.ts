import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Config } from '../config/config.js';
import { CodexMcpError } from '../errors/codex-mcp-error.js';
import { ErrorCodes } from '../errors/codes.js';
import type { Logger } from '../util/logger.js';
import { redactText } from '../util/redact.js';
import { buildCodexArgs, type BrokerLaunchSpec } from './command-builder.js';
import { parseCodexOutput, type ParsedCodexOutput } from './output-parser.js';
import { runProcess, type ProcessResult } from './process-runner.js';

export interface CodexRunRequest {
  prompt: string;
  projectRoot: string;
  broker?: BrokerLaunchSpec;
  timeoutMs: number;
  signal?: AbortSignal;
  /** JSON Schema for the final response; passed to Codex when supplied. */
  outputSchema?: unknown;
}

export interface CodexRunResult extends ParsedCodexOutput {
  exitCode: number | null;
  durationMs: number;
  timedOut: boolean;
  stderr: string;
}

export type CodexSpawn = (
  args: readonly string[],
  input: { prompt: string; cwd: string; timeoutMs: number; signal?: AbortSignal },
) => Promise<ProcessResult>;

export interface CodexRunnerOptions {
  config: Config;
  logger: Logger;
  /** Injectable spawn for tests and for the fake-CLI integration suite. */
  spawn?: CodexSpawn;
}

/**
 * Runs Codex as an ephemeral, read-only, non-interactive reviewer.
 *
 * The runner owns the temp files Codex needs (last-message sink, output schema)
 * and guarantees they are removed even when the run fails, so nothing about a
 * review outlives it.
 */
export class CodexRunner {
  private readonly config: Config;
  private readonly logger: Logger;
  private readonly spawn: CodexSpawn;

  constructor(options: CodexRunnerOptions) {
    this.config = options.config;
    this.logger = options.logger;
    this.spawn =
      options.spawn ??
      ((args, input) =>
        runProcess({
          command: this.config.codexBinary,
          args,
          cwd: input.cwd,
          stdin: input.prompt,
          timeoutMs: input.timeoutMs,
          ...(input.signal ? { signal: input.signal } : {}),
          env: {
            ...process.env,
            // Keep Codex non-interactive and quiet regardless of user config.
            NO_COLOR: '1',
            CI: '1',
          },
        }));
  }

  async run(request: CodexRunRequest): Promise<CodexRunResult> {
    const workDir = await mkdtemp(join(tmpdir(), 'codex-mcp-'));
    const lastMessageFile = join(workDir, 'last-message.txt');
    let outputSchemaFile: string | undefined;

    try {
      if (request.outputSchema) {
        outputSchemaFile = join(workDir, 'output-schema.json');
        await writeFile(outputSchemaFile, JSON.stringify(request.outputSchema), 'utf8');
      }

      const args = buildCodexArgs({
        config: this.config,
        projectRoot: request.projectRoot,
        lastMessageFile,
        ...(request.broker ? { broker: request.broker } : {}),
        ...(outputSchemaFile ? { outputSchemaFile } : {}),
      });

      this.logger.debug('invoking codex', {
        model: this.config.model ?? '(codex default)',
        sandbox: this.config.sandbox,
        ephemeral: this.config.ephemeral,
        broker: request.broker?.name ?? null,
        promptChars: request.prompt.length,
      });

      const result = await this.spawn(args, {
        prompt: request.prompt,
        cwd: request.projectRoot,
        timeoutMs: request.timeoutMs,
        ...(request.signal ? { signal: request.signal } : {}),
      });

      if (result.spawnFailed) {
        throw new CodexMcpError(
          ErrorCodes.CODEX_NOT_INSTALLED,
          `Could not execute \`${this.config.codexBinary}\`: ${redactText(result.spawnError ?? 'unknown error')}`,
        );
      }

      if (result.timedOut) {
        throw new CodexMcpError(
          ErrorCodes.REVIEW_TIMEOUT,
          `Codex did not finish within ${request.timeoutMs}ms and was terminated.`,
          { details: { timeoutMs: request.timeoutMs } },
        );
      }

      if (result.aborted) {
        throw new CodexMcpError(ErrorCodes.CODEX_EXECUTION_FAILED, 'The review was cancelled.');
      }

      const lastMessage = await readFileSafe(lastMessageFile);
      const parsed = parseCodexOutput(result.stdout, lastMessage);

      if (result.code !== 0) {
        this.assertNotModelError(result, parsed);
        throw new CodexMcpError(
          ErrorCodes.CODEX_EXECUTION_FAILED,
          `Codex exited with code ${result.code}. ${summarizeFailure(result, parsed)}`,
          { details: { exitCode: result.code, errors: parsed.errors.slice(0, 5).map(redactText) } },
        );
      }

      this.assertNotModelError(result, parsed);

      return {
        ...parsed,
        exitCode: result.code,
        durationMs: result.durationMs,
        timedOut: result.timedOut,
        stderr: redactText(result.stderr.slice(-4000)),
      };
    } finally {
      await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /**
   * Distinguish "your model name is wrong" from a generic failure. Silently
   * falling back to another model would violate PLAN.md §6, so this surfaces a
   * dedicated code and stops.
   */
  private assertNotModelError(result: ProcessResult, parsed: ParsedCodexOutput): void {
    const haystack = `${result.stderr}\n${parsed.errors.join('\n')}`.toLowerCase();
    const modelProblem =
      /\bmodel\b[^\n]*\b(not found|unknown|unsupported|not available|does not exist|invalid|unrecognized)\b/.test(haystack) ||
      /\b(unknown|unsupported|invalid) model\b/.test(haystack) ||
      // The CLI is too old for the requested model. Same user problem — the
      // model cannot be used — but it needs a different remedy than a typo.
      /\bmodel\b[^\n]*\brequires a newer version\b/.test(haystack);
    if (!modelProblem) return;

    const needsUpgrade = /\brequires a newer version\b/.test(haystack);
    throw new CodexMcpError(
      ErrorCodes.CODEX_MODEL_NOT_AVAILABLE,
      this.config.model
        ? `Codex rejected the configured model "${this.config.model}"${
            needsUpgrade ? ': the installed Codex CLI is too old for it. Run `codex update`, or configure a model this CLI supports.' : '.'
          } codex-mcp does not substitute a different model.`
        : 'Codex rejected the default model.',
      { details: { model: this.config.model ?? null, ...(needsUpgrade ? { remedy: 'upgrade-codex-cli' } : {}) } },
    );
  }
}

async function readFileSafe(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return undefined;
  }
}

function summarizeFailure(result: ProcessResult, parsed: ParsedCodexOutput): string {
  if (parsed.errors.length > 0) return redactText(parsed.errors[0] as string);
  const stderr = result.stderr.trim();
  if (stderr) return redactText(stderr.split('\n').slice(-3).join(' ').slice(0, 500));
  return 'No error detail was reported.';
}
