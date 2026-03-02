import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().default("gpt-4o-mini"),
  AUTH_MODE: z.enum(["none", "api_key", "jwt", "hybrid"]).default("none"),
  REQUIRE_API_KEY: z.coerce.boolean().default(false),
  API_KEYS_JSON: z.string().default("{}"),
  JWT_SHARED_SECRET: z.string().optional(),
  JWT_ISSUER: z.string().optional(),
  JWT_AUDIENCE: z.string().optional(),
  COGNITO_REGION: z.string().optional(),
  COGNITO_USER_POOL_ID: z.string().optional(),
  JWT_PROJECT_CLAIM: z.string().default("project_id"),
  JWT_USER_CLAIM: z.string().default("sub"),
  RUN_TIMEOUT_MS: z.coerce.number().int().positive().default(45_000),
  MAX_PLAN_STEPS: z.coerce.number().int().positive().max(6).default(6),
  RETRY_TRANSIENT: z.coerce.number().int().min(0).max(5).default(2),
  RETRY_BASE_DELAY_MS: z.coerce.number().int().positive().default(200),
  RETRY_MAX_DELAY_MS: z.coerce.number().int().positive().default(5_000),
  MESSAGE_RATE_PER_MINUTE: z.coerce.number().int().positive().default(60),
  GLOBAL_RATE_PER_MINUTE: z.coerce.number().int().positive().default(240),
  RETENTION_DAYS: z.coerce.number().int().positive().default(30),
  ENFORCE_COST_BUDGET: z.coerce.boolean().default(true),
  DEFAULT_DAILY_COST_BUDGET_USD: z.coerce.number().positive().default(5),
  PROJECT_DAILY_COST_BUDGETS_JSON: z.string().default("{}"),
  TOOL_CALL_COST_USD: z.coerce.number().nonnegative().default(0.0002),
  POLICY_FAIL_CLOSED_SCOPES: z.string().default("write,admin,payment"),
  PROJECT_TOOL_ALLOWLIST_JSON: z.string().default("{}"),
  NETPULSE_ENDPOINT: z.string().url().optional()
});

export type Env = {
  nodeEnv: "development" | "test" | "production";
  port: number;
  openAiApiKey?: string;
  openAiModel: string;
  authMode: "none" | "api_key" | "jwt" | "hybrid";
  requireApiKey: boolean;
  apiKeys: Record<string, string>;
  jwtSharedSecret?: string;
  jwtIssuer?: string;
  jwtAudience?: string;
  cognitoRegion?: string;
  cognitoUserPoolId?: string;
  jwtProjectClaim: string;
  jwtUserClaim: string;
  runTimeoutMs: number;
  maxPlanSteps: number;
  retryTransient: number;
  retryBaseDelayMs: number;
  retryMaxDelayMs: number;
  messageRatePerMinute: number;
  globalRatePerMinute: number;
  retentionDays: number;
  enforceCostBudget: boolean;
  defaultDailyCostBudgetUsd: number;
  projectDailyCostBudgets: Record<string, number>;
  toolCallCostUsd: number;
  failClosedScopes: Set<string>;
  projectToolAllowlist: Record<string, string[]>;
  netPulseEndpoint?: string;
};

const parseJson = <T>(raw: string, fallback: T): T => {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
};

export const loadEnv = (source: NodeJS.ProcessEnv = process.env): Env => {
  const parsed = schema.parse(source);
  return {
    nodeEnv: parsed.NODE_ENV,
    port: parsed.PORT,
    openAiApiKey: parsed.OPENAI_API_KEY,
    openAiModel: parsed.OPENAI_MODEL,
    authMode: parsed.AUTH_MODE,
    requireApiKey: parsed.REQUIRE_API_KEY,
    apiKeys: parseJson<Record<string, string>>(parsed.API_KEYS_JSON, {}),
    jwtSharedSecret: parsed.JWT_SHARED_SECRET,
    jwtIssuer: parsed.JWT_ISSUER,
    jwtAudience: parsed.JWT_AUDIENCE,
    cognitoRegion: parsed.COGNITO_REGION,
    cognitoUserPoolId: parsed.COGNITO_USER_POOL_ID,
    jwtProjectClaim: parsed.JWT_PROJECT_CLAIM,
    jwtUserClaim: parsed.JWT_USER_CLAIM,
    runTimeoutMs: parsed.RUN_TIMEOUT_MS,
    maxPlanSteps: parsed.MAX_PLAN_STEPS,
    retryTransient: parsed.RETRY_TRANSIENT,
    retryBaseDelayMs: parsed.RETRY_BASE_DELAY_MS,
    retryMaxDelayMs: parsed.RETRY_MAX_DELAY_MS,
    messageRatePerMinute: parsed.MESSAGE_RATE_PER_MINUTE,
    globalRatePerMinute: parsed.GLOBAL_RATE_PER_MINUTE,
    retentionDays: parsed.RETENTION_DAYS,
    enforceCostBudget: parsed.ENFORCE_COST_BUDGET,
    defaultDailyCostBudgetUsd: parsed.DEFAULT_DAILY_COST_BUDGET_USD,
    projectDailyCostBudgets: parseJson<Record<string, number>>(parsed.PROJECT_DAILY_COST_BUDGETS_JSON, {}),
    toolCallCostUsd: parsed.TOOL_CALL_COST_USD,
    failClosedScopes: new Set(
      parsed.POLICY_FAIL_CLOSED_SCOPES.split(",")
        .map((scope) => scope.trim())
        .filter(Boolean),
    ),
    projectToolAllowlist: parseJson<Record<string, string[]>>(parsed.PROJECT_TOOL_ALLOWLIST_JSON, {}),
    netPulseEndpoint: parsed.NETPULSE_ENDPOINT
  };
};
