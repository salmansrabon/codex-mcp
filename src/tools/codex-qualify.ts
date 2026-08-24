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

Two optional inputs change the answer you get, so supply them when they apply:

- \`knownCoverage\` — coverage that already exists outside this artifact (an automated suite, a
  test-management pack). Without it the reviewer cannot tell "absent here" from "untested anywhere",
  and will ask for tests the project already runs.
- \`constraints.maxTestCases\` — a hard ceiling on the final artifact. With it, the reviewer answers
  "what is the strongest set of N" and names what each addition should displace, instead of handing
  back more cases than the artifact can hold.

Findings come back with their verification recorded: \`verificationStatus\` (CONFIRMED / PROVISIONAL /
HYPOTHESIS), the path the reviewer traced, the contradictions it searched for, separate evidence,
impact, and scope confidences, and \`objectionPriority\` (MUST_FIX / SHOULD_FIX / OPTIONAL). A
CONFIRMED label that is not backed by a recorded contradiction search is downgraded by codex-mcp
before you see it. OPTIONAL findings do not block acceptance.

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
