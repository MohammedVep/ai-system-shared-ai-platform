#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
AWS_BIN="${AWS_BIN:-$(command -v aws || true)}"
NODE_BIN="${NODE_BIN:-$(command -v node || true)}"
if [[ -z "${AWS_BIN}" && -x /opt/homebrew/bin/aws ]]; then
  AWS_BIN="/opt/homebrew/bin/aws"
fi
if [[ -z "${NODE_BIN}" && -x /usr/local/bin/node ]]; then
  NODE_BIN="/usr/local/bin/node"
fi
if [[ -z "${NODE_BIN}" && -x /opt/homebrew/bin/node ]]; then
  NODE_BIN="/opt/homebrew/bin/node"
fi
if [[ -z "${AWS_BIN}" || -z "${NODE_BIN}" ]]; then
  echo "AWS CLI and Node.js are required." >&2
  exit 1
fi

required_vars=(
  AWS_REGION
  ECS_EXPRESS_SERVICE_ARN
  CONTAINER_IMAGE
  CONTAINER_PORT
  CPU
  MEMORY
  MIN_TASK_COUNT
  MAX_TASK_COUNT
  AUTO_SCALING_METRIC
  AUTO_SCALING_TARGET_VALUE
  HEALTH_CHECK_PATH
  ENV_VARS_JSON
)

for var_name in "${required_vars[@]}"; do
  if [[ -z "${!var_name:-}" ]]; then
    echo "Missing required environment variable: ${var_name}" >&2
    exit 1
  fi
done

aws_cmd() {
  local cmd=("${AWS_BIN}" --region "${AWS_REGION}")
  if [[ -n "${AWS_PROFILE:-}" ]]; then
    cmd+=(--profile "${AWS_PROFILE}")
  fi
  "${cmd[@]}" "$@"
}

PRIMARY_CONTAINER_JSON="$("${NODE_BIN}" -e '
const envVars = JSON.parse(process.argv[1]);
const json = {
  image: process.argv[2],
  containerPort: Number(process.argv[3]),
  environment: Object.entries(envVars).map(([name, value]) => ({ name, value: String(value) })),
};
process.stdout.write(JSON.stringify(json));
' "${ENV_VARS_JSON}" "${CONTAINER_IMAGE}" "${CONTAINER_PORT}")"

SCALING_TARGET_JSON="$("${NODE_BIN}" -e '
const json = {
  minTaskCount: Number(process.argv[1]),
  maxTaskCount: Number(process.argv[2]),
  autoScalingMetric: process.argv[3],
  autoScalingTargetValue: Number(process.argv[4]),
};
process.stdout.write(JSON.stringify(json));
' "${MIN_TASK_COUNT}" "${MAX_TASK_COUNT}" "${AUTO_SCALING_METRIC}" "${AUTO_SCALING_TARGET_VALUE}")"

quota_value="$(aws_cmd service-quotas get-service-quota \
  --service-code fargate \
  --quota-code L-3032A538 \
  --query 'Quota.Value' \
  --output text)"

usage_value="$(aws_cmd cloudwatch get-metric-statistics \
  --namespace AWS/Usage \
  --metric-name ResourceCount \
  --dimensions Name=Class,Value=Standard/OnDemand Name=Resource,Value=vCPU Name=Service,Value=Fargate Name=Type,Value=Resource \
  --start-time "$(date -u -v-30M +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d '30 minutes ago' +%Y-%m-%dT%H:%M:%SZ)" \
  --end-time "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --period 300 \
  --statistics Maximum \
  --query 'max_by(Datapoints,&Maximum).Maximum' \
  --output text)"

current_cpu="$(aws_cmd ecs describe-express-gateway-service \
  --service-arn "${ECS_EXPRESS_SERVICE_ARN}" \
  --query 'service.activeConfigurations[0].cpu' \
  --output text)"

required_vcpu="$("${NODE_BIN}" -e 'console.log(Number(process.argv[1]) / 1024)' "${CPU}")"
current_vcpu="$("${NODE_BIN}" -e 'console.log(Number(process.argv[1]) / 1024)' "${current_cpu}")"
additional_vcpu="$("${NODE_BIN}" -e 'console.log(Math.max(Number(process.argv[1]) - Number(process.argv[2]), 0))' "${required_vcpu}" "${current_vcpu}")"
available_vcpu="$("${NODE_BIN}" -e 'console.log(Number(process.argv[1]) - Number(process.argv[2]))' "${quota_value}" "${usage_value}")"

echo "Quota vCPU: ${quota_value}"
echo "Observed recent usage vCPU: ${usage_value}"
echo "Current service vCPU: ${current_vcpu}"
echo "Requested service vCPU: ${required_vcpu}"
echo "Additional headroom needed vCPU: ${additional_vcpu}"
echo "Available headroom vCPU: ${available_vcpu}"

enough_headroom="$("${NODE_BIN}" -e 'console.log(Number(process.argv[1]) >= Number(process.argv[2]) ? "yes" : "no")' "${available_vcpu}" "${additional_vcpu}")"
if [[ "${enough_headroom}" != "yes" ]]; then
  echo "Not enough Fargate vCPU headroom to apply the scale-up safely yet." >&2
  exit 1
fi

aws_cmd ecs update-express-gateway-service \
  --service-arn "${ECS_EXPRESS_SERVICE_ARN}" \
  --health-check-path "${HEALTH_CHECK_PATH}" \
  --primary-container "${PRIMARY_CONTAINER_JSON}" \
  --cpu "${CPU}" \
  --memory "${MEMORY}" \
  --scaling-target "${SCALING_TARGET_JSON}" \
  --output json
