import OpenAI from "openai";
import type { ModelGenerateRequest, ModelGenerateResult, ModelProvider } from "./types.js";

export class OpenAiModelProvider implements ModelProvider {
  providerName = "openai";
  private readonly client: OpenAI;

  constructor(
    apiKey: string,
    private readonly defaultModel: string,
  ) {
    this.client = new OpenAI({ apiKey });
  }

  async generate(request: ModelGenerateRequest): Promise<ModelGenerateResult> {
    const startedAt = Date.now();
    const completion = await this.client.chat.completions.create({
      model: request.modelHint ?? this.defaultModel,
      messages: request.messages.map((message) => ({
        role: message.role,
        content: message.content
      })),
      temperature: 0.2
    });

    const text = completion.choices[0]?.message?.content ?? "";
    const totalTokens = completion.usage?.total_tokens ?? 0;

    return {
      text,
      model: completion.model,
      latencyMs: Date.now() - startedAt,
      costEstimate: Number((totalTokens * 0.000002).toFixed(6))
    };
  }
}
