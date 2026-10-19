type LogLevel = "debug" | "info" | "warn" | "error";
type LogContext = Record<string, unknown>;

const LEVEL_PRIORITY: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function isLogLevel(value: string | undefined): value is LogLevel {
  return value !== undefined && value in LEVEL_PRIORITY;
}

const configuredLevel = process.env.LOG_LEVEL?.toLowerCase();
const threshold: LogLevel = isLogLevel(configuredLevel) ? configuredLevel : "info";

function serializeErrors(_key: string, value: unknown): unknown {
  return value instanceof Error ? { name: value.name, message: value.message, stack: value.stack } : value;
}

/** Writes one JSON line to stderr; stdout belongs to the stdio JSON-RPC channel. */
function write(level: LogLevel, message: string, context?: LogContext): void {
  if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[threshold]) return;
  const entry = { time: new Date().toISOString(), level, message, ...context };
  process.stderr.write(`${JSON.stringify(entry, serializeErrors)}\n`);
}

export const logger = {
  debug: (message: string, context?: LogContext): void => write("debug", message, context),
  info: (message: string, context?: LogContext): void => write("info", message, context),
  warn: (message: string, context?: LogContext): void => write("warn", message, context),
  error: (message: string, context?: LogContext): void => write("error", message, context),
};
