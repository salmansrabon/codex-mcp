#!/usr/bin/env node
/**
 * Smoke-test a real review against a real project and a real Codex call.
 *
 * This is the only test that spends model budget. Everything in `npm test` runs
 * against a fake Codex CLI and is free; this one proves the whole path —
 * auth, model, sandbox, evidence collection, connectors, structured output.
 *
 *   node scripts/try-review.mjs --project /path/to/repo
 *   node scripts/try-review.mjs --project /path/to/repo --type bugs
 *   node scripts/try-review.mjs --project /path/to/repo --candidates ./my-candidates.json
 *   node scripts/try-review.mjs --project /path/to/repo --task DEV-123
 *
 * With no --candidates it uses a built-in set seeded with known flaws, so you
 * can judge the reviewer by whether it finds them:
 *
 *   - two candidates are duplicates of each other  -> expect one in `remove`
 *   - one asserts behavior the code contradicts    -> expect it in `modify`
 *   - several obvious scenarios are absent         -> expect them in `missing`
 *
 * A reviewer that returns PASS on this set is not working.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { loadConfig } from '../dist/src/config/config.js';
import { CodexMcpServer } from '../dist/src/server.js';
import { Logger } from '../dist/src/util/logger.js';

function parseArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      flags[token.slice(2)] = next;
      i += 1;
    } else {
      flags[token.slice(2)] = true;
    }
  }
  return flags;
}

const flags = parseArgs(process.argv.slice(2));

if (flags.help || !flags.project) {
  process.stdout.write(
    [
      'Usage: node scripts/try-review.mjs --project <path> [options]',
      '',
      '  --project <path>      Repository to review. Required.',
      '  --type <t>            test-design | bugs | combined   (default: test-design)',
      '  --candidates <file>   JSON: { "testCases": [...], "bugs": [...] }',
      '  --task <id>           Requirement id, e.g. DEV-123',
      '  --focus <text>        Extra emphasis for the reviewer',
      '  --json                Print the raw result only',
      '',
    ].join('\n'),
  );
  process.exit(flags.project ? 0 : 1);
}

/**
 * Deliberately flawed candidates.
 *
 * TC-1 and TC-2 are the same scenario written twice. That flaw is
 * repo-independent — it needs no requirement, no diff, and no domain knowledge
 * to spot — which makes it the one reliable signal this script can assert on
 * against an arbitrary project. The rest is judged by eye.
 */
const SEEDED = {
  testCases: [
    {
      id: 'TC-1',
      title: 'The primary success path returns a successful response',
      priority: 'high',
      steps: ['Exercise the main entry point with valid input'],
      expectedResult: 'The call succeeds',
    },
    {
      id: 'TC-2',
      title: 'The main flow succeeds when given valid input',
      priority: 'low',
      steps: ['Exercise the main entry point with valid input'],
      expectedResult: 'The call succeeds',
    },
    {
      id: 'TC-3',
      title: 'Invalid input is silently ignored and still returns success',
      priority: 'medium',
      steps: ['Send a request containing an unexpected or malformed field'],
      expectedResult: 'The request succeeds and the invalid value is dropped without an error',
    },
  ],
  bugs: [
    {
      id: 'BUG-1',
      title: 'User input reaches the data layer without any validation',
      severity: 'critical',
      stepsToReproduce: ['Send a request with an unexpected field'],
      expectedBehavior: 'The request is rejected',
      actualBehavior: 'The value is persisted',
    },
  ],
};

const type = flags.type ?? 'test-design';
const projectRoot = resolve(flags.project);
const candidates = flags.candidates ? JSON.parse(readFileSync(resolve(flags.candidates), 'utf8')) : SEEDED;

const candidate =
  type === 'bugs'
    ? { bugs: candidates.bugs ?? [] }
    : type === 'combined'
      ? { testCases: candidates.testCases ?? [], bugs: candidates.bugs ?? [] }
      : { testCases: candidates.testCases ?? [] };

const config = loadConfig({ cwd: resolve(new URL('..', import.meta.url).pathname) });
const logger = new Logger(flags.json ? 'error' : config.logLevel);
const server = new CodexMcpServer({ config, logger });

if (!flags.json) {
  process.stderr.write(
    `\nReviewing ${projectRoot}\n  type:  ${type}\n  model: ${config.model ?? '(codex default)'}\n` +
      `  sandbox: ${config.sandbox}\n  connectors: ${Object.keys(config.connectors).join(', ') || 'none'}\n\n`,
  );
}

const startedAt = Date.now();
let result;
try {
  result = await server.callToolForTesting('codex_qualify', {
    reviewType: type,
    project: { root: projectRoot },
    ...(flags.task ? { task: { id: flags.task, source: 'jira' } } : {}),
    candidate,
    ...(flags.focus ? { options: { focus: flags.focus } } : {}),
  });
} catch (err) {
  process.stderr.write(`\nFAILED: ${err.code ?? 'ERROR'} — ${err.message}\n`);
  if (err.remediation) process.stderr.write(`${err.remediation}\n`);
  process.exit(1);
}

