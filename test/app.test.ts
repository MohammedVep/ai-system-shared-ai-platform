import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import type { Env } from "../src/config/env.js";

const baseEnv: Env = {
  nodeEnv: "test",
  port: 3001,
  openAiApiKey: undefined,
  openAiModel: "gpt-4o-mini",
  requireApiKey: false,
  apiKeys: {},
  runTimeoutMs: 45_000,
  maxPlanSteps: 6,
  retryTransient: 2,
  messageRatePerMinute: 60,
  retentionDays: 30,
  failClosedScopes: new Set(["write", "admin", "payment"]),
  projectToolAllowlist: {
    default: ["echo"]
  }
};

const waitForTerminalRun = async (
  app: ReturnType<typeof buildApp>,
  runId: string,
): Promise<{ status: string; final_answer?: string; error?: string; termination_reason?: string }> => {
  for (let i = 0; i < 80; i += 1) {
    const response = await app.inject({
      method: "GET",
      url: `/v1/runs/${runId}`
    });
    const body = response.json();
    if (["completed", "failed", "blocked"].includes(body.status)) {
      return body;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Run did not complete in time");
};

describe("Shared AI Platform API", () => {
  const apps = [] as ReturnType<typeof buildApp>[];

  afterEach(async () => {
    while (apps.length > 0) {
      const app = apps.pop();
      await app?.close();
    }
  });

  it("creates session and completes a run", async () => {
    const app = buildApp({ env: baseEnv });
    apps.push(app);

    const sessionRes = await app.inject({
      method: "POST",
      url: "/v1/sessions",
      payload: {
        project_id: "default",
        user_id: "user-1",
        channel: "web"
      }
    });

    expect(sessionRes.statusCode).toBe(201);
    const sessionId = sessionRes.json().session_id as string;

    const msgRes = await app.inject({
      method: "POST",
      url: `/v1/sessions/${sessionId}/messages`,
      payload: {
        message: "Give me a short summary",
        tool_mode: "auto",
        response_mode: "stream"
      }
    });

    expect(msgRes.statusCode).toBe(200);
    const runId = msgRes.json().run_id as string;

    const run = await waitForTerminalRun(app, runId);
    expect(run.status).toBe("completed");
    expect(run.final_answer).toContain("Mock response:");
  });

  it("supports idempotency for message submission", async () => {
    const app = buildApp({ env: baseEnv });
    apps.push(app);

    const sessionRes = await app.inject({
      method: "POST",
      url: "/v1/sessions",
      payload: {
        project_id: "default",
        user_id: "user-2",
        channel: "web"
      }
    });
    const sessionId = sessionRes.json().session_id as string;

    const payload = {
      message: "Hello",
      tool_mode: "auto",
      response_mode: "stream"
    };

    const first = await app.inject({
      method: "POST",
      url: `/v1/sessions/${sessionId}/messages`,
      headers: {
        "idempotency-key": "idem-1"
      },
      payload
    });

    const second = await app.inject({
      method: "POST",
      url: `/v1/sessions/${sessionId}/messages`,
      headers: {
        "idempotency-key": "idem-1"
      },
      payload
    });

    expect(first.json().run_id).toBe(second.json().run_id);
  });

  it("blocks non-allowlisted tool invocation", async () => {
    const app = buildApp({ env: baseEnv });
    apps.push(app);

    const sessionRes = await app.inject({
      method: "POST",
      url: "/v1/sessions",
      payload: {
        project_id: "default",
        user_id: "user-3",
        channel: "web"
      }
    });

    const sessionId = sessionRes.json().session_id as string;
    const msgRes = await app.inject({
      method: "POST",
      url: `/v1/sessions/${sessionId}/messages`,
      payload: {
        message: '/tool write_audit_note {"note":"please persist"}',
        tool_mode: "auto",
        response_mode: "stream"
      }
    });

    const runId = msgRes.json().run_id as string;
    const run = await waitForTerminalRun(app, runId);

    expect(run.status).toBe("blocked");
    expect(run.termination_reason).toBe("blocked_by_policy");
    expect(run.error).toBe("tool_not_allowlisted");
  });

  it("redacts PII from model output", async () => {
    const app = buildApp({ env: baseEnv });
    apps.push(app);

    const sessionRes = await app.inject({
      method: "POST",
      url: "/v1/sessions",
      payload: {
        project_id: "default",
        user_id: "user-4",
        channel: "web"
      }
    });

    const sessionId = sessionRes.json().session_id as string;
    const msgRes = await app.inject({
      method: "POST",
      url: `/v1/sessions/${sessionId}/messages`,
      payload: {
        message: "Send result to john.doe@example.com",
        tool_mode: "auto",
        response_mode: "stream"
      }
    });

    const run = await waitForTerminalRun(app, msgRes.json().run_id);
    expect(run.status).toBe("completed");
    expect(run.final_answer).toContain("[REDACTED_EMAIL]");
    expect(run.final_answer).not.toContain("john.doe@example.com");
  });

  it("streams run events through SSE endpoint", async () => {
    const app = buildApp({ env: baseEnv });
    apps.push(app);

    const sessionRes = await app.inject({
      method: "POST",
      url: "/v1/sessions",
      payload: {
        project_id: "default",
        user_id: "user-5",
        channel: "web"
      }
    });

    const sessionId = sessionRes.json().session_id as string;
    const msgRes = await app.inject({
      method: "POST",
      url: `/v1/sessions/${sessionId}/messages`,
      payload: {
        message: "SSE check",
        tool_mode: "auto",
        response_mode: "stream"
      }
    });

    const runId = msgRes.json().run_id as string;
    await waitForTerminalRun(app, runId);

    const streamRes = await app.inject({
      method: "GET",
      url: `/v1/runs/${runId}/stream`
    });

    expect(streamRes.statusCode).toBe(200);
    expect(streamRes.headers["content-type"]).toContain("text/event-stream");
    expect(streamRes.body).toContain("RunStarted");
    expect(streamRes.body).toContain("RunCompleted");
  });
});
