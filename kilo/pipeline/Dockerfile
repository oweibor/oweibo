# kilo-pipeline — Production Dockerfile (TypeScript)
# =====================================================
# Kilo Code v9 — Phase 2 Pipeline Foundation
#
# Base: node:20-slim (not alpine — native modules for @xenova/transformers)
# Memory budget: 1 GB (set in docker-compose.yml)
# Model: MiniLM-L6-v2 via @xenova/transformers (CPU, quantized, ~80 MB)
#
# Build: docker compose build kilo-pipeline
# Run:   docker compose up -d kilo-pipeline

# ── Stage 1: Install all deps (prod + dev, needed for tsc) ──────
FROM node:20-slim AS deps

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm ci 2>/dev/null || npm install

# ── Stage 2: Compile TypeScript → JavaScript ────────────────────
FROM deps AS builder

WORKDIR /app

COPY tsconfig.json ./
COPY src/ ./src/

RUN npx tsc --project tsconfig.json

# ── Stage 3: Install production-only deps ───────────────────────
FROM node:20-slim AS prod-deps

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev 2>/dev/null || npm install --omit=dev

# ── Stage 4: Runtime image ──────────────────────────────────────
FROM node:20-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    && rm -rf /var/lib/apt/lists/*

RUN groupadd -r kilo && useradd -r -g kilo -m kilo

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY package.json ./

RUN mkdir -p /app/models && chown kilo:kilo /app/models
RUN mkdir -p /var/kilo/checkpoints && chown kilo:kilo /var/kilo/checkpoints

USER kilo

EXPOSE 3100

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD curl -sf http://localhost:3100/health || exit 1

CMD ["node", "dist/index.js"]
