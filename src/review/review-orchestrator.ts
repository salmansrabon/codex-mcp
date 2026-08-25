import type { AuthManager } from '../auth/auth-manager.js';
import { CodexRunner } from '../codex/codex-runner.js';
import type { Config } from '../config/config.js';
import { collectArtifacts } from '../evidence/artifacts.js';
import { planDatabaseEvidence } from '../evidence/database.js';
import { collectExternalEvidence } from '../evidence/external-mcp.js';
import { collectGitEvidence, type GitEvidence } from '../evidence/git.js';
import { planRequirementEvidence } from '../evidence/jira.js';
import { collectProjectRules } from '../evidence/project-rules.js';
import { collectRelatedRepositories } from '../evidence/related-repositories.js';
import { collectRepositoryEvidence } from '../evidence/repository.js';
import { CodexMcpError, toCodexMcpError } from '../errors/codex-mcp-error.js';
import { ErrorCodes } from '../errors/codes.js';
import { AutoConsentGate, type ConsentGate } from '../policy/consent.js';
import { PermissionEngine } from '../policy/permission-engine.js';
import { detectNarrowedScope } from '../evidence/scope.js';
import { MEMORY_CONTEXT_LIMIT, ProjectMemoryStore, memoryStateDir } from '../memory/project-memory.js';
import type { PromptContext } from '../prompts/base-reviewer.js';
import {
  QualifyRequestSchema,
  ReviewTypeSchema,
  validateCandidateShape,
  type ParsedQualifyRequest,
  type QualifyRequest,
} from '../schemas/qualify-request.js';
import { RECONCILIATION_INSTRUCTION, type QualifyResult } from '../schemas/qualify-result.js';
import type { ReviewStatus } from '../schemas/review-common.js';
import { newReviewId } from '../util/ids.js';
import type { Logger } from '../util/logger.js';
import { safePathIdentifier } from '../util/redact.js';
import { buildBrokerLaunchSpec } from './broker-launcher.js';
import { verifyCandidateCitations } from './citation-verifier.js';
import { reviewCombined, worstStatus } from './combined-reviewer.js';
import { assessReviewDepth } from './review-depth.js';
import { readableRoots, resolveReviewScope } from './review-scope.js';
import { compareWithCandidates } from './risk-discovery-reviewer.js';
import type { EvidenceCoverage } from './verification-gate.js';

const SUPPORTED_REVIEW_TYPES = ReviewTypeSchema.options;

export interface ReviewOrchestratorOptions {
  config: Config;
  logger: Logger;
  /** Override the project-memory directory. Tests use this to stay off real state. */
  memoryStateDir?: string;
  authManager: AuthManager;
  /** Injectable for tests; defaults to a real CodexRunner. */
  runner?: CodexRunner;
  /**
   * Decides whether a review may reach each external connector. Defaults to
   * refusing: a non-interactive caller cannot obtain consent, and silently
   * proceeding would make the gate decorative.
   */
  consent?: ConsentGate;
}

/**
 * Coordinates one `codex_qualify` call end to end (PLAN.md §4, §20).
 *
 *   validate -> authenticate -> collect evidence -> build prompt ->
 *   invoke Codex -> validate output -> normalize -> return
 *
 * The orchestrator never writes to the project and never returns a partially
 * validated review. Concurrency is capped so several callers cannot fork an
 * unbounded number of Codex processes at the same repository.
 */
export class ReviewOrchestrator {
  private readonly config: Config;
  private readonly logger: Logger;
  private readonly memory: ProjectMemoryStore;
  private readonly authManager: AuthManager;
  private readonly permissions: PermissionEngine;
  private readonly runner: CodexRunner;
  private readonly consent: ConsentGate;
  private active = 0;
  private readonly queue: (() => void)[] = [];

