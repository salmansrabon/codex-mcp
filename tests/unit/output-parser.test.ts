import { describe, expect, it } from 'vitest';

import {
  collectAttemptedCommands,
  extractJson,
  findFinalAgentMessage,
  parseCodexOutput,
  parseJsonlEvents,
} from '../../src/codex/output-parser.js';

describe('extractJson', () => {
  it('parses a bare JSON object', () => {
    expect(extractJson('{"status":"PASS"}')).toEqual({ status: 'PASS' });
  });

  it('extracts JSON from a fenced block', () => {
    expect(extractJson('Here you go:\n```json\n{"status":"PASS"}\n```\n')).toEqual({ status: 'PASS' });
  });

  it('prefers the last fenced block when the model shows its work first', () => {
    const text = '```json\n{"draft":true}\n```\nRevised:\n```json\n{"status":"PASS"}\n```';
    expect(extractJson(text)).toEqual({ status: 'PASS' });
  });

  it('finds an object surrounded by prose', () => {
    expect(extractJson('Some preamble {"status":"CHANGES_REQUIRED"} and a trailing note')).toEqual({
      status: 'CHANGES_REQUIRED',
    });
  });

  it('is not truncated by braces inside string values', () => {
    const text = '{"reason":"the handler returns } early","status":"PASS"}';
    expect(extractJson(text)).toEqual({ reason: 'the handler returns } early', status: 'PASS' });
  });

  it('is not confused by escaped quotes', () => {
    expect(extractJson('{"reason":"he said \\"no\\"","status":"PASS"}')).toEqual({
      reason: 'he said "no"',
      status: 'PASS',
    });
  });

  it('returns undefined when there is no JSON at all', () => {
    expect(extractJson('I could not complete the review.')).toBeUndefined();
  });

  it('returns undefined for an unterminated object rather than guessing', () => {
    expect(extractJson('{"status":"PASS"')).toBeUndefined();
  });
});

describe('parseJsonlEvents', () => {
  it('parses valid lines and skips interleaved noise', () => {
    const stdout = ['{"msg":{"type":"agent_message","message":"hi"}}', 'plain diagnostic line', '{"broken":'].join('\n');
    const { events } = parseJsonlEvents(stdout);
    expect(events).toHaveLength(1);
  });

  it('collects reported errors', () => {
    const { errors } = parseJsonlEvents('{"msg":{"type":"error","message":"model unavailable"}}');
    expect(errors).toEqual(['model unavailable']);
  });
});

describe('findFinalAgentMessage', () => {
  it('returns the last agent message', () => {
    const { events } = parseJsonlEvents(
      ['{"msg":{"type":"agent_message","message":"first"}}', '{"msg":{"type":"agent_message","message":"second"}}'].join('\n'),
    );
    expect(findFinalAgentMessage(events)).toBe('second');
  });

  it('supports the flat event shape as well as the nested one', () => {
    const { events } = parseJsonlEvents('{"type":"agent_message","message":"flat"}');
    expect(findFinalAgentMessage(events)).toBe('flat');
  });
});

describe('collectAttemptedCommands', () => {
  it('records shell commands and MCP tool calls for the audit log', () => {
    const { events } = parseJsonlEvents(
      [
        '{"msg":{"type":"exec_command_begin","command":["git","diff"]}}',
        '{"msg":{"type":"mcp_tool_call_begin","invocation":{"tool":"jira__get_issue"}}}',
      ].join('\n'),
    );
    expect(collectAttemptedCommands(events)).toEqual(['git diff', 'mcp:jira__get_issue']);
  });
});

