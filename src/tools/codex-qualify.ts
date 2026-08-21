import { zodToJsonSchema } from 'zod-to-json-schema';

import type { ReviewOrchestrator } from '../review/review-orchestrator.js';
import { QualifyRequestSchema } from '../schemas/qualify-request.js';

export const CODEX_QUALIFY_TOOL_NAME = 'codex_qualify';

export const CODEX_QUALIFY_DESCRIPTION = `Independently qualify candidate test cases and/or bug findings before you write your final artifact.

Send the candidate result you are holding in memory — do not write it to a file first, and do not
call this after the report is published. codex-mcp runs Codex as a separate reviewer that inspects
the repository itself, derives its own expected coverage or verdict, and only then compares that
against your candidate. It returns a review delta.

What comes back is a second opinion, not a ruling. Verify each objection against the cited evidence:
apply the ones the evidence supports, reject the ones it does not and record why, investigate the
rest. You own the final artifact; codex-mcp never writes it.

The reviewer is strictly read-only: it cannot edit files, commit, push, modify issues, or write to
any database or external system.

Required: reviewType, project.root, and a matching candidate set. Everything else — task context,
blast-radius, test-charter, connectors — is optional and never blocks a review.`;

export function qualifyInputSchema(): Record<string, unknown> {
  const schema = zodToJsonSchema(QualifyRequestSchema, {
    name: 'QualifyRequest',
    $refStrategy: 'none',
  }) as Record<string, unknown>;

  const definitions = schema['definitions'] as Record<string, unknown> | undefined;
  const body = (definitions?.['QualifyRequest'] as Record<string, unknown> | undefined) ?? schema;
  return { ...body, type: 'object' };
}

export async function handleCodexQualify(
  orchestrator: ReviewOrchestrator,
  args: unknown,
  signal?: AbortSignal,
): Promise<unknown> {
  return orchestrator.qualify(args, signal);
}
