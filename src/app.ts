import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv, type Env } from "./config/env.js";
import {
  canaryConfigSchema,
  createSessionSchema,
  feedbackSchema,
  legacyMessageSchema,
  onboardingProjectSchema,
  postMessageSchema
} from "./api/schemas.js";
import { InMemoryStore } from "./store/inMemoryStore.js";
import { newId } from "./utils/id.js";
import { AuthError, AuthService } from "./api/auth.js";
import { FixedWindowRateLimiter, RateLimitError } from "./api/rateLimiter.js";
import { ContextService } from "./services/context/contextService.js";
import { PolicyEngine } from "./services/policy/policyEngine.js";
import { ToolBroker } from "./services/tool/toolBroker.js";
import { ModelRouter } from "./services/model/modelRouter.js";
import { TelemetryService } from "./services/telemetry/telemetryService.js";
import { Orchestrator } from "./services/orchestration/orchestrator.js";
import type { RunRecord, Session } from "./domain/types.js";
import { toSseEvent } from "./utils/sse.js";
import type { ToolAdapter } from "./contracts/sdk.js";
import { logger } from "./services/telemetry/logger.js";
import { CanaryService } from "./services/ops/canaryService.js";
import { SloService } from "./services/ops/sloService.js";
import { CloudCodeExecutionService } from "./services/integrations/cloudCodeExecutionService.js";
import { NetPulseService } from "./services/integrations/netPulseService.js";
import { TelecomService } from "./services/integrations/telecomService.js";
import { ProjectOnboardingService } from "./services/onboarding/projectOnboardingService.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const staticCandidates = [join(__dirname, "..", "public"), join(__dirname, "..", "..", "public")];
const staticRoot = staticCandidates.find((path) => existsSync(path)) ?? staticCandidates[0];

export type AppDeps = {
  env?: Env;
  store?: InMemoryStore;
  toolAdapters?: Array<{ projectId: string; adapter: ToolAdapter }>;
};

const defaultEchoTool: ToolAdapter = {
  toolId: "echo",
  description: "Echo input payload",
  inputSchema: {
    type: "object",
    properties: {
      text: { type: "string" }
    },
    required: ["text"],
    additionalProperties: false
  },
  outputSchema: {
    type: "object",
    properties: {
      echoed: { type: "string" }
    },
    required: ["echoed"],
    additionalProperties: false
  },
  timeoutMs: 2_000,
  scopes: ["read"],
  execute: async (input) => {
    const payload = input as { text: string };
    return {
      output: {
        echoed: payload.text
      }
    };
  }
};

const defaultWriteTool: ToolAdapter = {
  toolId: "write_audit_note",
  description: "Simulated privileged write tool",
  inputSchema: {
    type: "object",
    properties: {
      note: { type: "string" }
    },
    required: ["note"],
    additionalProperties: false
  },
  outputSchema: {
    type: "object",
    properties: {
      status: { type: "string" }
    },
    required: ["status"],
    additionalProperties: false
  },
  timeoutMs: 2_000,
  scopes: ["write"],
  execute: async () => ({
    output: {
      status: "ok"
    }
  })
};

const defaultTelecomTool = (telecomService: TelecomService): ToolAdapter => ({
  toolId: "telecom_dispatch",
  description: "Dispatches a telecom network message through configured provider",
  inputSchema: {
    type: "object",
    properties: {
      channel: { type: "string" },
      to: { type: "string" },
      message: { type: "string" }
    },
    required: ["channel", "to", "message"],
    additionalProperties: false
  },
  outputSchema: {
    type: "object",
    properties: {
      provider: { type: "string" },
      messageId: { type: "string" },
      accepted: { type: "boolean" }
    },
    required: ["provider", "messageId", "accepted"],
    additionalProperties: false
  },
  timeoutMs: 2_000,
  scopes: ["write"],
  execute: async (input) => {
    const payload = input as { channel: "sms" | "voice" | "whatsapp"; to: string; message: string };
    const result = await telecomService.dispatch(payload);
    return { output: result };
  }
});

const defaultCloudExecTool = (executor: CloudCodeExecutionService): ToolAdapter => ({
  toolId: "cloud_code_exec",
  description: "Runs JavaScript code via cloud execution workers",
  inputSchema: {
    type: "object",
    properties: {
      code: { type: "string" },
      timeout_ms: { type: "number" }
    },
    required: ["code"],
    additionalProperties: false
  },
  outputSchema: {
    type: "object",
    properties: {
      output: { type: "string" },
      worker: { type: "string" }
    },
    required: ["output", "worker"],
    additionalProperties: false
  },
  timeoutMs: 4_000,
  scopes: ["read"],
  execute: async (input) => {
    const payload = input as { code: string; timeout_ms?: number };
    const result = await executor.execute(payload.code, payload.timeout_ms ?? 1500);
    return { output: result };
  }
});

