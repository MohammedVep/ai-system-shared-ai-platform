import Fastify from "fastify";
import { loadEnv, type Env } from "./config/env.js";
import { createSessionSchema, feedbackSchema, postMessageSchema } from "./api/schemas.js";
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

export const buildApp = (deps: AppDeps = {}) => {
  const env = deps.env ?? loadEnv();
  const store = deps.store ?? new InMemoryStore();

  const authService = new AuthService(env);
  const rateLimiter = new FixedWindowRateLimiter(env.messageRatePerMinute);

  const contextService = new ContextService(store);
  const policyEngine = new PolicyEngine(env);
  const toolBroker = new ToolBroker();
  const modelRouter = new ModelRouter(env);
  const telemetry = new TelemetryService(store);
  const orchestrator = new Orchestrator(
    env,
    store,
    contextService,
    policyEngine,
    toolBroker,
    modelRouter,
    telemetry,
  );

  toolBroker.registerTool("default", defaultEchoTool);
  toolBroker.registerTool("default", defaultWriteTool);
  for (const item of deps.toolAdapters ?? []) {
    toolBroker.registerTool(item.projectId, item.adapter);
  }

  const app = Fastify({
    loggerInstance: logger
  });

  app.get("/health", async () => ({
    status: "ok",
    provider: modelRouter.currentProviderName()
  }));

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
      if (idempotencyKey) {
        const existingRunId = store.getIdempotentRun(sessionId, idempotencyKey);
        if (existingRunId) {
          const existing = store.getRun(existingRunId);
          return reply.send({
            run_id: existingRunId,
            status: existing?.status ?? "running"
          });
        }
      }

      const userMessage = {
        id: newId(),
        role: "user" as const,
        content: body.message,
        createdAt: new Date().toISOString()
      };
      store.appendMessage(sessionId, userMessage);

      const run: RunRecord = {
        id: newId(),
        traceId: newId(),
        sessionId: session.id,
        projectId: session.projectId,
        userId: session.userId,
        status: "queued",
        toolMode: body.tool_mode,
        responseMode: body.response_mode,
        query: body.message,
        contextRefs: body.context_refs,
        context: [],
        plan: [],
        steps: [],
        attempts: 0,
        createdAt: new Date().toISOString(),
        idempotencyKey
      };

      store.createRun(run);
      if (idempotencyKey) {
        store.setIdempotentRun(sessionId, idempotencyKey, run.id);
      }

      setImmediate(() => {
        orchestrator
          .run(run.id)
          .catch((error) => app.log.error({ error, runId: run.id }, "orchestrator run failed"));
      });

      return reply.send({
        run_id: run.id,
        status: "queued"
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
