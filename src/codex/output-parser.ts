/**
 * Extract the reviewer's structured result from Codex output.
 *
 * Three sources, in order of reliability:
 *   1. the `--output-last-message` file;
 *   2. the final `agent_message` in the `--json` event stream;
 *   3. raw stdout, as a last resort.
 *
 * Models wrap JSON in prose and fences no matter how firmly they are told not
 * to, so extraction is deliberately forgiving. Validation is not: whatever comes
 * out of here still has to pass the zod schema.
 */

export interface CodexItem {
  id?: string;
  type?: string;
  text?: string;
  message?: string;
  command?: string | string[];
  exit_code?: number | null;
  status?: string;
  tool?: string;
  server?: string;
  [key: string]: unknown;
}

export interface CodexEvent {
  type?: string;
  /** Legacy envelope (Codex <= ~0.14x). */
  msg?: { type?: string; message?: string; text?: string; [key: string]: unknown };
  /** Current envelope: `item.started` / `item.completed` carry an `item`. */
  item?: CodexItem;
  usage?: Record<string, number>;
  [key: string]: unknown;
}

export interface TokenUsage {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  reasoningOutputTokens?: number;
}

export interface ParsedCodexOutput {
  /** Final assistant message text, if one could be identified. */
  finalMessage?: string;
  /** Parsed JSON object from the final message. */
  json?: unknown;
  events: CodexEvent[];
  /** Errors Codex reported in its event stream. */
  errors: string[];
  /** Tool/command calls Codex attempted, for the audit log. */
  attemptedCommands: string[];
  /** Token accounting, when the CLI reports it. */
  usage?: TokenUsage;
}

export function parseJsonlEvents(stdout: string): { events: CodexEvent[]; errors: string[] } {
  const events: CodexEvent[] = [];
  const errors: string[] = [];

  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.startsWith('{')) continue;
    try {
      events.push(JSON.parse(trimmed) as CodexEvent);
    } catch {
      // Codex interleaves non-JSON diagnostics; ignore them.
    }
  }

  for (const event of events) {
    const type = eventType(event);
    if (type === 'error' || type === 'stream_error' || type === 'turn.failed') {
      const message = extractText(event);
      if (message) errors.push(message);
    }
  }

  return { events, errors };
}

/**
 * The event envelope has changed across Codex releases, and codex-mcp has to
 * work against whichever CLI the user has installed:
 *
 *   flat     `{ type: "agent_message", message }`            (oldest)
 *   nested   `{ msg: { type: "agent_message", message } }`
 *   item     `{ type: "item.completed", item: { type: "agent_message", text } }`  (0.149+)
 *
 * `eventKind` collapses all three onto the inner semantic type, so the rest of
 * the parser does not care which CLI produced the line. Missing an event here
 * is not fatal — the last-message file is the primary source — but it silently
 * empties the audit log, which is how the 0.149 change went unnoticed.
 */
function eventKind(event: CodexEvent): string | undefined {
  if (event.item?.type) return event.item.type;
  return (event.msg?.type as string | undefined) ?? (event.type as string | undefined);
}

/** Outer envelope type, for events like `turn.completed` that carry no item. */
function eventType(event: CodexEvent): string | undefined {
  return (event.msg?.type as string | undefined) ?? (event.type as string | undefined);
}

function extractText(event: CodexEvent): string | undefined {
  const sources: Record<string, unknown>[] = [];
  if (event.item) sources.push(event.item as Record<string, unknown>);
  if (event.msg) sources.push(event.msg as Record<string, unknown>);
  sources.push(event as Record<string, unknown>);

  for (const source of sources) {
    for (const key of ['message', 'text', 'last_agent_message', 'content']) {
      const value = source[key];
      if (typeof value === 'string' && value.trim() !== '') return value;
    }
  }
  return undefined;
}

const FINAL_MESSAGE_KINDS = new Set(['agent_message', 'task_complete', 'agent_message_delta_done', 'assistant_message']);

export function findFinalAgentMessage(events: readonly CodexEvent[]): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index] as CodexEvent;
    // `item.started` carries an empty placeholder; only completed items count.
    if (event.type === 'item.started') continue;
    if (!FINAL_MESSAGE_KINDS.has(eventKind(event) ?? '')) continue;
    const text = extractText(event);
    if (text) return text;
  }
  return undefined;
}

