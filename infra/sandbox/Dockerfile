# kilo-sandbox — Hardened execution image for Kilo CLI tasks
# ============================================================
# Security profile:
#   - Runs as the built-in 'node' user (uid 1000) — never root
#   - @kilocode/cli pre-installed so each task needs no npm install
#   - No shell interpreters needed at task-execution time
#   - Minimal surface: no curl, no wget, no package managers beyond what kilo needs
#
# Build:  docker build -t kilo-sandbox:latest infra/sandbox/
# Config: set SANDBOX_IMAGE=kilo-sandbox:latest in config.env

FROM node:20-slim

# Switch to root only for the install step, then drop permanently
USER root

WORKDIR /app

# Install kilo CLI globally so every sandbox invocation skips the npm install penalty.
# Pin to a specific version in production to prevent supply-chain drift.
RUN npm install -g @kilocode/cli \
    && npm cache clean --force

# Create a writable /tmp for kilo's internal temp files (root fs will be read-only at runtime).
# /checkpoint is the only other writable path — provided via Docker bind mount at spawn time.
RUN mkdir -p /tmp && chmod 1777 /tmp

# Drop to non-root for all runtime execution
USER node

WORKDIR /workspace

# The container is started with 'sleep infinity' and then driven via docker exec.
# No CMD/ENTRYPOINT needed — the pipeline sets Cmd at createContainer time.
