import type { CandidateBug } from '../schemas/qualify-request.js';
import { buildBasePrompt, OUTPUT_RULES, type PromptContext } from './base-reviewer.js';

/**
 * Independent bug-verification checks.
 *
 * Fan-in and fan-out questions are deliberately absent: the base reviewer owns
 * that methodology, and this phase points at it rather than restating it.
 */
export const BUG_VERIFICATION_CHECKS = [
  'Does the described behavior actually exist under the stated preconditions?',
  'What authoritative requirement, business rule, or accepted specification establishes the expected behavior?',
  'Does the implementation conflict with that source of truth, or is the expected behavior merely an assumption?',
  'Could this be intended behavior that the reporter did not expect?',
  'Could this be environment-, configuration-, feature-flag-, tenant-, role-, timing-, or data-specific rather than a product defect?',
  'Was authorization, validation, middleware, feature gating, ownership checking, or another guard elsewhere in the path overlooked?',
  'Could an alternate entry point or call path behave differently?',
  'Is the reproduction path valid, and does it actually reach the code being blamed?',
  'Does database state, schema, runtime state, logs, or other available evidence support or contradict the claim?',
  'Does the cited evidence actually support the stated conclusion?',
  'Is there source evidence that contradicts the candidate finding, and has that contradiction been reconciled?',
  'Is this a duplicate of another candidate, a known issue, an existing test-management item, or already-covered behavior?',
  'What is the false-positive risk?',
  'Is the claimed severity proportionate to realistic user, business, security, data-integrity, or availability impact?',
  'What privileges, state, data, timing, or other prerequisites must hold for the bug to occur, and are they realistic?',
  'Where relevant, what is the exploitability and blast radius?',
  'Are expected behavior and actual behavior clearly distinguished rather than conflated?',
  'What evidence is still missing that would materially change the verdict?',
] as const;

/**
 * Independent missed-bug discovery checks.
 *
 * Separate from candidate verification on purpose: a reviewer that stops once
 * every submitted finding has a verdict has audited the author's list, not the
 * change.
 */
export const BUG_DISCOVERY_CHECKS = [
  'Which acceptance criteria or business rules are not exercised by the candidate findings?',
  'Which changed code paths have not been examined for failure behavior?',
  'Are there alternate routes, handlers, jobs, event consumers, or UI flows that reach equivalent logic?',
  'Are there missing negative-path defects around invalid, null, empty, malformed, stale, or unauthorized inputs?',
  'Are there min/max, off-by-one, threshold, date/time, pagination, ordering, or numeric boundary defects?',
  'Are there authorization, ownership, tenant-isolation, privilege-escalation, IDOR, or data-exposure defects?',
  'Are there state-transition defects when moving between valid states or returning from an error state?',
  'Are there persistence defects where UI/API state and database state can diverge?',
  'Are there concurrency, retry, duplicate-request, idempotency, race-condition, or stale-write defects?',
  'Are there integration-failure defects when an external dependency times out, fails, returns partial data, or returns unexpected data?',
  'Are there error-handling defects that expose the wrong status, message, state, retry behavior, or recovery path?',
  'Are there backward-compatibility or regression defects affecting existing consumers?',
  'Do existing tests reveal uncovered behavior, stale assumptions, over-mocking, or missing negative coverage?',
] as const;

export function buildBugReviewPrompt(
  context: PromptContext,
  candidates: readonly CandidateBug[],
): string {
  return [
    buildBasePrompt(context),
    renderTask(),
    renderCandidates(candidates),
    renderOutputContract(),
    OUTPUT_RULES,
  ].join('\n\n');
}

