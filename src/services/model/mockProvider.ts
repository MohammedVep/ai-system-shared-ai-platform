import type { ModelGenerateRequest, ModelGenerateResult, ModelProvider } from "./types.js";

export class MockModelProvider implements ModelProvider {
  providerName = "mock";

  async generate(request: ModelGenerateRequest): Promise<ModelGenerateResult> {
    const start = Date.now();
    const latestUser = [...request.messages].reverse().find((message) => message.role === "user");
    const text = latestUser
      ? `Mock response: ${latestUser.content}`
      : "Mock response: no user message provided.";
    return {
      text,
      model: "mock-v1",
      latencyMs: Date.now() - start,
      costEstimate: 0
    };
  }
}
