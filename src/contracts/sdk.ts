export type JSONSchema = Record<string, unknown>;

export type ToolScope = "read" | "write" | "admin" | "payment";

export type ToolContext = {
  traceId: string;
  runId: string;
  sessionId: string;
  projectId: string;
  userId: string;
};

export type ToolResult = {
  output: unknown;
  metadata?: Record<string, string | number | boolean>;
};

export type ToolAdapter = {
  toolId: string;
  description: string;
  inputSchema: JSONSchema;
  outputSchema: JSONSchema;
  timeoutMs: number;
  scopes?: ToolScope[];
  execute: (input: unknown, ctx: ToolContext) => Promise<ToolResult>;
};

export type ContextChunk = {
  id: string;
  source: string;
  content: string;
  score?: number;
};

export type ContextProvider = {
  providerId: string;
  fetch: (sessionId: string, query: string, limit: number) => Promise<ContextChunk[]>;
};

export type PolicyAction =
  | "message_ingress"
  | "plan_generation"
  | "tool_execution"
  | "model_output"
  | "feedback_ingress";

export type PolicyEvent = {
  action: PolicyAction;
  projectId: string;
  sessionId?: string;
  runId?: string;
  userId?: string;
  payload: Record<string, unknown>;
  requiredScopes?: ToolScope[];
};

export type PolicyDecision = {
  allow: boolean;
  reasonCode: string;
  details?: string;
  decisionId: string;
};

export type PolicyHook = {
  hookId: string;
  evaluate: (event: PolicyEvent) => Promise<PolicyDecision | null>;
};
