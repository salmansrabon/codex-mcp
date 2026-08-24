import type { ReasoningEffort } from '../config/schema.js';
import type { ArtifactCollection } from '../evidence/artifacts.js';
import type { GitEvidence } from '../evidence/git.js';

/**
 * How much review a change is worth (PLAN.md §9 adaptive strategy).
 *
 * A reviewer with one depth setting is either wasteful or shallow, and which
 * one depends entirely on the change it is handed. The measured cost of a full
 * two-repository authorization review was ~6.7 minutes and ~400k reviewer
 * tokens; spending that on a copy change is not thoroughness, it is a fixed
 * tax that makes the gate too expensive to run on the small changes where it
 * would be cheapest to act on.
 *
 * Classification is deliberately mechanical — file counts and path shapes, not
 * a model call. A model asked how hard it should think will answer "hard",
 * which is how a budget becomes advisory.
 */
export type ReviewDepth = 'SMALL' | 'MEDIUM' | 'HIGH';

export interface DepthAssessment {
  depth: ReviewDepth;
  /** Human-readable reasons, surfaced in the prompt and the result meta. */
  signals: string[];
  /** Never above the configured effort: this lowers cost, it does not raise ambition. */
  reasoningEffort: ReasoningEffort;
}

/**
 * Path fragments that indicate a risk class where a shallow review is worse
 * than no review, because the failure is silent and expensive.
 *
 * Deliberately generic substrings rather than any project's layout: the point
 * is to recognize a *kind* of code across stacks, not to encode one repository.
 */
const RISK_MARKERS: { readonly label: string; readonly patterns: readonly string[] }[] = [
  {
    label: 'authorization or authentication code is in the change',
    patterns: ['auth', 'permission', 'policy', 'role', 'acl', 'session', 'token', 'login', 'credential', 'tenant', 'guard'],
  },
  {
    label: 'persistence or schema code is in the change',
    patterns: ['migration', 'migrations', 'schema', 'entity', 'entities', 'model', 'models', 'repository', 'repositories', 'dao', '.sql'],
  },
  {
    label: 'external integration code is in the change',
    patterns: ['webhook', 'integration', 'client', 'gateway', 'adapter', 'connector', 'queue', 'consumer', 'publisher'],
  },
  {
    label: 'shared or widely-consumed code is in the change',
    patterns: ['shared', 'common', 'core', 'util', 'utils', 'helpers', 'lib', 'middleware', 'interceptor'],
  },
  {
    label: 'money or billing code is in the change',
    patterns: ['payment', 'billing', 'invoice', 'charge', 'price', 'pricing', 'refund'],
  },
];

/** Top-level directory names that mean a repository holds several deployables. */
const MULTI_PACKAGE_ROOTS = ['packages', 'apps', 'services', 'modules'];

const SMALL_MAX_FILES = 4;
const MEDIUM_MAX_FILES = 20;

export interface DepthInput {
  git: GitEvidence;
  artifacts: ArtifactCollection;
  candidateCount: number;
  /** Connector names available for this review; each one widens the surface. */
  connectors: readonly string[];
  /** Set when the review root sits below the caller's workspace. */
  narrowedScope: boolean;
  configuredEffort: ReasoningEffort;
}

export function assessReviewDepth(input: DepthInput): DepthAssessment {
  const changed = input.git.changedFiles ?? [];
  const signals: string[] = [];

  // No diff is not a small change; it is an unknown one. Without a change set
  // the reviewer has to derive scope from the requirement and the code, which
  // is the most expensive path, not the cheapest.
  if (!input.git.available || changed.length === 0) {
    signals.push('no change set could be resolved, so the affected surface is unknown');
    return { depth: 'HIGH', signals, reasoningEffort: input.configuredEffort };
  }

  signals.push(`${changed.length} changed file${changed.length === 1 ? '' : 's'}`);

  const lowered = changed.map((file) => file.toLowerCase());
  const risks = RISK_MARKERS.filter((marker) =>
    lowered.some((file) => marker.patterns.some((pattern) => segmentMatch(file, pattern))),
  );
  for (const risk of risks) signals.push(risk.label);

  const roots = new Set(changed.map((file) => file.split('/')[0] ?? '').filter(Boolean));
  const spansPackages = [...roots].some((root) => MULTI_PACKAGE_ROOTS.includes(root.toLowerCase()));
  const distinctRoots = roots.size;
  if (spansPackages) signals.push('the change spans a multi-package layout');
  if (distinctRoots > 3) signals.push(`the change touches ${distinctRoots} top-level areas`);

  if (input.connectors.length > 0) signals.push(`${input.connectors.length} external evidence connector(s) participate`);
  if (input.narrowedScope) signals.push('the review root is narrower than the workspace, so cross-directory effects are unverifiable here');

  // A supplied blast-radius or charter is a lead, not a saving: it still has to
  // be verified, and verifying somebody's dependency claim is the expensive
  // part. It raises depth rather than lowering it.
  if (input.artifacts.blastRadius.present || input.artifacts.testCharter.present) {
    signals.push('supplied analysis artifacts must be verified rather than trusted');
  }

  const heavy =
    risks.length >= 2 ||
    changed.length > MEDIUM_MAX_FILES ||
    spansPackages ||
    input.narrowedScope ||
    (risks.length >= 1 && changed.length > SMALL_MAX_FILES);

  if (heavy) return { depth: 'HIGH', signals, reasoningEffort: input.configuredEffort };

  const moderate =
    risks.length >= 1 ||
    changed.length > SMALL_MAX_FILES ||
    distinctRoots > 3 ||
    input.artifacts.blastRadius.present ||
    input.artifacts.testCharter.present ||
    input.candidateCount > 12;

  if (moderate) return { depth: 'MEDIUM', signals, reasoningEffort: input.configuredEffort };

  signals.push('no risk-class markers, single area, small diff');
  return { depth: 'SMALL', signals, reasoningEffort: lowerEffort(input.configuredEffort) };
}

/**
 * One step down the effort ladder, and only for a change with no risk markers.
 *
 * Never below `medium`: the reviewer still has to trace a path and search for
 * contradictions, and a `minimal`-effort run that returns a confident answer is
 * the exact behavior the verification gate exists to prevent.
 */
function lowerEffort(configured: ReasoningEffort): ReasoningEffort {
  const ladder: ReasoningEffort[] = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
  const index = ladder.indexOf(configured);
  if (index <= ladder.indexOf('medium')) return configured;
  return ladder[index - 1] ?? configured;
}

/**
 * Match on a path segment or extension rather than a bare substring, so
 * `authorization/` matches and `author.ts` does not.
 */
function segmentMatch(file: string, pattern: string): boolean {
  if (pattern.startsWith('.')) return file.endsWith(pattern);
  return file.split(/[\\/._-]/).includes(pattern);
}
