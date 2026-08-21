import type { Socket } from "node:net";
import { createRuntimeAtlasApp } from "./app.js";
import {
  ConfigurationError,
  isLoopbackHost,
  loadConfig,
  type AtlasConfig,
} from "./config.js";
import { createLogger } from "./logger.js";
import { AtlasRuntime } from "./runtime.js";

let config: AtlasConfig;
try {
  config = loadConfig();
} catch (error) {
  const message =
    error instanceof ConfigurationError
      ? error.message
      : "Unknown configuration error";
  process.stderr.write(
    `${JSON.stringify({
      time: new Date().toISOString(),
      level: "error",
      event: "configuration.invalid",
      error: message,
    })}\n`,
  );
  process.exit(1);
}

const logger = createLogger(config.logLevel);
const runtime = new AtlasRuntime({
  maxBufferedEvents: config.maxBufferedEvents,
  maxEventsPerTrace: config.maxEventsPerTrace,
  maxRetainedEvents: config.maxRetainedEvents,
  maxRemoteEventIds: Math.max(12_000, config.maxBufferedEvents * 4),
  maxTraces: config.maxTraces,
});
const app = createRuntimeAtlasApp({ config, logger, runtime });
const sockets = new Set<Socket>();
const server = app.listen(config.port, config.host, () => {
  logger.info("server.started", {
    url: `http://${config.host}:${config.port}`,
    mode: config.production ? "production" : "development",
    project: config.projectName,
    demo: config.demoEnabled,
    sourcePatterns: config.sourcePatterns.length,
  });
  if (!isLoopbackHost(config.host)) {
    logger.warn("server.network_exposure", {
      host: config.host,
      authenticatedIngest: Boolean(config.ingestToken),
      sourceInspection: config.exposeSource,
      message:
        "Runtime Atlas is listening beyond loopback; use a trusted network or reverse proxy",
    });
  }
});

server.on("connection", (socket) => {
  sockets.add(socket);
  socket.once("close", () => sockets.delete(socket));
});

let shuttingDown = false;
function shutdown(signal: NodeJS.Signals): void {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info("server.shutdown.started", { signal });
  runtime.closeSubscribers();

  const force = setTimeout(() => {
    logger.error("server.shutdown.forced", { openSockets: sockets.size });
    for (const socket of sockets) socket.destroy();
    process.exit(1);
  }, config.shutdownTimeoutMs);
  force.unref();

  server.close((error) => {
    clearTimeout(force);
    if (error) {
      logger.error("server.shutdown.failed", { error: error.message });
      process.exitCode = 1;
    } else {
      logger.info("server.shutdown.completed");
    }
  });
  server.closeIdleConnections();
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
