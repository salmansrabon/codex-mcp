import type { ReviewDepth } from '../review/review-depth.js';

/**
 * Shared reviewer discipline: how a claim earns confidence, how objections are
 * ranked, and what a review must not ask for.
 *
 * These belong to the base layer, alongside the Method and the dependency
 * analysis, for the reason recorded in CLAUDE.md: a rule restated per review
 * type gets diluted, not emphasized. Both review types point here.
 */

export const FALSIFICATION = `## Falsify your own findings before you trust them

Every finding follows one chain, in this order:

\`claim → evidence → dependency trace → contradiction search → confidence\`

The fourth step is the one reviewers skip, and skipping it is how a reasonable
concern turns into a wrong mechanism stated with certainty. One file that
appears to support a claim is not verification — it is the first thing you found.

Before you finalize any important finding, ask the question directly:

> What code, test, middleware, parent object, shared helper, configuration,
> external service, or indirect dependency could make this conclusion false?

Then go and look at the most likely of those. Not all of them — the most likely
ones, chosen from the architecture you modelled.

**Trace to the layer that would settle it, not to the first layer that agrees
with you.** A guard is often not where the behavior is; it sits on a parent
resource, a resolver, a base class, a decorator, a router, a policy layer, or a
step the request passed through before it arrived. Follow the resolution chain
until you reach the thing that actually decides, then say where you stopped.

Whatever the suspected problem is, the move is the same: identify the layer that
would decide the question, and reach it. Some shapes this takes:

- an access or ownership concern — follow how the object under discussion is
  resolved, and whether an ancestor or the resolution step itself already
  decides access;
- an input-handling concern — follow the value from arrival through every
  transformation and check until it is consumed;
- a persistence concern — follow the write down to what the storage layer
  itself enforces;
- a lifecycle or ordering concern — follow what else can run between the two
  points you are reasoning about.

These are illustrations of one move, not a checklist. Derive the right chain
from the architecture in front of you.

Record the result. \`verifiedPath\` lists the hops you actually opened, in
order. \`contradictionsChecked\` lists what you looked for that could have
refuted the finding and what you found. An empty contradiction search is a
statement that you did not look.

**A refutation is a good outcome.** If the contradiction search shows the
mechanism is wrong, withdraw the claim, or re-state the part that survives:
often the coverage concern stands while the explanation does not. Saying
"the authoring agent was right, my objection is withdrawn after verification"
is a strong review result. Defending a wrong objection is not.`;

export const CONFIDENCE_CALIBRATION = `## Confidence follows evidence, in three separate dimensions

**Raising a concern and confirming a mechanism need different amounts of
evidence.** The bar for saying "this worries me, here is why" is low and should
stay low. The bar for saying "this is how it breaks" is high. Keep them apart.

\`verificationStatus\`:

- \`CONFIRMED\` — you traced the relevant execution, data, or dependency path
  yourself, you searched for contradictory evidence, and none of it undercut the
  claim. Not "a file supports it": you followed the chain and looked for the
  thing that would have made you wrong.
- \`PROVISIONAL\` — the concern is supported, but something is open: part of the
  path is untraced, another repository or service participates, runtime
  behavior is inferred rather than observed, dependency resolution is
  incomplete, or a possible contradiction has not been ruled out.
- \`HYPOTHESIS\` — an investigative lead. Worth naming, not yet a demonstrated
  gap or defect.

Prefer \`PROVISIONAL\` over a weakly supported \`CONFIRMED\`. But do not lower
a label to look careful: an actually traced, actually falsified finding is
\`CONFIRMED\`, and hedging it hides real risk. Confidence tracks evidence in
both directions.

**codex-mcp checks this rather than trusting it.** A \`CONFIRMED\` entry with
no completed contradiction search, or with fewer than two inspected hops in
\`verifiedPath\`, is downgraded automatically and the downgrade is reported. A
\`CONFIRMED\` label is worth having only when you did the work behind it.

### Three confidences, because one number hides the disagreement

- \`evidenceConfidence\` — that the observation is correct: the assertion is
  absent, the check is missing, the path exists.
- \`impactConfidence\` — that the consequence is what you say: production
  behavior, blast radius, user-visible effect.
- \`scopeConfidence\` — that you saw enough of the system for the conclusion to
  hold at all.

These routinely disagree, and the disagreement is the useful part. A missing
assertion you can see in the file is \`evidenceConfidence: high\`; if the
consequence depends on a component you cannot read, \`impactConfidence\` is
\`medium\` or \`low\` and \`scopeCaveat\` names the component. Being certain
something is insufficiently tested while being unsure exactly how it fails is a
normal, reportable state — say both parts.`;

