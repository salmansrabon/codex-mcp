import type { CandidateTestCase } from '../schemas/qualify-request.js';
import { buildBasePrompt, OUTPUT_RULES, type PromptContext } from './base-reviewer.js';

/** Coverage dimensions from PLAN.md §10.1, in the order a reviewer should walk them. */
export const TEST_DESIGN_DIMENSIONS = [
  'requirement coverage',
  'acceptance criteria',
  'changed contracts (API shapes, event payloads, DB columns)',
  'happy path',
  'failure paths',
  'boundaries',
  'null / empty / invalid values',
  'state transitions',
  'persistence',
  'retries',
  'idempotency',
  'concurrency',
  'authorization',
  'role access',
  'tenant isolation',
  'upstream and downstream dependencies',
  'integration behavior',
  'regression risk',
  'error handling',
] as const;

/** Quality problems to look for *within* the candidate set. */
export const TEST_QUALITY_CHECKS = [
  'test redundancy — two cases exercising the same state and contract',
  'weak assertions — asserting a call happened rather than the observable outcome',
  'implementation-coupled assertions — asserting internals that may change without behavior changing',
  'overlap with existing tests already in the repository',
  'missing high-value scenarios',
] as const;

export function buildTestDesignPrompt(context: PromptContext, candidates: readonly CandidateTestCase[]): string {
  return [
    buildBasePrompt(context),
    renderTask(),
    renderCandidates(candidates),
    renderOutputContract(),
    OUTPUT_RULES,
  ].join('\n\n');
}

function renderTask(): string {
  return `## Your task: test-design review

Work through steps 1–9 of the Method before you look closely at the candidate set.

**Step 9 — derive expected coverage independently.** For the change under review,
determine what a competent test suite must cover. Walk these dimensions and, for
each, decide whether it is in scope for *this* change and what specifically must
be verified:

${TEST_DESIGN_DIMENSIONS.map((dimension) => `- ${dimension}`).join('\n')}

A dimension being listed does not make it relevant. Judge relevance from the
code and the requirement; a review that demands concurrency tests for a static
copy change is noise.

**Step 10 — compare.** Only now read the candidate test cases and reconcile:

- **accepted** — the candidate is correct and pulls its weight. List its id.
- **modify** — the candidate targets something real but is wrong, weak, or
  contradicted by the implementation. Say precisely what is wrong and cite it.
- **remove** — the candidate is redundant against another candidate or an
  existing test, or verifies nothing meaningful. Name what supersedes it.
- **missing** — coverage your independent analysis requires that no candidate
  provides. Cite the code that creates the risk.

Also check quality within the candidate set:

${TEST_QUALITY_CHECKS.map((check) => `- ${check}`).join('\n')}

Do not manufacture findings to look thorough. If the candidate set is genuinely
adequate, return status \`PASS\` with everything in \`accepted\` and an empty
\`missing\`. An unnecessary objection costs the authoring agent real time and
teaches it to ignore you.`;
}

function renderCandidates(candidates: readonly CandidateTestCase[]): string {
  return `## Candidate test cases (${candidates.length})

These exist only in the authoring agent's memory. They have not been written to
any report, and you are not writing one either.

\`\`\`json
${JSON.stringify(candidates, null, 2)}
\`\`\``;
}

function renderOutputContract(): string {
  return `## Result semantics

- \`status\`: \`PASS\` when no change is required; \`CHANGES_REQUIRED\` when any
  entry appears in modify, remove, or missing; \`INCONCLUSIVE\` when missing
  evidence prevented you from forming a view on material parts of the change.
- \`accepted\`: candidate ids only.
- \`summary\`: counts matching the array lengths.
- \`disagreements\`: where you and the candidate reach opposite conclusions from
  the same evidence and the authoring agent must adjudicate. State both positions.
- \`limitations\`: what you could not verify and how it constrains the review.

Every entry in \`modify\`, \`remove\`, and \`missing\` needs at least one evidence
reference with a concrete location.`;
}
