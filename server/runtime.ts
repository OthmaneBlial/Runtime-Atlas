import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { Response } from "express";
import type {
  NodeKind,
  RuntimeEvent,
  RuntimeEventInput,
  TraceSummary,
} from "../shared/types.js";

interface SpanContext {
  traceId: string;
  spanId?: string;
}

export interface InstrumentDescriptor {
  id: string;
  label: string;
  kind: NodeKind;
  description?: string;
  meta?: Record<string, string>;
}

type AsyncHandler<Args extends unknown[], Result> = (
  ...args: Args
) => Promise<Result>;

function safeError(error: unknown): string {
  const message =
    error instanceof Error ? error.message : "Unknown runtime error";
  return [...message]
    .map((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint < 32 || codePoint === 127 ? "�" : character;
    })
    .join("")
    .slice(0, 2_048);
}

export interface AtlasRuntimeOptions {
  maxBufferedEvents?: number;
  maxTraces?: number;
  maxRemoteEventIds?: number;
  maxEventsPerTrace?: number;
  maxRetainedEvents?: number;
}

export class AtlasRuntime {
  private readonly context = new AsyncLocalStorage<SpanContext>();
  private readonly subscribers = new Set<Response>();
  private readonly eventBuffer: RuntimeEvent[] = [];
  private readonly traces = new Map<string, TraceSummary>();
  private readonly remoteEventIds = new Set<string>();
  private readonly maxBufferedEvents: number;
  private readonly maxTraces: number;
  private readonly maxRemoteEventIds: number;
  private readonly maxEventsPerTrace: number;
  private readonly maxRetainedEvents: number;
  private sequence = 0;
  private retainedEvents = 0;

  constructor(options: AtlasRuntimeOptions = {}) {
    this.maxBufferedEvents = options.maxBufferedEvents ?? 800;
    this.maxTraces = options.maxTraces ?? 60;
    this.maxRemoteEventIds = options.maxRemoteEventIds ?? 12_000;
    this.maxEventsPerTrace = options.maxEventsPerTrace ?? 5_000;
    this.maxRetainedEvents = options.maxRetainedEvents ?? 50_000;
  }

