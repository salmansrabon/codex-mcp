import type { CandidateBug } from '../schemas/qualify-request.js';
import { buildBasePrompt, OUTPUT_RULES, type PromptContext } from './base-reviewer.js';

/** Verification questions from PLAN.md §10.2. */
export const BUG_VERIFICATION_CHECKS = [
  'Does the described behavior actually exist in the code as written?',
  'Does the requirement say the behavior is incorrect, or is the "expected" behavior an assumption?',
  'Was authorization, validation, or middleware elsewhere in the call path overlooked?',
  'Is the reproduction path valid, and does it reach the code being blamed?',
  'Does database state support or contradict the claim?',
  'Does the cited evidence actually support the stated conclusion?',
  'Is this a duplicate of another candidate finding, a known issue, or already-covered behavior?',
  'What is the false-positive risk?',
  'Is the claimed severity proportionate to real impact?',
  'What prerequisites must hold for the bug to occur, and are they realistic?',
  'Where relevant, what is the exploitability or blast radius?',
  'Are expected and actual behavior distinguished, or conflated?',
  'What evidence is missing that would settle the question?',
] as const;

export function buildBugReviewPrompt(context: PromptContext, candidates: readonly CandidateBug[]): string {
  return [
    buildBasePrompt(context),
    renderTask(),
    renderCandidates(candidates),
    renderOutputContract(),
    OUTPUT_RULES,
  ].join('\n\n');
}

function renderTask(): string {
  return `## Your task: bug-finding verification

Work through steps 1–9 of the Method before forming a verdict.

For each candidate finding, try to **falsify it first**. Trace the actual call
path in the code: entry point, routing, middleware, validation, authorization,
the handler, and persistence. A large share of reported defects dissolve once a
guard somewhere else in the path is accounted for.

Ask each of these:

${BUG_VERIFICATION_CHECKS.map((check) => `- ${check}`).join('\n')}

Then assign exactly one verdict per candidate:

- \`VERIFIED\` — the defect is real and the evidence supports it.
- \`FALSE_POSITIVE\` — the behavior does not occur, or it is correct. Cite the
  code that refutes the claim.
- \`NEEDS_MORE_EVIDENCE\` — plausible but unproven. List precisely what evidence
  would settle it in \`missingEvidence\`.
- \`SEVERITY_DISAGREEMENT\` — the defect is real, the stated severity is not.
  Give your assessment and the reasoning.
- \`DUPLICATE_OR_ALREADY_COVERED\` — another candidate or a known issue covers
  it. Name it in \`duplicateOf\`.
- \`INCONCLUSIVE\` — you could not reach a view; explain what blocked you.

If your independent inspection surfaces a defect the candidate set missed, put
it in \`additionalFindings\` with evidence. Do not pad this list: only report
what you can point at in the code or data.

Confidence is about your evidence, not your tone. Use \`high\` only when you
traced the actual path and can cite it.`;
}

function renderCandidates(candidates: readonly CandidateBug[]): string {
  return `## Candidate bug findings (${candidates.length})

These exist only in the authoring agent's memory and have not been filed
anywhere. Do not file, comment on, or transition anything.

\`\`\`json
${JSON.stringify(candidates, null, 2)}
\`\`\``;
}

function renderOutputContract(): string {
  return `## Result semantics

- \`status\`: \`PASS\` when every candidate is \`VERIFIED\` with no severity
  disagreement; \`CHANGES_REQUIRED\` when any finding needs the authoring agent
  to act; \`INCONCLUSIVE\` when missing evidence blocked material verdicts.
- \`findings\`: exactly one entry per candidate id, none skipped.
- \`recommendation\`: what the authoring agent should do — keep, remove,
  re-scope, gather specific evidence, or merge into another finding.
- \`limitations\`: evidence you could not obtain and what it prevented.

Every \`FALSE_POSITIVE\` verdict must cite the specific code that refutes the
claim. "I could not reproduce it" is \`NEEDS_MORE_EVIDENCE\`, not a refutation.`;
}
