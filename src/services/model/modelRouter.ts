import type { Env } from "../../config/env.js";
import type { ModelGenerateRequest, ModelGenerateResult, ModelProvider } from "./types.js";
import { MockModelProvider } from "./mockProvider.js";
import { OpenAiModelProvider } from "./openAiProvider.js";

export class ModelRouter {
  private readonly provider: ModelProvider;
  private readonly defaultModelName: string;

  constructor(env: Env) {
    this.defaultModelName = env.openAiModel;
    this.provider = env.openAiApiKey
      ? new OpenAiModelProvider(env.openAiApiKey, env.openAiModel)
      : new MockModelProvider();
  }

  async generate(request: ModelGenerateRequest): Promise<ModelGenerateResult> {
    return this.provider.generate(request);
  }

  currentProviderName(): string {
    return this.provider.providerName;
  }

  defaultModel(): string {
    return this.defaultModelName;
  }
}