describe('parseCodexOutput', () => {
  it('prefers the last-message file over the event stream', () => {
    const stdout = '{"msg":{"type":"agent_message","message":"{\\"status\\":\\"ERROR\\"}"}}';
    const parsed = parseCodexOutput(stdout, '{"status":"PASS"}');
    expect(parsed.json).toEqual({ status: 'PASS' });
  });

  it('falls back to the event stream when the file is empty', () => {
    const stdout = '{"msg":{"type":"agent_message","message":"{\\"status\\":\\"PASS\\"}"}}';
    expect(parseCodexOutput(stdout, '   ').json).toEqual({ status: 'PASS' });
  });

  it('reports no JSON rather than inventing one', () => {
    expect(parseCodexOutput('{"msg":{"type":"agent_message","message":"sorry"}}').json).toBeUndefined();
  });
});

/**
 * Codex 0.149 replaced the flat/nested event envelope with `item.started` /
 * `item.completed` wrappers. The payloads below are captured verbatim from a
 * real `codex exec --json` run, because a schema change here silently empties
 * the audit log without failing a single review.
 */
describe('Codex 0.149 item.* event envelope', () => {
  const stream = [
    '{"type":"thread.started","thread_id":"01a0238f-e511-7b83-90c4-2a932553b1a3"}',
    '{"type":"turn.started"}',
    '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"I will list that directory now."}}',
    '{"type":"item.started","item":{"id":"item_1","type":"command_execution","command":"/usr/bin/bash -lc \'ls src/policy\'","aggregated_output":"","exit_code":null,"status":"in_progress"}}',
    '{"type":"item.completed","item":{"id":"item_1","type":"command_execution","command":"/usr/bin/bash -lc \'ls src/policy\'","aggregated_output":"a.ts\\n","exit_code":0,"status":"completed"}}',
    '{"type":"item.completed","item":{"id":"item_2","type":"agent_message","text":"{\\"status\\":\\"PASS\\"}"}}',
    '{"type":"turn.completed","usage":{"input_tokens":31062,"cached_input_tokens":25088,"cache_write_input_tokens":0,"output_tokens":76,"reasoning_output_tokens":0}}',
  ].join('\n');

  it('finds the final agent message inside item.completed', () => {
    const { events } = parseJsonlEvents(stream);
    expect(findFinalAgentMessage(events)).toBe('{"status":"PASS"}');
  });

  it('extracts the result JSON without a last-message file', () => {
    expect(parseCodexOutput(stream).json).toEqual({ status: 'PASS' });
  });

  it('records executed commands, counting each exactly once', () => {
    const { events } = parseJsonlEvents(stream);
    expect(collectAttemptedCommands(events)).toEqual(["/usr/bin/bash -lc 'ls src/policy'"]);
  });

  it('reports token usage from turn.completed', () => {
    expect(parseCodexOutput(stream).usage).toEqual({
      inputTokens: 31062,
      cachedInputTokens: 25088,
      outputTokens: 76,
      reasoningOutputTokens: 0,
    });
  });

  it('records MCP tool calls made through the evidence broker', () => {
    const { events } = parseJsonlEvents(
      '{"type":"item.completed","item":{"id":"i","type":"mcp_tool_call","server":"codex_mcp_evidence","tool":"jira-mcp__get_jira_ticket"}}',
    );
    expect(collectAttemptedCommands(events)).toEqual(['mcp:codex_mcp_evidence.jira-mcp__get_jira_ticket']);
  });

  it('surfaces a failed turn as an error', () => {
    const { errors } = parseJsonlEvents('{"type":"turn.failed","message":"model unavailable"}');
    expect(errors).toEqual(['model unavailable']);
  });

  it('still understands the legacy envelope from older CLIs', () => {
    const legacy = [
      '{"msg":{"type":"exec_command_begin","command":["git","diff"]}}',
      '{"msg":{"type":"agent_message","message":"{\\"status\\":\\"PASS\\"}"}}',
    ].join('\n');
    const { events } = parseJsonlEvents(legacy);
    expect(findFinalAgentMessage(events)).toBe('{"status":"PASS"}');
    expect(collectAttemptedCommands(events)).toEqual(['git diff']);
  });
});
