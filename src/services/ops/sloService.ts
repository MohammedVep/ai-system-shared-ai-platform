import type { InMemoryStore } from "../../store/inMemoryStore.js";

const percentile = (values: number[], p: number): number => {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1);
  return sorted[idx] ?? 0;
};

export class SloService {
  constructor(private readonly store: InMemoryStore) {}

  buildDashboard(): {
    generatedAt: string;
    availabilityPct: number;
    orchestratorSuccessPct: number;
    policyBlockRatePct: number;
    firstTokenP95Ms: number;
    runCount: number;
    statusBreakdown: Record<string, number>;
  } {
    const runs = this.store.getAllRuns();
    const summary = this.store.getPlatformSummary();
    const events = this.store.getAllRunEvents();

    const completed = summary.runStatusCounts.completed ?? 0;
    const failed = summary.runStatusCounts.failed ?? 0;
    const blocked = summary.runStatusCounts.blocked ?? 0;

    const successDenominator = completed + failed;
    const orchestratorSuccessPct = successDenominator > 0 ? (completed / successDenominator) * 100 : 100;

    const totalRuns = summary.runCount;
    const policyBlockRatePct = totalRuns > 0 ? (blocked / totalRuns) * 100 : 0;

    const firstTokenByRun = new Map<string, number>();
    const runStartedAtByRun = new Map<string, number>();

    for (const event of events) {
      const ts = new Date(event.timestamp).getTime();
      if (event.type === "RunStarted") {
        runStartedAtByRun.set(event.runId, ts);
      }
      if (event.type === "Token" && !firstTokenByRun.has(event.runId)) {
        firstTokenByRun.set(event.runId, ts);
      }
    }

    const firstTokenLatencies: number[] = [];
    for (const [runId, tokenTs] of firstTokenByRun) {
      const startTs = runStartedAtByRun.get(runId);
      if (startTs && tokenTs >= startTs) {
        firstTokenLatencies.push(tokenTs - startTs);
      }
    }

    const availabilityPct = Math.max(0, 100 - (failed / Math.max(totalRuns, 1)) * 100);

    return {
      generatedAt: new Date().toISOString(),
      availabilityPct: Number(availabilityPct.toFixed(2)),
      orchestratorSuccessPct: Number(orchestratorSuccessPct.toFixed(2)),
      policyBlockRatePct: Number(policyBlockRatePct.toFixed(2)),
      firstTokenP95Ms: Number(percentile(firstTokenLatencies, 0.95).toFixed(0)),
      runCount: runs.length,
      statusBreakdown: summary.runStatusCounts
    };
  }
}
