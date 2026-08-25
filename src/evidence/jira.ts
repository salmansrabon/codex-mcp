import type { ConnectorConfig } from '../config/config.js';
import type { ParsedQualifyRequest } from '../schemas/qualify-request.js';

/**
 * One acceptance criterion, with where it came from.
 *
 * Provenance is carried rather than written into the text because an author who
 * honestly wrote "(inferred)" beside a criterion was being objected to for it —
 * the reviewer read the parenthetical as a claim rather than as a disclosure.
 * As data it is unambiguous, and the gate can act on it.
 */
export interface AcceptanceCriterion {
  /** Stable handle the review delta can cite, e.g. "AC2". */
  id: string;
  text: string;
  provenance: 'explicit' | 'inferred';
  source?: string;
}

export interface RequirementEvidence {
  /** Requirement text the caller supplied, if any. */
  supplied: boolean;
  taskId?: string;
  source?: string;
  title?: string;
  description?: string;
  acceptanceCriteria: AcceptanceCriterion[];
  /** True when Codex can go read the requirement itself rather than trusting the caller. */
  independentlyReadable: boolean;
  connectorName?: string;
  limitations: string[];
}

/**
 * Requirement handling (PLAN.md §11.5).
 *
 * Preference order:
 *   1. Codex reads the requirement itself through a Jira-kind connector.
 *   2. Falls back to the requirement text the authoring agent supplied.
 *   3. Neither: the review proceeds and records the gap as a limitation.
 *
 * codex-mcp does not fetch the ticket here on Codex's behalf — doing so would
 * re-introduce the second-hand interpretation the plan is trying to eliminate.
 */
export function planRequirementEvidence(
  request: ParsedQualifyRequest,
  jiraConnectors: readonly ConnectorConfig[],
): RequirementEvidence {
  const task = request.task ?? {};
  // A bare string is what every existing caller sends, and it means "explicit".
  // Only the object form can say otherwise.
  const acceptanceCriteria: AcceptanceCriterion[] = (task.acceptanceCriteria ?? []).map((entry, index) => {
    const id = `AC${index + 1}`;
    if (typeof entry === 'string') return { id, text: entry, provenance: 'explicit' as const };
    return {
      id,
      text: entry.text,
      provenance: entry.provenance,
      ...(entry.source ? { source: entry.source } : {}),
    };
  });
  const supplied = Boolean(task.description || task.title || acceptanceCriteria.length > 0);
  const connector = jiraConnectors[0];
  const independentlyReadable = Boolean(connector && task.id);

  const limitations: string[] = [];
  if (!independentlyReadable) {
    if (!task.id) {
      limitations.push('No task id was supplied, so the requirement could not be read independently.');
    } else if (!connector) {
      limitations.push(
        `No requirement connector is configured, so "${task.id}" could not be read independently; ` +
          'the review relies on requirement text supplied by the authoring agent.',
      );
    }
  }
  if (!supplied && !independentlyReadable) {
    limitations.push(
      'No requirement text was available from any source. Coverage judgments are derived from code and tests alone.',
    );
  }

  return {
    supplied,
    ...(task.id ? { taskId: task.id } : {}),
    ...(task.source ? { source: task.source } : {}),
    ...(task.title ? { title: task.title } : {}),
    ...(task.description ? { description: task.description } : {}),
    acceptanceCriteria,
    independentlyReadable,
    ...(connector ? { connectorName: connector.name } : {}),
    limitations,
  };
}