  instrument<Args extends unknown[], Result>(
    descriptor: InstrumentDescriptor,
    handler: AsyncHandler<Args, Result>,
  ): AsyncHandler<Args, Result> {
    return async (...args: Args) => {
      const parent = this.context.getStore();
      if (!parent) return handler(...args);

      const spanId = randomUUID();
      const startedAt = Date.now();
      this.emit({
        type: "span:start",
        traceId: parent.traceId,
        spanId,
        parentSpanId: parent.spanId,
        nodeId: descriptor.id,
        timestamp: startedAt,
        detail: descriptor.meta,
      });

      return this.context.run({ traceId: parent.traceId, spanId }, async () => {
        try {
          const result = await handler(...args);
          this.emit({
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
          this.emit({
            type: "span:error",
            traceId: parent.traceId,
            spanId,
            parentSpanId: parent.spanId,
            nodeId: descriptor.id,
            timestamp: Date.now(),
            duration: Date.now() - startedAt,
            error: safeError(error),
          });
          throw error;
        }
      });
    };
  }

  async trace<Result>(
    request: { method: string; path: string; status?: number },
    handler: () => Promise<Result>,
  ): Promise<Result> {
    const traceId = randomUUID();
    const startedAt = Date.now();

    this.traces.set(traceId, {
      id: traceId,
      method: request.method,
      path: request.path,
      startedAt,
      outcome: "running",
      events: [],
    });
    this.trimTraces();
    this.emit({ type: "trace:start", traceId, timestamp: startedAt, request });

    return this.context.run({ traceId }, async () => {
      try {
        const result = await handler();
        const status = request.status ?? 200;
        const duration = Date.now() - startedAt;
        this.emit({
          type: "trace:finish",
          traceId,
          timestamp: Date.now(),
          duration,
          request: { ...request, status },
        });
        this.finishTrace(traceId, duration, status, "ok");
        return result;
      } catch (error) {
        const status =
          request.status && request.status >= 400 ? request.status : 500;
        const duration = Date.now() - startedAt;
        this.emit({
          type: "trace:finish",
          traceId,
          timestamp: Date.now(),
          duration,
          request: { ...request, status },
          error: safeError(error),
        });
        this.finishTrace(traceId, duration, status, "error");
        throw error;
      }
    });
  }

  subscribe(response: Response): () => void {
    this.subscribers.add(response);
    response.write(
      `event: ready\ndata: ${JSON.stringify({ connectedAt: Date.now() })}\n\n`,
    );

    const recent = this.eventBuffer.slice(-100);
    for (const event of recent) this.writeEvent(response, event);

    const heartbeat = setInterval(() => {
      if (!response.writableEnded)
        response.write(`: heartbeat ${Date.now()}\n\n`);
    }, 15_000);
    heartbeat.unref();

    return () => {
      clearInterval(heartbeat);
      this.subscribers.delete(response);
    };
  }

  getTraces(): TraceSummary[] {
    return [...this.traces.values()].sort((a, b) => {
      const aSequence = a.events.at(-1)?.sequence ?? 0;
      const bSequence = b.events.at(-1)?.sequence ?? 0;
      return bSequence - aSequence || b.startedAt - a.startedAt;
    });
  }

  clear(): number {
    const cleared = this.traces.size;
    this.traces.clear();
    this.eventBuffer.length = 0;
    this.remoteEventIds.clear();
    this.retainedEvents = 0;
    return cleared;
  }

  stats(): {
    traces: number;
    retainedEvents: number;
    bufferedEvents: number;
    subscribers: number;
  } {
    return {
      traces: this.traces.size,
      retainedEvents: this.retainedEvents,
      bufferedEvents: this.eventBuffer.length,
      subscribers: this.subscribers.size,
    };
  }

  closeSubscribers(): void {
    for (const response of this.subscribers) {
      if (!response.writableEnded) response.end();
    }
    this.subscribers.clear();
  }

  ingest(events: RuntimeEventInput[]): number {
    let accepted = 0;
    for (const event of events) {
      if (event.eventId && this.remoteEventIds.has(event.eventId)) continue;
      if (event.eventId) {
        this.remoteEventIds.add(event.eventId);
        if (this.remoteEventIds.size > this.maxRemoteEventIds) {
          const oldest = this.remoteEventIds.values().next().value as
            string | undefined;
          if (oldest) this.remoteEventIds.delete(oldest);
        }
      }

      if (!this.traces.has(event.traceId)) {
        this.traces.set(event.traceId, {
          id: event.traceId,
          method: event.request?.method ?? "TASK",
          path: event.request?.path ?? event.service ?? "background",
          startedAt: event.timestamp,
          outcome: "running",
          events: [],
        });
        this.trimTraces();
      }

      this.emit(event);
      accepted += 1;
      if (event.type === "trace:finish") {
        this.finishTrace(
          event.traceId,
          event.duration ?? 0,
          event.request?.status ?? (event.error ? 500 : 200),
          event.error ? "error" : "ok",
        );
      }
    }
    return accepted;
  }

  private emit(event: RuntimeEventInput): void {
    const sequence = ++this.sequence;
    const completeEvent: RuntimeEvent = {
      ...event,
      id: `${event.traceId}:${sequence}`,
      sequence,
    };
    this.eventBuffer.push(completeEvent);
    if (this.eventBuffer.length > this.maxBufferedEvents)
      this.eventBuffer.shift();

    const trace = this.traces.get(event.traceId);
    if (trace) {
      trace.events.push(completeEvent);
      this.retainedEvents += 1;
      if (trace.events.length > this.maxEventsPerTrace) {
        trace.events.splice(1, 1);
        this.retainedEvents -= 1;
      }
      this.trimRetainedEvents(event.traceId);
    }

    for (const subscriber of this.subscribers) {
      try {
        this.writeEvent(subscriber, completeEvent);
      } catch {
        this.subscribers.delete(subscriber);
      }
    }
  }

  private writeEvent(response: Response, event: RuntimeEvent): void {
    response.write(
      `id: ${event.sequence}\nevent: runtime\ndata: ${JSON.stringify(event)}\n\n`,
    );
  }

  private finishTrace(
    traceId: string,
    duration: number,
    status: number,
    outcome: "ok" | "error",
  ): void {
    const trace = this.traces.get(traceId);
    if (!trace) return;
    trace.duration = duration;
    trace.status = status;
    trace.outcome = outcome;
  }

  private trimTraces(): void {
    while (this.traces.size > this.maxTraces) {
      const oldest = this.traces.keys().next().value as string | undefined;
      if (!oldest) break;
      this.evictTrace(oldest);
    }
  }

  private trimRetainedEvents(currentTraceId: string): void {
    while (this.retainedEvents > this.maxRetainedEvents) {
      const traceIds = [...this.traces.keys()];
      const oldest =
        traceIds.find((traceId) => traceId !== currentTraceId) ?? traceIds[0];
      if (!oldest) break;
      const trace = this.traces.get(oldest);
      if (oldest === currentTraceId && this.traces.size === 1 && trace) {
        if (trace.events.length <= 1) break;
        trace.events.splice(1, 1);
        this.retainedEvents -= 1;
      } else {
        this.evictTrace(oldest);
      }
    }
  }

  private evictTrace(traceId: string): void {
    const trace = this.traces.get(traceId);
    if (!trace) return;
    this.retainedEvents -= trace.events.length;
    this.traces.delete(traceId);
    for (let index = this.eventBuffer.length - 1; index >= 0; index -= 1) {
      if (this.eventBuffer[index].traceId === traceId)
        this.eventBuffer.splice(index, 1);
    }
  }
}

export class AtlasBuilder {
  constructor(private readonly runtime: AtlasRuntime) {}

  route<Args extends unknown[], Result>(
    descriptor: Omit<InstrumentDescriptor, "kind">,
    handler: AsyncHandler<Args, Result>,
  ) {
    return this.runtime.instrument({ ...descriptor, kind: "route" }, handler);
  }

  middleware<Args extends unknown[], Result>(
    descriptor: Omit<InstrumentDescriptor, "kind">,
    handler: AsyncHandler<Args, Result>,
  ) {
    return this.runtime.instrument(
      { ...descriptor, kind: "middleware" },
      handler,
    );
  }

  service<Args extends unknown[], Result>(
    descriptor: Omit<InstrumentDescriptor, "kind">,
    handler: AsyncHandler<Args, Result>,
  ) {
    return this.runtime.instrument({ ...descriptor, kind: "service" }, handler);
  }

  database<Args extends unknown[], Result>(
    descriptor: Omit<InstrumentDescriptor, "kind">,
    handler: AsyncHandler<Args, Result>,
  ) {
    return this.runtime.instrument(
      { ...descriptor, kind: "database" },
      handler,
    );
  }

  cache<Args extends unknown[], Result>(
    descriptor: Omit<InstrumentDescriptor, "kind">,
    handler: AsyncHandler<Args, Result>,
  ) {
    return this.runtime.instrument({ ...descriptor, kind: "cache" }, handler);
  }

  external<Args extends unknown[], Result>(
    descriptor: Omit<InstrumentDescriptor, "kind">,
    handler: AsyncHandler<Args, Result>,
  ) {
    return this.runtime.instrument(
      { ...descriptor, kind: "external" },
      handler,
    );
  }

  queue<Args extends unknown[], Result>(
    descriptor: Omit<InstrumentDescriptor, "kind">,
    handler: AsyncHandler<Args, Result>,
  ) {
    return this.runtime.instrument({ ...descriptor, kind: "queue" }, handler);
  }
}
