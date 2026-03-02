import type { PlanStep, PlannerOutput } from "../../domain/types.js";
import { newId } from "../../utils/id.js";
import type { ToolAdapter } from "../../contracts/sdk.js";

const TOOL_DIRECTIVE_REGEX = /\/tool\s+([a-zA-Z0-9_-]+)\s*(\{[\s\S]*\})?/;

export class Planner {
  constructor(private readonly maxSteps: number) {}

  plan(params: {
    query: string;
    toolMode: "auto" | "required" | "none";
    availableTools: ToolAdapter[];
  }): PlannerOutput {
    const plan: PlanStep[] = [];

    if (/\b(need clarification|not enough info|unsure)\b/i.test(params.query)) {
      return {
        confidence: 0.35,
        needsClarification: true,
        plan: []
      };
    }

    const toolDirective = params.toolMode === "none" ? null : this.parseToolDirective(params.query);

    if (toolDirective) {
      plan.push({
        id: newId(),
        type: "tool_call",
        description: `Invoke tool ${toolDirective.toolId}`,
        toolId: toolDirective.toolId,
        input: toolDirective.input,
        completed: false
      });
    } else if (params.toolMode === "required") {
      const defaultTool = params.availableTools[0];
      if (!defaultTool) {
        return {
          confidence: 0.4,
          needsClarification: true,
          plan: []
        };
      }
      plan.push({
        id: newId(),
        type: "tool_call",
        description: `Invoke required tool ${defaultTool.toolId}`,
        toolId: defaultTool.toolId,
        input: {},
        completed: false
      });
    }

    plan.push({
      id: newId(),
      type: "model_response",
      description: "Synthesize final answer",
      completed: false
    });

    const trimmedPlan = plan.slice(0, this.maxSteps);
    return {
      confidence: trimmedPlan.length > 0 ? 0.78 : 0.45,
      needsClarification: false,
      plan: trimmedPlan
    };
  }

  private parseToolDirective(query: string): { toolId: string; input: unknown } | null {
    const match = query.match(TOOL_DIRECTIVE_REGEX);
    if (!match) {
      return null;
    }

    const toolId = match[1];
    const inputRaw = match[2];
    if (!inputRaw) {
      return { toolId, input: {} };
    }

    try {
      const input = JSON.parse(inputRaw) as unknown;
      return { toolId, input };
    } catch {
      return { toolId, input: {} };
    }
  }
}
