FROM node:20-slim

# Prevents zombie processes; optional but recommended
# Install tini if desired (commented to keep slim). Node 20 handles signals well.

WORKDIR /app

# Install only production deps
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy source
COPY server ./server

# Ensure non-root can write logs in /app
RUN chown -R node:node /app
USER node

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

CMD ["node", "server/index.js"]
