import { z } from 'zod';

/** Shared vocabulary for both review result shapes (PLAN.md §13.3). */
export const ReviewStatusSchema = z.enum(['PASS', 'CHANGES_REQUIRED', 'INCONCLUSIVE', 'ERROR']);
export type ReviewStatus = z.infer<typeof ReviewStatusSchema>;

export const ConfidenceSchema = z.enum(['low', 'medium', 'high']);
export type Confidence = z.infer<typeof ConfidenceSchema>;
export const PrioritySchema = z.enum(['low', 'medium', 'high', 'critical']);

/**
 * Whether a severity or priority is settled, or still conditional on evidence
 * the reviewer could not reach.
 *
 * Downgrading a severity because scope was incomplete is the wrong correction:
 * definitive evidence of unauthenticated RCE in the code you *can* read is
 * critical whether or not you saw the frontend. What is uncertain is the impact
 * assessment, not the finding. So the severity stays as the available evidence
 * justifies it, and the uncertainty is recorded beside it.
 */
export const SeverityStatusSchema = z.enum(['CONFIRMED', 'PROVISIONAL']);
export type SeverityStatus = z.infer<typeof SeverityStatusSchema>;

/**
 * How well the *mechanism* of a finding is established, as opposed to how bad
 * its impact would be.
 *
 * Separate from `severityStatus` on purpose. A reviewer can be certain a
 * scenario is untested (`CONFIRMED` evidence) while being wrong about why it
 * breaks, and the evaluation that motivated this field failed exactly there: an
 * incomplete dependency trace was reported as a settled mechanism.
 *
 * The default is deliberately the *weaker* value. Silence must not buy
 * confidence — a reviewer that never mentions a contradiction search has not
 * done one, and the gate in `verification-gate.ts` treats it that way.
 */
export const VerificationStatusSchema = z.enum(['CONFIRMED', 'PROVISIONAL', 'HYPOTHESIS']);
export type VerificationStatus = z.infer<typeof VerificationStatusSchema>;

/**
 * What the review established about a claim someone else made.
 *
 * The five values exist because the previous three collapsed two very different
 * outcomes into one. "I looked and found the guard that makes this impossible"
 * and "I looked and found nothing either way" were both reported as
 * FALSE_POSITIVE, so a reviewer with incomplete access could overturn a correct
 * finding by failing to find its evidence. Absence of proof was being spent as
 * proof of absence.
 *
 * - `CONFIRMED` — the mechanism was traced and survived a contradiction search.
 * - `REFUTED` — **positive contradictory evidence** establishes the claim false.
 *   Not "unsupported"; something was found that makes the claim impossible.
 * - `UNPROVEN` — looked, found neither support nor contradiction. The claim
 *   stands unverified; the author keeps it.
 * - `CONFLICTING_EVIDENCE` — support and contradiction were both found. A human
 *   has to adjudicate; the reviewer must not pick a side by itself.
 * - `INSUFFICIENT_SCOPE` — the evidence that would settle it lives somewhere the
 *   reviewer could not reach.
 *
 * Only `REFUTED` overturns the author. It is the only value the gate demands
 * positive evidence for, and the only one it will silently take away.
 */
export const ClaimStatusSchema = z.enum([
  'CONFIRMED',
  'REFUTED',
  'UNPROVEN',
  'CONFLICTING_EVIDENCE',
  'INSUFFICIENT_SCOPE',
]);
export type ClaimStatus = z.infer<typeof ClaimStatusSchema>;

/** The claim statuses that leave the author's finding standing. */
export const NON_OVERTURNING_CLAIM_STATUSES: readonly ClaimStatus[] = [
  'UNPROVEN',
  'CONFLICTING_EVIDENCE',
  'INSUFFICIENT_SCOPE',
];

/**
 * What the authoring agent must actually do about an objection.
 *
 * Ranking exists so a report cannot be padded into significance. `OPTIONAL`
 * entries are observations; on their own they do not block acceptance, which is
 * enforced in the status derivation rather than left to prose.
 */
export const ObjectionPrioritySchema = z.enum(['MUST_FIX', 'SHOULD_FIX', 'OPTIONAL']);
export type ObjectionPriority = z.infer<typeof ObjectionPrioritySchema>;

export const EvidenceSchema = z.object({
  source: z.string().min(1),
  location: z.string().min(1),
  note: z.string().optional(),
});
export type Evidence = z.infer<typeof EvidenceSchema>;

/**
 * One recorded attempt to disprove the reviewer's own claim.
 *
 * This is the evidence that falsification happened. It is a first-class field
 * rather than prose because it has to be machine-checkable: `CONFIRMED` is
 * granted by the gate only when at least one of these came back
 * `no-contradiction-found`, so an unfalsified claim cannot present itself as a
 * verified one.
 */