  constructor(options: ReviewOrchestratorOptions) {
    this.config = options.config;
    this.logger = options.logger;
    this.authManager = options.authManager;
    this.permissions = new PermissionEngine(options.config);
    this.runner = options.runner ?? new CodexRunner({ config: options.config, logger: options.logger });
    // Memory is codex-mcp's own state, written outside the sandbox and never
    // into the project. Without a resolvable state directory it stays disabled
    // rather than guessing a location.
    const stateDir = options.memoryStateDir ?? memoryStateDir();
    this.memory = new ProjectMemoryStore({
      stateDir: stateDir ?? '',
      logger: options.logger,
      enabled: Boolean(stateDir) && options.config.memoryEnabled,
    });
    this.consent =
      options.consent ??
      new AutoConsentGate(false, 'No interactive client was available to approve external evidence access.');
  }

  get permissionEngine(): PermissionEngine {
    return this.permissions;
  }

  async qualify(rawRequest: unknown, signal?: AbortSignal): Promise<QualifyResult> {
    const request = this.parseRequest(rawRequest);
    const reviewId = newReviewId();
    const logger = this.logger.child({ reviewId, reviewType: request.reviewType });

    await this.acquireSlot(signal);
    try {
      return await this.runReview(reviewId, request, logger, signal);
    } finally {
      this.releaseSlot();
    }
  }

  private parseRequest(rawRequest: unknown): ParsedQualifyRequest {
    const parsed = QualifyRequestSchema.safeParse(rawRequest);
    if (!parsed.success) {
      // An unsupported review type gets its own code: it is the one validation
      // failure a caller can fix without re-reading the whole schema.
      const reviewTypeIssue = parsed.error.issues.find((issue) => issue.path[0] === 'reviewType');
      if (reviewTypeIssue) {
        throw new CodexMcpError(
          ErrorCodes.INVALID_REVIEW_TYPE,
          `Unsupported reviewType. Use one of: ${SUPPORTED_REVIEW_TYPES.join(', ')}.`,
        );
      }
      const detail = parsed.error.issues
        .slice(0, 12)
        .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
        .join('; ');
      throw new CodexMcpError(ErrorCodes.INVALID_REVIEW_REQUEST, `Invalid codex_qualify request: ${detail}`);
    }

    const problems = validateCandidateShape(parsed.data);
    if (problems.length > 0) {
      throw new CodexMcpError(ErrorCodes.INVALID_REVIEW_REQUEST, problems.join(' '));
    }

    const testCases = parsed.data.candidate.testCases ?? [];
    const bugs = parsed.data.candidate.bugs ?? [];
    if (testCases.length + bugs.length > this.config.maxCandidateItems) {
      throw new CodexMcpError(
        ErrorCodes.INVALID_REVIEW_REQUEST,
        `Candidate set has ${testCases.length + bugs.length} items, above the configured limit of ${this.config.maxCandidateItems}. Split the review.`,
      );
    }

    const pass = parsed.data.options?.pass ?? 1;
    if (pass > this.config.maxPasses) {
      throw new CodexMcpError(
        ErrorCodes.INVALID_REVIEW_REQUEST,
        `Review pass ${pass} exceeds MAX_REVIEW_PASSES=${this.config.maxPasses}. ` +
          'Reconcile the findings you already have and write the final artifact.',
      );
    }

    return parsed.data;
  }

