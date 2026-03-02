import type { Env } from "../../config/env.js";
import type { ToolScope } from "../../contracts/sdk.js";
import type { PlanStep, RunRecord, RunTerminationReason } from "../../domain/types.js";
import { InMemoryStore } from "../../store/inMemoryStore.js";
import { sha256 } from "../../utils/hash.js";
import { newId } from "../../utils/id.js";
import { retryTransient } from "../../utils/retry.js";
import type { ModelRouter } from "../model/modelRouter.js";
import type { CostService } from "../ops/costService.js";
import type { PolicyEngine } from "../policy/policyEngine.js";
import { ToolExecutionError, ToolValidationError, type ToolBroker } from "../tool/toolBroker.js";
import type { TelemetryService } from "../telemetry/telemetryService.js";

export type ExecutionResult = {
  finalAnswer?: string;
  terminated: boolean;
  terminationReason?: RunTerminationReason;
  error?: string;
};

export class Executor {
  constructor(
    private readonly env: Env,
    private readonly store: InMemoryStore,
    private readonly toolBroker: ToolBroker,
    private readonly policyEngine: PolicyEngine,
    private readonly modelRouter: ModelRouter,
    private readonly costService: CostService,
    private readonly telemetry: TelemetryService,
  ) {}

  async execute(run: RunRecord, plan: PlanStep[], actorScopes: string[]): Promise<ExecutionResult> {
    const toolOutputs: Array<{ toolId: string; output: unknown }> = [];
    let finalAnswer: string | undefined;
    run.costUsd = this.costService.runTotal(run.id);

    for (const step of plan) {
      if (step.type === "tool_call") {
        if (!step.toolId) {
          step.error = "Missing tool id";
          continue;
        }

        const tool = this.toolBroker.getTool(run.projectId, step.toolId);
        if (!tool) {
          step.error = `Tool ${step.toolId} not found`;
          return {
            terminated: true,
            terminationReason: "tool_failure_exhausted",
            error: step.error
          };
        }

        const policyDecision = await this.policyEngine.evaluate({
          action: "tool_execution",
          projectId: run.projectId,
          sessionId: run.sessionId,
          runId: run.id,
          userId: run.userId,
          requiredScopes: tool.scopes,
          payload: {
            toolId: step.toolId,
            actorScopes
          }
        });

        if (!policyDecision.allow) {
          this.telemetry.publish({
            eventId: newId(),
            type: "PolicyBlocked",
            traceId: run.traceId,
            runId: run.id,
            projectId: run.projectId,
            actor: "policy-engine",
            model: this.modelRouter.currentProviderName(),
            latencyMs: 0,
            costEstimate: 0,
            timestamp: new Date().toISOString(),
            payload: {
              reasonCode: policyDecision.reasonCode,
              details: policyDecision.details,
              toolId: step.toolId
            }
          });
          return {
            terminated: true,
            terminationReason: "blocked_by_policy",
            error: policyDecision.reasonCode
          };
        }

        this.telemetry.publish({
          eventId: newId(),
          type: "ToolInvoked",
          traceId: run.traceId,
          runId: run.id,
          projectId: run.projectId,
          actor: "executor",
          model: this.modelRouter.currentProviderName(),
          latencyMs: 0,
          costEstimate: 0,
          timestamp: new Date().toISOString(),
          payload: {
            toolId: step.toolId,
            input: step.input ?? {}
          }
        });

        try {
          if (!this.allowCost(run.projectId, this.env.toolCallCostUsd)) {
            run.costUsd = this.costService.runTotal(run.id);
            return {
              terminated: true,
              terminationReason: "cost_budget_exceeded",
              error: "daily_cost_budget_exceeded"
            };
          }

          const result = await retryTransient(
            () =>
              this.toolBroker.executeTool(run.projectId, step.toolId!, step.input ?? {}, {
                traceId: run.traceId,
                runId: run.id,
                sessionId: run.sessionId,
                projectId: run.projectId,
                userId: run.userId
              }),
            {
              retries: this.env.retryTransient,
              baseDelayMs: this.env.retryBaseDelayMs,
              maxDelayMs: this.env.retryMaxDelayMs
            },
            (error) => error instanceof ToolExecutionError && error.transient,
          );

          const outputString = JSON.stringify(result.output);
          this.store.saveToolAudit({
            id: newId(),
            traceId: run.traceId,
            runId: run.id,
            projectId: run.projectId,
            requestor: run.userId,
            toolId: step.toolId,
            inputHash: sha256(JSON.stringify(step.input ?? {})),
            resultHash: sha256(outputString),
            decisionId: policyDecision.decisionId,
            timestamp: new Date().toISOString()
          });

          this.telemetry.publish({
            eventId: newId(),
            type: "ToolCompleted",
            traceId: run.traceId,
            runId: run.id,
            projectId: run.projectId,
            actor: "executor",
            model: this.modelRouter.currentProviderName(),
            latencyMs: 0,
            costEstimate: 0,
            timestamp: new Date().toISOString(),
            payload: {
              toolId: step.toolId,
              output: result.output,
              incrementalCostUsd: this.env.toolCallCostUsd
            }
          });

          toolOutputs.push({ toolId: step.toolId, output: result.output });
          this.costService.recordCost(run.projectId, run.id, this.env.toolCallCostUsd);
          run.costUsd = this.costService.runTotal(run.id);
          step.completed = true;
        } catch (error) {
          if (error instanceof ToolValidationError) {
            step.error = error.message;
            return {
              terminated: true,
              terminationReason: "tool_failure_exhausted",
              error: error.message
            };
          }
          if (error instanceof ToolExecutionError) {
            step.error = error.message;
            return {
              terminated: true,
              terminationReason: "tool_failure_exhausted",
              error: error.message
            };
          }
          step.error = error instanceof Error ? error.message : "Unknown tool error";
          return {
            terminated: true,
            terminationReason: "tool_failure_exhausted",
            error: step.error
          };
        }
      }

      if (step.type === "model_response") {
        const projectedModelSpend = 0.0005;
        if (!this.allowCost(run.projectId, projectedModelSpend)) {
          run.costUsd = this.costService.runTotal(run.id);
          return {
            terminated: true,
            terminationReason: "cost_budget_exceeded",
            error: "daily_cost_budget_exceeded"
          };
        }

        const response = await retryTransient(
          () =>
            this.modelRouter.generate({
              projectId: run.projectId,
              traceId: run.traceId,
              runId: run.id,
              modelHint: run.modelHint,
              messages: [
                {
                  role: "system",
                  content:
                    "You are a project AI gateway assistant. Answer clearly, follow policy, and only use provided facts."
                },
                {
                  role: "user",
                  content: this.buildModelPrompt(run.query, run.context, toolOutputs)
                }
              ]
            }),
          {
            retries: this.env.retryTransient,
            baseDelayMs: this.env.retryBaseDelayMs,
            maxDelayMs: this.env.retryMaxDelayMs
          },
          isTransientModelError,
        );

        const redacted = this.policyEngine.sanitizeOutput(response.text);
        const outputDecision = await this.policyEngine.evaluate({
          action: "model_output",
          projectId: run.projectId,
          sessionId: run.sessionId,
          runId: run.id,
          userId: run.userId,
          payload: { output: redacted }
        });

        if (!outputDecision.allow) {
          return {
            terminated: true,
            terminationReason: "blocked_by_policy",
            error: outputDecision.reasonCode
          };
        }

        for (const token of redacted.split(" ")) {
          this.telemetry.publish({
            eventId: newId(),
            type: "Token",
            traceId: run.traceId,
            runId: run.id,
            projectId: run.projectId,
            actor: "model",
            model: response.model,
            latencyMs: response.latencyMs,
            costEstimate: response.costEstimate,
            timestamp: new Date().toISOString(),
            payload: { token }
          });
        }

        this.costService.recordCost(run.projectId, run.id, response.costEstimate);
        run.costUsd = this.costService.runTotal(run.id);
        finalAnswer = redacted;
        step.completed = true;
      }
    }

    run.costUsd = this.costService.runTotal(run.id);

    return {
      finalAnswer,
      terminated: false
    };
  }

  private buildModelPrompt(
    query: string,
    context: RunRecord["context"],
    toolOutputs: Array<{ toolId: string; output: unknown }>,
  ): string {
    const contextText = context
      .map((chunk) => `- [${chunk.source}] ${chunk.content}`)
      .slice(0, 8)
      .join("\n");
    const toolText = toolOutputs
      .map((item) => `- ${item.toolId}: ${JSON.stringify(item.output)}`)
      .join("\n");

    return [
      `User query: ${query}`,
      "Context:",
      contextText || "- none",
      "Tool outputs:",
      toolText || "- none"
    ].join("\n");
  }

  private allowCost(projectId: string, proposedUsd: number): boolean {
    const decision = this.costService.canSpend(projectId, proposedUsd);
    return decision.allowed;
  }
}

const isTransientModelError = (error: unknown): boolean => {
  if (!(error instanceof Error)) {
    return false;
  }
  const message = error.message.toLowerCase();
  return (
    message.includes("timeout") ||
    message.includes("timed out") ||
    message.includes("rate limit") ||
    message.includes("temporarily unavailable") ||
    message.includes("overloaded")
  );
};
