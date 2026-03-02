import type { Env } from "../../config/env.js";
import type { PolicyDecision, PolicyEvent, PolicyHook, ToolScope } from "../../contracts/sdk.js";
import { newId } from "../../utils/id.js";
import { containsPromptInjection, redactPii } from "./guardrails.js";

const PRIVILEGED_SCOPES = new Set<ToolScope>(["write", "admin", "payment"]);

export class PolicyEngine {
  private healthy = true;
  private readonly hooks: PolicyHook[] = [];

  constructor(private readonly env: Env) {}

  registerHook(hook: PolicyHook): void {
    this.hooks.push(hook);
  }

  markUnhealthy(): void {
    this.healthy = false;
  }

  markHealthy(): void {
    this.healthy = true;
  }

  sanitizeOutput(output: string): string {
    return redactPii(output);
  }

  async evaluate(event: PolicyEvent): Promise<PolicyDecision> {
    const decisionId = newId();

    const privilegeRequired = (event.requiredScopes ?? []).some((scope) => PRIVILEGED_SCOPES.has(scope));
    if (!this.healthy && privilegeRequired) {
      return {
        allow: false,
        reasonCode: "policy_engine_unavailable_fail_closed",
        details: "Policy engine unavailable for privileged action",
        decisionId
      };
    }

    const builtInDecision = this.applyBuiltInRules(event, decisionId);
    if (!builtInDecision.allow) {
      return builtInDecision;
    }

    for (const hook of this.hooks) {
      try {
        const result = await hook.evaluate(event);
        if (result && !result.allow) {
          return {
            ...result,
            decisionId
          };
        }
      } catch {
        if (privilegeRequired || this.env.failClosedScopes.size > 0) {
          return {
            allow: false,
            reasonCode: "policy_hook_failure",
            details: `Policy hook ${hook.hookId} failed`,
            decisionId
          };
        }
      }
    }

    return {
      allow: true,
      reasonCode: "allow",
      decisionId
    };
  }

  private applyBuiltInRules(event: PolicyEvent, decisionId: string): PolicyDecision {
    const textPayload = JSON.stringify(event.payload);

    if (
      (event.action === "message_ingress" || event.action === "plan_generation") &&
      containsPromptInjection(textPayload)
    ) {
      return {
        allow: true,
        reasonCode: "allow_with_sanitization",
        details: "Prompt injection patterns detected and sanitized",
        decisionId
      };
    }

    if (event.action === "tool_execution") {
      const allowedTools = this.env.projectToolAllowlist[event.projectId] ?? [];
      const toolId = String(event.payload.toolId ?? "");

      if (allowedTools.length > 0 && !allowedTools.includes(toolId)) {
        return {
          allow: false,
          reasonCode: "tool_not_allowlisted",
          details: `Tool ${toolId} is not allowlisted for project ${event.projectId}`,
          decisionId
        };
      }

      const requiredScopes = event.requiredScopes ?? [];
      const hasPrivileged = requiredScopes.some((scope) => PRIVILEGED_SCOPES.has(scope));
      const actorScopes = new Set(
        (event.payload.actorScopes as string[] | undefined) ?? ["read"],
      );
      if (hasPrivileged) {
        const hasScope = requiredScopes.every((scope) => actorScopes.has(scope));
        if (!hasScope) {
          return {
            allow: false,
            reasonCode: "insufficient_scope",
            details: "Actor lacks required privileged scope",
            decisionId
          };
        }
      }
    }

    return {
      allow: true,
      reasonCode: "allow",
      decisionId
    };
  }
}
