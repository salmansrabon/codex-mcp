import { tokenizeToolName } from './capability-classifier.js';

/**
 * Map connector-specific tool names onto the stable capability vocabulary from
 * PLAN.md §8, so a reviewer prompt can ask for "the requirement" without
 * knowing whether the connector calls it `getJiraIssue` or `get_jira_ticket`.
 *
 * Normalization is advisory: an unmapped tool is still exposed under its own
 * name. Version 1 does not require every connector to speak the same schema.
 */

export const NORMALIZED_CAPABILITIES = [
  'requirement.read',
  'requirement.search',
  'database.schema',
  'database.query_readonly',
  'testmanagement.search',
  'testmanagement.read',
  'external_file.list',
  'external_file.read',
] as const;

export type NormalizedCapability = (typeof NORMALIZED_CAPABILITIES)[number];

interface Rule {
  capability: NormalizedCapability;
  kinds: readonly string[];
  /** All tokens must be present in the tool name. */
  allOf?: readonly string[];
  /** At least one token must be present. */
  anyOf?: readonly string[];
  /** None of these tokens may be present. */
  noneOf?: readonly string[];
}

const RULES: readonly Rule[] = [
  { capability: 'requirement.search', kinds: ['jira'], anyOf: ['search', 'jql', 'find', 'query'] },
  { capability: 'requirement.read', kinds: ['jira'], anyOf: ['issue', 'ticket', 'story', 'page', 'requirement'], noneOf: ['search', 'jql'] },

  { capability: 'database.schema', kinds: ['database'], anyOf: ['schema', 'table', 'tables', 'columns', 'describe', 'databases', 'connections'] },
  { capability: 'database.query_readonly', kinds: ['database'], anyOf: ['query', 'select', 'sql', 'rows'], noneOf: ['update', 'insert', 'delete'] },

  { capability: 'testmanagement.search', kinds: ['testmanagement'], anyOf: ['search', 'find', 'query', 'list'] },
  { capability: 'testmanagement.read', kinds: ['testmanagement'], anyOf: ['case', 'cases', 'run', 'suite', 'plan', 'result'], noneOf: ['search'] },

  { capability: 'external_file.list', kinds: ['external_file'], anyOf: ['list', 'ls', 'dir', 'browse'] },
  { capability: 'external_file.read', kinds: ['external_file'], anyOf: ['read', 'get', 'download', 'cat', 'fetch'] },
];

export function normalizeCapability(connectorKind: string, toolName: string): NormalizedCapability | undefined {
  const tokens = new Set(tokenizeToolName(toolName));
  for (const rule of RULES) {
    if (!rule.kinds.includes(connectorKind)) continue;
    if (rule.noneOf?.some((token) => tokens.has(token))) continue;
    if (rule.allOf && !rule.allOf.every((token) => tokens.has(token))) continue;
    if (rule.anyOf && !rule.anyOf.some((token) => tokens.has(token))) continue;
    return rule.capability;
  }
  return undefined;
}
