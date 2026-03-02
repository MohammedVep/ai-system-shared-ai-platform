import type {
  FeedbackRecord,
  RunEvent,
  RunRecord,
  Session,
  SessionMessage,
  ToolAuditEntry
} from "../domain/types.js";

export class InMemoryStore {
  private readonly sessions = new Map<string, Session>();
  private readonly runs = new Map<string, RunRecord>();
  private readonly feedback = new Map<string, FeedbackRecord>();
  private readonly runEvents = new Map<string, RunEvent[]>();
  private readonly idempotency = new Map<string, string>();
  private readonly toolAudit = new Map<string, ToolAuditEntry>();

  createSession(session: Session): Session {
    this.sessions.set(session.id, session);
    return session;
  }

  getSession(sessionId: string): Session | undefined {
    return this.sessions.get(sessionId);
  }

  findSessionByProjectUser(projectId: string, userId: string): Session | undefined {
    return [...this.sessions.values()].find(
      (session) => session.projectId === projectId && session.userId === userId,
    );
  }

  appendMessage(sessionId: string, message: SessionMessage): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }
    session.messages.push(message);
  }

  createRun(run: RunRecord): RunRecord {
    this.runs.set(run.id, run);
    return run;
  }

  updateRun(run: RunRecord): void {
    this.runs.set(run.id, run);
  }

  getRun(runId: string): RunRecord | undefined {
    return this.runs.get(runId);
  }

  getAllRuns(): RunRecord[] {
    return [...this.runs.values()];
  }

  setIdempotentRun(sessionId: string, key: string, runId: string): void {
    this.idempotency.set(`${sessionId}:${key}`, runId);
  }

  getIdempotentRun(sessionId: string, key: string): string | undefined {
    return this.idempotency.get(`${sessionId}:${key}`);
  }

  saveFeedback(record: FeedbackRecord): void {
    this.feedback.set(record.id, record);
  }

  getFeedbackByRun(runId: string): FeedbackRecord[] {
    return [...this.feedback.values()].filter((item) => item.runId === runId);
  }

  appendRunEvent(runId: string, event: RunEvent): void {
    const existing = this.runEvents.get(runId) ?? [];
    existing.push(event);
    this.runEvents.set(runId, existing);
  }

  getRunEvents(runId: string): RunEvent[] {
    return this.runEvents.get(runId) ?? [];
  }

  getAllRunEvents(): RunEvent[] {
    return [...this.runEvents.values()].flat();
  }

  saveToolAudit(entry: ToolAuditEntry): void {
    this.toolAudit.set(entry.id, entry);
  }

  getToolAuditByRun(runId: string): ToolAuditEntry[] {
    return [...this.toolAudit.values()].filter((item) => item.runId === runId);
  }

  getPlatformSummary(): {
    sessionCount: number;
    runCount: number;
    runStatusCounts: Record<string, number>;
    feedbackCount: number;
    auditEntryCount: number;
    totalEventCount: number;
    totalCostUsd: number;
  } {
    const runStatusCounts = [...this.runs.values()].reduce<Record<string, number>>((acc, run) => {
      acc[run.status] = (acc[run.status] ?? 0) + 1;
      return acc;
    }, {});

    const totalEventCount = [...this.runEvents.values()].reduce((acc, events) => acc + events.length, 0);
    const totalCostUsd = Number(
      [...this.runs.values()].reduce((acc, run) => acc + (run.costUsd ?? 0), 0).toFixed(8),
    );

    return {
      sessionCount: this.sessions.size,
      runCount: this.runs.size,
      runStatusCounts,
      feedbackCount: this.feedback.size,
      auditEntryCount: this.toolAudit.size,
      totalEventCount,
      totalCostUsd
    };
  }
}
