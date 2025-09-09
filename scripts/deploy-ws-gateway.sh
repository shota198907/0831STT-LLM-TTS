#!/bin/bash

# Deploy WebSocket Gateway to Google Cloud Run
set -e

PROJECT_ID=${PROJECT_ID:-"your-project-id"}
REGION=${REGION:-"asia-northeast1"}
SERVICE_NAME="ws-gateway"
COMMIT_SHA=${COMMIT_SHA:-$(git rev-parse --short HEAD)}

echo "Deploying WebSocket Gateway to Cloud Run..."
echo "Project: $PROJECT_ID"
echo "Region: $REGION"
echo "Service: $SERVICE_NAME"
echo "Commit: $COMMIT_SHA"

# Build and push the container
docker build -t gcr.io/$PROJECT_ID/$SERVICE_NAME:$COMMIT_SHA ./ws-gateway/
docker push gcr.io/$PROJECT_ID/$SERVICE_NAME:$COMMIT_SHA

# Deploy to Cloud Run
gcloud run deploy $SERVICE_NAME \
  --image gcr.io/$PROJECT_ID/$SERVICE_NAME:$COMMIT_SHA \
  --region $REGION \
  --platform managed \
  --allow-unauthenticated \
  --port 8080 \
  --memory 1Gi \
  --cpu 1 \
  --timeout 300 \
  --concurrency 1000 \
  --max-instances 10 \
  --min-instances 1 \
  --set-env-vars "PORT=8080,WS_PATH=/ws,IDLE_SEC=45,MAX_MSG_BYTES=2097152,REQUIRE_TOKEN=false,MAX_BYTES=16777216,MAX_CONN_SECS=600,SILENCE_MS=1200,EOU_GRACE_MS=300"

echo "WebSocket Gateway deployed successfully!"
echo "Service URL: https://$SERVICE_NAME-$PROJECT_ID.a.run.app"
echo "WebSocket URL: wss://$SERVICE_NAME-$PROJECT_ID.a.run.app/ws"
