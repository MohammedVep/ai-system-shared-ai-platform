import type { Env } from "../../config/env.js";
import type { RunRecord, RunTerminationReason, SessionMessage } from "../../domain/types.js";
import { InMemoryStore } from "../../store/inMemoryStore.js";
import { newId } from "../../utils/id.js";
import type { ContextService } from "../context/contextService.js";
import { Executor } from "./executor.js";
import { Planner } from "./planner.js";
import { Verifier } from "./verifier.js";
import type { PolicyEngine } from "../policy/policyEngine.js";
import type { ToolBroker } from "../tool/toolBroker.js";
import type { ModelRouter } from "../model/modelRouter.js";
import type { TelemetryService } from "../telemetry/telemetryService.js";

export class Orchestrator {
  private readonly planner: Planner;
  private readonly verifier = new Verifier();
  private readonly executor: Executor;
  private readonly policyEngine: PolicyEngine;
  private readonly toolBroker: ToolBroker;

  constructor(
    private readonly env: Env,
    private readonly store: InMemoryStore,
    private readonly contextService: ContextService,
    policyEngine: PolicyEngine,
    toolBroker: ToolBroker,
    modelRouter: ModelRouter,
    private readonly telemetry: TelemetryService,
  ) {
    this.planner = new Planner(env.maxPlanSteps);
    this.executor = new Executor(env, store, toolBroker, policyEngine, modelRouter, telemetry);
    this.policyEngine = policyEngine;
    this.toolBroker = toolBroker;
  }

  async run(runId: string): Promise<void> {
    const run = this.store.getRun(runId);
    if (!run) {
      return;
    }

    run.status = "running";
    run.startedAt = new Date().toISOString();
    this.store.updateRun(run);

    this.telemetry.publish({
      eventId: newId(),
      type: "RunStarted",
      traceId: run.traceId,
      runId: run.id,
      projectId: run.projectId,
      actor: "orchestrator",
      model: "n/a",
      latencyMs: 0,
      costEstimate: 0,
      timestamp: new Date().toISOString(),
      payload: {
        query: run.query,
        toolMode: run.toolMode
      }
    });

    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => {
        reject(new Error("run_timeout"));
      }, this.env.runTimeoutMs);
    });

    try {
      await Promise.race([this.executeLoop(run), timeoutPromise]);
    } catch (error) {
      const isTimeout = error instanceof Error && error.message === "run_timeout";
      this.completeRun(run, {
        status: "failed",
        terminationReason: isTimeout ? "timeout" : "internal_error",
        error: isTimeout ? "Run exceeded timeout budget" : error instanceof Error ? error.message : "Unknown error"
      });
      return;
    }
  }

  private async executeLoop(run: RunRecord): Promise<void> {
    const maxAttempts = 2;
    const actorScopes = ["read"];

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      run.attempts = attempt;

      const ingressDecision = await this.policyEngine.evaluate({
        action: "message_ingress",
        projectId: run.projectId,
        sessionId: run.sessionId,
        runId: run.id,
        userId: run.userId,
        payload: {
          message: run.query
        }
      });
      if (!ingressDecision.allow) {
        this.completeRun(run, {
          status: "blocked",
          terminationReason: "blocked_by_policy",
          error: ingressDecision.reasonCode
        });
        return;
      }

      run.context = await this.contextService.buildContext({
        sessionId: run.sessionId,
        query: run.query,
        contextRefs: run.contextRefs
      });

      const planningDecision = await this.policyEngine.evaluate({
        action: "plan_generation",
        projectId: run.projectId,
        sessionId: run.sessionId,
        runId: run.id,
        userId: run.userId,
        payload: {
          query: run.query,
          contextCount: run.context.length
        }
      });
      if (!planningDecision.allow) {
        this.completeRun(run, {
          status: "blocked",
          terminationReason: "blocked_by_policy",
          error: planningDecision.reasonCode
        });
        return;
      }

      const planOutput = this.planner.plan({
        query: run.query,
        toolMode: run.toolMode,
        availableTools: this.toolBroker.listTools(run.projectId)
      });

      run.plan = planOutput.plan;
      run.steps = planOutput.plan;
      this.store.updateRun(run);

      this.telemetry.publish({
        eventId: newId(),
        type: "PlanGenerated",
        traceId: run.traceId,
        runId: run.id,
        projectId: run.projectId,
        actor: "planner",
        model: "rule-based-planner",
        latencyMs: 0,
        costEstimate: 0,
        timestamp: new Date().toISOString(),
        payload: {
          confidence: planOutput.confidence,
          stepCount: planOutput.plan.length,
          needsClarification: planOutput.needsClarification
        }
      });

      if (planOutput.needsClarification) {
        this.completeRun(run, {
          status: "failed",
          terminationReason: "insufficient_context",
          error: "Planner requested clarification"
        });
        return;
      }

      const result = await this.executor.execute(run, planOutput.plan, actorScopes);
      run.steps = planOutput.plan;
      this.store.updateRun(run);

      if (result.terminated) {
        const status = result.terminationReason === "blocked_by_policy" ? "blocked" : "failed";
        this.completeRun(run, {
          status,
          terminationReason: result.terminationReason ?? "internal_error",
          error: result.error
        });
        return;
      }

      const verification = this.verifier.verify(planOutput.plan, result.finalAnswer);
      if (!verification.ok) {
        if (attempt < maxAttempts) {
          continue;
        }
        this.completeRun(run, {
          status: "failed",
          terminationReason: "tool_failure_exhausted",
          error: verification.reason
        });
        return;
      }

      run.finalAnswer = result.finalAnswer;
      this.store.appendMessage(run.sessionId, this.asAssistantMessage(result.finalAnswer ?? ""));
      this.completeRun(run, {
        status: "completed",
        terminationReason: "completed"
      });
      return;
    }
  }

  private asAssistantMessage(content: string): SessionMessage {
    return {
      id: newId(),
      role: "assistant",
      content,
      createdAt: new Date().toISOString()
    };
  }

  private completeRun(
    run: RunRecord,
    payload: {
      status: "completed" | "failed" | "blocked";
      terminationReason: RunTerminationReason;
      error?: string;
    },
  ): void {
    run.status = payload.status;
    run.terminationReason = payload.terminationReason;
    run.error = payload.error;
    run.completedAt = new Date().toISOString();
    this.store.updateRun(run);

    const eventType = payload.status === "completed" ? "RunCompleted" : "RunFailed";
    this.telemetry.publish({
      eventId: newId(),
      type: eventType,
      traceId: run.traceId,
      runId: run.id,
      projectId: run.projectId,
      actor: "orchestrator",
      model: "n/a",
      latencyMs: 0,
      costEstimate: 0,
      timestamp: new Date().toISOString(),
      payload: {
        status: payload.status,
        terminationReason: payload.terminationReason,
        error: payload.error,
        answer: run.finalAnswer
      }
    });
  }
}
