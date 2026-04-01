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
if [[ -z "${AWS_BIN}" ]]; then
  echo "Unable to locate the AWS CLI binary." >&2
  exit 1
fi
if [[ -z "${NODE_BIN}" ]]; then
  echo "Unable to locate the Node.js binary." >&2
  exit 1
fi

required_vars=(
  AWS_REGION
  APP_RUNNER_SERVICE_ARN
  ECS_EXPRESS_SERVICE_NAME
  ECS_CLUSTER
  EXECUTION_ROLE_NAME
  INFRASTRUCTURE_ROLE_NAME
  CONTAINER_IMAGE
  CONTAINER_PORT
  CPU
  MEMORY
  HEALTH_CHECK_PATH
  MIN_TASK_COUNT
  MAX_TASK_COUNT
  AUTO_SCALING_METRIC
  AUTO_SCALING_TARGET_VALUE
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

ensure_role() {
  local role_name="$1"
  local trust_policy_path="$2"
  local managed_policy_arn="$3"

  if ! aws_cmd iam get-role --role-name "${role_name}" >/dev/null 2>&1; then
    aws_cmd iam create-role \
      --role-name "${role_name}" \
      --assume-role-policy-document "file://${trust_policy_path}" \
      >/dev/null
  fi

  aws_cmd iam attach-role-policy \
    --role-name "${role_name}" \
    --policy-arn "${managed_policy_arn}" \
    >/dev/null
}

ensure_cluster() {
  local cluster_name="$1"
  local status
  status="$(aws_cmd ecs describe-clusters --clusters "${cluster_name}" --query 'clusters[0].status' --output text 2>/dev/null || true)"

  if [[ -z "${status}" || "${status}" == "None" ]]; then
    aws_cmd ecs create-cluster --cluster-name "${cluster_name}" >/dev/null
  fi
}

ensure_endpoint_ingress() {
  local service_arn="$1"
  local service_security_group
  local vpc_id
  local endpoint_security_groups
  local endpoint_group_id

  service_security_group="$(aws_cmd ecs describe-express-gateway-service \
    --service-arn "${service_arn}" \
    --query 'service.activeConfigurations[0].networkConfiguration.securityGroups[0]' \
    --output text)"

  if [[ -z "${service_security_group}" || "${service_security_group}" == "None" ]]; then
    return
  fi

  vpc_id="$(aws_cmd ec2 describe-security-groups \
    --group-ids "${service_security_group}" \
    --query 'SecurityGroups[0].VpcId' \
    --output text)"

  endpoint_security_groups="$(aws_cmd ec2 describe-vpc-endpoints \
    --filters "Name=vpc-id,Values=${vpc_id}" \
    --query 'VpcEndpoints[?VpcEndpointType==`Interface` && PrivateDnsEnabled==`true` && (contains(ServiceName, `ecr.api`) || contains(ServiceName, `ecr.dkr`) || contains(ServiceName, `ecs`) || contains(ServiceName, `logs`))].Groups[].GroupId' \
    --output text)"

  for endpoint_group_id in ${endpoint_security_groups}; do
    aws_cmd ec2 authorize-security-group-ingress \
      --group-id "${endpoint_group_id}" \
      --protocol tcp \
      --port 443 \
      --source-group "${service_security_group}" \
      >/dev/null 2>&1 || true
  done
}

echo "Reviewing source App Runner service ..."
aws_cmd apprunner describe-service \
  --service-arn "${APP_RUNNER_SERVICE_ARN}" \
  --query 'Service.{ServiceName:ServiceName,ServiceUrl:ServiceUrl,Image:SourceConfiguration.ImageRepository.ImageIdentifier,Port:SourceConfiguration.ImageRepository.ImageConfiguration.Port,HealthPath:HealthCheckConfiguration.Path}' \
  --output json

echo "Ensuring IAM roles exist ..."
ensure_role \
  "${EXECUTION_ROLE_NAME}" \
  "${ROOT_DIR}/infra/ecs-express/ecs-task-execution-trust-policy.json" \
  "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
ensure_role \
  "${INFRASTRUCTURE_ROLE_NAME}" \
  "${ROOT_DIR}/infra/ecs-express/ecs-infrastructure-trust-policy.json" \
  "arn:aws:iam::aws:policy/service-role/AmazonECSInfrastructureRoleforExpressGatewayServices"

echo "Ensuring ECS cluster exists ..."
ensure_cluster "${ECS_CLUSTER}"

EXECUTION_ROLE_ARN="$(aws_cmd iam get-role --role-name "${EXECUTION_ROLE_NAME}" --query 'Role.Arn' --output text)"
INFRASTRUCTURE_ROLE_ARN="$(aws_cmd iam get-role --role-name "${INFRASTRUCTURE_ROLE_NAME}" --query 'Role.Arn' --output text)"

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

SERVICE_ARN="$(aws_cmd ecs list-services \
  --cluster "${ECS_CLUSTER}" \
  --query "serviceArns[?contains(@, \`${ECS_EXPRESS_SERVICE_NAME}\`)] | [0]" \
  --output text)"

if [[ "${SERVICE_ARN}" != "None" && -n "${SERVICE_ARN}" ]]; then
  echo "Updating existing ECS Express service ..."
  aws_cmd ecs update-express-gateway-service \
    --service-arn "${SERVICE_ARN}" \
    --execution-role-arn "${EXECUTION_ROLE_ARN}" \
    --health-check-path "${HEALTH_CHECK_PATH}" \
    --primary-container "${PRIMARY_CONTAINER_JSON}" \
    --cpu "${CPU}" \
    --memory "${MEMORY}" \
    --scaling-target "${SCALING_TARGET_JSON}" \
    --monitor-resources \
    --monitor-mode TEXT-ONLY \
    --output json
else
  echo "Creating ECS Express service ..."
  aws_cmd ecs create-express-gateway-service \
    --cluster "${ECS_CLUSTER}" \
    --service-name "${ECS_EXPRESS_SERVICE_NAME}" \
    --execution-role-arn "${EXECUTION_ROLE_ARN}" \
    --infrastructure-role-arn "${INFRASTRUCTURE_ROLE_ARN}" \
    --health-check-path "${HEALTH_CHECK_PATH}" \
    --primary-container "${PRIMARY_CONTAINER_JSON}" \
    --cpu "${CPU}" \
    --memory "${MEMORY}" \
    --scaling-target "${SCALING_TARGET_JSON}" \
    --monitor-resources \
    --monitor-mode TEXT-ONLY \
    --output json

  SERVICE_ARN="$(aws_cmd ecs list-services \
    --cluster "${ECS_CLUSTER}" \
    --query "serviceArns[?contains(@, \`${ECS_EXPRESS_SERVICE_NAME}\`)] | [0]" \
    --output text)"
fi

echo "Ensuring VPC endpoint ingress for ECS Express tasks ..."
ensure_endpoint_ingress "${SERVICE_ARN}"

echo "Current ECS Express status ..."
aws_cmd ecs describe-express-gateway-service \
  --service-arn "${SERVICE_ARN}" \
  --output json
