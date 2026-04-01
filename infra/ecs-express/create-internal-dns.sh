#!/usr/bin/env bash

set -euo pipefail

AWS_BIN="${AWS_BIN:-$(command -v aws || true)}"
if [[ -z "${AWS_BIN}" && -x /opt/homebrew/bin/aws ]]; then
  AWS_BIN="/opt/homebrew/bin/aws"
fi
if [[ -z "${AWS_BIN}" ]]; then
  echo "Unable to locate the AWS CLI binary." >&2
  exit 1
fi

required_vars=(
  AWS_REGION
  CLOUDMAP_NAMESPACE_ID
  CLOUDMAP_SERVICE_NAME
  INSTANCE_ID
  TARGET_CNAME
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

service_id="$(aws_cmd servicediscovery list-services \
  --filters "Name=NAMESPACE_ID,Values=${CLOUDMAP_NAMESPACE_ID},Condition=EQ" \
  --query "Services[?Name==\`${CLOUDMAP_SERVICE_NAME}\`].Id | [0]" \
  --output text)"

if [[ -z "${service_id}" || "${service_id}" == "None" ]]; then
  service_id="$(aws_cmd servicediscovery create-service \
    --name "${CLOUDMAP_SERVICE_NAME}" \
    --namespace-id "${CLOUDMAP_NAMESPACE_ID}" \
    --dns-config "RoutingPolicy=WEIGHTED,DnsRecords=[{Type=CNAME,TTL=60}]" \
    --query 'Service.Id' \
    --output text)"
fi

operation_id="$(aws_cmd servicediscovery register-instance \
  --service-id "${service_id}" \
  --instance-id "${INSTANCE_ID}" \
  --attributes "AWS_INSTANCE_CNAME=${TARGET_CNAME}" \
  --query 'OperationId' \
  --output text)"

for _ in $(seq 1 40); do
  status="$(aws_cmd servicediscovery get-operation --operation-id "${operation_id}" --query 'Operation.Status' --output text)"
  if [[ "${status}" == "SUCCESS" ]]; then
    break
  fi
  if [[ "${status}" == "FAIL" ]]; then
    aws_cmd servicediscovery get-operation --operation-id "${operation_id}" --output json >&2
    exit 1
  fi
  sleep 3
done

aws_cmd servicediscovery get-service --id "${service_id}" --output json
