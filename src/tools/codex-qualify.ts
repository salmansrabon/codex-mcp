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

**A bug verdict never overturns you on an absence.** Verdicts are CONFIRMED, REFUTED, UNPROVEN,
CONFLICTING_EVIDENCE, INSUFFICIENT_SCOPE, SEVERITY_DISAGREEMENT, or DUPLICATE_OR_ALREADY_COVERED.
Only REFUTED says your finding is wrong, and it requires the reviewer to cite what it *found* that
makes the claim impossible — a refutation built on "I looked and found nothing" is downgraded to
UNPROVEN before you see it, and the downgrade is reported. Treat UNPROVEN, CONFLICTING_EVIDENCE, and
INSUFFICIENT_SCOPE as "still yours to resolve", not as clearance.

Two more things come back that you did not ask for:

- \`riskDiscovery\` — a second, independent Codex run that was never shown your candidate set,
  answering "what did the author miss". It carries an explicit release-blocker sweep across security,
  data integrity, business rules, migration, backward compatibility, and availability, plus the blast
  radius as an inspected-or-not coverage map. \`riskOverlap\` marks which of its findings are NEW.
  Turn it off with \`options.independentDiscovery: false\` if you only want the audit.
- \`bugs.citationChecks\` — every \`file:line\` you cited, resolved against the filesystem before
  the review ran. A citation that points at nothing is reported plainly; it does not make your
  finding false, but it does mean the reference needs fixing.

\`meta.evidence.scope.complete: false\` means the review is scope-limited: a repository this change
depends on could not be read, every confidence is capped, and the unreadable roots are named.

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