const COMMAND_KINDS = new Set(['exec_command_begin', 'command_execution', 'local_shell_call']);
const MCP_CALL_KINDS = new Set(['mcp_tool_call_begin', 'mcp_tool_call']);

export function collectAttemptedCommands(events: readonly CodexEvent[]): string[] {
  const commands: string[] = [];

  for (const event of events) {
    // Commands appear on both started and completed; count each once.
    if (event.type === 'item.completed' && event.item?.type === 'command_execution') continue;

    const kind = eventKind(event) ?? '';
    const source = (event.item ?? event.msg ?? {}) as Record<string, unknown>;

    if (COMMAND_KINDS.has(kind)) {
      const command = source['command'];
      if (Array.isArray(command)) commands.push(command.join(' '));
      else if (typeof command === 'string') commands.push(command);
      continue;
    }

    if (MCP_CALL_KINDS.has(kind)) {
      const invocation = source['invocation'];
      if (invocation && typeof invocation === 'object') {
        const tool = (invocation as Record<string, unknown>)['tool'];
        if (typeof tool === 'string') {
          commands.push(`mcp:${tool}`);
          continue;
        }
      }
      const tool = source['tool'];
      const server = source['server'];
      if (typeof tool === 'string') {
        commands.push(`mcp:${typeof server === 'string' ? `${server}.` : ''}${tool}`);
      }
    }
  }

  return commands;
}

/**
 * Pull the first complete JSON object or array out of arbitrary text.
 *
 * Brace counting is string- and escape-aware so a `}` inside a quoted evidence
 * string does not truncate the object.
 */
export function extractJson(text: string): unknown | undefined {
  const stripped = stripCodeFences(text).trim();
  if (stripped === '') return undefined;

  const direct = tryParse(stripped);
  if (direct !== undefined) return direct;

  for (let start = 0; start < stripped.length; start += 1) {
    const char = stripped[start];
    if (char !== '{' && char !== '[') continue;
    const end = findMatchingClose(stripped, start);
    if (end === -1) continue;
    const parsed = tryParse(stripped.slice(start, end + 1));
    if (parsed !== undefined) return parsed;
  }
  return undefined;
}

function stripCodeFences(text: string): string {
  const fence = /```(?:json|jsonc|json5)?\s*\n([\s\S]*?)```/gi;
  const matches = [...text.matchAll(fence)];
  if (matches.length === 0) return text;
  // The result is normally the last fenced block, after any reasoning prose.
  const last = matches[matches.length - 1];
  return last?.[1] ?? text;
}

function findMatchingClose(text: string, start: number): number {
  const open = text[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === open) depth += 1;
    else if (char === close) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function tryParse(text: string): unknown | undefined {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Token accounting from `turn.completed`, when the CLI reports it. */
export function collectUsage(events: readonly CodexEvent[]): TokenUsage | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const usage = (events[index] as CodexEvent).usage;
    if (!usage || typeof usage !== 'object') continue;
    const mapped: TokenUsage = {};
    if (typeof usage['input_tokens'] === 'number') mapped.inputTokens = usage['input_tokens'];
    if (typeof usage['cached_input_tokens'] === 'number') mapped.cachedInputTokens = usage['cached_input_tokens'];
    if (typeof usage['output_tokens'] === 'number') mapped.outputTokens = usage['output_tokens'];
    if (typeof usage['reasoning_output_tokens'] === 'number') {
      mapped.reasoningOutputTokens = usage['reasoning_output_tokens'];
    }
    if (Object.keys(mapped).length > 0) return mapped;
  }
  return undefined;
}

export function parseCodexOutput(stdout: string, lastMessageFileContent?: string): ParsedCodexOutput {
  const { events, errors } = parseJsonlEvents(stdout);
  const fromEvents = findFinalAgentMessage(events);
  const finalMessage = (lastMessageFileContent?.trim() || fromEvents || undefined) ?? undefined;

  const json = finalMessage ? extractJson(finalMessage) : extractJson(stdout);
  const usage = collectUsage(events);

  return {
    ...(finalMessage ? { finalMessage } : {}),
    ...(json !== undefined ? { json } : {}),
    events,
    errors,
    attemptedCommands: collectAttemptedCommands(events),
    ...(usage ? { usage } : {}),
  };
}