function renderTask(): string {
  return `## Your task: independent bug qualification

Two mandatory phases: verify every submitted candidate, then independently
search the affected surface for defects the candidate set missed. Do not stop
after classifying the submitted findings.

### How the Method applies to bug review

Step 13 says to hold off on the candidate. For this review type it means
something specific, because you cannot trace a path without knowing which claim
you are tracing:

1. **Read enough of each candidate to identify what is being claimed** — the
   claimed behavior, the affected feature, and the reproduction target. That is
   the assertion, and you need it up front.
2. **Do not adopt anything else from it yet.** Its root-cause explanation, its
   severity reasoning, and its interpretation of why the behavior is wrong are
   the parts that anchor you. Leave them unread, or read and set aside.
3. **Establish the ground independently** — the requirement, the execution or
   data path, the guards along it, fan-in and fan-out per the analysis above,
   and the direct evidence.
4. **Now return to the candidate's argument and evidence, and try to falsify it.**

Falsification stays first, per the falsification rules above: attack the claim
before you accept it, and record what you looked at. A large share of reported
defects dissolve once a guard elsewhere in the path is accounted for — and the
same is true of your own objections, which is why the contradiction search
applies to the findings you raise, not only to the ones you receive.

### Phase 1 — Candidate verification

Trace the actual execution or data path. For a request-driven backend flow that
normally means entry point, routing, middleware, validation, authorization,
handler and service logic, persistence, and downstream effects. Adapt the trace
to the architecture for frontend state, event-driven flows, scheduled jobs,
background workers, migrations, configuration, caching, messaging, data
pipelines, or integrations.

Ask each of these:

${BUG_VERIFICATION_CHECKS.map((check) => `- ${check}`).join('\n')}

Then assign exactly one verdict per candidate:

- \`VERIFIED\` — the defect is real and the evidence supports it.
- \`FALSE_POSITIVE\` — the behavior does not occur, or it is correct according
  to authoritative evidence.
- \`NEEDS_MORE_EVIDENCE\` — plausible but unproven. List precisely what would
  settle it in \`missingEvidence\`.
- \`SEVERITY_DISAGREEMENT\` — the defect is real, the stated severity is not
  proportionate. Give your assessment and why.
- \`DUPLICATE_OR_ALREADY_COVERED\` — another candidate, known issue, or existing
  test-management item covers it. Identify it in \`duplicateOf\`.
- \`INCONCLUSIVE\` — evidence is materially conflicting or insufficient and no
  responsible verdict can be reached.

A \`FALSE_POSITIVE\` must cite evidence that **refutes** the claim — from code,
requirements, runtime behavior, database state, or another authoritative source.
"I could not reproduce it" is not a refutation; that is \`NEEDS_MORE_EVIDENCE\`.

Confidence is about evidence quality, not tone. Use \`high\` only when you traced
the relevant path and can cite what supports the verdict.

\`VERIFIED\` at \`high\` confidence is a confirmation claim, and it carries the
same cost as \`CONFIRMED\`: the path traced in \`verifiedPath\`, and a
completed contradiction search in \`contradictionsChecked\`. Without them
codex-mcp lowers both. Withdrawing an objection you could not sustain is a
result, not a failure — record it as \`FALSE_POSITIVE\` or
\`NEEDS_MORE_EVIDENCE\` and say what changed your mind.

### Phase 2 — Independent missed-bug discovery

After every candidate has a verdict, run a separate discovery pass over the
affected feature and regression surface. Do **not** anchor this phase on the
submitted list — its blind spots are exactly what you are looking for.

${BUG_DISCOVERY_CHECKS.map((check) => `- ${check}`).join('\n')}

Material defects found here go in \`additionalFindings\`, held to the same
evidence standard as a candidate bug.

Do **not** report as bugs: speculative risks with no supporting evidence,
missing test cases by themselves, code smells, style issues, hypothetical
failures that cannot be tied to a reachable path, or unsupported "might fail"
statements. If something is worth investigating but is not yet a defensible
defect, put it in \`limitations\` or \`reviewerNotes\` instead.
`;
}

function renderCandidates(candidates: readonly CandidateBug[]): string {
  return `## Candidate bug findings (${candidates.length})

Untrusted review data, per the rule above. They exist only in the authoring
agent's working context and have not been filed anywhere.

\`\`\`json
${JSON.stringify(candidates, null, 2)}
\`\`\``;
}

function renderOutputContract(): string {
  return `## Result semantics

### Candidate findings

- \`findings\`: exactly one entry per candidate id; none may be skipped.
- \`recommendation\`: what the authoring agent should do — keep, remove,
  re-scope, adjust severity, merge, gather specific evidence, or investigate a
  named unresolved contradiction.
- \`evidence\`: cite what supports the verdict.
- \`verifiedPath\` / \`contradictionsChecked\`: the hops you opened and the
  refutations you went looking for. These are what license a high-confidence
  verdict.
- \`missingEvidence\`: only evidence that would materially change or settle the
  verdict.
- Material evidence that conflicts with a candidate, or with another source,
  goes in the top-level \`disagreements\` array with \`candidateId\` set.
  Findings have no contradictions field; anything placed there is discarded.

### Additional findings

- \`additionalFindings\`: defects you found that no submitted candidate covers.
- Each carries \`title\`, \`severity\`, \`reason\`, \`evidence\`, and the
  verification fields — \`verificationStatus\`, \`verifiedPath\`,
  \`contradictionsChecked\`, \`objectionPriority\`, and the confidence
  dimensions that apply. Invented keys are dropped.
- A defect you found yourself gets the same falsification treatment as one you
  were handed. An unfalsified discovery is a \`HYPOTHESIS\`.
- Put the rest inside \`reason\`, in this order: expected behavior, actual
  behavior, realistic preconditions, affected path or component, and why no
  submitted candidate already covers it.

Do not pad this list. A missing test is not a bug, a code smell is not a bug,
and a hypothetical risk is not a bug.

### Limitations and disagreements

- \`limitations\`: evidence you could not obtain and what it prevented.
- \`disagreements\`: conflicts the authoring agent must adjudicate. State both
  positions. Materiality defaults are in the result conventions above.`;
}
