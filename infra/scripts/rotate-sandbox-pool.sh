#!/usr/bin/env bash
# infra/scripts/rotate-sandbox-pool.sh
# Called by CI on sandbox image rebuild — drains and refills the warm pool gracefully.
# Usage: ./infra/scripts/rotate-sandbox-pool.sh [namespace] [pool-size]
set -euo pipefail

NAMESPACE=${1:-oweibo}
POOL_SIZE=${2:-5}
API_BASE=${OWEIBO_API_URL:-http://localhost:3000}

echo "▶ Starting sandbox pool rotation (namespace=$NAMESPACE, target pool=$POOL_SIZE)"

# 1. Signal pool manager to drain — marks all idle VMs as draining (no new tasks)
echo "→ Draining warm pool..."
curl -sf -X POST "$API_BASE/internal/sandbox/drain" \
  -H "Content-Type: application/json" \
  -d '{"gracePeriodMs": 30000}' || {
  echo "⚠  Drain endpoint unavailable — proceeding with hard reset"
}

# 2. Wait for in-flight tasks to complete (max 60s)
echo "→ Waiting for in-flight tasks to complete..."
for i in {1..12}; do
  IN_FLIGHT=$(curl -sf "$API_BASE/internal/sandbox/status" | \
    python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('inFlight',0))" 2>/dev/null || echo 0)
  if [ "$IN_FLIGHT" = "0" ]; then
    echo "  ✓ No in-flight tasks remaining"
    break
  fi
  echo "  ... $IN_FLIGHT tasks still running ($i/12)"
  sleep 5
done

# 3. Scale pool to 0 — evict all VMs (they will be replaced with new image)
echo "→ Evicting current pool VMs..."
curl -sf -X POST "$API_BASE/internal/sandbox/resize" \
  -H "Content-Type: application/json" \
  -d '{"targetSize": 0}' || echo "⚠  Resize endpoint unavailable"

sleep 3

# 4. Refill with new image
echo "→ Refilling pool with new image (size=$POOL_SIZE)..."
curl -sf -X POST "$API_BASE/internal/sandbox/resize" \
  -H "Content-Type: application/json" \
  -d "{\"targetSize\": $POOL_SIZE}" || echo "⚠  Refill endpoint unavailable — pool will self-heal"

echo "✓ Sandbox pool rotation complete"
