import type { RunRecord } from "../../domain/types.js";

type ChannelMetrics = {
  total: number;
  completed: number;
  failed: number;
  blocked: number;
  latencies: number[];
};

export type CanaryConfig = {
  enabled: boolean;
  trafficPercent: number;
  candidateModel?: string;
  rollbackThresholds: {
    maxErrorRateDelta: number;
    maxLatencyMultiplier: number;
    minSamples: number;
  };
};

export type CanaryState = {
  config: CanaryConfig;
  baseline: ChannelMetrics;
  canary: ChannelMetrics;
  lastRollback?: {
    at: string;
    reason: string;
  };
};

const emptyMetrics = (): ChannelMetrics => ({
  total: 0,
  completed: 0,
  failed: 0,
  blocked: 0,
  latencies: []
});

const toP95 = (latencies: number[]): number => {
  if (latencies.length === 0) {
    return 0;
  }
  const sorted = [...latencies].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1);
  return sorted[idx] ?? 0;
};

const ratio = (num: number, den: number): number => (den <= 0 ? 0 : num / den);

export class CanaryService {
  private readonly state: CanaryState;

  constructor(defaultModel?: string) {
    this.state = {
      config: {
        enabled: false,
        trafficPercent: 0,
        candidateModel: defaultModel,
        rollbackThresholds: {
          maxErrorRateDelta: 0.05,
          maxLatencyMultiplier: 1.25,
          minSamples: 20
        }
      },
      baseline: emptyMetrics(),
      canary: emptyMetrics()
    };
  }

  getState(): CanaryState {
    return {
      config: { ...this.state.config, rollbackThresholds: { ...this.state.config.rollbackThresholds } },
      baseline: { ...this.state.baseline, latencies: [...this.state.baseline.latencies] },
      canary: { ...this.state.canary, latencies: [...this.state.canary.latencies] },
      lastRollback: this.state.lastRollback ? { ...this.state.lastRollback } : undefined
    };
  }

  updateConfig(input: Partial<CanaryConfig>): CanaryState {
    if (typeof input.enabled === "boolean") {
      this.state.config.enabled = input.enabled;
    }
    if (typeof input.trafficPercent === "number") {
      this.state.config.trafficPercent = Math.max(0, Math.min(100, Math.floor(input.trafficPercent)));
    }
    if (typeof input.candidateModel === "string") {
      this.state.config.candidateModel = input.candidateModel;
    }
    if (input.rollbackThresholds) {
      this.state.config.rollbackThresholds = {
        ...this.state.config.rollbackThresholds,
        ...input.rollbackThresholds
      };
    }
    return this.getState();
  }

  assignRun(runId: string, baselineModel: string): { channel: "baseline" | "canary"; modelHint: string } {
    if (
      !this.state.config.enabled ||
      !this.state.config.candidateModel ||
      this.state.config.trafficPercent <= 0
    ) {
      return { channel: "baseline", modelHint: baselineModel };
    }

    const bucket = this.hashPercent(runId);
    if (bucket < this.state.config.trafficPercent) {
      return {
        channel: "canary",
        modelHint: this.state.config.candidateModel
      };
    }

    return {
      channel: "baseline",
      modelHint: baselineModel
    };
  }

  recordRun(run: RunRecord): void {
    const metrics = run.releaseChannel === "canary" ? this.state.canary : this.state.baseline;
    metrics.total += 1;

    if (run.status === "completed") {
      metrics.completed += 1;
    } else if (run.status === "failed") {
      metrics.failed += 1;
    } else if (run.status === "blocked") {
      metrics.blocked += 1;
    }

    if (run.startedAt && run.completedAt) {
      const latency = new Date(run.completedAt).getTime() - new Date(run.startedAt).getTime();
      if (Number.isFinite(latency) && latency > 0) {
        metrics.latencies.push(latency);
        if (metrics.latencies.length > 500) {
          metrics.latencies.shift();
        }
      }
    }

    this.autoRollbackIfNeeded();
  }

  private autoRollbackIfNeeded(): void {
    if (!this.state.config.enabled) {
      return;
    }

    const minSamples = this.state.config.rollbackThresholds.minSamples;
    if (this.state.canary.total < minSamples || this.state.baseline.total < minSamples) {
      return;
    }

    const canaryErrorRate = ratio(this.state.canary.failed, this.state.canary.total);
    const baselineErrorRate = ratio(this.state.baseline.failed, this.state.baseline.total);
    const errorDelta = canaryErrorRate - baselineErrorRate;

    const canaryLatency = toP95(this.state.canary.latencies);
    const baselineLatency = toP95(this.state.baseline.latencies);
    const latencyMultiplier = baselineLatency > 0 ? canaryLatency / baselineLatency : 1;

    const errorTooHigh = errorDelta > this.state.config.rollbackThresholds.maxErrorRateDelta;
    const latencyTooHigh = latencyMultiplier > this.state.config.rollbackThresholds.maxLatencyMultiplier;

    if (!errorTooHigh && !latencyTooHigh) {
      return;
    }

    const reason = errorTooHigh
      ? `error delta ${errorDelta.toFixed(3)} exceeded threshold`
      : `latency multiplier ${latencyMultiplier.toFixed(3)} exceeded threshold`;

    this.state.config.enabled = false;
    this.state.config.trafficPercent = 0;
    this.state.lastRollback = {
      at: new Date().toISOString(),
      reason
    };
  }

  private hashPercent(value: string): number {
    let hash = 0;
    for (let i = 0; i < value.length; i += 1) {
      hash = (hash * 31 + value.charCodeAt(i)) >>> 0;
    }
    return hash % 100;
  }
}
