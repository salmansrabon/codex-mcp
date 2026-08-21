import { describe, expect, it, vi } from 'vitest';

import type { ConnectorConfig } from '../../src/config/config.js';
import { AutoConsentGate, describeAccess, ElicitationConsentGate } from '../../src/policy/consent.js';
import { Logger } from '../../src/util/logger.js';

const silentLogger = new Logger('error', {}, { write: () => {} });

const connector = (overrides: Partial<ConnectorConfig> = {}): ConnectorConfig => ({
  name: 'db-mcp',
  kind: 'database',
  enabled: true,
  approval: 'once',
  transport: 'stdio',
  command: 'node',
  args: [],
  env: {},
  headers: {},
  allowTools: [],
  denyTools: [],
  startupTimeoutMs: 1000,
  callTimeoutMs: 1000,
  maxRows: 500,
  timeoutMs: 1000,
  ...overrides,
});

const req = (c: ConnectorConfig) => ({ connector: c, reviewId: 'rev_1', purpose: 'verify persistence' });

describe('ElicitationConsentGate', () => {
  it('grants when the user accepts', async () => {
    const gate = new ElicitationConsentGate(async () => 'accept', silentLogger);
    expect((await gate.request(req(connector()))).granted).toBe(true);
  });

  it('refuses when the user declines', async () => {
    const gate = new ElicitationConsentGate(async () => 'decline', silentLogger);
    const decision = await gate.request(req(connector()));
    expect(decision.granted).toBe(false);
    expect(decision.reason).toMatch(/Declined by the user/);
  });

  it('treats a cancelled prompt as a refusal', async () => {
    const gate = new ElicitationConsentGate(async () => 'cancel', silentLogger);
    expect((await gate.request(req(connector()))).granted).toBe(false);
  });

  it('asks once per session in `once` mode', async () => {
    const elicit = vi.fn(async () => 'accept' as const);
    const gate = new ElicitationConsentGate(elicit, silentLogger);
    const c = connector({ approval: 'once' });

    await gate.request(req(c));
    await gate.request(req(c));
    await gate.request(req(c));

    expect(elicit).toHaveBeenCalledTimes(1);
  });

  it('remembers a refusal too, rather than re-asking until the user gives in', async () => {
    const elicit = vi.fn(async () => 'decline' as const);
    const gate = new ElicitationConsentGate(elicit, silentLogger);
    const c = connector({ approval: 'once' });

    expect((await gate.request(req(c))).granted).toBe(false);
    expect((await gate.request(req(c))).granted).toBe(false);
    expect(elicit).toHaveBeenCalledTimes(1);
  });

  it('asks every time in `always` mode', async () => {
    const elicit = vi.fn(async () => 'accept' as const);
    const gate = new ElicitationConsentGate(elicit, silentLogger);
    const c = connector({ approval: 'always' });

    await gate.request(req(c));
    await gate.request(req(c));

    expect(elicit).toHaveBeenCalledTimes(2);
  });

  it('never asks for a trusted connector', async () => {
    const elicit = vi.fn(async () => 'accept' as const);
    const gate = new ElicitationConsentGate(elicit, silentLogger);
    const decision = await gate.request(req(connector({ approval: 'trusted' })));

    expect(decision.granted).toBe(true);
    expect(decision.implicit).toBe(true);
    expect(elicit).not.toHaveBeenCalled();
  });

  it('refuses when the client cannot show a prompt', async () => {
    // A prompt nobody can see is not consent, so this must not fall through to
    // "allow" — that would make the gate decorative.
    const gate = new ElicitationConsentGate(async () => 'unsupported', silentLogger);
    const decision = await gate.request(req(connector()));

    expect(decision.granted).toBe(false);
    expect(decision.reason).toMatch(/approval: trusted/);
  });

  it('keeps per-connector decisions separate', async () => {
    const answers: Record<string, 'accept' | 'decline'> = { 'jira-mcp': 'accept', 'db-mcp': 'decline' };
    let asked = '';
    const gate = new ElicitationConsentGate(async (message) => {
      asked = message.includes('jira-mcp') ? 'jira-mcp' : 'db-mcp';
      return answers[asked] as 'accept' | 'decline';
    }, silentLogger);

    expect((await gate.request(req(connector({ name: 'jira-mcp', kind: 'jira' })))).granted).toBe(true);
    expect((await gate.request(req(connector({ name: 'db-mcp' })))).granted).toBe(false);
    expect(asked).toBe('db-mcp');
  });

  it('tells the user what the connector would actually do', async () => {
    let shown = '';
    const gate = new ElicitationConsentGate(async (message) => {
      shown = message;
      return 'accept';
    }, silentLogger);

    await gate.request(req(connector({ maxRows: 250 })));
    expect(shown).toMatch(/read-only SELECT/);
    expect(shown).toMatch(/250 rows/);
    expect(shown).toMatch(/writes to this system are refused/i);
  });
});

describe('AutoConsentGate', () => {
  it('applies its fixed answer', async () => {
    expect((await new AutoConsentGate(true).request(req(connector()))).granted).toBe(true);
    expect((await new AutoConsentGate(false).request(req(connector()))).granted).toBe(false);
  });

  it('still honors a trusted connector when the default is deny', async () => {
    const decision = await new AutoConsentGate(false).request(req(connector({ approval: 'trusted' })));
    expect(decision.granted).toBe(true);
  });
});

describe('describeAccess', () => {
  it('describes each connector kind in plain terms', () => {
    expect(describeAccess(connector({ kind: 'jira' }))).toMatch(/read issues/);
    expect(describeAccess(connector({ kind: 'database', maxRows: 10 }))).toMatch(/10 rows/);
    expect(describeAccess(connector({ kind: 'custom' }))).toMatch(/read-only tools/);
  });
});
