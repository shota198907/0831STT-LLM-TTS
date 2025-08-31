#!/bin/bash

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Configuration
PROJECT_ID="stt-llm-tts-470704"
REGION="asia-northeast1"
SERVICE_NAME="ai-phone-system"

echo -e "${GREEN}🔧 Setting up environment variables for AI Phone System${NC}"

# Check if gcloud is installed
if ! command -v gcloud &> /dev/null; then
    echo -e "${RED}❌ gcloud CLI is not installed. Please install it first.${NC}"
    exit 1
fi

# Set the project
gcloud config set project $PROJECT_ID

echo -e "${YELLOW}📝 Please provide the following environment variables:${NC}"

# Prompt for API keys
read -p "Enter your Gemini API Key: " GEMINI_API_KEY
read -p "Enter your Google Cloud API Key: " GOOGLE_CLOUD_API_KEY

# Set environment variables
echo -e "${YELLOW}🔧 Setting environment variables on Cloud Run service${NC}"

gcloud run services update $SERVICE_NAME \
  --region=$REGION \
  --set-env-vars="GOOGLE_CLOUD_PROJECT_ID=$PROJECT_ID,GEMINI_API_KEY=$GEMINI_API_KEY,GOOGLE_CLOUD_API_KEY=$GOOGLE_CLOUD_API_KEY,NODE_ENV=production,DEBUG_LOGGING=false,VERBOSE_LOGGING=false"

echo -e "${GREEN}✅ Environment variables set successfully!${NC}"
echo -e "${YELLOW}📋 Next steps:${NC}"
echo -e "1. Create a service account for Google Cloud APIs"
echo -e "2. Download the service account key JSON file"
echo -e "3. Upload it as a secret in Google Secret Manager"
echo -e "4. Update the Cloud Run service to use the secret"
