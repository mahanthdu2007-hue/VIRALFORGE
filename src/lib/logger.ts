/**
 * Structured logging.
 *
 * One line of JSON per event so logs stay greppable and machine-parseable in
 * both dev and production. No transports, no external dependency: the process
 * writes to stdout/stderr and whatever runs it decides where that goes.
 */

import { isAppError, toAppError } from './errors';

export const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const SEVERITY: Record<LogLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
};

export const isLogLevel = (value: unknown): value is LogLevel =>
  typeof value === 'string' && (LOG_LEVELS as readonly string[]).includes(value);

/** Arbitrary structured fields attached to a log line. */
export type LogContext = Record<string, unknown>;

export interface Logger {
  trace(message: string, context?: LogContext): void;
  debug(message: string, context?: LogContext): void;
  info(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
  /** Errors are normalised via `toAppError`, so kind/code always appear. */
  error(message: string, error?: unknown, context?: LogContext): void;
  /** Derive a logger that stamps every line with extra fields (e.g. jobId). */
  child(bindings: LogContext): Logger;
}

/** Where log lines go. Swappable so tests can capture output. */
export type LogSink = (level: LogLevel, line: string) => void;

const defaultSink: LogSink = (level, line) => {
  if (level === 'error' || level === 'warn') process.stderr.write(`${line}\n`);
  else process.stdout.write(`${line}\n`);
};

function serialiseError(error: unknown): LogContext {
  const app = toAppError(error);
  return {
    err: {
      ...app.toJSON(),
      // Diagnostics withheld from the wire belong in the log.
      ...(app.logDetails ? { logDetails: app.logDetails } : {}),
      ...(isAppError(error) ? {} : { normalised: true }),
      stack: app.stack,
    },
  };
}

export interface LoggerOptions {
  level: LogLevel;
  name?: string;
  bindings?: LogContext;
  sink?: LogSink;
}

export function createLogger(options: LoggerOptions): Logger {
  const { level, name, bindings = {}, sink = defaultSink } = options;
  const threshold = SEVERITY[level];

  const write = (lineLevel: LogLevel, message: string, context?: LogContext) => {
    if (SEVERITY[lineLevel] < threshold) return;

    const entry = {
      ts: new Date().toISOString(),
      level: lineLevel,
      ...(name ? { logger: name } : {}),
      msg: message,
      ...bindings,
      ...context,
    };

    // A non-serialisable field must never take down the caller.
    let line: string;
    try {
      line = JSON.stringify(entry);
    } catch {
      line = JSON.stringify({ ts: entry.ts, level: lineLevel, msg: message, ctxUnserialisable: true });
    }
    sink(lineLevel, line);
  };

  return {
    trace: (m, c) => write('trace', m, c),
    debug: (m, c) => write('debug', m, c),
    info: (m, c) => write('info', m, c),
    warn: (m, c) => write('warn', m, c),
    error: (m, e, c) => write('error', m, { ...(e === undefined ? {} : serialiseError(e)), ...c }),
    child: (extra) =>
      createLogger({ level, ...(name ? { name } : {}), bindings: { ...bindings, ...extra }, ...(options.sink ? { sink } : {}) }),
  };
}
