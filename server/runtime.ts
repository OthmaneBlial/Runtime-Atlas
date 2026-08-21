import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { Response } from "express";
import type { NodeKind, RuntimeEvent, RuntimeEventInput, TraceSummary } from "../shared/types.js";

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

type AsyncHandler<Args extends unknown[], Result> = (...args: Args) => Promise<Result>;

const MAX_EVENTS = 800;
const MAX_TRACES = 60;
const MAX_REMOTE_EVENT_IDS = 12_000;

export class AtlasRuntime {
  private readonly context = new AsyncLocalStorage<SpanContext>();
  private readonly subscribers = new Set<Response>();
  private readonly eventBuffer: RuntimeEvent[] = [];
  private readonly traces = new Map<string, TraceSummary>();
  private readonly remoteEventIds = new Set<string>();
  private sequence = 0;

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
            error: error instanceof Error ? error.message : "Unknown runtime error",
          });
          throw error;
        }
      });
    };
  }

  async trace<Result>(
    request: { method: string; path: string },
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
        const status = 200;
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
        const status = 500;
        const duration = Date.now() - startedAt;
        this.emit({
          type: "trace:finish",
          traceId,
          timestamp: Date.now(),
          duration,
          request: { ...request, status },
          error: error instanceof Error ? error.message : "Unknown runtime error",
        });
        this.finishTrace(traceId, duration, status, "error");
        throw error;
      }
    });
  }

  subscribe(response: Response): () => void {
    this.subscribers.add(response);
    response.write(`event: ready\ndata: ${JSON.stringify({ connectedAt: Date.now() })}\n\n`);

    const recent = this.eventBuffer.slice(-100);
    for (const event of recent) this.writeEvent(response, event);

    return () => this.subscribers.delete(response);
  }

  getTraces(): TraceSummary[] {
    return [...this.traces.values()].sort((a, b) => {
      const aSequence = a.events.at(-1)?.sequence ?? 0;
      const bSequence = b.events.at(-1)?.sequence ?? 0;
      return bSequence - aSequence || b.startedAt - a.startedAt;
    });
  }

  ingest(events: RuntimeEventInput[]): number {
    let accepted = 0;
    for (const event of events) {
      if (event.eventId && this.remoteEventIds.has(event.eventId)) continue;
      if (event.eventId) {
        this.remoteEventIds.add(event.eventId);
        if (this.remoteEventIds.size > MAX_REMOTE_EVENT_IDS) {
          const oldest = this.remoteEventIds.values().next().value as string | undefined;
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
    if (this.eventBuffer.length > MAX_EVENTS) this.eventBuffer.shift();

    const trace = this.traces.get(event.traceId);
    if (trace) trace.events.push(completeEvent);

    for (const subscriber of this.subscribers) {
      this.writeEvent(subscriber, completeEvent);
    }
  }

  private writeEvent(response: Response, event: RuntimeEvent): void {
    response.write(`id: ${event.sequence}\nevent: runtime\ndata: ${JSON.stringify(event)}\n\n`);
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
    while (this.traces.size > MAX_TRACES) {
      const oldest = this.traces.keys().next().value as string | undefined;
      if (!oldest) break;
      this.traces.delete(oldest);
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
    return this.runtime.instrument({ ...descriptor, kind: "middleware" }, handler);
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
    return this.runtime.instrument({ ...descriptor, kind: "database" }, handler);
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
    return this.runtime.instrument({ ...descriptor, kind: "external" }, handler);
  }

  queue<Args extends unknown[], Result>(
    descriptor: Omit<InstrumentDescriptor, "kind">,
    handler: AsyncHandler<Args, Result>,
  ) {
    return this.runtime.instrument({ ...descriptor, kind: "queue" }, handler);
  }
}
