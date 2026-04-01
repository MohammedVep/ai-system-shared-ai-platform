#!/usr/bin/env bash

set -euo pipefail

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
  PUBLIC_HOSTED_ZONE_ID
  PUBLIC_FQDN
  LISTENER_ARN
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

listener_json="$(aws_cmd elbv2 describe-listeners --listener-arns "${LISTENER_ARN}" --output json)"
load_balancer_arn="$("${NODE_BIN}" -e '
const payload = JSON.parse(process.argv[1]);
process.stdout.write(payload.Listeners[0].LoadBalancerArn);
' "${listener_json}")"

load_balancer_json="$(aws_cmd elbv2 describe-load-balancers --load-balancer-arns "${load_balancer_arn}" --output json)"
alb_dns_name="$("${NODE_BIN}" -e '
const payload = JSON.parse(process.argv[1]);
process.stdout.write(payload.LoadBalancers[0].DNSName);
' "${load_balancer_json}")"
alb_hosted_zone_id="$("${NODE_BIN}" -e '
const payload = JSON.parse(process.argv[1]);
process.stdout.write(payload.LoadBalancers[0].CanonicalHostedZoneId);
' "${load_balancer_json}")"

rules_json="$(aws_cmd elbv2 describe-rules --listener-arn "${LISTENER_ARN}" --output json)"
rule_arn="$("${NODE_BIN}" -e '
const payload = JSON.parse(process.argv[1]);
const rule = payload.Rules.find((item) => !item.IsDefault && item.Conditions.some((c) => c.Field === "host-header"));
if (!rule) process.exit(1);
process.stdout.write(rule.RuleArn);
' "${rules_json}")"

updated_conditions_json="$("${NODE_BIN}" -e '
const payload = JSON.parse(process.argv[1]);
const publicFqdn = process.argv[2];
const rule = payload.Rules.find((item) => !item.IsDefault && item.Conditions.some((c) => c.Field === "host-header"));
if (!rule) process.exit(1);
const nextConditions = rule.Conditions.map((condition) => {
  if (condition.Field !== "host-header") return condition;
  const values = new Set([
    ...(condition.HostHeaderConfig?.Values ?? condition.Values ?? []),
    publicFqdn,
  ]);
  return {
    Field: "host-header",
    HostHeaderConfig: {
      Values: [...values],
    },
  };
});
process.stdout.write(JSON.stringify(nextConditions));
' "${rules_json}" "${PUBLIC_FQDN}")"

idempotency_token="$("${NODE_BIN}" -e '
const token = process.argv[1].replace(/[^a-zA-Z0-9]/g, "").slice(0, 32) || "sharedaiplatform";
process.stdout.write(token.toLowerCase());
' "${PUBLIC_FQDN}")"

certificate_arn="$(aws_cmd acm request-certificate \
  --domain-name "${PUBLIC_FQDN}" \
  --validation-method DNS \
  --idempotency-token "${idempotency_token}" \
  --query 'CertificateArn' \
  --output text)"

validation_json=""
for _ in $(seq 1 30); do
  validation_json="$(aws_cmd acm describe-certificate --certificate-arn "${certificate_arn}" --output json)"
  record_name="$("${NODE_BIN}" -e '
const payload = JSON.parse(process.argv[1]);
const option = payload.Certificate.DomainValidationOptions?.find((item) => item.DomainName === process.argv[2]);
process.stdout.write(option?.ResourceRecord?.Name ?? "");
' "${validation_json}" "${PUBLIC_FQDN}")"
  if [[ -n "${record_name}" ]]; then
    break
  fi
  sleep 2
done

record_name="$("${NODE_BIN}" -e '
const payload = JSON.parse(process.argv[1]);
const option = payload.Certificate.DomainValidationOptions?.find((item) => item.DomainName === process.argv[2]);
process.stdout.write(option?.ResourceRecord?.Name ?? "");
' "${validation_json}" "${PUBLIC_FQDN}")"
record_type="$("${NODE_BIN}" -e '
const payload = JSON.parse(process.argv[1]);
const option = payload.Certificate.DomainValidationOptions?.find((item) => item.DomainName === process.argv[2]);
process.stdout.write(option?.ResourceRecord?.Type ?? "");
' "${validation_json}" "${PUBLIC_FQDN}")"
record_value="$("${NODE_BIN}" -e '
const payload = JSON.parse(process.argv[1]);
const option = payload.Certificate.DomainValidationOptions?.find((item) => item.DomainName === process.argv[2]);
process.stdout.write(option?.ResourceRecord?.Value ?? "");
' "${validation_json}" "${PUBLIC_FQDN}")"

if [[ -z "${record_name}" || -z "${record_type}" || -z "${record_value}" ]]; then
  echo "Unable to retrieve ACM DNS validation record for ${PUBLIC_FQDN}." >&2
  exit 1
fi

validation_batch_file="$(mktemp)"
cat >"${validation_batch_file}" <<JSON
{
  "Comment": "ACM validation for ${PUBLIC_FQDN}",
  "Changes": [
    {
      "Action": "UPSERT",
      "ResourceRecordSet": {
        "Name": "${record_name}",
        "Type": "${record_type}",
        "TTL": 60,
        "ResourceRecords": [
          {
            "Value": "${record_value}"
          }
        ]
      }
    }
  ]
}
JSON

aws_cmd route53 change-resource-record-sets \
  --hosted-zone-id "${PUBLIC_HOSTED_ZONE_ID}" \
  --change-batch "file://${validation_batch_file}" \
  >/dev/null

for _ in $(seq 1 80); do
  cert_status="$(aws_cmd acm describe-certificate --certificate-arn "${certificate_arn}" --query 'Certificate.Status' --output text)"
  if [[ "${cert_status}" == "ISSUED" ]]; then
    break
  fi
  if [[ "${cert_status}" == "FAILED" ]]; then
    aws_cmd acm describe-certificate --certificate-arn "${certificate_arn}" --output json >&2
    exit 1
  fi
  sleep 15
done

aws_cmd elbv2 add-listener-certificates \
  --listener-arn "${LISTENER_ARN}" \
  --certificates "CertificateArn=${certificate_arn}" \
  >/dev/null

aws_cmd elbv2 modify-rule \
  --rule-arn "${rule_arn}" \
  --conditions "${updated_conditions_json}" \
  >/dev/null

alias_batch_file="$(mktemp)"
cat >"${alias_batch_file}" <<JSON
{
  "Comment": "Public cutover for ${PUBLIC_FQDN}",
  "Changes": [
    {
      "Action": "UPSERT",
      "ResourceRecordSet": {
        "Name": "${PUBLIC_FQDN}",
        "Type": "A",
        "AliasTarget": {
          "HostedZoneId": "${alb_hosted_zone_id}",
          "DNSName": "dualstack.${alb_dns_name}",
          "EvaluateTargetHealth": false
        }
      }
    }
  ]
}
JSON

aws_cmd route53 change-resource-record-sets \
  --hosted-zone-id "${PUBLIC_HOSTED_ZONE_ID}" \
  --change-batch "file://${alias_batch_file}" \
  >/dev/null

echo "Public domain configured: https://${PUBLIC_FQDN}"
echo "ALB DNS: ${alb_dns_name}"
echo "Certificate ARN: ${certificate_arn}"