export const buildApp = (deps: AppDeps = {}) => {
  const env = deps.env ?? loadEnv();
  const store = deps.store ?? new InMemoryStore();

  const authService = new AuthService(env);
  const rateLimiter = new FixedWindowRateLimiter(env.messageRatePerMinute);

  const contextService = new ContextService(store);
  const policyEngine = new PolicyEngine(env);
  const toolBroker = new ToolBroker();
  const modelRouter = new ModelRouter(env);
  const telecomService = new TelecomService();
  const cloudCodeExecutionService = new CloudCodeExecutionService();
  const onboardingService = new ProjectOnboardingService();
  const canaryService = new CanaryService(modelRouter.defaultModel());
  const sloService = new SloService(store);
  const telemetry = new TelemetryService(store);
  const netPulseService = new NetPulseService(env.netPulseEndpoint);
  telemetry.registerSink((event) => netPulseService.publish(event));
  const orchestrator = new Orchestrator(
    env,
    store,
    contextService,
    policyEngine,
    toolBroker,
    modelRouter,
    canaryService,
    telemetry,
  );

  toolBroker.registerTool("default", defaultEchoTool);
  toolBroker.registerTool("default", defaultWriteTool);
  toolBroker.registerTool("default", defaultTelecomTool(telecomService));
  toolBroker.registerTool("default", defaultCloudExecTool(cloudCodeExecutionService));
  for (const item of deps.toolAdapters ?? []) {
    toolBroker.registerTool(item.projectId, item.adapter);
  }

  const app = Fastify({
    loggerInstance: logger
  });

  app.register(fastifyStatic, {
    root: staticRoot,
    prefix: "/assets/",
    index: false
  });

  app.get("/", async (_, reply) => {
    return reply.type("text/html").sendFile("index.html");
  });

  app.get("/dashboard", async (_, reply) => {
    return reply.type("text/html").sendFile("ops.html");
  });

  const enqueueRun = (params: {
    session: Session;
    message: string;
    contextRefs?: string[];
    toolMode: "auto" | "required" | "none";
    responseMode: "stream" | "sync";
    idempotencyKey?: string;
  }): { run: RunRecord; reused: boolean } => {
    if (params.idempotencyKey) {
      const existingRunId = store.getIdempotentRun(params.session.id, params.idempotencyKey);
      if (existingRunId) {
        const existingRun = store.getRun(existingRunId);
        if (existingRun) {
          return { run: existingRun, reused: true };
        }
      }
    }

    const userMessage = {
      id: newId(),
      role: "user" as const,
      content: params.message,
      createdAt: new Date().toISOString()
    };
    store.appendMessage(params.session.id, userMessage);

    const runId = newId();
    const assignment = canaryService.assignRun(runId, modelRouter.defaultModel());

    const run: RunRecord = {
      id: runId,
      traceId: newId(),
      sessionId: params.session.id,
      projectId: params.session.projectId,
      userId: params.session.userId,
      releaseChannel: assignment.channel,
      modelHint: assignment.modelHint,
      status: "queued",
      toolMode: params.toolMode,
      responseMode: params.responseMode,
      query: params.message,
      contextRefs: params.contextRefs,
      context: [],
      plan: [],
      steps: [],
      attempts: 0,
      createdAt: new Date().toISOString(),
      idempotencyKey: params.idempotencyKey
    };

    store.createRun(run);
    if (params.idempotencyKey) {
      store.setIdempotentRun(params.session.id, params.idempotencyKey, run.id);
    }

    setImmediate(() => {
      orchestrator
        .run(run.id)
        .catch((error) => app.log.error({ error, runId: run.id }, "orchestrator run failed"));
    });

    return { run, reused: false };
  };

  app.get("/health", async () => ({
    status: "ok",
    provider: modelRouter.currentProviderName(),
    uptime_ms: Math.floor(process.uptime() * 1000)
  }));

  app.get("/v1/platform/status", async () => {
    const summary = store.getPlatformSummary();
    return {
      service: "shared-ai-platform-v1",
      environment: env.nodeEnv,
      provider: modelRouter.currentProviderName(),
      generated_at: new Date().toISOString(),
      capabilities: {
        chat_interface: true,
        context_assembly: true,
        tool_calling: true,
        planner_executor_verifier: true,
        guardrails: true,
        telemetry_and_eval: true,
        telecom_network_connector: true,
        cloud_code_execution: true,
        mini_load_balancer: true,
        realtime_transit_telemetry: true
      },
      runtime: {
        timeout_ms: env.runTimeoutMs,
        max_plan_steps: env.maxPlanSteps,
        retry_transient: env.retryTransient,
        retention_days: env.retentionDays,
        cloud_exec_workers: cloudCodeExecutionService.workerCount()
      },
      summary,
      slo: sloService.buildDashboard(),
      canary: canaryService.getState(),
      netpulse: netPulseService.status()
    };
  });

  app.get("/v1/ops/slo-dashboard", async () => sloService.buildDashboard());

  app.get("/v1/ops/canary", async () => canaryService.getState());

  app.post("/v1/ops/canary", async (request, reply) => {
    try {
      const body = canaryConfigSchema.parse(request.body);
      const updated = canaryService.updateConfig({
        enabled: body.enabled,
        trafficPercent: body.traffic_percent,
        candidateModel: body.candidate_model,
        rollbackThresholds: body.rollback_thresholds
          ? {
              maxErrorRateDelta: body.rollback_thresholds.max_error_rate_delta ?? 0.05,
              maxLatencyMultiplier: body.rollback_thresholds.max_latency_multiplier ?? 1.25,
              minSamples: body.rollback_thresholds.min_samples ?? 20
            }
          : undefined
      });
      return reply.send(updated);
    } catch (error) {
      return handleError(reply, error);
    }
  });

  app.get("/v1/ops/evals/latest", async (request, reply) => {
    try {
      const evalPath = join(process.cwd(), "eval-results", "latest.json");
      const raw = await readFile(evalPath, "utf8");
      return reply.send(JSON.parse(raw));
    } catch {
      return reply.code(404).send({ error: "eval_not_found" });
    }
  });

  app.get("/v1/ops/netpulse", async () => netPulseService.status());

  app.get("/v1/transit/telemetry/stream", async (request, reply) => {
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive"
    });

    const unsubscribe = telemetry.subscribeAll((event) => {
      reply.raw.write(toSseEvent(event.type, event));
    });

    const keepAlive = setInterval(() => {
      reply.raw.write(": ping\n\n");
    }, 15_000);

    request.raw.on("close", () => {
      clearInterval(keepAlive);
      unsubscribe();
    });
  });

  app.post("/v1/onboarding/projects", async (request, reply) => {
    try {
      const body = onboardingProjectSchema.parse(request.body);
      const project = onboardingService.register({
        projectId: body.project_id,
        legacyEndpoint: body.legacy_endpoint,
        adapterTools: body.adapter_tools,
        status: body.status
      });
      return reply.code(201).send(project);
    } catch (error) {
      return handleError(reply, error);
    }
  });

  app.get("/v1/onboarding/projects", async () => onboardingService.list());

  app.post("/v1/onboarding/projects/:projectId/pilot-live", async (request, reply) => {
    const projectId = (request.params as { projectId: string }).projectId;
    const updated = onboardingService.markStatus(projectId, "pilot_live");
    if (!updated) {
      return reply.code(404).send({ error: "project_not_found" });
    }
    return reply.send(updated);
  });

  app.post("/legacy/:projectId/chat", async (request, reply) => {
    try {
      const projectId = (request.params as { projectId: string }).projectId;
      const onboardingProject = onboardingService.get(projectId);
      if (!onboardingProject) {
        return reply.code(404).send({ error: "project_not_onboarded" });
      }

      const body = legacyMessageSchema.parse(request.body);
      let session = store.findSessionByProjectUser(projectId, body.user_id);
      if (!session) {
        session = store.createSession({
          id: newId(),
          projectId,
          userId: body.user_id,
          channel: "legacy_migrated",
          createdAt: new Date().toISOString(),
          messages: []
        });
      }

      const { run } = enqueueRun({
        session,
        message: body.message,
        contextRefs: body.context_refs,
        toolMode: body.tool_mode,
        responseMode: body.response_mode
      });
      onboardingService.markStatus(projectId, "migrating");

      return reply.send({
        project_id: projectId,
        run_id: run.id,
        status: run.status,
        migrated_from: onboardingProject.legacyEndpoint
      });
    } catch (error) {
      return handleError(reply, error);
    }
  });

  app.post("/v1/sessions", async (request, reply) => {
    try {
      const body = createSessionSchema.parse(request.body);
      const apiKey = request.headers["x-api-key"] as string | undefined;
      const projectId = authService.authorize(body.project_id, apiKey);
      rateLimiter.check(`${projectId}:${body.user_id}`);

      const session: Session = {
        id: newId(),
        projectId,
        userId: body.user_id,
        channel: body.channel,
        metadata: body.metadata,
        createdAt: new Date().toISOString(),
        messages: []
      };

      store.createSession(session);
      return reply.code(201).send({
        session_id: session.id,
        created_at: session.createdAt
      });
    } catch (error) {
      return handleError(reply, error);
    }
  });

  app.post("/v1/sessions/:sessionId/messages", async (request, reply) => {
    try {
      const sessionId = (request.params as { sessionId: string }).sessionId;
      const session = store.getSession(sessionId);
      if (!session) {
        return reply.code(404).send({ error: "session_not_found" });
      }

      const body = postMessageSchema.parse(request.body);
      const apiKey = request.headers["x-api-key"] as string | undefined;
      authService.authorize(session.projectId, apiKey);
      rateLimiter.check(`${session.projectId}:${session.userId}`);

      const idempotencyKey = request.headers["idempotency-key"] as string | undefined;
      const { run } = enqueueRun({
        session,
        message: body.message,
        contextRefs: body.context_refs,
        toolMode: body.tool_mode,
        responseMode: body.response_mode,
        idempotencyKey
      });

      return reply.send({
        run_id: run.id,
        status: run.status
      });
    } catch (error) {
      return handleError(reply, error);
    }
  });

  app.get("/v1/runs/:runId", async (request, reply) => {
    const runId = (request.params as { runId: string }).runId;
    const run = store.getRun(runId);
    if (!run) {
      return reply.code(404).send({ error: "run_not_found" });
    }

    return reply.send({
      run_id: run.id,
      session_id: run.sessionId,
      project_id: run.projectId,
      release_channel: run.releaseChannel,
      model_hint: run.modelHint,
      status: run.status,
      attempts: run.attempts,
      steps: run.steps,
      final_answer: run.finalAnswer,
      termination_reason: run.terminationReason,
      error: run.error,
      created_at: run.createdAt,
      started_at: run.startedAt,
      completed_at: run.completedAt
    });
  });

  app.get("/v1/runs/:runId/stream", async (request, reply) => {
    const runId = (request.params as { runId: string }).runId;
    const run = store.getRun(runId);
    if (!run) {
      return reply.code(404).send({ error: "run_not_found" });
    }

    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive"
    });

    const priorEvents = telemetry.getRunEvents(runId);
    for (const event of priorEvents) {
      reply.raw.write(toSseEvent(event.type, event));
    }
    const alreadyTerminal = priorEvents.some(
      (event) => event.type === "RunCompleted" || event.type === "RunFailed",
    );
    if (alreadyTerminal) {
      reply.raw.end();
      return;
    }

    const unsubscribe = telemetry.subscribe(runId, (event) => {
      reply.raw.write(toSseEvent(event.type, event));
      if (event.type === "RunCompleted" || event.type === "RunFailed") {
        clearInterval(keepAlive);
        unsubscribe();
        reply.raw.end();
      }
    });

    const keepAlive = setInterval(() => {
      reply.raw.write(": ping\n\n");
    }, 15_000);

    request.raw.on("close", () => {
      clearInterval(keepAlive);
      unsubscribe();
    });
  });

  app.post("/v1/feedback", async (request, reply) => {
    try {
      const body = feedbackSchema.parse(request.body);
      const apiKey = request.headers["x-api-key"] as string | undefined;
      authService.authorize(body.project_id, apiKey);

      const run = store.getRun(body.run_id);
      if (!run) {
        return reply.code(404).send({ error: "run_not_found" });
      }

      store.saveFeedback({
        id: newId(),
        runId: body.run_id,
        projectId: body.project_id,
        rating: body.rating,
        labels: body.labels,
        note: body.note,
        createdAt: new Date().toISOString()
      });

      return reply.code(201).send({ status: "accepted" });
    } catch (error) {
      return handleError(reply, error);
    }
  });

  return app;
};

const handleError = (reply: { code: (statusCode: number) => { send: (body: unknown) => unknown } }, error: unknown) => {
  if (error instanceof AuthError) {
    return reply.code(401).send({ error: "unauthorized", message: error.message });
  }

  if (error instanceof RateLimitError) {
    return reply.code(429).send({ error: "rate_limited", message: error.message });
  }

  if (error instanceof Error) {
    return reply.code(400).send({ error: "bad_request", message: error.message });
  }

  return reply.code(500).send({ error: "internal_error" });
};
