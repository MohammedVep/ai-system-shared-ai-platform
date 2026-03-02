import type { PlanStep } from "../../domain/types.js";
import { redactPii } from "../policy/guardrails.js";

export type VerificationResult = {
  ok: boolean;
  reason?: "missing_answer" | "incomplete_steps" | "output_not_sanitized";
};

export class Verifier {
  verify(plan: PlanStep[], answer: string | undefined): VerificationResult {
    if (!answer || answer.trim().length === 0) {
      return {
        ok: false,
        reason: "missing_answer"
      };
    }

    if (plan.some((step) => !step.completed)) {
      return {
        ok: false,
        reason: "incomplete_steps"
      };
    }

    if (redactPii(answer) !== answer) {
      return {
        ok: false,
        reason: "output_not_sanitized"
      };
    }

    return { ok: true };
  }
}
