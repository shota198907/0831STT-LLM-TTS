#!/usr/bin/env bash
set -euo pipefail

# Usage:
#   PROJECT_ID=your-project \
#   OPENAI_SECRET_NAME=OPENAI_API_KEY \
#   GEMINI_SECRET_NAME=GEMINI_API_KEY \
#   GOOGLE_CREDS_SECRET_NAME=service-account-key \
#   bash scripts/dev-with-secrets.sh
#
# This script fetches secrets from Google Secret Manager at runtime and starts the dev server
# without writing keys to disk. Requires `gcloud auth application-default login` or a service
# account with access to the secrets.

PROJECT_ID=${PROJECT_ID:-${GOOGLE_CLOUD_PROJECT_ID:-}}
if [[ -z "${PROJECT_ID}" ]]; then
  echo "PROJECT_ID (or GOOGLE_CLOUD_PROJECT_ID) is required" >&2
  exit 1
fi

OPENAI_SECRET_NAME=${OPENAI_SECRET_NAME:-OPENAI_API_KEY}
GEMINI_SECRET_NAME=${GEMINI_SECRET_NAME:-GEMINI_API_KEY}
# Optional: path to SA JSON; many libs use ADC so this may be unnecessary locally
GOOGLE_CREDS_SECRET_NAME=${GOOGLE_CREDS_SECRET_NAME:-}

fetch_secret() {
  local name=$1
  gcloud secrets versions access latest --secret="${name}" --project "${PROJECT_ID}"
}

export OPENAI_API_KEY="$(fetch_secret "${OPENAI_SECRET_NAME}")"
export GEMINI_API_KEY="$(fetch_secret "${GEMINI_SECRET_NAME}")"

if [[ -n "${GOOGLE_CREDS_SECRET_NAME}" ]]; then
  # Export GOOGLE_APPLICATION_CREDENTIALS via a temp file that is auto-removed on exit
  tmp_json=$(mktemp)
  trap 'rm -f "${tmp_json}"' EXIT
  gcloud secrets versions access latest --secret="${GOOGLE_CREDS_SECRET_NAME}" --project "${PROJECT_ID}" > "${tmp_json}"
  export GOOGLE_APPLICATION_CREDENTIALS="${tmp_json}"
fi

echo "Starting dev server with secrets from Secret Manager (no local .env needed)"
pnpm dev

