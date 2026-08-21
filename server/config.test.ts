// @vitest-environment node
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigurationError, isLoopbackHost, loadConfig } from "./config.js";

describe("server configuration", () => {
  it("uses a private, demo-ready local configuration by default", () => {
    const config = loadConfig({}, "/workspace/runtime-atlas");

    expect(config).toMatchObject({
      host: "127.0.0.1",
      port: 4319,
      demoEnabled: true,
      exposeSource: true,
      allowClearTraces: true,
      otlpBodyLimitBytes: 8 * 1_048_576,
    });
    expect(config.sourcePatterns).toEqual([
      path.resolve("/workspace/runtime-atlas/server/demo-application.ts"),
    ]);
  });

  it("defaults public production bindings to safer capabilities", () => {
    const config = loadConfig(
      { NODE_ENV: "production", HOST: "0.0.0.0" },
      "/workspace/runtime-atlas",
    );

    expect(config.production).toBe(true);
    expect(config.exposeSource).toBe(false);
    expect(config.allowClearTraces).toBe(false);
    expect(isLoopbackHost(config.host)).toBe(false);
  });

  it("enables project mode when source globs are supplied", () => {
    const config = loadConfig(
      {
        ATLAS_SOURCE_GLOB: "src/**/*.ts,packages/api/**/*.ts",
        ATLAS_PROJECT_NAME: "payments-api",
      },
      "/workspace/project",
    );

    expect(config.demoEnabled).toBe(false);
    expect(config.projectName).toBe("payments-api");
    expect(config.sourcePatterns).toEqual([
      "/workspace/project/src/**/*.ts",
      "/workspace/project/packages/api/**/*.ts",
    ]);
  });

  it.each([
    [{ PORT: "70000" }, "PORT"],
    [{ ATLAS_OTLP_BODY_LIMIT: "unlimited" }, "ATLAS_OTLP_BODY_LIMIT"],
    [{ ATLAS_INGEST_TOKEN: "short" }, "ATLAS_INGEST_TOKEN"],
    [{ ATLAS_EXPOSE_SOURCE: "sometimes" }, "ATLAS_EXPOSE_SOURCE"],
    [{ ATLAS_MAX_RETAINED_EVENTS: "999" }, "ATLAS_MAX_RETAINED_EVENTS"],
    [{ ATLAS_LOG_LEVEL: "verbose" }, "ATLAS_LOG_LEVEL"],
  ])("fails fast for invalid environment values", (env, expected) => {
    expect(() => loadConfig(env, "/workspace/runtime-atlas")).toThrowError(
      ConfigurationError,
    );
    expect(() => loadConfig(env, "/workspace/runtime-atlas")).toThrow(expected);
  });
});