export const ContradictionCheckSchema = z.object({
  checked: z
    .string()
    .min(1)
    .describe('The candidate refutation you looked for, e.g. "a guard on the parent resource that already blocks this".'),
  where: z.string().optional().describe('Where you looked: file, directory, test file, connector, or service.'),
  outcome: z
    .enum(['no-contradiction-found', 'weakens', 'refutes', 'unresolved'])
    .describe(
      'no-contradiction-found: looked and the claim survived. weakens: partly undermines it. ' +
        'refutes: something you FOUND makes the claim impossible — not merely absent support. ' +
        'unresolved: could not reach the evidence.',
    ),
  detail: z.string().optional(),
  /**
   * What was found that contradicts the claim.
   *
   * Load-bearing for `refutes`, and the gate enforces it: a refutation with no
   * cited contradictory evidence is a failed search wearing a verdict's
   * clothes. "I could not find support" is `unresolved`, never `refutes`.
   */
  contradictoryEvidence: z
    .array(EvidenceSchema)
    .default([])
    .describe('Required for outcome "refutes": the code, test, config, or record that makes the claim false.'),
});
export type ContradictionCheck = z.infer<typeof ContradictionCheckSchema>;

/** Fields any severity- or priority-bearing entry carries. */
export const SeverityQualifierShape = {
  severityStatus: SeverityStatusSchema.default('CONFIRMED').describe(
    'PROVISIONAL when a component you could not inspect could materially change the impact.',
  ),
  impactConfidence: ConfidenceSchema.optional().describe(
    'Confidence in the impact assessment specifically, as distinct from confidence that the finding is real.',
  ),
  scopeCaveat: z
    .string()
    .optional()
    .describe('What you could not inspect that could change the impact. Required reading when severityStatus is PROVISIONAL.'),
} as const;

/**
 * Fields that record *how the conclusion was reached*, carried by every entry a
 * reader might act on.
 *
 * The three confidence dimensions are split because collapsing them is what
 * produces a confident wrong answer. "This path is untested" and "this is why
 * production breaks" are different claims with different evidence, and a single
 * `confidence` value silently reports the weaker one at the strength of the
 * stronger.
 */
export const VerificationShape = {
  verificationStatus: VerificationStatusSchema.default('PROVISIONAL').describe(
    'CONFIRMED only when you traced the relevant path AND searched for contradictions and found none. ' +
      'PROVISIONAL when part of the path, another repository, or runtime behavior is unverified. ' +
      'HYPOTHESIS when this is an investigative lead rather than a demonstrated gap or defect.',
  ),
  verifiedPath: z
    .array(z.string())
    .default([])
    .describe(
      'The hops you actually inspected, in order, e.g. ["routes/x.ts:12", "services/y.ts:40", "policy/z.ts:88"]. ' +
        'One file is not a trace. Name only hops you opened.',
    ),
  contradictionsChecked: z
    .array(ContradictionCheckSchema)
    .default([])
    .describe('What you looked at that could have made this finding false, and what you found. Required for CONFIRMED.'),
  evidenceConfidence: ConfidenceSchema.optional().describe(
    'Confidence that the observation itself is correct — the assertion is absent, the check is missing, the path exists.',
  ),
  scopeConfidence: ConfidenceSchema.optional().describe(
    'Confidence that you saw enough of the system for this conclusion to hold, e.g. low when another repository participates.',
  ),
} as const;

/**
 * What a verdict must produce before it is allowed to overturn somebody.
 *
 * A separate field rather than a convention about `evidence[]`, because the
 * distinction it encodes is the one the whole review turns on. `evidence`
 * answers "what did you look at"; a failed search has evidence too — the files
 * you opened and did not find the bug in. `refutedBy` answers "what did you
 * FIND that makes this impossible", and there is no honest way to fill it in
 * from a search that came back empty.
 *
 * The gate reads it and nothing else for the refutation decision, so the
 * question cannot be answered by writing more prose.
 */
export const RefutationShape = {
  refutedBy: z
    .array(EvidenceSchema)
    .default([])
    .describe(
      'Required for a REFUTED verdict: the guard, test, constraint, config, or record you FOUND that makes the claim impossible. ' +
        'Not the files you searched. If you cannot fill this in, the verdict is UNPROVEN.',
    ),
} as const;

