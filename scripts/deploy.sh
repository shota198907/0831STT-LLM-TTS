#!/usr/bin/env bash
set -euo pipefail

# Cloud Run deploy script
# - Builds a Docker image using the Dockerfile
# - Deploys to Cloud Run with optional env vars from env.yaml
#
# Usage:
#   bash scripts/deploy.sh <SERVICE_NAME>
#
# Options via env vars:
#   PROJECT=<gcp-project-id>        # defaults to gcloud default project
#   REGION=<region>                 # defaults to asia-northeast1
#   ENV_FILE=<path/to/env.yaml>     # defaults to env.yaml if exists
#   IMAGE_TAG=<tag>                 # defaults to YYYYMMDD-HHMMSS
#   ALLOW_UNAUTH=<true|false>       # defaults to true (WS uses token-gate)
#   CPU=<vCPU> MEM=<size> CONCURRENCY=<n> MAX_INSTANCES=<n>
#   SECRET_GOOGLE_API_KEY=<secretName[:version]>   # injects GOOGLE_API_KEY from Secret Manager
#   SECRET_WS_TOKEN=<secretName[:version]>          # injects WS_TOKEN from Secret Manager

SERVICE=${1:-}
if [[ -z "${SERVICE}" ]]; then
  echo "Usage: bash scripts/deploy.sh <SERVICE_NAME>" >&2
  exit 1
fi

PROJECT=${PROJECT:-$(gcloud config get-value project 2>/dev/null || true)}
REGION=${REGION:-asia-northeast1}
ENV_FILE=${ENV_FILE:-env.yaml}
IMAGE_TAG=${IMAGE_TAG:-$(date +%Y%m%d-%H%M%S)}
ALLOW_UNAUTH=${ALLOW_UNAUTH:-true}
CPU=${CPU:-1}
MEM=${MEM:-1Gi}
CONCURRENCY=${CONCURRENCY:-40}
MAX_INSTANCES=${MAX_INSTANCES:-10}

if [[ -z "${PROJECT}" ]]; then
  echo "PROJECT is not set and gcloud default project is empty." >&2
  exit 1
fi

IMAGE="gcr.io/${PROJECT}/${SERVICE}:${IMAGE_TAG}"
DOCKERFILE=${DOCKERFILE:-Dockerfile.ws-gateway}

echo "[Build] Building container image: ${IMAGE} (dockerfile=${DOCKERFILE})"
gcloud builds submit --tag "${IMAGE}" --gcs-log-dir="" --config /dev/null --verbosity=info --timeout=1200 --ignore-file=.dockerignore --dockerfile "${DOCKERFILE}" . 2>/dev/null || \
  gcloud builds submit --tag "${IMAGE}" --file "${DOCKERFILE}"

ENV_FLAG=()
if [[ -f "${ENV_FILE}" ]]; then
  echo "[Deploy] Using env vars file: ${ENV_FILE}"
  ENV_FLAG=("--env-vars-file=${ENV_FILE}")
else
  echo "[Deploy] No env file found at ${ENV_FILE}. Proceeding without it."
fi

# Secret Manager bindings
SECRET_FLAGS=()
if [[ -n "${SECRET_GOOGLE_API_KEY}" ]]; then
  SECRET_FLAGS+=("--set-secrets=GOOGLE_API_KEY=${SECRET_GOOGLE_API_KEY}")
fi
if [[ -n "${SECRET_WS_TOKEN}" ]]; then
  SECRET_FLAGS+=("--set-secrets=WS_TOKEN=${SECRET_WS_TOKEN}")
fi

UNAUTH_FLAG=("--allow-unauthenticated")
if [[ "${ALLOW_UNAUTH}" != "true" ]]; then
  UNAUTH_FLAG=()
fi

echo "[Deploy] Deploying to Cloud Run: service=${SERVICE} region=${REGION} project=${PROJECT}"
gcloud run deploy "${SERVICE}" \
  --image "${IMAGE}" \
  --region "${REGION}" \
  --project "${PROJECT}" \
  --port 8080 \
  "${UNAUTH_FLAG[@]}" \
  --cpu "${CPU}" \
  --memory "${MEM}" \
  --concurrency "${CONCURRENCY}" \
  --max-instances "${MAX_INSTANCES}" \
  "${ENV_FLAG[@]}" \
  "${SECRET_FLAGS[@]}"

echo "[Info] Service URL:"
gcloud run services describe "${SERVICE}" --region "${REGION}" --project "${PROJECT}" --format='value(status.url)'

echo "[Done] Deployed ${SERVICE}"
