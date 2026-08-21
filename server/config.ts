import path from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

export interface AtlasConfig {
  host: string;
  port: number;
  projectName: string;
  environment: string;
  production: boolean;
  demoEnabled: boolean;
  sourcePatterns: string[];
  distDirectory: string;
  ingestToken?: string;
  exposeSource: boolean;
  allowClearTraces: boolean;
  trustProxy: boolean;
  logLevel: LogLevel;
  otlpBodyLimitBytes: number;
  otlpSpanLimit: number;
  otlpConcurrencyLimit: number;
  ingestRateLimit: number;
  demoRateLimit: number;
  maxTraces: number;
  maxBufferedEvents: number;
  maxEventsPerTrace: number;
  maxRetainedEvents: number;
  maxStreamClients: number;
  topologyCacheMs: number;
  shutdownTimeoutMs: number;
}

export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}

function integer(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = env[name];
  if (raw == null || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new ConfigurationError(
      `${name} must be an integer between ${minimum} and ${maximum}`,
    );
  }
  return value;
}

function boolean(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: boolean,
): boolean {
  const raw = env[name];
  if (raw == null || raw === "") return fallback;
  if (["1", "true", "yes", "on"].includes(raw.toLowerCase())) return true;
  if (["0", "false", "no", "off"].includes(raw.toLowerCase())) return false;
  throw new ConfigurationError(`${name} must be true or false`);
}

function byteLimit(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: string,
): number {
  const raw = (env[name] ?? fallback).trim().toLowerCase();
  const match = /^(\d+)(b|kb|mb)$/.exec(raw);
  if (!match)
    throw new ConfigurationError(
      `${name} must use b, kb, or mb (for example: 8mb)`,
    );
  const multiplier =
    match[2] === "mb" ? 1_048_576 : match[2] === "kb" ? 1_024 : 1;
  const bytes = Number(match[1]) * multiplier;
  if (!Number.isSafeInteger(bytes) || bytes < 1_024 || bytes > 67_108_864) {
    throw new ConfigurationError(`${name} must be between 1kb and 64mb`);
  }
  return bytes;
}

function safeLabel(value: string, name: string): string {
  const trimmed = value.trim();
  const hasControlCharacter = [...trimmed].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint < 32 || codePoint === 127;
  });
  if (!trimmed || trimmed.length > 80 || hasControlCharacter) {
    throw new ConfigurationError(
      `${name} must be between 1 and 80 printable characters`,
    );
  }
  return trimmed;
}

export function isLoopbackHost(host: string): boolean {
  return ["127.0.0.1", "::1", "localhost"].includes(host.toLowerCase());
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  workingDirectory = process.cwd(),
): AtlasConfig {
  const host = (env.HOST ?? "127.0.0.1").trim();
  if (!host || /[\s/]/.test(host))
    throw new ConfigurationError("HOST must be a valid hostname or IP address");

  const sourceGlobs = env.ATLAS_SOURCE_GLOB?.split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const demoEnabled = !sourceGlobs?.length;
  const sourcePatterns = (
    sourceGlobs?.length ? sourceGlobs : ["server/demo-application.ts"]
  ).map((value) =>
    path.isAbsolute(value) ? value : path.resolve(workingDirectory, value),
  );
  const ingestToken = env.ATLAS_INGEST_TOKEN?.trim() || undefined;
  if (ingestToken && ingestToken.length < 16) {
    throw new ConfigurationError(
      "ATLAS_INGEST_TOKEN must contain at least 16 characters when configured",
    );
  }

  const logLevel = (env.ATLAS_LOG_LEVEL ?? "info") as LogLevel;
  if (!["debug", "info", "warn", "error", "silent"].includes(logLevel)) {
    throw new ConfigurationError(
      "ATLAS_LOG_LEVEL must be debug, info, warn, error, or silent",
    );
  }

  return {
    host,
    port: integer(env, "PORT", 4319, 1, 65_535),
    projectName: safeLabel(
      env.ATLAS_PROJECT_NAME ??
        (demoEnabled ? "meridian-commerce-demo" : "runtime-atlas"),
      "ATLAS_PROJECT_NAME",
    ),
    environment: safeLabel(
      env.ATLAS_ENVIRONMENT ?? "local",
      "ATLAS_ENVIRONMENT",
    ),
    production: env.NODE_ENV === "production",
    demoEnabled,
    sourcePatterns,
    distDirectory: path.resolve(workingDirectory, "dist"),
    ingestToken,
    exposeSource: boolean(env, "ATLAS_EXPOSE_SOURCE", isLoopbackHost(host)),
    allowClearTraces: boolean(
      env,
      "ATLAS_ALLOW_CLEAR",
      demoEnabled && isLoopbackHost(host),
    ),
    trustProxy: boolean(env, "ATLAS_TRUST_PROXY", false),
    logLevel,
    otlpBodyLimitBytes: byteLimit(env, "ATLAS_OTLP_BODY_LIMIT", "8mb"),
    otlpSpanLimit: integer(env, "ATLAS_OTLP_MAX_SPANS", 1_000, 1, 100_000),
    otlpConcurrencyLimit: integer(
      env,
      "ATLAS_OTLP_MAX_CONCURRENT_REQUESTS",
      16,
      1,
      1_000,
    ),
    ingestRateLimit: integer(env, "ATLAS_INGEST_RATE_LIMIT", 600, 1, 100_000),
    demoRateLimit: integer(env, "ATLAS_DEMO_RATE_LIMIT", 120, 1, 10_000),
    maxTraces: integer(env, "ATLAS_MAX_TRACES", 60, 1, 1_000),
    maxBufferedEvents: integer(
      env,
      "ATLAS_MAX_BUFFERED_EVENTS",
      800,
      100,
      100_000,
    ),
    maxEventsPerTrace: integer(
      env,
      "ATLAS_MAX_EVENTS_PER_TRACE",
      5_000,
      100,
      100_000,
    ),
    maxRetainedEvents: integer(
      env,
      "ATLAS_MAX_RETAINED_EVENTS",
      50_000,
      1_000,
      1_000_000,
    ),
    maxStreamClients: integer(env, "ATLAS_MAX_STREAM_CLIENTS", 100, 1, 10_000),
    topologyCacheMs: integer(env, "ATLAS_TOPOLOGY_CACHE_MS", 2_000, 0, 60_000),
    shutdownTimeoutMs: integer(
      env,
      "ATLAS_SHUTDOWN_TIMEOUT_MS",
      10_000,
      1_000,
      60_000,
    ),
  };
}