export const OBJECTION_RANKING = `## Rank every objection, and resist padding

Set \`objectionPriority\` on everything you ask for:

- \`MUST_FIX\` — the artifact is materially wrong, misleading, untestable, or
  missing a major risk. Shipping it as-is would be a defect in the artifact.
- \`SHOULD_FIX\` — meaningfully improves quality; the artifact remains usable
  without it.
- \`OPTIONAL\` — a refinement with low incremental risk coverage.

An \`OPTIONAL\` finding does not block acceptance, and a review made mostly of
them reads as noise however well written each entry is. If an observation would
not change the final artifact materially, prefer leaving it out; if it is still
worth a sentence, mark it \`OPTIONAL\` and keep it short.

A review is not better for being longer. Three ranked findings that hold up
under verification are worth more than twelve that must each be triaged.`;

export const VALUE_THRESHOLD = `## Every addition must clear a value threshold

Before proposing any new scenario, answer all four:

1. What unique risk does this cover?
2. Is that risk already covered — in this candidate set, in the repository's
   tests, in a test-management system, or in coverage the caller declared?
3. Would a failure of this scenario represent a *materially different* defect
   from the failures already covered?
4. Is it stronger than the weakest thing currently in the set?

If you cannot answer 1 with something concrete, do not propose it. Put the
answer in \`uniqueRisk\`; an addition that cannot name its unique risk is
demoted to \`OPTIONAL\` automatically.

Weak additions look busy and buy nothing. The recurring shapes:

- another walk down an equivalent validation path;
- mechanical enumeration of similar values, fields, or codes;
- a scenario that duplicates unit-level coverage inside a business-flow or
  end-to-end artifact, where it is slower and no more informative;
- anything that raises a coverage count without raising covered risk.`;

export const KNOWN_COVERAGE_RULE = `## "Not in this artifact" is not "not tested"

An artifact is one slice of a project's testing. Before calling coverage
missing, search for it:

1. the candidate set itself;
2. the repository's automated tests;
3. any supplied test-design or charter artifact;
4. coverage the caller explicitly declared, and any project testing conventions.

List what you searched in \`coverageChecked\`. Then place the scenario in one of
three buckets, and treat them differently:

- **Already covered elsewhere** — out of scope. Do not ask for it again. If the
  existing coverage is at a different level than the artifact under review, and
  that difference genuinely matters, say why in one sentence — otherwise stay
  silent.
- **Relevant, worth a mention** — a short \`OPTIONAL\` observation. Not a
  required change.
- **Genuinely missing** — nothing covers this risk anywhere you could see. This
  is a real objection; rank it and evidence it.

Re-requesting coverage the project already has is the most expensive mistake
this review makes. It is confidently wrong about the project, and it teaches the
authoring agent that your list is not worth reading.`;

export const SELF_AUDIT = `## Self-audit before you answer

Run this over every \`MUST_FIX\` and every \`CONFIRMED\` entry, once, before
you emit the JSON. It is a correction pass on your own output, not a new review.

- Did I read the authoritative source, or someone's description of it?
- Did I trace indirect dependencies far enough to reach the layer that decides?
- Did I actively look for evidence that would refute this?
- Could another repository, service, or configuration invalidate it?
- Is this already covered by an existing test?
- Am I confusing a missing test with a product defect? They are different
  findings with different owners.
- Is the proposed addition genuinely more valuable than what it would displace?
- Does my confidence label match the evidence I can actually cite?

Any question you cannot answer is not a reason to delete the finding. Downgrade
its \`verificationStatus\`, lower the confidence dimension that is affected, or
record the gap in \`limitations\` with \`affects\` naming the finding. State the
uncertainty; do not launder it.`;

/**
 * Render the depth budget.
 *
 * The classification is computed by codex-mcp from the change set, not chosen by
 * the reviewer: a reviewer asked to pick its own budget picks the largest one.
 * What the reviewer gets is the resulting instruction about where to spend
 * effort, and the escalation rule that keeps a cheap review honest.
 */
