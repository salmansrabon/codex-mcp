import type { ConnectorConfig } from '../config/config.js';
import type { Logger } from '../util/logger.js';

/**
 * Human consent for reaching an external system during a review.
 *
 * Repository and git evidence need no gate: the caller handed us `project.root`,
 * so reading it is the request itself. Reaching *outside* it — a ticket tracker,
 * a production database, a file server — is a separate decision the operator
 * should get to make, and a static `enabled: true` in a config file written
 * weeks ago is not that decision.
 *
 * A denied connector is a recorded limitation, never a failed review.
 */

export type ApprovalMode = 'always' | 'once' | 'trusted';

export interface ConsentRequest {
  connector: ConnectorConfig;
  reviewId: string;
  /** Short description of what the review would use it for. */
  purpose: string;
}

export interface ConsentDecision {
  granted: boolean;
  /** Why, for the limitations block when denied. */
  reason: string;
  /** True when nobody was actually asked (unsupported client, or `trusted`). */
  implicit: boolean;
}

export interface ConsentGate {
  request(req: ConsentRequest): Promise<ConsentDecision>;
}

/** What a connector kind gives the reviewer access to, in plain terms. */
export function describeAccess(connector: ConnectorConfig): string {
  switch (connector.kind) {
    case 'jira':
      return 'read issues, comments, and acceptance criteria from your tracker';
    case 'database':
      return `run read-only SELECT/SHOW/DESCRIBE queries (max ${connector.maxRows} rows)`;
    case 'testmanagement':
      return 'read existing test cases, runs, and results';
    case 'external_file':
      return 'list and read remote files';
    default:
      return 'use its policy-approved read-only tools';
  }
}

/**
 * Consent backed by MCP elicitation, so the approval prompt reaches the actual
 * human in the MCP client rather than a log nobody reads.
 */
export class ElicitationConsentGate implements ConsentGate {
  private readonly granted = new Set<string>();
  private readonly denied = new Set<string>();

  constructor(
    private readonly elicit: (message: string) => Promise<'accept' | 'decline' | 'cancel' | 'unsupported'>,
    private readonly logger: Logger,
  ) {}

  async request(req: ConsentRequest): Promise<ConsentDecision> {
    const { connector } = req;
    const mode: ApprovalMode = connector.approval;

    if (mode === 'trusted') {
      return { granted: true, reason: 'Connector is configured as trusted.', implicit: true };
    }

    if (mode === 'once') {
      if (this.granted.has(connector.name)) {
        return { granted: true, reason: 'Approved earlier in this session.', implicit: true };
      }
      if (this.denied.has(connector.name)) {
        return { granted: false, reason: 'Declined earlier in this session.', implicit: true };
      }
    }

    const message =
      `codex-mcp wants to use the "${connector.name}" connector for this review.\n\n` +
      `It would ${describeAccess(connector)}.\n\n` +
      `Read-only: writes to this system are refused by policy regardless of your answer.` +
      (mode === 'once' ? '\n\nApproving applies for the rest of this session.' : '');

    const outcome = await this.elicit(message);

    if (outcome === 'unsupported') {
      // The client cannot ask anyone. Falling back to "allow" would make the
      // gate decorative, so an unaskable connector is skipped and reported.
      this.logger.warn('client does not support elicitation; connector skipped', { connector: connector.name });
      return {
        granted: false,
        reason:
          `Your MCP client cannot show approval prompts, so "${connector.name}" was not used. ` +
          `Set \`approval: trusted\` on it in codex-mcp.yaml to allow it without asking.`,
        implicit: true,
      };
    }

    const granted = outcome === 'accept';
    if (mode === 'once') {
      (granted ? this.granted : this.denied).add(connector.name);
    }

    this.logger.info('connector consent decision', { connector: connector.name, granted, mode });

    return {
      granted,
      reason: granted
        ? 'Approved by the user.'
        : `Declined by the user, so "${connector.name}" evidence was not consulted.`,
      implicit: false,
    };
  }
}

/** Fixed answer, for the CLI, tests, and headless runs. */
export class AutoConsentGate implements ConsentGate {
  constructor(
    private readonly decision: boolean,
    private readonly why = 'No interactive client; using the configured default.',
  ) {}

  async request(req: ConsentRequest): Promise<ConsentDecision> {
    if (req.connector.approval === 'trusted') {
      return { granted: true, reason: 'Connector is configured as trusted.', implicit: true };
    }
    return {
      granted: this.decision,
      reason: this.decision ? this.why : `${this.why} "${req.connector.name}" was not used.`,
      implicit: true,
    };
  }
}
