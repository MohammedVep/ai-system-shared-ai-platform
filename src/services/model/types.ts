export type ModelMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type ModelGenerateRequest = {
  projectId: string;
  traceId: string;
  runId: string;
  messages: ModelMessage[];
  modelHint?: string;
};

export type ModelGenerateResult = {
  text: string;
  model: string;
  latencyMs: number;
  costEstimate: number;
};

export interface ModelProvider {
  providerName: string;
  generate(request: ModelGenerateRequest): Promise<ModelGenerateResult>;
}