/** Objection ranking, carried by anything the authoring agent is asked to act on. */
export const ObjectionShape = {
  objectionPriority: ObjectionPrioritySchema.default('SHOULD_FIX').describe(
    'MUST_FIX: the artifact is materially wrong, misleading, untestable, or missing a major risk. ' +
      'SHOULD_FIX: meaningfully better with it, usable without it. ' +
      'OPTIONAL: refinement with low incremental risk coverage — does not block acceptance.',
  ),
} as const;

/**
 * A gap in what the reviewer could actually inspect. Recording these is what
 * keeps an under-informed review honest instead of confidently wrong.
 */
export const LimitationSchema = z.object({
  area: z.string().min(1).describe('What could not be verified: requirement, database, runtime, external-system, ...'),
  detail: z.string().min(1),
  impact: z.string().optional(),
  /**
   * Whether this gap prevented a reliable assessment. Defaults to false: a
   * skipped connector or an unread ticket is a recorded fact about the review,
   * not a failed review, and defaulting the other way would make INCONCLUSIVE
   * the normal outcome of any partially-connected setup.
   */
  material: z.boolean().default(false),
  /**
   * Ids of the findings this gap actually undermines.
   *
   * A limitation nobody can attach to a finding reads as boilerplate and gets
   * skimmed. Naming the findings turns "I could not see the callers" into a
   * hedge on the specific severity that depended on them.
   */
  affects: z.array(z.string()).default([]),
});
export type Limitation = z.infer<typeof LimitationSchema>;

/**
 * What grounds a statement about how the system is supposed to behave.
 *
 * The failure this exists for: a reviewer proposed "assert the phone number is
 * safely prefilled" for a form that has no prefill behavior anywhere — not in
 * the requirement, not in a rule, not in the code. It was plausible, it read
 * like a competent test expectation, and it was fiction. Nothing in the
 * pipeline could tell it apart from a grounded one, because both are prose with
 * an `evidence` array attached, and the evidence for the invented one pointed
 * at the file where the field is *defined*.
 *
 * So the basis is asked for separately from the evidence. "Which file did you
 * look at" and "what establishes that the system should do this" are different
 * questions, and only the second one can be answered `none`.
 */
export const BehaviorBasisSchema = z.enum([
  'acceptance-criterion',
  'project-rule',
  'contract',
  'implementation',
  'runtime',
  'none',
]);
export type BehaviorBasis = z.infer<typeof BehaviorBasisSchema>;

/** Bases that establish intended behavior. `implementation` is included: what the code does is a fact about behavior. */
export const GROUNDING_BASES: readonly BehaviorBasis[] = [
  'acceptance-criterion',
  'project-rule',
  'contract',
  'implementation',
  'runtime',
];

/**
 * Carried by every entry that tells the author the system should behave a
 * particular way.
 *
 * The default is `none`, so an entry that says nothing about its basis is
 * treated as having none — the same direction every other default in this
 * schema points. An ungrounded assertion is not deleted; it is demoted to a
 * non-blocking investigation, because "nobody has established this" and "this
 * is wrong" are different claims and the reviewer may well be onto something.
 */
export const BehaviorAssertionShape = {
  assertedBehavior: z
    .string()
    .optional()
    .describe(
      'The behavior you are stating the system should have, if this entry states one. ' +
        'Leave empty when the entry only reports what the code does today.',
    ),
  behaviorBasis: BehaviorBasisSchema.default('none').describe(
    'What establishes the asserted behavior. `none` is the honest answer when it seemed reasonable but nothing states it — ' +
      'codex-mcp then demotes the entry to a non-blocking investigation rather than dropping it.',
  ),
  behaviorEvidence: z
    .array(EvidenceSchema)
    .default([])
    .describe('The specific criterion, rule clause, contract, code, or run that establishes the asserted behavior.'),
} as const;

/**
 * Which source actually decides a disagreement, worked out rather than assumed.
 *
 * The failure this exists for: a reviewer read ticket prose as settled
 * specification and demanded the tests match it, when the prose was an
 * illustrative example and a project rule defined the real behavior. The old
 * hierarchy hard-coded "authoritative requirement" at the top and left the
 * reviewer to decide what counted as one, which in practice meant whatever the
 * ticket said.
 *
 * Nothing here ranks sources by itself. It records the reasoning, so the gate
 * can refuse to let a disagreement block on a source the reviewer itself
 * described as illustrative.
 */
export const AuthoritativeSourceSchema = z.enum([
  'acceptance-criterion',
  'project-rule',
  'architecture-decision',
  'domain-contract',
  'runtime-evidence',
  'implementation',
  'ticket-prose',
  'model-inference',
  'undetermined',
]);
export type AuthoritativeSource = z.infer<typeof AuthoritativeSourceSchema>;