  private async runReview(
    reviewId: string,
    request: ParsedQualifyRequest,
    logger: Logger,
    signal?: AbortSignal,
  ): Promise<QualifyResult> {
    const startedAt = new Date();
    const projectRoot = await this.permissions.assertProjectRootReadable(request.project.root);
    const projectRootId = await safePathIdentifier(projectRoot);

    await this.authManager.requireAuthenticated();

    if (!this.config.model) {
      if (this.config.requireModel) {
        // Some operators need the gate pinned to a known reviewer, so that a
        // Codex default change cannot quietly alter review quality.
        throw new CodexMcpError(
          ErrorCodes.CODEX_MODEL_NOT_CONFIGURED,
          'No model is configured and `requireModel` is set. Set CODEX_MODEL or `review.model`.',
        );
      }
      logger.debug('no model configured; Codex will use its own default');
    }

    const testCases = request.candidate.testCases ?? [];
    const bugs = request.candidate.bugs ?? [];
    const pass = request.options?.pass ?? 1;

    logger.info('review started', {
      projectRootId,
      model: this.config.model ?? '(codex default)',
      sandbox: this.config.sandbox,
      pass,
      candidateTestCases: testCases.length,
      candidateBugs: bugs.length,
    });

    const selection = {
      useJira: request.options?.useJira ?? true,
      useDatabase: request.options?.useDatabase ?? true,
      useExternalMcps: request.options?.useExternalMcps ?? true,
    };

    const [repository, git, artifacts, external, projectMemory, related] = await Promise.all([
      collectRepositoryEvidence(projectRoot),
      this.config.permissions.gitRead
        ? collectGitEvidence(projectRoot, logger, request.project.branch)
        : Promise.resolve<GitEvidence>({ available: false, notes: ['Git read access is disabled by configuration.'] }),
      collectArtifacts(projectRoot, this.permissions, request.artifacts ?? {}, this.config.maxArtifactBytes),
      collectExternalEvidence(this.config, this.permissions, selection, logger, this.consent, reviewId),
      this.memory.retrieve(projectRoot, MEMORY_CONTEXT_LIMIT),
      // Which other repositories this change actually depends on, read out of
      // the project's own declarations. Runs before anything decides what the
      // review may see, so a refused dependency is a named gap rather than an
      // invisible one.
      collectRelatedRepositories(projectRoot, {
        workspaceRoot: this.config.sources.cwd,
        ...(request.project.additionalRoots ? { declaredRoots: request.project.additionalRoots } : {}),
      }),
    ]);

    try {
      const jiraConnectors = external.connectors.filter((connector) => connector.kind === 'jira');
      const dbConnectors = external.connectors.filter((connector) => connector.kind === 'database');

      const requirement = planRequirementEvidence(request, jiraConnectors);
      const database = planDatabaseEvidence(dbConnectors);
      const broker = buildBrokerLaunchSpec(this.config, external.connectors);

      // The client launches this server with its workspace as the cwd, so a
      // root below it means the caller narrowed scope — possibly without meaning to.
      const scopeNotice = detectNarrowedScope(projectRoot, this.config.sources.cwd);
      if (scopeNotice) {
        logger.info('review scoped below the workspace root', {
          scopedTo: scopeNotice.scopedTo,
          unreachableSiblings: scopeNotice.unreachableSiblings.length,
        });
      }

      // Access is decided separately from discovery: `scope.additionalRoots` is
      // what widens the reviewer's boundary, and `scope.unreachableRoots` is
      // what caps its confidence and lands in `limitations` by name.
      const scope = await resolveReviewScope({
        projectRoot,
        workspaceRoot: this.config.sources.cwd,
        related,
        allowExpansion: request.options?.expandScope ?? true,
      });
      if (scope.additionalRoots.length > 0 || scope.unreachableRoots.length > 0) {
        logger.info('review scope resolved across repositories', {
          additionalRoots: scope.additionalRoots.length,
          unreachableRoots: scope.unreachableRoots.length,
        });
      }

      // Rules are retrieved against this change rather than loaded wholesale: a
      // reviewer handed every rule in the repository reads none of them.
      const rules = await collectProjectRules(projectRoot, {
        changedFiles: git.changedFiles ?? [],
        terms: [
          ...testCases.map((testCase) => testCase.title),
          ...bugs.map((bug) => `${bug.title} ${bug.component ?? ''}`),
          request.task?.title ?? '',
          request.task?.description ?? '',
          ...(request.task?.acceptanceCriteria ?? []),
          request.options?.focus ?? '',
        ].filter(Boolean),
      });

      // Every `file:line` the author cited, resolved against the filesystem
      // before the prompt exists. It is a fact, so it is settled in code; the
      // reviewer is left with the part that needs judgment.
      const citations = await verifyCandidateCitations(bugs, { roots: readableRoots(scope) });
      if (citations.broken.size > 0) {
        logger.warn('author citations do not resolve', {
          broken: citations.broken.size,
          checked: citations.checks.length,
        });
      }

      const coverage: EvidenceCoverage = {
        scopeComplete: scope.complete && !scopeNotice,
        citationsPresent: citations.present,
        citationsVerified: citations.verified,
        brokenCitations: citations.broken,
        scopeGaps: [
          ...scope.gaps,
          ...(scopeNotice
            ? [`the review root sits below the workspace, so ${scopeNotice.unreachableSiblings.join(', ')} are not readable`]
            : []),
        ],
      };

      // Depth is decided from the change set before the prompt exists, so the
      // reviewer receives a budget rather than choosing one. A model asked how
      // hard to think answers "hard", which is how a budget becomes advisory.
      const depth = assessReviewDepth({
        git,
        artifacts,
        candidateCount: testCases.length + bugs.length,
        connectors: external.evidence.usable,
        narrowedScope: Boolean(scopeNotice),
        configuredEffort: this.config.reasoningEffort,
      });
      logger.info('review depth assessed', { depth: depth.depth, reasoningEffort: depth.reasoningEffort });

      const context: PromptContext = {
        projectRoot,
        ...(scopeNotice ? { scopeNotice } : {}),
        ...(request.project.branch ? { branch: request.project.branch } : {}),
        ...(request.project.note ? { projectNote: request.project.note } : {}),
        repository,
        git,
        scope,
        related,
        rules,
        citationChecks: citations.checks,
        requirement,
        artifacts,
        database,
        external: external.evidence,
        projectMemory,
        ...(request.knownCoverage ? { knownCoverage: request.knownCoverage } : {}),
        ...(request.constraints ? { constraints: request.constraints } : {}),
        depth: { level: depth.depth, signals: depth.signals },
        ...(request.options?.focus ? { focus: request.options.focus } : {}),
        pass,
        maxPasses: this.config.maxPasses,
      };

      const timeoutMs = Math.min(request.options?.timeoutMs ?? this.config.reviewTimeoutMs, this.config.reviewTimeoutMs);

      const outcome = await reviewCombined({
        context,
        testCases: request.reviewType === 'bugs' ? [] : testCases,
        bugs: request.reviewType === 'test-design' ? [] : bugs,
        runner: this.runner,
        logger,
        ...(broker ? { broker } : {}),
        timeoutMs,
        reasoningEffort: depth.reasoningEffort,
        coverage,
        citationChecks: citations.checks,
        // The unanchored pass is on by default. Its whole value is answering
        // "what did the author miss", which the audit path structurally cannot.
        independentDiscovery: request.options?.independentDiscovery ?? true,
        ...(signal ? { signal } : {}),
      });

      const statuses: ReviewStatus[] = [];
      if (outcome.testDesign) statuses.push(outcome.testDesign.status);
      if (outcome.bugs) statuses.push(outcome.bugs.status);
      if (outcome.riskDiscovery) statuses.push(outcome.riskDiscovery.status);

      // Comparison happens here, after both paths finished, and never inside
      // either prompt: a discovery run told what the author already has stops
      // being a discovery run.
      const riskOverlap = outcome.riskDiscovery
        ? compareWithCandidates(outcome.riskDiscovery.findings, { testCases, bugs })
        : undefined;

      // Persisted after validation, from data that already passed the schema.
      // A memory failure must not fail a review that otherwise succeeded.
      await this.memory
        .persist(projectRoot, [
          ...(outcome.testDesign?.projectMemory ?? []),
          ...(outcome.bugs?.projectMemory ?? []),
          ...(outcome.riskDiscovery?.projectMemory ?? []),
        ])
        .catch((error: unknown) => {
          logger.warn('project memory not persisted', { error: error instanceof Error ? error.message : String(error) });
        });

      const completedAt = new Date();
      const durationMs = completedAt.getTime() - startedAt.getTime();

      const result: QualifyResult = {
        reviewId,
        reviewType: request.reviewType,
        status: worstStatus(statuses),
        ...(outcome.testDesign ? { testDesign: outcome.testDesign } : {}),
        ...(outcome.bugs ? { bugs: outcome.bugs } : {}),
        ...(outcome.riskDiscovery ? { riskDiscovery: outcome.riskDiscovery } : {}),
        ...(riskOverlap ? { riskOverlap } : {}),
        meta: {
          ...(this.config.model ? { model: this.config.model } : {}),
          reasoningEffort: depth.reasoningEffort,
          sandbox: this.config.sandbox,
          depth: depth.depth,
          depthSignals: depth.signals,
          pass,
          maxPasses: this.config.maxPasses,
          furtherPassesAllowed: pass < this.config.maxPasses,
          durationMs,
          startedAt: startedAt.toISOString(),
          completedAt: completedAt.toISOString(),
          outputRepairAttempts: outcome.repairAttempts,
          candidateCounts: { testCases: testCases.length, bugs: bugs.length },
          evidence: {
            projectRootId,
            git: git.available,
            blastRadius: artifacts.blastRadius.present,
            testCharter: artifacts.testCharter.present,
            requirement: requirement.independentlyReadable || requirement.supplied,
            connectors: external.evidence.usable,
            scope: {
              complete: coverage.scopeComplete,
              additionalRoots: scope.additionalRoots.map((root) => root.path),
              unreachableRoots: scope.unreachableRoots.map((root) => root.path),
              gaps: [...coverage.scopeGaps],
            },
            projectRules: {
              discovered: rules.discovered.length,
              applied: rules.selected.map((rule) => rule.path),
            },
            citations: { checked: citations.checks.length, broken: citations.broken.size },
          },
        },
        reconciliation: {
          instruction: RECONCILIATION_INSTRUCTION,
          codexIsNotAuthoritative: true,
        },
      };

      logger.info('review completed', {
        projectRootId,
        status: result.status,
        durationMs,
        outputRepairAttempts: outcome.repairAttempts,
        codexCommandCount: outcome.attemptedCommands.length,
        scopeComplete: coverage.scopeComplete,
        newRisksFound: riskOverlap?.filter((entry) => entry.relation === 'NEW').length ?? 0,
        ...(outcome.usage ? { tokenUsage: outcome.usage } : {}),
        connectors: external.evidence.usable,
      });

      return result;
    } catch (err) {
      const error = toCodexMcpError(err);
      logger.error('review failed', { projectRootId, code: error.code, message: error.message });
      throw error;
    } finally {
      await external.manager.closeAll();
    }
  }

  private async acquireSlot(signal?: AbortSignal): Promise<void> {
    if (this.active < this.config.maxConcurrentReviews) {
      this.active += 1;
      return;
    }
    await new Promise<void>((resolvePromise, rejectPromise) => {
      const onAbort = (): void => {
        const index = this.queue.indexOf(grant);
        if (index >= 0) this.queue.splice(index, 1);
        rejectPromise(new CodexMcpError(ErrorCodes.CODEX_EXECUTION_FAILED, 'The review was cancelled while queued.'));
      };
      const grant = (): void => {
        signal?.removeEventListener('abort', onAbort);
        this.active += 1;
        resolvePromise();
      };
      if (signal?.aborted) {
        rejectPromise(new CodexMcpError(ErrorCodes.CODEX_EXECUTION_FAILED, 'The review was cancelled before it started.'));
        return;
      }
      signal?.addEventListener('abort', onAbort, { once: true });
      this.queue.push(grant);
    });
  }

  private releaseSlot(): void {
    this.active = Math.max(0, this.active - 1);
    const next = this.queue.shift();
    if (next) next();
  }
}

export type { QualifyRequest };
