import { EventEmitter } from "node:events";
import type { RunEvent } from "../../domain/types.js";
import { InMemoryStore } from "../../store/inMemoryStore.js";
import { logger } from "./logger.js";

export class TelemetryService {
  private readonly emitter = new EventEmitter();
  private readonly sinks: Array<(event: RunEvent) => void | Promise<void>> = [];

  constructor(private readonly store: InMemoryStore) {}

  publish(event: RunEvent): void {
    this.store.appendRunEvent(event.runId, event);
    this.emitter.emit(event.runId, event);
    this.emitter.emit("all", event);
    logger.info(
      {
        event: event.type,
        runId: event.runId,
        traceId: event.traceId,
        projectId: event.projectId,
        latencyMs: event.latencyMs,
        costEstimate: event.costEstimate,
        payload: event.payload
      },
      "run event",
    );
    for (const sink of this.sinks) {
      Promise.resolve(sink(event)).catch((error) => {
        logger.warn({ error, eventType: event.type }, "telemetry sink publish failed");
      });
    }
  }

  getRunEvents(runId: string): RunEvent[] {
    return this.store.getRunEvents(runId);
  }

  subscribe(runId: string, listener: (event: RunEvent) => void): () => void {
    this.emitter.on(runId, listener);
    return () => {
      this.emitter.off(runId, listener);
    };
  }

  subscribeAll(listener: (event: RunEvent) => void): () => void {
    this.emitter.on("all", listener);
    return () => {
      this.emitter.off("all", listener);
    };
  }

  registerSink(sink: (event: RunEvent) => void | Promise<void>): void {
    this.sinks.push(sink);
  }
}
