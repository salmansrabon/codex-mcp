#!/usr/bin/env node
/**
 * A stand-in for the Codex CLI.
 *
 * Speaks enough of the real interface for integration tests: `exec` with
 * `--json` JSONL events on stdout, `-o` last-message file, `--version`, and
 * `login status`. Behavior is chosen with FAKE_CODEX_MODE so a test can
 * exercise the malformed-output and failure paths without a network call.
 *
 * It also records every invocation to FAKE_CODEX_LOG so tests can assert on the
 * argv and the prompt Codex was actually given.
 */
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const mode = process.env.FAKE_CODEX_MODE ?? 'valid';
const logPath = process.env.FAKE_CODEX_LOG;

function valueAfter(flag) {
  const index = argv.indexOf(flag);
  return index === -1 ? undefined : argv[index + 1];
}

function emit(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

async function readStdin() {
  if (process.stdin.isTTY) return '';
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

if (argv[0] === '--version' || argv[0] === '-V') {
  process.stdout.write('codex-cli 0.0.0-fake\n');
  process.exit(0);
}

if (argv[0] === 'login' && argv[1] === 'status') {
  if (process.env.FAKE_CODEX_AUTH === 'none') {
    process.stdout.write('Not logged in\n');
    process.exit(0);
  }
  process.stdout.write(
    process.env.FAKE_CODEX_AUTH === 'api' ? 'Logged in using an API key\n' : 'Logged in using ChatGPT\n',
  );
  process.exit(0);
}

if (argv[0] !== 'exec') {
  process.stderr.write(`fake-codex: unsupported invocation ${argv.join(' ')}\n`);
  process.exit(2);
}

const prompt = await readStdin();

if (logPath) {
  appendFileSync(logPath, `${JSON.stringify({ argv, prompt, cwd: process.cwd() })}\n`);
}

if (mode === 'model-too-old') {
  emit({
    msg: {
      type: 'error',
      message:
        '{"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The \'gpt-5.6-sol\' model requires a newer version of Codex. Please upgrade to the latest app or CLI and try again."}}',
    },
  });
  process.exit(1);
}

if (mode === 'model-error') {
  emit({ msg: { type: 'error', message: 'model "made-up-model" is not available for this account' } });
  process.exit(1);
}

if (mode === 'crash') {
  process.stderr.write('fake-codex: internal failure\n');
  process.exit(3);
}

// Deliberate delay, so a test can hold a concurrency slot open.
const delayMs = Number.parseInt(process.env.FAKE_CODEX_DELAY_MS ?? '0', 10);
if (Number.isFinite(delayMs) && delayMs > 0) {
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}

if (mode === 'hang') {
  // Never exits; the runner's timeout must terminate this.
  setInterval(() => {}, 1000);
} else {
  const isRepair = prompt.includes('Your previous response was not valid');
  const responsePath = isRepair
    ? (process.env.FAKE_CODEX_REPAIR_RESPONSE ?? process.env.FAKE_CODEX_RESPONSE)
    : process.env.FAKE_CODEX_RESPONSE;

  let body;
  if (mode === 'malformed' || (mode === 'malformed-once' && !isRepair)) {
    body = 'I looked at the repository and everything seems fine to me.';
  } else if (responsePath) {
    body = readFileSync(responsePath, 'utf8');
  } else {
    body = JSON.stringify({ status: 'PASS', accepted: [], modify: [], remove: [], missing: [] });
  }

  // A couple of plausible tool calls, so the audit path has something to record.
  emit({ msg: { type: 'exec_command_begin', command: ['git', 'diff', '--stat'] } });
  emit({ msg: { type: 'exec_command_end', exit_code: 0 } });
  emit({ msg: { type: 'agent_message', message: body } });
  emit({ msg: { type: 'task_complete', last_agent_message: body } });

  const lastMessageFile = valueAfter('-o') ?? valueAfter('--output-last-message');
  if (lastMessageFile) writeFileSync(lastMessageFile, body, 'utf8');

  process.exit(0);
}