const seconds = Math.round((Date.now() - startedAt) / 1000);

if (flags.json) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exit(0);
}

process.stdout.write(`\n${'='.repeat(70)}\n${result.status}  (${seconds}s, review ${result.reviewId})\n${'='.repeat(70)}\n`);

const td = result.testDesign;
if (td) {
  process.stdout.write(`\nTEST DESIGN  accepted ${td.summary.accepted} · modify ${td.summary.modify} · remove ${td.summary.remove} · missing ${td.summary.missing}\n`);
  for (const entry of td.modify) {
    process.stdout.write(`\n  MODIFY ${entry.candidateId}\n    ${entry.reason}\n    -> ${entry.recommendation}\n`);
    for (const e of entry.evidence) process.stdout.write(`    [${e.source}] ${e.location}\n`);
  }
  for (const entry of td.remove) {
    process.stdout.write(`\n  REMOVE ${entry.candidateId}\n    ${entry.reason}\n`);
  }
  for (const entry of td.missing) {
    process.stdout.write(`\n  MISSING (${entry.priority}) ${entry.title}\n    ${entry.reason}\n`);
    for (const e of entry.evidence) process.stdout.write(`    [${e.source}] ${e.location}\n`);
  }
}

const bugs = result.bugs;
if (bugs) {
  process.stdout.write(`\nBUGS  verified ${bugs.summary.verified} · false-positive ${bugs.summary.falsePositive} · needs-evidence ${bugs.summary.needsMoreEvidence} · other ${bugs.summary.other}\n`);
  for (const finding of bugs.findings) {
    process.stdout.write(`\n  ${finding.verdict} (${finding.confidence}) ${finding.candidateId}\n    ${finding.reason}\n    -> ${finding.recommendation}\n`);
    for (const e of finding.evidence) process.stdout.write(`    [${e.source}] ${e.location}\n`);
  }
  for (const extra of bugs.additionalFindings) {
    process.stdout.write(`\n  ALSO FOUND: ${extra.title}\n    ${extra.reason}\n`);
  }
}

const limitations = [...(td?.limitations ?? []), ...(bugs?.limitations ?? [])];
if (limitations.length > 0) {
  process.stdout.write('\nLIMITATIONS\n');
  for (const l of limitations) process.stdout.write(`  [${l.area}] ${l.detail}\n`);
}

process.stdout.write(`\nEvidence used: ${JSON.stringify(result.meta.evidence)}\n`);
if (result.meta.tokenUsage) process.stdout.write(`Tokens: ${JSON.stringify(result.meta.tokenUsage)}\n`);
process.stdout.write(`Further passes allowed: ${result.meta.furtherPassesAllowed}\n`);

// With the built-in candidates we know the right answer, so check it rather
// than making the operator read the delta and judge. Only the duplicate is
// asserted: it is the one flaw that holds against any repository.
if (!flags.candidates && td) {
  process.stdout.write(`\n${'-'.repeat(70)}\nHARNESS SELF-CHECK\n${'-'.repeat(70)}\n`);
  const flagged = new Set([...td.remove.map((e) => e.candidateId), ...td.modify.map((e) => e.candidateId)]);
  const caughtDuplicate = flagged.has('TC-1') || flagged.has('TC-2');
  const citedEvidence = [...td.missing, ...td.modify].every((e) => e.evidence.length > 0);

  process.stdout.write(`  ${caughtDuplicate ? 'PASS' : 'FAIL'}  flagged the duplicate scenario (TC-1 / TC-2)\n`);
  process.stdout.write(`  ${citedEvidence ? 'PASS' : 'FAIL'}  every modify/missing entry cites evidence\n`);
  process.stdout.write(`  ${td.missing.length > 0 ? 'PASS' : 'note'}  proposed ${td.missing.length} missing scenario(s)\n`);

  if (result.status === 'INCONCLUSIVE') {
    process.stdout.write(
      '\n  Status is INCONCLUSIVE. Expected when the built-in candidates are run\n' +
        '  against an unfamiliar repo with no requirement: the reviewer cannot tell\n' +
        '  what should have been covered. Pass --task, or --candidates with real\n' +
        '  cases, for a sharper run.\n',
    );
  }
  if (!caughtDuplicate) {
    process.stdout.write('\n  The duplicate went unflagged. Check the model and reasoning effort before trusting a real review.\n');
  }
  process.stdout.write('\n');
  process.exit(caughtDuplicate ? 0 : 1);
}

process.stdout.write('\n');
process.exit(0);
