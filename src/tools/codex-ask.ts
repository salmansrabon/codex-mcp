import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { CodexRunner } from '../codex/codex-runner.js';
import { usableConnectors, type Config, type ConnectorConfig } from '../config/config.js';
import { CodexMcpError } from '../errors/codex-mcp-error.js';
import { ErrorCodes } from '../errors/codes.js';
import { describeAccess, type ConsentGate } from '../policy/consent.js';
import { buildBrokerLaunchSpec } from '../review/broker-launcher.js';
import type { Logger } from '../util/logger.js';

export const CODEX_ASK_TOOL_NAME = 'codex_ask';

export const CODEX_ASK_DESCRIPTION = `Ask Codex a general question and get a prose answer.

This is the one surface that answers in prose instead of a review delta.

It reads **no repository**. Codex runs rooted at an empty scratch directory, so nothing about the
user's code is in scope for the answer, and a question like "what does this repo do" reaches a model
that cannot see it. Use \`codex_qualify\` when the answer must be grounded in code.

It CAN reach configured evidence connectors — a ticket tracker, a read-only database — on exactly
the terms a review does: each one goes through the same human consent gate its \`approval\` setting
drives. A connector that is denied, or that nobody was available to approve, is reported in
\`limitations\` and the question is answered without it rather than failing. \`connectorsUsed\` names
what was actually attached, so you can tell a grounded answer from an ungrounded one.

Answers are not evidence in the way a review's citations are: prose here is not verified against a
source. The usual precedence still holds — requirement, runtime, code, and database beat model
opinion.`;

export const CODEX_ASK_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    question: {
      type: 'string',
      minLength: 1,
      description: 'The question to answer. No repository context is supplied.',
    },
  },
  required: ['question'],
  additionalProperties: false,
} as const;

/**
 * A question that takes this long has gone wrong. The review path allows 15
 * minutes because it reads a repository; this one does not.
 */
const ASK_TIMEOUT_MS = 120_000;

/** Only the part of AuthManager this tool needs, so tests can supply their own. */
export interface AskAuthGate {
  requireAuthenticated(): Promise<unknown>;
}

export interface AskDeps {
  runner: CodexRunner;
  config: Config;
  logger: Logger;
  auth: AskAuthGate;
  /**
   * Consent for reaching outside the process, on the same terms as a review.
   * The CLI supplies a self-consenting gate: typing the command IS the request.
   */
  consent: ConsentGate;
}

export interface AskRequest {
  question: string;
}

export interface AskResult {
  answer: string;
  /** Connectors actually attached, so a caller can tell grounded from not. */
  connectorsUsed: string[];
  /** Connectors that were configured but withheld, and why. */
  limitations: string[];
  durationMs: number;
}

function parseRequest(args: unknown): AskRequest {
  const question = (args as AskRequest | undefined)?.question;
  if (typeof question !== 'string' || question.trim() === '') {
    throw new CodexMcpError(
      ErrorCodes.INVALID_REVIEW_REQUEST,
      '`question` is required and must be a non-empty string.',
    );
  }
  return { question: question.trim() };
}

/** Ask about each configured connector, keeping only the ones consent allows. */
async function gatherConsent(
  connectors: readonly ConnectorConfig[],
  consent: ConsentGate,
  askId: string,
): Promise<{ granted: ConnectorConfig[]; limitations: string[] }> {
  const granted: ConnectorConfig[] = [];
  const limitations: string[] = [];

  for (const connector of connectors) {
    const decision = await consent.request({
      connector,
      reviewId: askId,
      purpose: `answer a question; it would ${describeAccess(connector)}`,
    });
    if (decision.granted) granted.push(connector);
    else limitations.push(`Connector "${connector.name}" was not used: ${decision.reason}`);
  }

  return { granted, limitations };
}

/**
 * Answer a question, optionally grounded in consented evidence connectors.
 *
 * Two boundaries are structural rather than instructions the model is asked to
 * respect. The repository is out of scope because `projectRoot` is a throwaway
 * empty directory, so the read-only sandbox has nothing of the caller's to
 * read. And a connector reaches Codex only by being passed as a broker, which
 * happens only after `ConsentGate` grants it — the same gate, and the same
 * `approval` setting, that governs a review.
 *
 * The answer is never constrained by an output schema; prose is the point.
 */
export async function handleCodexAsk(deps: AskDeps, args: unknown): Promise<AskResult> {
  const request = parseRequest(args);

  // Fail before spending a spawn, matching the review path's behaviour.
  await deps.auth.requireAuthenticated();

  const askId = `ask_${Date.now().toString(36)}`;
  const { granted, limitations } = await gatherConsent(
    usableConnectors(deps.config),
    deps.consent,
    askId,
  );
  const broker = buildBrokerLaunchSpec(deps.config, granted);

  const scratch = await mkdtemp(join(tmpdir(), 'codex-mcp-ask-'));
  try {
    deps.logger.debug('codex_ask', {
      questionChars: request.question.length,
      connectors: granted.map((c) => c.name),
    });

    const result = await deps.runner.run({
      prompt: buildPrompt(request.question, granted),
      projectRoot: scratch,
      timeoutMs: ASK_TIMEOUT_MS,
      ...(broker ? { broker } : {}),
    });

    return {
      answer: result.finalMessage?.trim() ?? '',
      connectorsUsed: granted.map((c) => c.name),
      limitations,
      durationMs: result.durationMs,
    };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

function buildPrompt(question: string, connectors: readonly ConnectorConfig[]): string {
  const lines = [
    'Answer the question below directly and concisely.',
    '',
    'You are rooted in an empty directory and have no access to the user\'s repository. If the',
    'question is about their code, say plainly that you cannot see it rather than guessing.',
  ];

  if (connectors.length > 0) {
    lines.push(
      '',
      'You DO have read-only access to the following, through the evidence broker:',
      ...connectors.map((c) => `- ${c.name}: ${describeAccess(c)}`),
      '',
      'Use them to ground your answer where they are relevant, and cite what you read. If a lookup',
      'returns nothing, say so rather than filling the gap from memory.',
    );
  } else {
    lines.push(
      '',
      'You have no ticket tracker or database access. If the question is about a specific ticket or',
      'dataset, say plainly that you cannot see it.',
    );
  }

  lines.push('', 'QUESTION', question);
  return lines.join('\n');
}
