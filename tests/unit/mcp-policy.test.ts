import { describe, expect, it } from 'vitest';

import { evaluateMcpTool } from '../../src/policy/mcp-policy.js';

describe('evaluateMcpTool default policy', () => {
  it('allows read', () => {
    expect(evaluateMcpTool('get_issue', 'read').effect).toBe('allow');
  });

  it('denies write, destructive, and unknown', () => {
    expect(evaluateMcpTool('create_issue', 'write').effect).toBe('deny');
    expect(evaluateMcpTool('delete_issue', 'destructive').effect).toBe('deny');
    expect(evaluateMcpTool('frobnicate', 'unknown').effect).toBe('deny');
  });
});

describe('allow and deny lists', () => {
  it('rescues an unknown tool that is explicitly allowlisted', () => {
    expect(evaluateMcpTool('frobnicate', 'unknown', { allowTools: ['frobnicate'] }).effect).toBe('allow');
  });

  it('supports trailing-glob allowlist entries', () => {
    expect(evaluateMcpTool('jira_get_thing', 'unknown', { allowTools: ['jira_get_*'] }).effect).toBe('allow');
    expect(evaluateMcpTool('other_thing', 'unknown', { allowTools: ['jira_get_*'] }).effect).toBe('deny');
  });

  it('cannot allowlist a mutating tool back into the review', () => {
    expect(evaluateMcpTool('create_issue', 'write', { allowTools: ['create_issue'] }).effect).toBe('deny');
    expect(evaluateMcpTool('delete_issue', 'destructive', { allowTools: ['delete_issue', '*'] }).effect).toBe('deny');
  });

  it('lets the deny list override a read classification', () => {
    expect(evaluateMcpTool('get_secrets', 'read', { denyTools: ['get_secrets'] }).effect).toBe('deny');
  });

  it('evaluates the deny list before the allow list', () => {
    const decision = evaluateMcpTool('thing', 'unknown', { allowTools: ['thing'], denyTools: ['thing'] });
    expect(decision.effect).toBe('deny');
  });
});

describe('allowUnknown escape hatch', () => {
  it('permits unknown tools when explicitly enabled', () => {
    expect(evaluateMcpTool('frobnicate', 'unknown', { allowUnknown: true }).effect).toBe('allow');
  });

  it('still refuses write and destructive tools', () => {
    expect(evaluateMcpTool('update_thing', 'write', { allowUnknown: true }).effect).toBe('deny');
    expect(evaluateMcpTool('drop_thing', 'destructive', { allowUnknown: true }).effect).toBe('deny');
  });
});
