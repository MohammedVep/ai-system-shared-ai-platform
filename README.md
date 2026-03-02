# Shared AI Platform v1

Centralized AI Gateway for all internal projects with:
- Session/message/run APIs
- Planner/executor/verifier orchestration
- Policy guardrails with hard block behavior
- Tool broker + SDK contracts
- Streaming run events over SSE
- Audit + telemetry event trail

## Stack
- Node.js 22, TypeScript, Fastify
- OpenAI-first model router with provider abstraction
- In-memory runtime state (v1 scaffold), with infra manifests for PostgreSQL/Redis/NATS

## Quick Start
1. `cp .env.example .env`
2. `npm install`
3. `npm run dev`
4. Server: `http://localhost:3000`

## API
### Create session
`POST /v1/sessions`
```json
{
  "project_id": "default",
  "user_id": "u-1",
  "channel": "web",
  "metadata": {"team":"core"}
}
```

### Submit message
`POST /v1/sessions/{session_id}/messages`
```json
{
  "message": "Summarize current context",
  "context_refs": ["system notes..."],
  "tool_mode": "auto",
  "response_mode": "stream"
}
```

Tool invocation directive example:
```text
/tool echo {"text":"hello"}
```

### Poll run
`GET /v1/runs/{run_id}`

### Stream run events
`GET /v1/runs/{run_id}/stream`

### Submit feedback
`POST /v1/feedback`
```json
{
  "run_id": "<run_id>",
  "project_id": "default",
  "rating": "up",
  "labels": ["helpful"]
}
```

## Contracts
SDK interfaces are in [`src/contracts/sdk.ts`](src/contracts/sdk.ts).

## Offline Eval Runner
Run:
- `npm run eval:offline`

Dataset path:
- `eval-datasets/sample.json`

## Guardrails Implemented
- Prompt-injection pattern neutralization
- Tool allowlist per project
- Sensitive scope checks (`write`, `admin`, `payment`)
- PII/secret redaction in model output
- Policy fail-closed path for privileged actions when policy health degrades

## Deployment Assets
- Docker compose: `infra/docker-compose.yml`
- Kubernetes baseline: `infra/k8s/deployment.yaml`
