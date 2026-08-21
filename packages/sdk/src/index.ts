import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

export type NodeKind = "route" | "middleware" | "service" | "database" | "cache" | "external" | "queue";
export type RuntimeEventType = "trace:start" | "trace:finish" | "span:start" | "span:finish" | "span:error";

export interface RuntimeRequest {
  method: string;
  path: string;
  status?: number;
}

export interface RuntimeEventInput {
  eventId?: string;
  type: RuntimeEventType;
  traceId: string;
  spanId?: string;
  parentSpanId?: string;
  nodeId?: string;
  timestamp: number;
  duration?: number;
  request?: RuntimeRequest;
  detail?: Record<string, string | number | boolean>;
  error?: string;
  service?: string;
}

interface SpanContext {
  traceId: string;
  spanId?: string;
}

export interface AtlasDescriptor {
  id: string;
  label: string;
  description?: string;
  meta?: Record<string, string>;
}

export interface AtlasTransport {
  emit(event: RuntimeEventInput): void;
  flush(): Promise<void>;
  close(): Promise<void>;
}

export interface AtlasOptions {
  serviceName: string;
  collectorUrl?: string;
  transport?: AtlasTransport;
  flushIntervalMs?: number;
  maxQueueSize?: number;
  headers?: Record<string, string>;
  onError?: (error: Error) => void;
}

export interface HttpRequestLike {
  method?: string;
  originalUrl?: string;
  url?: string;
}

export interface HttpResponseLike {
  statusCode?: number;
  once(event: "finish" | "close", listener: () => void): unknown;
}

export type HttpNext = (error?: unknown) => void;

type AsyncHandler<Args extends unknown[], Result> = (...args: Args) => Promise<Result>;

export class HttpAtlasTransport implements AtlasTransport {
  private readonly queue: RuntimeEventInput[] = [];
  private timer?: ReturnType<typeof setTimeout>;
  private flushing?: Promise<void>;
  private failures = 0;

  constructor(
    private readonly endpoint: string,
    private readonly interval: number,
    private readonly headers: Record<string, string> = {},
    private readonly maxQueueSize = 2_000,
  ) {}

  emit(event: RuntimeEventInput): void {
    if (this.queue.length >= this.maxQueueSize) this.queue.shift();
    this.queue.push(event);
    if (this.queue.length >= 50) {
      void this.flush().catch(() => undefined);
      return;
    }
    this.schedule(this.interval);
  }

  async flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.queue.length) return;

    const batch = this.queue.splice(0, 100);
    this.flushing = fetch(this.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", connection: "close", ...this.headers },
      body: JSON.stringify({ events: batch }),
      keepalive: true,
    }).then(async (response) => {
      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        this.queue.unshift(...batch);
        throw new Error(`Runtime Atlas collector returned ${response.status}${detail ? `: ${detail}` : ""}`);
      }
      this.failures = 0;
    }).catch((error: unknown) => {
      this.failures += 1;
      throw error;
    }).finally(() => {
      this.flushing = undefined;
      if (this.queue.length) this.schedule(Math.min(5_000, this.interval * 2 ** this.failures));
    });
    return this.flushing;
  }

  async close(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    while (this.flushing || this.queue.length) await this.flush();
  }

  private schedule(delay: number): void {
    if (this.timer) return;
    this.timer = setTimeout(() => void this.flush().catch(() => undefined), delay);
    this.timer.unref?.();
  }
}

export class AtlasClient {
  private readonly context = new AsyncLocalStorage<SpanContext>();
  private readonly transport: AtlasTransport;

  constructor(private readonly options: AtlasOptions) {
    this.transport = options.transport ?? new HttpAtlasTransport(
      `${options.collectorUrl ?? "http://localhost:4319"}/api/ingest`,
      options.flushIntervalMs ?? 40,
      options.headers,
      options.maxQueueSize,
    );
  }

  instrument<Args extends unknown[], Result>(
    kind: NodeKind,
    descriptor: AtlasDescriptor,
    handler: AsyncHandler<Args, Result>,
  ): AsyncHandler<Args, Result> {
    return async (...args: Args) => {
      const parent = this.context.getStore();
      if (!parent) return handler(...args);

      const spanId = randomUUID();
      const startedAt = Date.now();
      this.send({
        type: "span:start",
        traceId: parent.traceId,
        spanId,
        parentSpanId: parent.spanId,
        nodeId: descriptor.id,
        timestamp: startedAt,
        detail: {
          kind,
          label: descriptor.label,
          ...(descriptor.description ? { description: descriptor.description } : {}),
          ...descriptor.meta,
        },
      });

      return this.context.run({ traceId: parent.traceId, spanId }, async () => {
        try {
          const result = await handler(...args);
          this.send({
            type: "span:finish",
            traceId: parent.traceId,
            spanId,
            parentSpanId: parent.spanId,
            nodeId: descriptor.id,
            timestamp: Date.now(),
            duration: Date.now() - startedAt,
          });
          return result;
        } catch (error) {
          this.send({
            type: "span:error",
            traceId: parent.traceId,
            spanId,
            parentSpanId: parent.spanId,
            nodeId: descriptor.id,
            timestamp: Date.now(),
            duration: Date.now() - startedAt,
            error: error instanceof Error ? error.message : "Unknown runtime error",
          });
          throw error;
        }
      });
    };
  }

