# ---------- Base (pnpm enabled) ----------
  FROM node:20-alpine AS base
  ENV PNPM_HOME=/pnpm
  ENV PATH=$PNPM_HOME:$PATH
  RUN corepack enable
  WORKDIR /app
  
  # ---------- Deps (populate pnpm store) ----------
  FROM base AS deps
  COPY pnpm-lock.yaml package.json ./
  RUN pnpm fetch
  
  # ---------- Builder (install offline & build) ----------
  FROM base AS builder
  # bring the fetched store & lockfile
  COPY --from=deps /pnpm /pnpm
  COPY --from=deps /app/pnpm-lock.yaml ./pnpm-lock.yaml
  COPY --from=deps /app/package.json ./package.json
  
  # app source
  COPY . .
  
  ENV NODE_ENV=production
  ENV NEXT_TELEMETRY_DISABLED=1
  
  # deterministic, offline install + build (Next.js standalone)
  RUN pnpm install --frozen-lockfile --offline
  RUN pnpm build
  
  # ---------- Runner (lean runtime) ----------
  FROM node:20-alpine AS runner
  WORKDIR /app
  
  ENV NODE_ENV=production
  ENV NEXT_TELEMETRY_DISABLED=1
  # Cloud Run listens on 8080 by default
  ENV PORT=8080
  
  # non-root user
  RUN addgroup -S nextjs && adduser -S nextjs -G nextjs
  
  # healthcheck tool
  RUN apk add --no-cache curl
  
  # copy standalone output only
  COPY --from=builder /app/.next/standalone ./
  COPY --from=builder /app/public ./public
  COPY --from=builder /app/.next/static ./.next/static
  
  USER nextjs
  EXPOSE 8080
  
  HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
    CMD curl -fsS http://localhost:8080/api/health || exit 1
  
  # Next standalone emits server.js as entrypoint
  CMD ["node", "server.js"]
  