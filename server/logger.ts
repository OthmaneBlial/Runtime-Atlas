import type { LogLevel } from "./config.js";

export interface AtlasLogger {
  debug(event: string, fields?: Record<string, unknown>): void;
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}

const PRIORITY: Record<Exclude<LogLevel, "silent">, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function safeFields(
  fields: Record<string, unknown> = {},
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(fields).filter(
      ([key]) => !/(authorization|cookie|secret|token|password)/i.test(key),
    ),
  );
}

export function createLogger(level: LogLevel): AtlasLogger {
  const write = (
    entryLevel: Exclude<LogLevel, "silent">,
    event: string,
    fields?: Record<string, unknown>,
  ) => {
    if (level === "silent" || PRIORITY[entryLevel] < PRIORITY[level]) return;
    const line = JSON.stringify({
      time: new Date().toISOString(),
      level: entryLevel,
      event,
      ...safeFields(fields),
    });
    (entryLevel === "error" ? process.stderr : process.stdout).write(
      `${line}\n`,
    );
  };
  return {
    debug: (event, fields) => write("debug", event, fields),
    info: (event, fields) => write("info", event, fields),
    warn: (event, fields) => write("warn", event, fields),
    error: (event, fields) => write("error", event, fields),
  };
}
