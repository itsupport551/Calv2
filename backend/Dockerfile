# ============================================================
# Enterprise Calendar Sync — Dockerfile
# ============================================================
# Multi-stage build for minimal attack surface.
# Production image is ~150MB (Alpine-based).
# ============================================================

# ---- Stage 1: Build ----
FROM node:20-alpine AS builder

WORKDIR /app

# Install dependencies first (cached unless package.json changes)
COPY package.json ./
RUN npm install --production=false

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

# Copy only production dependencies
COPY package.json ./
RUN npm install --production && npm cache clean --force

# Copy built code and Prisma
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

# Apply any pending database migrations, then start the server.
# `migrate deploy` is idempotent — safe to run on every boot.
CMD ["sh", "-c", "npx prisma migrate deploy --schema=src/database/prisma/schema.prisma && node dist/server.js"]