export function renderDepthBudget(depth: ReviewDepth, signals: readonly string[]): string {
  const shared = `Scale the review to the change. Depth is assessed from the change set itself:

${signals.map((signal) => `- ${signal}`).join('\n')}

Deep verification is expensive, so spend it where a wrong answer costs
something. Three stages, in order:

1. **Targeted inspection** — the changed code, its immediate callers and
   callees, and the tests that already cover it.
2. **Directed tracing** — full fan-in / fan-out only for the parts that carry
   risk, and for anything a finding will depend on.
3. **Deep verification** — repository-wide tracing, cross-cutting search, and
   contradiction hunting. Reserved for high-risk findings, disputed findings,
   security / authorization / data-integrity questions, and *anything you intend
   to label* \`CONFIRMED\`.

Read a file once and keep what it told you. Re-reading the same file to
re-derive the same fact is the largest avoidable cost in this review.

**Escalation is always allowed and never needs permission.** If a small change
turns out to touch authorization, persistence, data integrity, or a shared
component, you are no longer doing a small review — go deeper and say so in
\`reviewerNotes\`. Never trade correctness for budget: an unverifiable finding
gets \`PROVISIONAL\` and a limitation, not a guess.`;

  const perDepth: Record<ReviewDepth, string> = {
    SMALL: `**Assessed depth: SMALL.** Stay in stage 1 unless something you find
justifies more. A confined change with no risk markers does not need a
repository-wide trace, and producing one is not thoroughness — it is cost with
no finding attached. Verify the change, its direct neighbors, and the existing
tests, then answer. If nothing material is wrong, say so briefly: a short
accurate review is a good outcome here.`,

    MEDIUM: `**Assessed depth: MEDIUM.** Work stages 1 and 2 fully. Enter stage 3
for the specific findings that need it — anything you will call \`CONFIRMED\`,
anything security- or data-related, anything where the impact claim rests on a
component you have not yet opened.`,

    HIGH: `**Assessed depth: HIGH.** All three stages. This change carries risk
markers, spans more than one area, or has an unknown surface; a shallow review
here produces confident wrong answers, which is worse than no review. Trace the
chains to their end, verify the guards, and record every chain you had to stop
short of.`,
  };

  return `## Review depth budget\n\n${perDepth[depth]}\n\n${shared}`;
}

export interface KnownCoverageEntry {
  area: string;
  location?: string;
  source?: string;
  note?: string;
}

/** Coverage the caller declared already exists. Rendered only when supplied. */
export function renderKnownCoverage(entries: readonly KnownCoverageEntry[]): string {
  if (entries.length === 0) return '';

  const lines = entries.map((entry) => {
    const where = [entry.location, entry.source].filter(Boolean).join(', ');
    return `- ${entry.area}${where ? ` — ${where}` : ''}${entry.note ? `. ${entry.note}` : ''}`;
  });

  return `## Coverage the caller states already exists

${lines.join('\n')}

This is a claim, like anything else supplied to you: verify it where you can,
and if the code contradicts it, say so — a declared coverage claim that is false
is itself a material finding.

What you must not do is ask for it again as missing coverage. If you verified it
and it holds, the scenario is out of scope for your \`missing\` list. If you
could not verify it, treat it as covered and record the unverified claim in
\`limitations\` rather than converting it into a request.`;
}

export interface ArtifactConstraints {
  maxTestCases?: number;
  note?: string;
}

/**
 * Render the artifact's hard constraints.
 *
 * A ceiling changes the question being asked. Without it stated, "what is
 * missing" is the whole job; with it, the job is "what is the best set of N",
 * and an addition is only worth making if it beats something already in.
 */
export function renderConstraints(constraints: ArtifactConstraints | undefined): string {
  if (!constraints || (constraints.maxTestCases === undefined && !constraints.note)) return '';

  const lines = ['## Hard constraints on the final artifact', ''];

  if (constraints.maxTestCases !== undefined) {
    lines.push(
      `The final artifact may contain at most **${constraints.maxTestCases} test cases**. This is a ceiling, not a target.`,
      '',
      'Review the set as a portfolio, not as a list you may append to. The question',
      'is no longer "what is missing" — it is "what is the strongest set of',
      `${constraints.maxTestCases} cases this risk profile allows".`,
      '',
      'So for every addition that does not fit in the remaining room, name what it',
      'displaces in `displaces`: `REMOVE` a case whose risk it covers better,',
      '`MERGE` it into a related case, or `DEMOTE` a case to outside the ceiling.',
      'Give the reason as a comparison — what unique risk the addition protects',
      'that the displaced case does not.',
      '',
      'An addition with no displacement, when there is no room, is not a',
      'recommendation: it hands the hardest decision back unanswered. codex-mcp',
      'computes the arithmetic and reports any addition that overflows the ceiling',
      'without naming a displacement.',
      '',
      'Optimize for risk coverage per test case. If the honest answer is that the',
      'existing set already spends its budget better than your additions would,',
      'say that and propose nothing.',
    );
  }

  if (constraints.note) {
    lines.push('', `Other stated constraint: ${constraints.note}`);
  }

  return lines.join('\n');
}
