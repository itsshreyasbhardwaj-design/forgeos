/**
 * Structured logging with redaction.
 *
 * Every log line is a JSON object with a level, a message, a millisecond
 * timestamp and arbitrary structured fields. Fields whose keys look like
 * secrets are redacted before they ever reach a transport — logging is the
 * single most common way credentials leak out of an application.
 */
export const LOG_LEVELS = ['debug', 'info', 'warn', 'error', 'silent'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

export interface LogRecord {
  readonly level: Exclude<LogLevel, 'silent'>;
  readonly message: string;
  readonly time: number;
  readonly scope: string;
  readonly fields: Record<string, unknown>;
}

export type LogTransport = (record: LogRecord) => void;

const SECRET_KEY_PATTERN =
  /(pass(word)?|secret|token|api[-_]?key|authorization|cookie|credential|private[-_]?key|session)/i;

const REDACTED = '[redacted]';

/** Recursively redact secret-looking keys. Depth-bounded to survive cycles. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[max-depth]';
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SECRET_KEY_PATTERN.test(key) ? REDACTED : redact(item, depth + 1);
  }
  return out;
}

export const consoleTransport: LogTransport = (record) => {
  const line = JSON.stringify({
    level: record.level,
    time: new Date(record.time).toISOString(),
    scope: record.scope,
    msg: record.message,
    ...record.fields,
  });
  if (record.level === 'error') console.error(line);
  else if (record.level === 'warn') console.warn(line);
  else console.log(line);
};

/** Collects records in memory. Used by tests and by the in-app activity feed. */
export function memoryTransport(sink: LogRecord[]): LogTransport {
  return (record) => {
    sink.push(record);
  };
}

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
  /** Derive a logger that tags every record with an additional scope segment. */
  child(scope: string, fields?: Record<string, unknown>): Logger;
}

export interface LoggerOptions {
  readonly level?: LogLevel;
  readonly scope?: string;
  readonly transport?: LogTransport;
  readonly base?: Record<string, unknown>;
  readonly now?: () => number;
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const level = options.level ?? 'info';
  const scope = options.scope ?? 'forgeos';
  const transport = options.transport ?? consoleTransport;
  const base = options.base ?? {};
  const now = options.now ?? Date.now;
  const threshold = LEVEL_WEIGHT[level];

  const emit = (
    recordLevel: Exclude<LogLevel, 'silent'>,
    message: string,
    fields?: Record<string, unknown>
  ): void => {
    if (LEVEL_WEIGHT[recordLevel] < threshold) return;
    transport({
      level: recordLevel,
      message,
      time: now(),
      scope,
      fields: redact({ ...base, ...fields }) as Record<string, unknown>,
    });
  };

  return {
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
    child: (childScope, childFields) =>
      createLogger({
        level,
        scope: `${scope}:${childScope}`,
        transport,
        base: { ...base, ...childFields },
        now,
      }),
  };
}

/** A logger that discards everything. Handy as a default parameter. */
export const silentLogger: Logger = createLogger({ level: 'silent', transport: () => {} });