  async trace<Result>(request: RuntimeRequest, handler: () => Promise<Result>): Promise<Result> {
    const traceId = randomUUID();
    const startedAt = Date.now();
    this.send({ type: "trace:start", traceId, timestamp: startedAt, request });

    return this.context.run({ traceId }, async () => {
      try {
        const result = await handler();
        this.send({
          type: "trace:finish",
          traceId,
          timestamp: Date.now(),
          duration: Date.now() - startedAt,
          request: { ...request, status: request.status ?? 200 },
        });
        await this.safeFlush();
        return result;
      } catch (error) {
        this.send({
          type: "trace:finish",
          traceId,
          timestamp: Date.now(),
          duration: Date.now() - startedAt,
          request: { ...request, status: request.status ?? 500 },
          error: error instanceof Error ? error.message : "Unknown runtime error",
        });
        await this.safeFlush();
        throw error;
      }
    });
  }

  /**
   * Connect/Express-compatible entry middleware. It begins a trace before
   * downstream handlers run and finishes it from the real response lifecycle.
   * AsyncLocalStorage carries this context into route/service wrappers.
   */
  httpMiddleware(options: {
    path?: (request: HttpRequestLike) => string;
    ignore?: (request: HttpRequestLike) => boolean;
  } = {}) {
    return (request: HttpRequestLike, response: HttpResponseLike, next: HttpNext): void => {
      if (options.ignore?.(request)) {
        next();
        return;
      }

      const traceId = randomUUID();
      const startedAt = Date.now();
      const runtimeRequest: RuntimeRequest = {
        method: request.method?.toUpperCase() || "HTTP",
        path: options.path?.(request) ?? request.originalUrl ?? request.url ?? "/",
      };
      this.send({ type: "trace:start", traceId, timestamp: startedAt, request: runtimeRequest });

      let finished = false;
      const finish = (closed: boolean) => {
        if (finished) return;
        finished = true;
        const status = closed && (!response.statusCode || response.statusCode < 400)
          ? 499
          : response.statusCode ?? 200;
        this.send({
          type: "trace:finish",
          traceId,
          timestamp: Date.now(),
          duration: Date.now() - startedAt,
          request: { ...runtimeRequest, status },
          ...(closed ? { error: "Connection closed before the response finished" } : {}),
        });
        void this.safeFlush();
      };

      response.once("finish", () => finish(false));
      response.once("close", () => finish(true));
      this.context.run({ traceId }, () => {
        try {
          next();
        } catch (error) {
          finish(true);
          throw error;
        }
      });
    };
  }

  route<Args extends unknown[], Result>(descriptor: AtlasDescriptor, handler: AsyncHandler<Args, Result>) {
    return this.instrument("route", descriptor, handler);
  }

  middleware<Args extends unknown[], Result>(descriptor: AtlasDescriptor, handler: AsyncHandler<Args, Result>) {
    return this.instrument("middleware", descriptor, handler);
  }

  service<Args extends unknown[], Result>(descriptor: AtlasDescriptor, handler: AsyncHandler<Args, Result>) {
    return this.instrument("service", descriptor, handler);
  }

  database<Args extends unknown[], Result>(descriptor: AtlasDescriptor, handler: AsyncHandler<Args, Result>) {
    return this.instrument("database", descriptor, handler);
  }

  cache<Args extends unknown[], Result>(descriptor: AtlasDescriptor, handler: AsyncHandler<Args, Result>) {
    return this.instrument("cache", descriptor, handler);
  }

  external<Args extends unknown[], Result>(descriptor: AtlasDescriptor, handler: AsyncHandler<Args, Result>) {
    return this.instrument("external", descriptor, handler);
  }

  queue<Args extends unknown[], Result>(descriptor: AtlasDescriptor, handler: AsyncHandler<Args, Result>) {
    return this.instrument("queue", descriptor, handler);
  }

  close(): Promise<void> {
    return this.transport.close();
  }

  private send(event: Omit<RuntimeEventInput, "service">): void {
    this.transport.emit({ ...event, eventId: randomUUID(), service: this.options.serviceName });
  }

  private async safeFlush(): Promise<void> {
    try {
      await this.transport.flush();
    } catch (error) {
      this.options.onError?.(error instanceof Error ? error : new Error("Runtime Atlas transport failed"));
    }
  }
}

export function createAtlas(options: AtlasOptions): AtlasClient {
  return new AtlasClient(options);
}
