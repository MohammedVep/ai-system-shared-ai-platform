import type { Env } from "../../config/env.js";

type BudgetWindow = {
  key: string;
  totalUsd: number;
};

const dayKey = (date = new Date()): string => date.toISOString().slice(0, 10);

const normalizeCost = (value: number): number => Number(Math.max(0, value).toFixed(8));

export class CostService {
  private readonly projectDailySpend = new Map<string, BudgetWindow>();
  private readonly runCost = new Map<string, number>();

  constructor(private readonly env: Env) {}

  canSpend(projectId: string, proposedUsd: number): { allowed: boolean; remainingUsd: number; limitUsd: number } {
    const limitUsd = this.projectBudget(projectId);
    if (!this.env.enforceCostBudget) {
      return { allowed: true, remainingUsd: Number.POSITIVE_INFINITY, limitUsd };
    }

    const window = this.getOrCreateWindow(projectId);
    const remainingUsd = normalizeCost(limitUsd - window.totalUsd);
    return {
      allowed: remainingUsd >= proposedUsd,
      remainingUsd,
      limitUsd
    };
  }

  recordCost(projectId: string, runId: string, deltaUsd: number): void {
    const normalized = normalizeCost(deltaUsd);
    if (normalized <= 0) {
      return;
    }

    const window = this.getOrCreateWindow(projectId);
    window.totalUsd = normalizeCost(window.totalUsd + normalized);
    this.projectDailySpend.set(projectId, window);

    const currentRun = this.runCost.get(runId) ?? 0;
    this.runCost.set(runId, normalizeCost(currentRun + normalized));
  }

  runTotal(runId: string): number {
    return this.runCost.get(runId) ?? 0;
  }

  projectSummary(projectId: string): {
    day: string;
    totalUsd: number;
    limitUsd: number;
    remainingUsd: number;
    utilizationPct: number;
  } {
    const window = this.getOrCreateWindow(projectId);
    const limitUsd = this.projectBudget(projectId);
    const remainingUsd = normalizeCost(limitUsd - window.totalUsd);
    const utilizationPct = limitUsd > 0 ? Number(((window.totalUsd / limitUsd) * 100).toFixed(2)) : 0;
    return {
      day: window.key,
      totalUsd: window.totalUsd,
      limitUsd,
      remainingUsd,
      utilizationPct
    };
  }

  globalSummary(): {
    day: string;
    totalUsd: number;
    projects: Array<{ projectId: string; totalUsd: number; limitUsd: number; remainingUsd: number }>;
  } {
    const today = dayKey();
    const projects = [...this.projectDailySpend.entries()]
      .filter(([, window]) => window.key === today)
      .map(([projectId, window]) => {
        const limitUsd = this.projectBudget(projectId);
        return {
          projectId,
          totalUsd: window.totalUsd,
          limitUsd,
          remainingUsd: normalizeCost(limitUsd - window.totalUsd)
        };
      });

    return {
      day: today,
      totalUsd: Number(projects.reduce((acc, project) => acc + project.totalUsd, 0).toFixed(8)),
      projects
    };
  }

  private projectBudget(projectId: string): number {
    return this.env.projectDailyCostBudgets[projectId] ?? this.env.defaultDailyCostBudgetUsd;
  }

  private getOrCreateWindow(projectId: string): BudgetWindow {
    const today = dayKey();
    const existing = this.projectDailySpend.get(projectId);
    if (existing && existing.key === today) {
      return existing;
    }

    const next = {
      key: today,
      totalUsd: 0
    };
    this.projectDailySpend.set(projectId, next);
    return next;
  }
}
