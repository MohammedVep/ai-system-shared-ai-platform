# Shared AI Platform v1

Centralized AI Gateway for all internal projects with:
- Session/message/run APIs
- Planner/executor/verifier orchestration
- Policy guardrails with hard block behavior
- Tool broker + SDK contracts
- Streaming run events over SSE
- Audit + telemetry event trail
- Canary controls + automatic rollback thresholds
- SLO and operations dashboard endpoints
- Telecom connector + cloud code execution tool
- Legacy bot endpoint migration for multi-project onboarding

## Stack
- Node.js 22, TypeScript, Fastify
- OpenAI-first model router with provider abstraction
- In-memory runtime state (v1 scaffold), with infra manifests for PostgreSQL/Redis/NATS

## Quick Start
1. `cp .env.example .env`
2. `npm install`
3. `npm run dev`
4. Server: `http://localhost:3000`

## Recruiter Frontend
- Landing page: `GET /`
- Live platform status API: `GET /v1/platform/status`
- Static frontend assets are served from `public/` and present:
- architecture highlights
- capability readiness badges
- live runtime metrics from the gateway

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

### Real-time transit telemetry stream
`GET /v1/transit/telemetry/stream`

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

## Ops Endpoints
- `GET /v1/platform/status`
- `GET /v1/ops/slo-dashboard`
- `GET /v1/ops/canary`
- `POST /v1/ops/canary`
- `GET /v1/ops/evals/latest`
- `GET /v1/ops/netpulse`

## Multi-Project Onboarding
- Register project migration: `POST /v1/onboarding/projects`
- List onboarded projects: `GET /v1/onboarding/projects`
- Mark pilot live: `POST /v1/onboarding/projects/{projectId}/pilot-live`
- Legacy endpoint bridge: `POST /legacy/{projectId}/chat`

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
- App Runner container config: `Dockerfile`

## AWS App Runner Deployment
1. Build and push image to ECR:
- `aws ecr create-repository --repository-name ai-system-shared-ai-platform`
- `aws ecr get-login-password --region us-east-1 | docker login --username AWS --password-stdin <account-id>.dkr.ecr.us-east-1.amazonaws.com`
- `docker build -t ai-system-shared-ai-platform:latest .`
- `docker tag ai-system-shared-ai-platform:latest <account-id>.dkr.ecr.us-east-1.amazonaws.com/ai-system-shared-ai-platform:latest`
- `docker push <account-id>.dkr.ecr.us-east-1.amazonaws.com/ai-system-shared-ai-platform:latest`
2. Create or update AWS App Runner service using that image with port `3000`.
