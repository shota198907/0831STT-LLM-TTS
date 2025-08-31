# AI Phone System - Deployment Guide

## Prerequisites

1. **Google Cloud Account** with billing enabled
2. **gcloud CLI** installed and configured
3. **Docker** installed (for local testing)
4. **Node.js 18+** for local development

## Project Setup

### 1. Google Cloud Project Configuration

\`\`\`bash
# Set your project ID
export PROJECT_ID="stt-llm-tts-470704"
gcloud config set project $PROJECT_ID

# Enable required APIs
gcloud services enable cloudbuild.googleapis.com
gcloud services enable run.googleapis.com
gcloud services enable speech.googleapis.com
gcloud services enable texttospeech.googleapis.com
gcloud services enable aiplatform.googleapis.com
\`\`\`

### 2. Service Account Setup

\`\`\`bash
# Create service account
gcloud iam service-accounts create ai-phone-system \
    --display-name="AI Phone System Service Account"

# Grant necessary permissions
gcloud projects add-iam-policy-binding $PROJECT_ID \
    --member="serviceAccount:ai-phone-system@$PROJECT_ID.iam.gserviceaccount.com" \
    --role="roles/speech.admin"

gcloud projects add-iam-policy-binding $PROJECT_ID \
    --member="serviceAccount:ai-phone-system@$PROJECT_ID.iam.gserviceaccount.com" \
    --role="roles/texttospeech.admin"

# Create and download service account key
gcloud iam service-accounts keys create ./service-account-key.json \
    --iam-account=ai-phone-system@$PROJECT_ID.iam.gserviceaccount.com
\`\`\`

### 3. API Keys Setup

1. **Gemini API Key**: Get from [Google AI Studio](https://makersuite.google.com/app/apikey)
2. **Google Cloud API Key**: Create in [Google Cloud Console](https://console.cloud.google.com/apis/credentials)

## Deployment Methods

### Method 1: Automated Deployment (Recommended)

\`\`\`bash
# Make scripts executable
chmod +x scripts/deploy.sh
chmod +x scripts/setup-env.sh

# Deploy the application
./scripts/deploy.sh

# Set up environment variables
./scripts/setup-env.sh
\`\`\`

### Method 2: Manual Deployment

\`\`\`bash
# Build and deploy using Cloud Build
gcloud builds submit --config cloudbuild.yaml .

# Set environment variables
gcloud run services update ai-phone-system \
  --region=asia-northeast1 \
  --set-env-vars="GOOGLE_CLOUD_PROJECT_ID=$PROJECT_ID,GEMINI_API_KEY=your_key_here,GOOGLE_CLOUD_API_KEY=your_key_here"
\`\`\`

## Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `GOOGLE_CLOUD_PROJECT_ID` | Your Google Cloud project ID | Yes |
| `GEMINI_API_KEY` | API key for Gemini AI | Yes |
| `GOOGLE_CLOUD_API_KEY` | Google Cloud API key | Yes |
| `GOOGLE_APPLICATION_CREDENTIALS` | Path to service account JSON | Yes |
| `NODE_ENV` | Environment (production) | Yes |
| `DEBUG_LOGGING` | Enable debug logs (false for production) | No |
| `VERBOSE_LOGGING` | Enable verbose logs (false for production) | No |

## Security Configuration

### 1. Service Account Key Management

Store the service account key in Google Secret Manager:

\`\`\`bash
# Create secret
gcloud secrets create ai-phone-service-account \
    --data-file=./service-account-key.json

# Grant access to Cloud Run
gcloud secrets add-iam-policy-binding ai-phone-service-account \
    --member="serviceAccount:ai-phone-system@$PROJECT_ID.iam.gserviceaccount.com" \
    --role="roles/secretmanager.secretAccessor"
\`\`\`

### 2. Update Cloud Run to Use Secret

\`\`\`bash
gcloud run services update ai-phone-system \
  --region=asia-northeast1 \
  --set-env-vars="GOOGLE_APPLICATION_CREDENTIALS=/secrets/service-account-key.json" \
  --set-secrets="/secrets/service-account-key.json=ai-phone-service-account:latest"
\`\`\`

## Monitoring and Logging

### Health Check Endpoint

The application includes a health check endpoint at `/api/health` that provides:
- Service status
- API configuration status
- System uptime
- Environment information

### Logging

- Production logs are sent to Google Cloud Logging
- Debug logging is disabled in production
- Access logs are automatically collected by Cloud Run

### Monitoring

Set up monitoring in Google Cloud Console:
1. Go to Cloud Run service
2. Click on "Metrics" tab
3. Set up alerting for error rates and latency

## Troubleshooting

### Common Issues

1. **Authentication Errors**
   - Verify service account permissions
   - Check API keys are correctly set
   - Ensure service account key is accessible

2. **API Quota Exceeded**
   - Check Google Cloud Console for quota limits
   - Request quota increases if needed

3. **Memory/CPU Issues**
   - Monitor resource usage in Cloud Run console
   - Adjust memory/CPU allocation in cloudbuild.yaml

4. **Audio Processing Errors**
   - Verify microphone permissions in browser
   - Check WebRTC compatibility
   - Test with different audio formats

### Debug Mode

For debugging, temporarily enable debug logging:

\`\`\`bash
gcloud run services update ai-phone-system \
  --region=asia-northeast1 \
  --set-env-vars="DEBUG_LOGGING=true,VERBOSE_LOGGING=true"
\`\`\`

## Performance Optimization

### Recommended Settings

- **Memory**: 2Gi (minimum for audio processing)
- **CPU**: 2 vCPU (for real-time processing)
- **Concurrency**: 80 (adjust based on usage)
- **Max Instances**: 10 (adjust based on expected load)
- **Timeout**: 300 seconds (for long conversations)

### Scaling Configuration

\`\`\`bash
gcloud run services update ai-phone-system \
  --region=asia-northeast1 \
  --memory=4Gi \
  --cpu=4 \
  --concurrency=50 \
  --max-instances=20
\`\`\`

## Cost Optimization

1. **Set appropriate resource limits** to avoid over-provisioning
2. **Use minimum instances = 0** to scale to zero when not in use
3. **Monitor API usage** and set up billing alerts
4. **Optimize audio processing** to reduce compute time

## Support

For issues and questions:
1. Check the health endpoint: `https://your-service-url/api/health`
2. Review Cloud Run logs in Google Cloud Console
3. Verify all environment variables are set correctly
4. Test locally using the development environment first