/**
 * Sources that can settle a disagreement on their own.
 *
 * Ticket prose is absent deliberately, and so is model inference. Ticket text
 * becomes decisive only by being an acceptance criterion — that is what makes
 * it normative rather than descriptive.
 */
export const DECISIVE_SOURCES: readonly AuthoritativeSource[] = [
  'acceptance-criterion',
  'project-rule',
  'architecture-decision',
  'domain-contract',
  'runtime-evidence',
];

export const AuthorityResolutionSchema = z.object({
  sourcesAvailable: z
    .array(AuthoritativeSourceSchema)
    .default([])
    .describe('Every source you actually had for this specific question.'),
  authoritative: AuthoritativeSourceSchema.default('undetermined').describe(
    'Which one decides this disagreement. `undetermined` when you cannot tell, which is a real answer.',
  ),
  reason: z.string().min(1).describe('Why that source decides it, in one sentence.'),
  ticketTextRole: z
    .enum(['normative', 'illustrative', 'unclear', 'not-applicable'])
    .default('unclear')
    .describe(
      'Whether the ticket wording is a requirement or an example. "The user enters e.g. +8801700000000" is illustrative; ' +
        'an acceptance criterion is normative.',
    ),
  conflictIsReal: z
    .boolean()
    .default(false)
    .describe('False when the two sources are answering different questions and only look like they disagree.'),
  /**
   * A project rule that changes the default source ordering.
   *
   * Checked against the rules actually retrieved for this review: a precedence
   * override naming a rule that was never loaded is dropped, so the ordering
   * cannot be rearranged by asserting a rule exists.
   */
  precedenceOverriddenBy: z
    .string()
    .optional()
    .describe('Path of the project rule that changes the default source ordering, exactly as it was given to you.'),
});
export type AuthorityResolution = z.infer<typeof AuthorityResolutionSchema>;

/** A point where the reviewer and the authoring agent genuinely disagree. */
export const DisagreementSchema = z.object({
  candidateId: z.string().optional(),
  topic: z.string().min(1),
  candidatePosition: z.string().min(1),
  reviewerPosition: z.string().min(1),
  evidence: z.array(EvidenceSchema).default([]),
  resolutionHint: z.string().optional(),
  /**
   * Which source decides this, worked out before the disagreement is raised.
   *
   * Optional in the schema and required in practice for a *blocking*
   * disagreement: the gate demotes one that cannot name a decisive source, so
   * a dispute grounded only in ticket prose or in the reviewer's own reading
   * becomes something to look at rather than something to fix.
   */
  authority: AuthorityResolutionSchema.optional(),
  /**
   * Defaults to true, the opposite of `Limitation.material`: the reviewer is
   * told to raise material findings only, so a disagreement it bothered to
   * record is one the authoring agent has to adjudicate.
   */
  material: z.boolean().default(true),
});
export type Disagreement = z.infer<typeof DisagreementSchema>;

/**
 * A durable, verified fact about the project, proposed by the reviewer and
 * persisted by codex-mcp between reviews.
 *
 * The Codex run itself is stateless and cannot remember anything; this is the
 * reviewer handing a fact back for the server to keep. Only verified, durable
 * knowledge belongs here — never an open question, a speculative finding, or
 * anything read out of a credential.
 */
export const MemoryFactSchema = z.object({
  topic: z.string().min(1).describe('Short subject line, e.g. "tenant ownership enforcement".'),
  fact: z.string().min(1).describe('The durable knowledge, stated concisely.'),
  evidence: z.array(EvidenceSchema).min(1).describe('What establishes it. A fact with no evidence is not verified.'),
  implication: z.string().optional().describe('Why it matters for future changes or testing.'),
});
export type MemoryFact = z.infer<typeof MemoryFactSchema>;

/**
 * The result of checking one citation the *author* made.
 *
 * Produced by codex-mcp, not by the reviewer. An author's `file:line` is a
 * factual claim about the repository, and it is the one part of a submitted
 * finding that can be checked without judgment — so it is checked in code,
 * before any model sees it, and the answer is handed to the reviewer as
 * evidence rather than left for it to re-derive.
 *
 * `MISSING_FILE` and `LINE_OUT_OF_RANGE` are the fabrication signatures: a model
 * that invented a citation names a file that is not there, or a line past the
 * end of one that is.
 */
export const CitationStatusSchema = z.enum([
  'VERIFIED',
  'MISSING_FILE',
  'LINE_OUT_OF_RANGE',
  'CONTENT_MISMATCH',
  'UNPARSEABLE',
  'OUT_OF_SCOPE',
]);
export type CitationStatus = z.infer<typeof CitationStatusSchema>;

