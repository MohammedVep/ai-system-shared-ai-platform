import type { ContextChunk } from "../contracts/sdk.js";

export type Session = {
  id: string;
  projectId: string;
  userId: string;
  channel: string;
  metadata?: Record<string, string>;
  createdAt: string;
  messages: SessionMessage[];
};

export type SessionMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: string;
};

export type RunStatus = "queued" | "running" | "completed" | "failed" | "blocked";

export type RunTerminationReason =
  | "completed"
  | "blocked_by_policy"
  | "tool_failure_exhausted"
  | "insufficient_context"
  | "cost_budget_exceeded"
  | "timeout"
  | "internal_error";

export type PlanStep = {
  id: string;
  type: "tool_call" | "model_response";
  description: string;
  toolId?: string;
  input?: unknown;
  completed: boolean;
  error?: string;
};

export type PlannerOutput = {
  confidence: number;
  needsClarification: boolean;
  plan: PlanStep[];
};

export type RunRecord = {
  id: string;
  traceId: string;
  sessionId: string;
  projectId: string;
  userId: string;
  actorScopes: string[];
  releaseChannel: "baseline" | "canary";
  modelHint?: string;
  status: RunStatus;
  toolMode: "auto" | "required" | "none";
  responseMode: "stream" | "sync";
  query: string;
  contextRefs?: string[];
  context: ContextChunk[];
  plan: PlanStep[];
  attempts: number;
  steps: PlanStep[];
  finalAnswer?: string;
  costUsd?: number;
  terminationReason?: RunTerminationReason;
  error?: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  idempotencyKey?: string;
};

export type FeedbackRecord = {
  id: string;
  runId: string;
  projectId: string;
  rating: "up" | "down";
  labels: string[];
  note?: string;
  createdAt: string;
};

export type RunEventType =
  | "RunStarted"
  | "PlanGenerated"
  | "ToolInvoked"
  | "ToolCompleted"
  | "PolicyBlocked"
  | "Token"
  | "RunCompleted"
  | "RunFailed";

export type RunEvent = {
  eventId: string;
  type: RunEventType;
  traceId: string;
  runId: string;
  projectId: string;
  actor: string;
  model: string;
  latencyMs: number;
  costEstimate: number;
  timestamp: string;
  payload: Record<string, unknown>;
};

export type ToolAuditEntry = {
  id: string;
  traceId: string;
  runId: string;
  projectId: string;
  requestor: string;
  toolId: string;
  inputHash: string;
  resultHash?: string;
  decisionId: string;
  timestamp: string;
};
