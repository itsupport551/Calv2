# ============================================================
# Enterprise Calendar Sync — Dockerfile
# ============================================================
# Multi-stage build for minimal attack surface.
# Production image is ~150MB (Alpine-based).
# ============================================================

# ---- Stage 1: Build ----
FROM node:20-alpine AS builder

WORKDIR /app

# Install dependencies first (cached unless package*.json changes).
# Copy the lockfile so `npm ci` runs deterministically — without it,
# Railway/Docker fall back to `npm install` which is slower, non-reproducible,
# and can pull a different Prisma/TS minor version than what was tested.
COPY package.json package-lock.json ./
RUN npm ci --include=dev

# Copy source and build
COPY tsconfig.json ./
COPY src/ ./src/

RUN npx prisma generate --schema=src/database/prisma/schema.prisma
RUN npx tsc -p tsconfig.json

# ---- Stage 2: Production ----
FROM node:20-alpine AS production

# Security: run as non-root user
RUN addgroup -g 1001 -S appgroup && \
    adduser -S appuser -u 1001 -G appgroup

WORKDIR /app

# Copy only production dependencies (lockfile required for `npm ci`)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy built code and Prisma artifacts
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/src/database/prisma ./src/database/prisma

# Security hardening
RUN chown -R appuser:appgroup /app
USER appuser

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:4400/health || exit 1

EXPOSE 4400

# Try to apply pending migrations, then ALWAYS start the server.
# - `timeout 25` bounds the migration so a hanging DB connection (e.g.
#   bad DATABASE_URL, IPv6-only direct URL Railway can't reach) cannot
#   stall startup past Railway's healthcheck window.
# - `|| true` catches both timeouts AND migration errors so node still
#   launches and /health stays reachable for diagnosis.
# - `exec node` makes node PID 1 for proper signal handling.
CMD ["sh", "-c", "timeout 25 npx prisma migrate deploy --schema=src/database/prisma/schema.prisma || echo '⚠️  Prisma migrate deploy failed or timed out — starting server anyway so /health is reachable. Verify DATABASE_URL and DIRECT_URL are correct.'; exec node dist/server.js"]