export const CitationCheckSchema = z.object({
  /** Id of the candidate finding this citation was attached to. */
  candidateId: z.string().min(1),
  /** The citation exactly as the author wrote it. */
  cited: z.string().min(1),
  status: CitationStatusSchema,
  /** Resolved repo-relative path, when one could be resolved at all. */
  resolvedPath: z.string().optional(),
  line: z.number().int().positive().optional(),
  /** Total lines in the cited file, when it exists. Makes an out-of-range citation self-evident. */
  fileLines: z.number().int().min(0).optional(),
  /** The line the author pointed at, verbatim, so the reviewer can judge support without re-reading. */
  citedLine: z.string().optional(),
  /** A few lines either side, so "nearby code contradicts it" is answerable. */
  context: z.string().optional(),
  detail: z.string().min(1),
});
export type CitationCheck = z.infer<typeof CitationCheckSchema>;

/** Citation statuses that mean the author pointed at something that is not there. */
export const BROKEN_CITATION_STATUSES: readonly CitationStatus[] = ['MISSING_FILE', 'LINE_OUT_OF_RANGE'];

/**
 * Whether the reviewer judged that a verified citation actually *supports* the
 * claim attached to it.
 *
 * Existence is machine-checkable and is checked in code; support is a judgment
 * and stays with the reviewer. Splitting them is what stops "the file exists"
 * from being reported as "the evidence holds".
 */
export const CitationAssessmentSchema = z.object({
  candidateId: z.string().min(1),
  cited: z.string().min(1),
  supportsClaim: z
    .enum(['SUPPORTS', 'DOES_NOT_SUPPORT', 'CONTRADICTS', 'UNRELATED', 'COULD_NOT_ASSESS'])
    .describe('CONTRADICTS means the cited code establishes the opposite of what it was cited for.'),
  detail: z.string().min(1),
});
export type CitationAssessment = z.infer<typeof CitationAssessmentSchema>;

/**
 * The failure classes a change has to be cleared against before a review can
 * call itself finished.
 *
 * A list rather than prose because the failure mode is silence: a reviewer that
 * never considered backward compatibility reports nothing about backward
 * compatibility, and the result is indistinguishable from one that considered
 * it and found nothing. Requiring an explicit per-class answer makes the
 * difference visible, and the gate records every class left unanswered.
 */
export const RELEASE_BLOCKER_CLASSES = [
  'security-authn-authz',
  'data-corruption-or-loss',
  'critical-business-rule',
  'migration-or-deployment',
  'backward-compatibility',
  'availability-or-performance-collapse',
] as const;

export const ReleaseBlockerClassSchema = z.enum(RELEASE_BLOCKER_CLASSES);
export type ReleaseBlockerClass = z.infer<typeof ReleaseBlockerClassSchema>;

export const BlockerSweepEntrySchema = z.object({
  blockerClass: ReleaseBlockerClassSchema,
  applicable: z.boolean().describe('False only when the change cannot touch this class at all. Say why in detail.'),
  outcome: z
    .enum(['no-blocker-found', 'blocker-found', 'not-inspected'])
    .describe('not-inspected is an honest answer and is recorded as a gap; a silent omission is not.'),
  detail: z.string().min(1).describe('What you inspected, or why the class cannot apply to this change.'),
  inspected: z.array(z.string()).default([]).describe('Files, tests, migrations, or configs you actually opened for this class.'),
  /** Titles of findings raised from this class, so the sweep links to the output. */
  findings: z.array(z.string()).default([]),
});
export type BlockerSweepEntry = z.infer<typeof BlockerSweepEntrySchema>;

/**
 * One node of a blast radius, and whether the review actually reached it.
 *
 * A blast-radius artifact is a list of places a change can reach. Left as
 * prose, it is read once and forgotten; as a checklist with an inspection
 * state, an unvisited high-risk node becomes a reportable gap instead of a
 * silent one.
 */
export const CoverageNodeSchema = z.object({
  component: z.string().min(1).describe('The component, module, service, table, or contract named by the blast radius.'),
  risk: z.enum(['high', 'medium', 'low']).describe('How badly a defect here would land, judged from the code, not from the artifact.'),
  inspected: z.boolean(),
  /** Where you looked. Required when inspected is true; an inspection with no location is a claim. */
  evidence: z.array(EvidenceSchema).default([]),
  outcome: z
    .enum(['no-issue-found', 'issue-found', 'unreachable', 'not-inspected'])
    .describe('unreachable: the component is outside every root you could read.'),
  note: z.string().optional(),
});
export type CoverageNode = z.infer<typeof CoverageNodeSchema>;
