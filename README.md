# Shared AI Platform v1

Centralized AI Gateway for all internal projects with:
- Session/message/run APIs
- Planner/executor/verifier orchestration
- Policy guardrails with hard block behavior
- Tool broker + SDK contracts
- Streaming run events over SSE
- Audit + telemetry event trail
- JWT/Cognito or API-key authentication
- Global + route-level rate limiting
- Retry/backoff for model, tool, auth JWKS, and NetPulse dispatch
- Structured failure responses with trace IDs and retry hints
- Cost-budget enforcement and per-project cost visibility
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

## Production Controls (All Projects)
- Auth modes:
  - `AUTH_MODE=none|api_key|jwt|hybrid`
  - API key header: `x-api-key`
  - JWT header: `Authorization: Bearer <token>`
  - JWT supports shared-secret validation or AWS Cognito JWKS
- Rate limits:
  - Global: `GLOBAL_RATE_PER_MINUTE`
  - Message/session routes: `MESSAGE_RATE_PER_MINUTE`
  - Response headers: `x-ratelimit-remaining`, `x-ratelimit-reset`, `x-ratelimit-global-remaining`, `x-ratelimit-global-reset`
- Cost controls:
  - `ENFORCE_COST_BUDGET`
  - `DEFAULT_DAILY_COST_BUDGET_USD`
  - `PROJECT_DAILY_COST_BUDGETS_JSON`
  - `GET /v1/ops/costs?project_id=<id>`
- Failure handling:
  - Error body always includes `trace_id` and `retryable`
  - `429` responses include `retry-after`

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
- ECS Express migration assets: `infra/ecs-express/`

## AWS App Runner Deployment
1. Build and push image to ECR:
- `aws ecr create-repository --repository-name ai-system-shared-ai-platform`
- `aws ecr get-login-password --region us-east-1 | docker login --username AWS --password-stdin <account-id>.dkr.ecr.us-east-1.amazonaws.com`
- `docker build -t ai-system-shared-ai-platform:latest .`
- `docker tag ai-system-shared-ai-platform:latest <account-id>.dkr.ecr.us-east-1.amazonaws.com/ai-system-shared-ai-platform:latest`
- `docker push <account-id>.dkr.ecr.us-east-1.amazonaws.com/ai-system-shared-ai-platform:latest`
2. Create or update AWS App Runner service using that image with port `3000`.

## AWS ECS Express Migration
This repository includes a repeatable App Runner to ECS Express migration path for the current production service.

Current production endpoint:
- Public DNS: `https://sharedaigateway.com`

Direct ECS endpoint:
- `https://ai-baf78f42f0924a8297f5f12f885b9239.ecs.us-east-1.on.aws`

Migration status:
- Public DNS cutover completed on `2026-04-01`
- Legacy App Runner service deleted on `2026-04-01`

Internal private DNS:
- `shared-ai-platform.np-prod.internal`

1. Copy `infra/ecs-express/app-runner-migration.env.example` to a local env file and adjust values if needed.
2. Export those variables in your shell.
3. Run `infra/ecs-express/migrate-from-apprunner.sh`.

The migration script also detects private interface endpoints for `ecr.api`, `ecr.dkr`, `ecs`, and `logs` in the target VPC and authorizes the ECS Express task security group on port `443` when needed. This is required in VPCs where private DNS for those endpoints is already enabled.

Current workload note:
- In this account, the current Fargate On-Demand vCPU usage is near the regional quota ceiling, so the ECS Express defaults in this repo are set to `256 CPU / 1024 MiB` with `maxTaskCount=1` to ensure the migrated service can launch. Increase the Fargate quota before scaling this service higher.

Completed cutover details:
- Public hosted zone: `sharedaigateway.com`
- ACM/TLS certificate terminates on the ECS Express ALB for `sharedaigateway.com`
- External traffic now routes through Route 53 alias records to the ECS Express load balancer
- The raw ECS hostname remains available for direct verification

Remaining infrastructure step:
- after the Fargate quota increase is approved, scale ECS Express back to `1024 CPU / 2048 MiB`

Prepared scale-up path:
- export `infra/ecs-express/scale-to-1024.env.example`
- run `infra/ecs-express/scale-when-quota-ready.sh`

Prepared internal DNS path:
- export `infra/ecs-express/internal-dns.env.example`
- run `infra/ecs-express/create-internal-dns.sh`

Prepared public DNS cutover path:
- export `infra/ecs-express/public-domain.env.example`
- run `infra/ecs-express/configure-public-domain.sh`

Prepared public domain registration + cutover path:
- chosen public domain: `sharedaigateway.com`
- export `infra/ecs-express/public-domain-registration.env.example`
- set `DOMAIN_CONTACT_EMAIL` to a real mailbox you control for registrar verification
- run `infra/ecs-express/register-public-domain.sh`
