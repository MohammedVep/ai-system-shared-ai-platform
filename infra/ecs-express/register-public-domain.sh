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
  DOMAIN_NAME
  DOMAIN_CONTACT_EMAIL
  LISTENER_ARN
)

for var_name in "${required_vars[@]}"; do
  if [[ -z "${!var_name:-}" ]]; then
    echo "Missing required environment variable: ${var_name}" >&2
    exit 1
  fi
done

PUBLIC_FQDN="${PUBLIC_FQDN:-${DOMAIN_NAME}}"
WAIT_TIMEOUT_SECONDS="${WAIT_TIMEOUT_SECONDS:-1800}"
POLL_INTERVAL_SECONDS="${POLL_INTERVAL_SECONDS:-15}"

aws_cmd() {
  local cmd=("${AWS_BIN}" --region "${AWS_REGION}")
  if [[ -n "${AWS_PROFILE:-}" ]]; then
    cmd+=(--profile "${AWS_PROFILE}")
  fi
  "${cmd[@]}" "$@"
}

domain_status="$(aws_cmd route53domains check-domain-availability \
  --domain-name "${DOMAIN_NAME}" \
  --query 'Availability' \
  --output text)"

existing_registered_domain="$(aws_cmd route53domains list-domains \
  --query "Domains[?Name=='${DOMAIN_NAME}'].Name | [0]" \
  --output text)"

if [[ "${existing_registered_domain}" == "${DOMAIN_NAME}" ]]; then
  echo "Domain already registered in this account: ${DOMAIN_NAME}"
elif [[ "${domain_status}" != "AVAILABLE" ]]; then
  echo "Domain is not available for registration: ${DOMAIN_NAME} (${domain_status})" >&2
  exit 1
else
  account_contact_json="$(aws_cmd account get-contact-information --output json)"
  contact_json="$("${NODE_BIN}" -e '
const payload = JSON.parse(process.argv[1]);
const email = process.argv[2];
const provinceMap = new Map([
  ["alberta", "AB"],
  ["british columbia", "BC"],
  ["manitoba", "MB"],
  ["new brunswick", "NB"],
  ["newfoundland and labrador", "NL"],
  ["newfoundland", "NL"],
  ["nova scotia", "NS"],
  ["northwest territories", "NT"],
  ["nunavut", "NU"],
  ["ontario", "ON"],
  ["prince edward island", "PE"],
  ["quebec", "QC"],
  ["saskatchewan", "SK"],
  ["yukon", "YK"],
  ["yukon territory", "YK"],
]);
const fullName = payload.ContactInformation?.FullName?.trim() || "";
const parts = fullName.split(/\s+/).filter(Boolean);
const firstName = parts.shift() || "Shared";
const lastName = parts.join(" ") || "AI Platform";
const countryCode = payload.ContactInformation?.CountryCode || "US";
const rawState = (payload.ContactInformation?.StateOrRegion || "").trim();
const normalizedState = (() => {
  if (!rawState) return "";
  if (countryCode !== "CA") return rawState;
  const upper = rawState.toUpperCase();
  if (provinceMap.has(rawState.toLowerCase())) return provinceMap.get(rawState.toLowerCase());
  if (provinceMap.has(upper.toLowerCase())) return provinceMap.get(upper.toLowerCase());
  return upper;
})();
const rawPhone = (payload.ContactInformation?.PhoneNumber || "").trim();
const normalizedPhone = (() => {
  if (!rawPhone) return "";
  const digits = rawPhone.replace(/\D/g, "");
  if (rawPhone.startsWith("+")) {
    const withoutPlus = rawPhone.slice(1).replace(/\D/g, "");
    if (withoutPlus.length > 1) {
      return `+${withoutPlus[0]}.${withoutPlus.slice(1)}`;
    }
  }
  if (countryCode === "CA" || countryCode === "US") {
    if (digits.length === 11 && digits.startsWith("1")) {
      return `+1.${digits.slice(1)}`;
    }
    if (digits.length === 10) {
      return `+1.${digits}`;
    }
  }
  if (digits.length > 1) {
    return `+${digits[0]}.${digits.slice(1)}`;
  }
  return rawPhone;
})();
const contact = {
  FirstName: firstName,
  LastName: lastName,
  ContactType: "PERSON",
  AddressLine1: payload.ContactInformation?.AddressLine1 || "",
  City: payload.ContactInformation?.City || "",
  State: normalizedState,
  CountryCode: countryCode,
  ZipCode: payload.ContactInformation?.PostalCode || "",
  PhoneNumber: normalizedPhone,
  Email: email,
};
process.stdout.write(JSON.stringify(contact));
' "${account_contact_json}" "${DOMAIN_CONTACT_EMAIL}")"

  operation_id="$(aws_cmd route53domains register-domain \
    --domain-name "${DOMAIN_NAME}" \
    --duration-in-years 1 \
    --auto-renew \
    --admin-contact "${contact_json}" \
    --registrant-contact "${contact_json}" \
    --tech-contact "${contact_json}" \
    --billing-contact "${contact_json}" \
    --privacy-protect-admin-contact \
    --privacy-protect-registrant-contact \
    --privacy-protect-tech-contact \
    --privacy-protect-billing-contact \
    --query 'OperationId' \
    --output text)"

  echo "Domain registration started: ${DOMAIN_NAME}"
  echo "Operation ID: ${operation_id}"

  elapsed=0
  while (( elapsed < WAIT_TIMEOUT_SECONDS )); do
    operation_status="$(aws_cmd route53domains get-operation-detail \
      --operation-id "${operation_id}" \
      --query 'Status' \
      --output text)"
    if [[ "${operation_status}" == "SUCCESSFUL" ]]; then
      echo "Domain registration completed."
      break
    fi
    if [[ "${operation_status}" == "ERROR" || "${operation_status}" == "FAILED" ]]; then
      aws_cmd route53domains get-operation-detail --operation-id "${operation_id}" --output json >&2
      exit 1
    fi
    sleep "${POLL_INTERVAL_SECONDS}"
    elapsed=$((elapsed + POLL_INTERVAL_SECONDS))
  done

  if (( elapsed >= WAIT_TIMEOUT_SECONDS )); then
    echo "Timed out waiting for domain registration to complete." >&2
    echo "Check status with: ${AWS_BIN} route53domains get-operation-detail --operation-id ${operation_id}" >&2
    exit 1
  fi
fi

hosted_zone_id="$(aws_cmd route53 list-hosted-zones-by-name \
  --dns-name "${DOMAIN_NAME}" \
  --query "HostedZones[?Name=='${DOMAIN_NAME}.'].Id | [0]" \
  --output text)"

if [[ -z "${hosted_zone_id}" || "${hosted_zone_id}" == "None" ]]; then
  echo "Unable to find hosted zone for domain: ${DOMAIN_NAME}" >&2
  exit 1
fi

export PUBLIC_HOSTED_ZONE_ID="${hosted_zone_id#/hostedzone/}"
export PUBLIC_FQDN

"$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/configure-public-domain.sh"
