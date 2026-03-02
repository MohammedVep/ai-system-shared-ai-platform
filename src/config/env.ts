import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().default("gpt-4o-mini"),
  REQUIRE_API_KEY: z.coerce.boolean().default(false),
  API_KEYS_JSON: z.string().default("{}"),
  RUN_TIMEOUT_MS: z.coerce.number().int().positive().default(45_000),
  MAX_PLAN_STEPS: z.coerce.number().int().positive().max(6).default(6),
  RETRY_TRANSIENT: z.coerce.number().int().min(0).max(5).default(2),
  MESSAGE_RATE_PER_MINUTE: z.coerce.number().int().positive().default(60),
  RETENTION_DAYS: z.coerce.number().int().positive().default(30),
  POLICY_FAIL_CLOSED_SCOPES: z.string().default("write,admin,payment"),
  PROJECT_TOOL_ALLOWLIST_JSON: z.string().default("{}")
  ,
  NETPULSE_ENDPOINT: z.string().url().optional()
});

export type Env = {
  nodeEnv: "development" | "test" | "production";
  port: number;
  openAiApiKey?: string;
  openAiModel: string;
  requireApiKey: boolean;
  apiKeys: Record<string, string>;
  runTimeoutMs: number;
  maxPlanSteps: number;
  retryTransient: number;
  messageRatePerMinute: number;
  retentionDays: number;
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
    requireApiKey: parsed.REQUIRE_API_KEY,
    apiKeys: parseJson<Record<string, string>>(parsed.API_KEYS_JSON, {}),
    runTimeoutMs: parsed.RUN_TIMEOUT_MS,
    maxPlanSteps: parsed.MAX_PLAN_STEPS,
    retryTransient: parsed.RETRY_TRANSIENT,
    messageRatePerMinute: parsed.MESSAGE_RATE_PER_MINUTE,
    retentionDays: parsed.RETENTION_DAYS,
    failClosedScopes: new Set(
      parsed.POLICY_FAIL_CLOSED_SCOPES.split(",")
        .map((scope) => scope.trim())
        .filter(Boolean),
    ),
    projectToolAllowlist: parseJson<Record<string, string[]>>(parsed.PROJECT_TOOL_ALLOWLIST_JSON, {}),
    netPulseEndpoint: parsed.NETPULSE_ENDPOINT
  };
};
