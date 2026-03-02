import { EventEmitter } from "node:events";
import type { RunEvent } from "../../domain/types.js";
import { InMemoryStore } from "../../store/inMemoryStore.js";
import { logger } from "./logger.js";

export class TelemetryService {
  private readonly emitter = new EventEmitter();

  constructor(private readonly store: InMemoryStore) {}

  publish(event: RunEvent): void {
    this.store.appendRunEvent(event.runId, event);
    this.emitter.emit(event.runId, event);
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
}
