import { describe, expect, it } from 'vitest';

import { classifyTool, tokenizeToolName } from '../../src/mcp-broker/capability-classifier.js';
import { normalizeCapability } from '../../src/mcp-broker/capability-normalizer.js';

describe('tokenizeToolName', () => {
  it('splits snake, kebab, and camel case alike', () => {
    expect(tokenizeToolName('get_jira_ticket')).toEqual(['get', 'jira', 'ticket']);
    expect(tokenizeToolName('getJiraIssue')).toEqual(['get', 'jira', 'issue']);
    expect(tokenizeToolName('list-tables')).toEqual(['list', 'tables']);
  });
});

describe('classifyTool', () => {
  it.each(['get_jira_ticket', 'list_tables', 'search_issues', 'describe_table', 'read_file', 'fetch_page'])(
    'classifies %s as read',
    (name) => {
      expect(classifyTool({ name }).risk).toBe('read');
    },
  );

  it.each(['create_issue', 'update_query', 'add_comment', 'transition_issue', 'upload_file', 'post_message'])(
    'classifies %s as write',
    (name) => {
      expect(classifyTool({ name }).risk).toBe('write');
    },
  );

  it.each(['delete_issue', 'drop_table', 'purge_cache', 'remove_file', 'terminate_session'])(
    'classifies %s as destructive',
    (name) => {
      expect(classifyTool({ name }).risk).toBe('destructive');
    },
  );

  it('lets a mutating verb outrank a read verb in the same name', () => {
    expect(classifyTool({ name: 'get_and_update_issue' }).risk).toBe('write');
    expect(classifyTool({ name: 'list_and_delete_files' }).risk).toBe('destructive');
  });

  it('treats a generic SQL execution tool as unknown, not read', () => {
    expect(classifyTool({ name: 'execute_query', description: 'Run a SQL query' }).risk).toBe('unknown');
  });

  it('accepts an explicitly read-scoped query tool', () => {
    expect(classifyTool({ name: 'read_query', description: 'Run a read-only SQL query' }).risk).toBe('read');
    expect(classifyTool({ name: 'query_readonly' }).risk).toBe('read');
  });

  it('classifies an ambiguous name whose description mentions mutation as write', () => {
    expect(classifyTool({ name: 'board_reconcile', description: 'Creates missing cards on the board.' }).risk).toBe('write');
  });

  it('lets an explicit self-declaration of mutation override a read verb', () => {
    expect(
      classifyTool({ name: 'get_report', description: 'This tool creates a snapshot row before returning.' }).risk,
    ).toBe('write');
    expect(classifyTool({ name: 'list_items', description: 'Has side effects on the cache index.' }).risk).toBe('write');
  });

  it('does not mistake mutating words in example prose for mutating behavior', () => {
    // Real case: a Jira search tool whose description lists "delete"/"remove"
    // as query synonyms. Read verb in the name outranks incidental prose.
    expect(
      classifyTool({
        name: 'find_relevant_tickets',
        description:
          'Given a requirement, find the top 5 most relevant Jira tickets. ' +
          'Examples: "remove" -> extraTerms: ["delete", "cleanup", "purge"].',
      }).risk,
    ).toBe('read');
  });

  it('defaults to unknown when nothing in the name or description signals read-only', () => {
    expect(classifyTool({ name: 'frobnicate' }).risk).toBe('unknown');
  });

  it('accepts a description that positively asserts read-only', () => {
    expect(classifyTool({ name: 'frobnicate', description: 'A read-only inspection helper.' }).risk).toBe('read');
  });

  it('always explains itself', () => {
    expect(classifyTool({ name: 'delete_everything' }).rationale).toMatch(/destructive verb/);
  });
});

describe('normalizeCapability', () => {
  it('maps jira tools onto the requirement vocabulary', () => {
    expect(normalizeCapability('jira', 'get_jira_ticket')).toBe('requirement.read');
    expect(normalizeCapability('jira', 'search_jira_by_jql')).toBe('requirement.search');
  });

  it('maps database tools onto schema and query capabilities', () => {
    expect(normalizeCapability('database', 'list_tables')).toBe('database.schema');
    expect(normalizeCapability('database', 'describe_table')).toBe('database.schema');
    expect(normalizeCapability('database', 'read_query')).toBe('database.query_readonly');
  });

  it('maps test-management and file tools', () => {
    expect(normalizeCapability('testmanagement', 'search_cases')).toBe('testmanagement.search');
    expect(normalizeCapability('testmanagement', 'get_case')).toBe('testmanagement.read');
    expect(normalizeCapability('external_file', 'list_dir')).toBe('external_file.list');
    expect(normalizeCapability('external_file', 'read_file')).toBe('external_file.read');
  });

  it('returns undefined for tools it cannot place, rather than guessing', () => {
    expect(normalizeCapability('custom', 'frobnicate')).toBeUndefined();
    expect(normalizeCapability('jira', 'frobnicate')).toBeUndefined();
  });
});
