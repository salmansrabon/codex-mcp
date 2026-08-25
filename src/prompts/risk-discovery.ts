import { RELEASE_BLOCKER_CLASSES } from '../schemas/review-common.js';
import { buildBasePrompt, OUTPUT_RULES, type PromptContext } from './base-reviewer.js';

/**
 * The independent-discovery prompt.
 *
 * It never contains the candidate set, and that omission is the whole design.
 * A reviewer holding a list of somebody else's findings spends its budget
 * adjudicating that list — the findings become the agenda, and the question
 * "what is not on this list" is answered, if at all, in whatever attention is
 * left over. Removing the list is the only reliable way to get an unanchored
 * answer, because no instruction to "derive independently first" survives
 * having the answer key in the context window.
 *
 * The two structured obligations here — the blocker sweep and the coverage map —
 * exist because their failure mode is silence. A reviewer that never considered
 * backward compatibility produces a report identical to one that considered it
 * and found nothing.
 */

export function buildRiskDiscoveryPrompt(context: PromptContext): string {
  return [buildBasePrompt(context), renderTask(), renderBlockerSweep(), renderCoverageMap(context), renderOutputContract(), OUTPUT_RULES].join(
    '\n\n',
  );
}

function renderTask(): string {
  return `## Your task: independent risk discovery

You are not reviewing anybody's work here. Nobody's findings, test cases, or bug
reports are in this prompt, and that is deliberate — you are the independent
half of a two-path review, and your value is entirely in what you find on your
own.

Derive, from the requirement, the diff, the implementation, the project's rules,
the tests, and the blast radius, what this change puts at risk.

Apply the Method and the fan-in / fan-out analysis above. Then answer, in order:

1. **What does this change actually do?** Not what the commit message says.
2. **What can reach the changed behavior, and what can it reach?** Trace both
   directions past the first hop.
3. **Where does it interact with something that was already fragile?** Shared
   utilities, implicit contracts, code with a comment explaining a workaround.
4. **What could make this feature unreleasable?** Work the sweep below.
5. **What high-impact failure is easy to miss here?** The one that does not show
   up in the diff — a caller two hops away, a migration that runs before the
   code deploys, a permission that is now checked in one path and not another.

A finding is worth reporting when a competent engineer, shown it, would change
something before shipping. Report the risk, not the observation: "this endpoint
has no test" is an observation; "an unauthenticated caller reaches the delete
path because the guard is applied in the router, not the handler, and this
change adds a second route to the same handler" is a finding.

Hold yourself to the same falsification standard as everything else here. A
release blocker you cannot trace is a HYPOTHESIS, and saying so is worth more
than an unverified alarm.`;
}

function renderBlockerSweep(): string {
  return `## The release-blocker sweep — every class, explicitly

Before you finish, answer for **each** class below. Return one \`blockerSweep\`
entry per class. There is no partial credit for silence: a class you skipped and
a class you cleared look identical in a report unless you say which happened.

${RELEASE_BLOCKER_CLASSES.map((blockerClass) => `- \`${blockerClass}\``).join('\n')}

For each:

- **applicable** — false only when the change genuinely cannot touch the class.
  "The diff has no SQL in it" is not enough on its own: a code change that alters
  what gets written is a data-integrity change without containing any SQL.
- **outcome** — \`no-blocker-found\` only after you inspected something; name what
  in \`inspected\`. \`not-inspected\` is an honest answer and is recorded as a gap.
  \`blocker-found\` must have a matching entry in \`findings\`.
- **detail** — what you looked at, or why the class cannot apply.

The two questions to ask yourself before returning:

> What could make this feature unreleasable?
>
> What high-impact failure might the author have completely missed?

If the honest answer to either is "I do not know", the sweep entry says
\`not-inspected\` and the limitation says why.`;
}

function renderCoverageMap(context: PromptContext): string {
  if (!context.artifacts.blastRadius.present) {
    return `## Coverage map

No blast-radius artifact was supplied, so \`coverageMap\` may be empty. Derive
the affected surface yourself as part of the dependency analysis; the absence of
an artifact is not the absence of a blast radius.`;
  }

  return `## Coverage map — turn the blast radius into a checklist

A blast-radius artifact was supplied. It is somebody's earlier analysis, so it is
a lead rather than evidence — but it is also a list of places this change can
reach, and an unvisited entry on that list is a hole in this review.

Return one \`coverageMap\` entry per component the blast radius names, **plus any
component it missed that your own dependency trace found**. For each, state:

- \`risk\` — judged from the code, not from what the artifact claimed.
- \`inspected\` — whether you actually opened it. Cite where in \`evidence\`.
- \`outcome\` — \`unreachable\` when the component lives outside every root you can
  read; that is a scope gap, not a clean result.

Do not return a conclusion while a high-risk component sits unvisited. Either
inspect it, or mark it \`not-inspected\` and say so — codex-mcp will report the
gap either way, and an unreported one is the failure this exists to prevent.`;
}

function renderOutputContract(): string {
  return `## Result semantics

- \`findings\` — risks you discovered. Each needs a mechanism, evidence, and a
  recommendation. Rank with \`objectionPriority\`; do not pad.
- \`releaseBlocking\` — true only if shipping as-is causes the failure. This is a
  narrower claim than \`severity: critical\` and should be rarer.
- \`blockerSweep\` — one entry per class, always.
- \`coverageMap\` — the blast radius as inspected reality.
- \`rulesApplied\` — every project rule you actually used, and what it decided. A
  finding that rests on a rule must name the rule here.
- \`limitations\` — what you could not reach. A repository you were told is
  unreadable belongs here by name.`;
}
