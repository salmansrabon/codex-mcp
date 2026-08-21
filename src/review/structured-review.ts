import type { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

import type { CodexRunner, CodexRunResult } from '../codex/codex-runner.js';
import type { BrokerLaunchSpec } from '../codex/command-builder.js';
import { CodexMcpError } from '../errors/codex-mcp-error.js';
import { ErrorCodes } from '../errors/codes.js';
import type { Logger } from '../util/logger.js';

export interface StructuredReviewRequest<T> {
  prompt: string;
  schema: z.ZodType<T, z.ZodTypeDef, unknown>;
  schemaName: string;
  projectRoot: string;
  broker?: BrokerLaunchSpec;
  timeoutMs: number;
  signal?: AbortSignal;
  logger: Logger;
  runner: CodexRunner;
}

export interface StructuredReviewOutcome<T> {
  result: T;
  run: CodexRunResult;
  repairAttempts: number;
}

/**
 * Run Codex and insist on schema-valid structured output (PLAN.md §20).
 *
 * Exactly one repair attempt: the retry tells Codex precisely which fields were
 * wrong and forbids re-running the analysis. If that also fails we raise
 * `CODEX_OUTPUT_INVALID` — a fabricated or partially-parsed review is worse than
 * an honest error, because the authoring agent would act on it.
 */
export async function runStructuredReview<T>(request: StructuredReviewRequest<T>): Promise<StructuredReviewOutcome<T>> {
  const jsonSchema = toJsonSchema(request.schema, request.schemaName);
  const promptWithSchema = `${request.prompt}\n\n${renderSchemaSection(request.schemaName, jsonSchema)}`;

  const first = await request.runner.run({
    prompt: promptWithSchema,
    projectRoot: request.projectRoot,
    ...(request.broker ? { broker: request.broker } : {}),
    timeoutMs: request.timeoutMs,
    ...(request.signal ? { signal: request.signal } : {}),
  });

  const firstAttempt = validate(request.schema, first);
  if (firstAttempt.ok) {
    return { result: firstAttempt.value, run: first, repairAttempts: 0 };
  }

  request.logger.warn('codex returned malformed review output; retrying once with schema correction', {
    schema: request.schemaName,
    problem: firstAttempt.problem,
  });

  const repairPrompt = buildRepairPrompt(
    request.schemaName,
    jsonSchema,
    first.finalMessage ?? '(no final message was produced)',
    firstAttempt.problem,
  );

  const second = await request.runner.run({
    prompt: repairPrompt,
    projectRoot: request.projectRoot,
    ...(request.broker ? { broker: request.broker } : {}),
    timeoutMs: request.timeoutMs,
    ...(request.signal ? { signal: request.signal } : {}),
  });

  const secondAttempt = validate(request.schema, second);
  if (secondAttempt.ok) {
    return { result: secondAttempt.value, run: second, repairAttempts: 1 };
  }

  throw new CodexMcpError(
    ErrorCodes.CODEX_OUTPUT_INVALID,
    'Codex did not return review output matching the required schema, including after one correction attempt. ' +
      'No review is returned rather than a fabricated one.',
    { details: { schema: request.schemaName, firstProblem: firstAttempt.problem, secondProblem: secondAttempt.problem } },
  );
}

type ValidationOutcome<T> = { ok: true; value: T } | { ok: false; problem: string };

function validate<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, run: CodexRunResult): ValidationOutcome<T> {
  if (run.json === undefined) {
    return { ok: false, problem: 'No JSON object could be extracted from the final message.' };
  }
  const parsed = schema.safeParse(run.json);
  if (parsed.success) return { ok: true, value: parsed.data };
  const problem = parsed.error.issues
    .slice(0, 12)
    .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
    .join('; ');
  return { ok: false, problem };
}

function toJsonSchema(schema: z.ZodType<unknown, z.ZodTypeDef, unknown>, name: string): unknown {
  return zodToJsonSchema(schema, { name, $refStrategy: 'none' });
}

function renderSchemaSection(name: string, jsonSchema: unknown): string {
  return `## Required output schema (${name})

Your entire response must be one JSON object valid against this schema.

\`\`\`json
${JSON.stringify(jsonSchema, null, 2)}
\`\`\``;
}

function buildRepairPrompt(name: string, jsonSchema: unknown, previous: string, problem: string): string {
  return `Your previous response was not valid against the required output schema.

Schema validation reported:
${problem}

Your previous response was:
--- BEGIN PREVIOUS RESPONSE ---
${previous.slice(0, 20_000)}
--- END PREVIOUS RESPONSE ---

Re-emit the SAME findings, corrected to satisfy the schema. Do not redo the
analysis, do not investigate further, do not change any verdict, and do not add
or drop findings. This is a formatting correction only.

Respond with exactly one JSON object. No prose, no markdown fences.

${renderSchemaSection(name, jsonSchema)}`;
}
