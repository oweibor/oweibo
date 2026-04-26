# docker/sandbox/Dockerfile
# Built once per dependency update; pushed to internal registry; mounted read-only.
# Used by GVisorSandbox (Track 1 — default production backend).
# Renovatebot bumps pinned versions; image rebuild triggers all pool VMs to rotate.
FROM node:20.14.0-alpine3.19

# Pre-install exactly the test runner versions the factory uses — pinned for determinism
RUN apk add --no-cache python3 py3-pip bash curl git && \
    pip3 install --no-cache-dir pytest==8.1.1 --break-system-packages

# Pre-install Node test runners at pinned versions
RUN npm install -g \
    jest@29.7.0 \
    vitest@1.6.0 \
    ts-jest@29.1.4 \
    typescript@5.4.5 \
    tsx@4.11.0 \
    --ignore-scripts

# Pre-warm module cache — all deps available offline (network=none in sandbox)
WORKDIR /sandbox-deps
COPY sandbox-deps.json package.json
RUN npm install --ignore-scripts --no-audit --no-fund 2>/dev/null || true

# Non-root user — defence in depth
RUN addgroup -g 1001 sandbox && adduser -u 1001 -G sandbox -s /bin/sh -D sandbox
USER sandbox

WORKDIR /workspace
CMD ["/bin/sh"]

# Build: docker build -t oweibo-sandbox:latest docker/sandbox/
# Push:  docker tag oweibo-sandbox:latest registry.internal/oweibo/sandbox:latest
#        docker push registry.internal/oweibo/sandbox:latest
