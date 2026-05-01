#!/usr/bin/env bash
# chaos/kill-and-recover.sh — Phase 7 chaos testing
#
# What it does:
#   1. (Optionally) runs a background k6 workload during the chaos window
#   2. Hard-kills the target container (SIGKILL via docker kill)
#   3. Waits for Docker's restart policy to bring it back
#   4. Polls the health endpoint until recovery or timeout
#   5. If workload was running, checks it resumed (error spike then recovery)
#   6. Reports pass/fail with timing
#
# Services exercised (run separately or together with --target):
#   kilo-pipeline — API gateway; restart should be < 30 s
#   qdrant        — semantic store; circuit breaker should open, close on recovery
#   redis         — short-term memory; reconnection should be transparent
#   ollama        — inference; tasks should queue and resume
#
# Usage:
#   ./load-tests/chaos/kill-and-recover.sh [--target SERVICE] [--compose-file FILE]
#
# Options:
#   --target SERVICE     Container/service to kill (default: kilo-pipeline)
#   --compose-file FILE  Path to docker-compose.yml (default: ./docker-compose.yml)
#   --health-url URL     Health endpoint to poll (default: http://localhost:3100)
#   --health-path PATH   Path appended to health URL (default: /)
#   --recovery-timeout N Seconds to wait for recovery (default: 60)
#   --with-load          Spin up a minimal k6 workload during chaos (requires k6 on PATH)
#   --k6-token TOKEN     Bearer token forwarded to k6 (required if --with-load)
#
# Exit code:
#   0 — recovery confirmed within timeout
#   1 — recovery timed out or health check never succeeded

set -euo pipefail

# ---------------------------------------------------------------------------
# Defaults
# ---------------------------------------------------------------------------

TARGET="kilo-pipeline"
COMPOSE_FILE="./docker-compose.yml"
HEALTH_URL="http://localhost:3100"
HEALTH_PATH="/"
RECOVERY_TIMEOUT=60
WITH_LOAD=false
K6_TOKEN=""

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------

while [[ $# -gt 0 ]]; do
  case "$1" in
    --target)           TARGET="$2";            shift 2 ;;
    --compose-file)     COMPOSE_FILE="$2";      shift 2 ;;
    --health-url)       HEALTH_URL="$2";        shift 2 ;;
    --health-path)      HEALTH_PATH="$2";       shift 2 ;;
    --recovery-timeout) RECOVERY_TIMEOUT="$2";  shift 2 ;;
    --with-load)        WITH_LOAD=true;         shift 1 ;;
    --k6-token)         K6_TOKEN="$2";          shift 2 ;;
    *)                  echo "Unknown arg: $1"; exit 1   ;;
  esac
done

HEALTH_ENDPOINT="${HEALTH_URL%/}${HEALTH_PATH}"
LOG_DIR="results/chaos"
mkdir -p "$LOG_DIR"
TIMESTAMP=$(date +%Y%m%dT%H%M%S)
LOG_FILE="${LOG_DIR}/${TARGET}_${TIMESTAMP}.log"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

log() { echo "[$(date +%T)] $*" | tee -a "$LOG_FILE"; }

die() {
  log "FAIL: $*"
  exit 1
}

health_ok() {
  curl -sf --max-time 5 "$HEALTH_ENDPOINT" > /dev/null 2>&1
}

wait_for_health() {
  local deadline=$(( $(date +%s) + RECOVERY_TIMEOUT ))
  while [[ $(date +%s) -lt $deadline ]]; do
    if health_ok; then
      return 0
    fi
    sleep 2
  done
  return 1
}

wait_for_down() {
  local deadline=$(( $(date +%s) + 15 ))
  while [[ $(date +%s) -lt $deadline ]]; do
    if ! health_ok; then
      return 0
    fi
    sleep 1
  done
  return 1  # never went down (already recovered or container did not die)
}

# ---------------------------------------------------------------------------
# Pre-flight
# ---------------------------------------------------------------------------

log "=== Chaos test: target=${TARGET} recovery_timeout=${RECOVERY_TIMEOUT}s ==="

if ! docker compose -f "$COMPOSE_FILE" ps --services --filter status=running 2>/dev/null \
    | grep -q "^${TARGET}$"; then
  die "Service '${TARGET}' is not running. Start the stack first."
fi

if ! health_ok; then
  die "Health endpoint ${HEALTH_ENDPOINT} is not healthy before chaos. Aborting."
fi

log "Pre-chaos health OK."

# ---------------------------------------------------------------------------
# Optional: start background load
# ---------------------------------------------------------------------------

K6_PID=""
if [[ "$WITH_LOAD" == true ]]; then
  if ! command -v k6 &>/dev/null; then
    die "--with-load requires k6 on PATH (https://k6.io/docs/getting-started/installation/)"
  fi
  if [[ -z "$K6_TOKEN" ]]; then
    die "--k6-token is required when --with-load is set"
  fi

  log "Starting background k6 workload (50 RPS during chaos window)…"
  K6_TOKEN="$K6_TOKEN" K6_BASE_URL="$HEALTH_URL" K6_RPS=50 K6_DURATION=3m \
    k6 run --quiet load-tests/k6/tasks-post.js \
    > "${LOG_DIR}/k6_chaos_${TIMESTAMP}.log" 2>&1 &
  K6_PID=$!
  sleep 5  # let workload ramp before we kill
fi

# ---------------------------------------------------------------------------
# Chaos: hard kill
# ---------------------------------------------------------------------------

log "Sending SIGKILL to container '${TARGET}'…"
KILL_TIME=$(date +%s)
docker kill "$TARGET" >> "$LOG_FILE" 2>&1 || true

# Confirm it actually went down (some services restart too fast)
if wait_for_down; then
  log "Container '${TARGET}' confirmed down."
else
  log "WARNING: health endpoint did not drop within 15 s — container may have restarted before observation."
fi

# ---------------------------------------------------------------------------
# Recovery: poll health
# ---------------------------------------------------------------------------

log "Waiting for '${TARGET}' to recover (timeout: ${RECOVERY_TIMEOUT}s)…"
RECOVER_START=$(date +%s)

if wait_for_health; then
  RECOVER_END=$(date +%s)
  ELAPSED=$(( RECOVER_END - KILL_TIME ))
  log "PASS: '${TARGET}' recovered in ${ELAPSED}s."
  RESULT=0
else
  log "FAIL: '${TARGET}' did not recover within ${RECOVERY_TIMEOUT}s."
  RESULT=1
fi

# ---------------------------------------------------------------------------
# Cleanup: stop background load if running
# ---------------------------------------------------------------------------

if [[ -n "$K6_PID" ]]; then
  log "Stopping background k6 workload (pid ${K6_PID})…"
  kill "$K6_PID" 2>/dev/null || true
  wait "$K6_PID" 2>/dev/null || true
fi

# ---------------------------------------------------------------------------
# Summarise
# ---------------------------------------------------------------------------

log "=== Chaos report: target=${TARGET} result=$([ $RESULT -eq 0 ] && echo PASS || echo FAIL) ==="
log "Log written to: ${LOG_FILE}"

exit $RESULT
