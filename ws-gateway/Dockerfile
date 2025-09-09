# syntax=docker/dockerfile:1

# WebSocket Gateway Dockerfile
FROM node:20-alpine

WORKDIR /app

# Install dependencies
COPY package.json ./
RUN npm install --production

# Copy source code
COPY server.js ./

# Create non-root user
RUN addgroup -S wsgateway && adduser -S wsgateway -G wsgateway

# Install curl for healthcheck
RUN apk add --no-cache curl

# Set environment variables
ENV NODE_ENV=production
ENV PORT=8080

# Change ownership
RUN chown -R wsgateway:wsgateway /app
USER wsgateway

EXPOSE 8080

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD curl -fsS http://localhost:8080/healthz || exit 1

CMD ["node", "server.js"]
    