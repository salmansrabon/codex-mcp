import { redactValue } from './redact.js';

export const LOG_LEVELS = ['error', 'warn', 'info', 'debug', 'trace'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const LEVEL_RANK: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3, trace: 4 };

export function parseLogLevel(value: string | undefined, fallback: LogLevel = 'info'): LogLevel {
  if (!value) return fallback;
  const normalized = value.trim().toLowerCase();
  return (LOG_LEVELS as readonly string[]).includes(normalized) ? (normalized as LogLevel) : fallback;
}

export interface LogSink {
  write(line: string): void;
}

/**
 * Structured logger. Everything goes to **stderr**: stdout belongs to the MCP
 * stdio transport and any stray byte there corrupts the protocol stream.
 *
 * All fields pass through {@link redactValue} even at `debug` (PLAN.md §23).
 */
export class Logger {
  private readonly bindings: Record<string, unknown>;

  constructor(
    private level: LogLevel = 'info',
    bindings: Record<string, unknown> = {},
    private readonly sink: LogSink = { write: (line) => process.stderr.write(line) },
  ) {
    this.bindings = bindings;
  }

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  getLevel(): LogLevel {
    return this.level;
  }

  /** Derive a logger that stamps extra fields onto every record. */
  child(bindings: Record<string, unknown>): Logger {
    return new Logger(this.level, { ...this.bindings, ...bindings }, this.sink);
  }

  isEnabled(level: LogLevel): boolean {
    return LEVEL_RANK[level] <= LEVEL_RANK[this.level];
  }

  error(message: string, fields?: Record<string, unknown>): void {
    this.log('error', message, fields);
  }
  warn(message: string, fields?: Record<string, unknown>): void {
    this.log('warn', message, fields);
  }
  info(message: string, fields?: Record<string, unknown>): void {
    this.log('info', message, fields);
  }
  debug(message: string, fields?: Record<string, unknown>): void {
    this.log('debug', message, fields);
  }
  trace(message: string, fields?: Record<string, unknown>): void {
    this.log('trace', message, fields);
  }

  log(level: LogLevel, message: string, fields?: Record<string, unknown>): void {
    if (!this.isEnabled(level)) return;
    const record = {
      ts: new Date().toISOString(),
      level,
      msg: message,
      ...(redactValue({ ...this.bindings, ...(fields ?? {}) }) as Record<string, unknown>),
    };
    let line: string;
    try {
      line = JSON.stringify(record);
    } catch {
      line = JSON.stringify({ ts: record.ts, level, msg: message, note: 'unserializable log fields' });
    }
    this.sink.write(`${line}\n`);
  }
}

/** Process-wide logger. `start`/`doctor` reconfigure its level after config load. */
export const rootLogger = new Logger(parseLogLevel(process.env.LOG_LEVEL));
