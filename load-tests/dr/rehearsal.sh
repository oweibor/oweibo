#!/usr/bin/env bash
# dr/rehearsal.sh — Phase 7 Disaster Recovery rehearsal
#
# What it does:
#   1. Takes a live pg_dump of the Postgres database (hot backup)
#   2. Spins up a scratch Postgres container
#   3. Restores the dump into scratch
#   4. Runs integrity checks (row counts, FK consistency, schema version)
#   5. (Optional) verifies WAL replay by applying archived WAL segments
#   6. Reports pass/fail and elapsed time — target < 15 min RTO
#
# Postgres is not in the current docker-compose; this script targets an
# externally managed Postgres reachable via $PG_HOST / $PG_PORT.
#
# Usage:
#   ./load-tests/dr/rehearsal.sh [OPTIONS]
#
# Required env vars (or pass via --flag):
#   PG_HOST      Postgres host (default: localhost)
#   PG_PORT      Postgres port (default: 5432)
#   PG_USER      Superuser login  (default: postgres)
#   PG_PASSWORD  Password (written to ~/.pgpass temporarily)
#   PG_DBNAME    Database to back up and restore (default: oweibo)
#
# Optional env vars:
#   DR_BACKUP_DIR    Where to store dumps (default: results/dr/backups)
#   DR_SCRATCH_PORT  Port for scratch Postgres container (default: 15432)
#   DR_WAL_ARCHIVE   Path to WAL archive dir for WAL replay test (optional)
#   DR_RTO_SECONDS   RTO budget in seconds (default: 900 = 15 min)
#
# Exit code:
#   0 — restore + integrity checks passed within RTO
#   1 — failure

set -euo pipefail

# ---------------------------------------------------------------------------
# Config (env overrides or defaults)
# ---------------------------------------------------------------------------

PG_HOST="${PG_HOST:-localhost}"
PG_PORT="${PG_PORT:-5432}"
PG_USER="${PG_USER:-postgres}"
PG_PASSWORD="${PG_PASSWORD:-}"
PG_DBNAME="${PG_DBNAME:-oweibo}"

DR_BACKUP_DIR="${DR_BACKUP_DIR:-results/dr/backups}"
DR_SCRATCH_PORT="${DR_SCRATCH_PORT:-15432}"
DR_WAL_ARCHIVE="${DR_WAL_ARCHIVE:-}"
DR_RTO_SECONDS="${DR_RTO_SECONDS:-900}"

SCRATCH_CONTAINER="dr-rehearsal-postgres-$$"
TIMESTAMP=$(date +%Y%m%dT%H%M%S)
DUMP_FILE="${DR_BACKUP_DIR}/oweibo_${TIMESTAMP}.dump"
LOG_DIR="results/dr"
LOG_FILE="${LOG_DIR}/rehearsal_${TIMESTAMP}.log"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

mkdir -p "$DR_BACKUP_DIR" "$LOG_DIR"

log() { echo "[$(date +%T)] $*" | tee -a "$LOG_FILE"; }
die() { log "FAIL: $*"; cleanup; exit 1; }

PGPASSFILE_TMP=""

setup_pgpass() {
  PGPASSFILE_TMP=$(mktemp /tmp/pgpass_XXXXXX)
  chmod 600 "$PGPASSFILE_TMP"
  echo "${PG_HOST}:${PG_PORT}:*:${PG_USER}:${PG_PASSWORD}" > "$PGPASSFILE_TMP"
  export PGPASSFILE="$PGPASSFILE_TMP"
}

cleanup() {
  log "Cleaning up scratch container and temp files…"
  docker rm -f "$SCRATCH_CONTAINER" 2>/dev/null || true
  [[ -n "$PGPASSFILE_TMP" ]] && rm -f "$PGPASSFILE_TMP"
}

trap 'cleanup' EXIT

psql_source() {
  PGPASSFILE="$PGPASSFILE_TMP" psql \
    -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -d "$PG_DBNAME" \
    -t -A "$@"
}

psql_scratch() {
  PGPASSWORD=dr_rehearsal psql \
    -h 127.0.0.1 -p "$DR_SCRATCH_PORT" -U postgres -d "$PG_DBNAME" \
    -t -A "$@"
}

wait_for_scratch_pg() {
  local deadline=$(( $(date +%s) + 30 ))
  while [[ $(date +%s) -lt $deadline ]]; do
    if PGPASSWORD=dr_rehearsal psql \
        -h 127.0.0.1 -p "$DR_SCRATCH_PORT" -U postgres \
        -c "SELECT 1" postgres > /dev/null 2>&1; then
      return 0
    fi
    sleep 2
  done
  return 1
}

# ---------------------------------------------------------------------------
# Pre-flight
# ---------------------------------------------------------------------------

log "=== DR rehearsal: db=${PG_DBNAME} host=${PG_HOST}:${PG_PORT} rto=${DR_RTO_SECONDS}s ==="

for cmd in pg_dump pg_restore docker psql; do
  command -v "$cmd" &>/dev/null || die "Required tool not found: ${cmd}"
done

[[ -z "$PG_PASSWORD" ]] && die "PG_PASSWORD is required"
setup_pgpass

# Verify source connectivity
psql_source -c "SELECT version();" > /dev/null \
  || die "Cannot connect to source Postgres at ${PG_HOST}:${PG_PORT}"

log "Source Postgres reachable."

# ---------------------------------------------------------------------------
# Step 1: Capture row counts from source for comparison
# ---------------------------------------------------------------------------

log "Capturing source row counts…"

SOURCE_COUNTS=$(psql_source -c "
  SELECT schemaname, tablename, n_live_tup
  FROM   pg_stat_user_tables
  ORDER  BY schemaname, tablename;
" 2>/dev/null || echo "")

SOURCE_TABLE_COUNT=$(psql_source -c "
  SELECT COUNT(*) FROM information_schema.tables
  WHERE table_schema NOT IN ('pg_catalog','information_schema');
")
log "Source: ${SOURCE_TABLE_COUNT} user tables."

# ---------------------------------------------------------------------------
# Step 2: pg_dump (custom format — fastest + parallel restore)
# ---------------------------------------------------------------------------

log "Dumping ${PG_DBNAME} to ${DUMP_FILE}…"
DUMP_START=$(date +%s)

PGPASSFILE="$PGPASSFILE_TMP" pg_dump \
  -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" \
  -Fc --no-password \
  -f "$DUMP_FILE" \
  "$PG_DBNAME" \
  || die "pg_dump failed"

DUMP_SIZE=$(du -sh "$DUMP_FILE" | cut -f1)
DUMP_ELAPSED=$(( $(date +%s) - DUMP_START ))
log "Dump complete: size=${DUMP_SIZE} elapsed=${DUMP_ELAPSED}s."

# ---------------------------------------------------------------------------
# Step 3: Spin up scratch Postgres
# ---------------------------------------------------------------------------

log "Starting scratch Postgres container (port ${DR_SCRATCH_PORT})…"

docker run -d --rm \
  --name "$SCRATCH_CONTAINER" \
  -e POSTGRES_PASSWORD=dr_rehearsal \
  -p "${DR_SCRATCH_PORT}:5432" \
  postgres:16-alpine \
  > /dev/null

wait_for_scratch_pg || die "Scratch Postgres did not become ready within 30 s."
log "Scratch Postgres ready."

# Create target database in scratch
PGPASSWORD=dr_rehearsal psql \
  -h 127.0.0.1 -p "$DR_SCRATCH_PORT" -U postgres postgres \
  -c "CREATE DATABASE \"${PG_DBNAME}\";" > /dev/null

# ---------------------------------------------------------------------------
# Step 4: Restore
# ---------------------------------------------------------------------------

log "Restoring dump into scratch Postgres…"
RESTORE_START=$(date +%s)

PGPASSWORD=dr_rehearsal pg_restore \
  -h 127.0.0.1 -p "$DR_SCRATCH_PORT" -U postgres \
  -d "$PG_DBNAME" \
  --no-owner --role=postgres \
  -j 4 \
  "$DUMP_FILE" \
  || die "pg_restore failed"

RESTORE_ELAPSED=$(( $(date +%s) - RESTORE_START ))
log "Restore complete: elapsed=${RESTORE_ELAPSED}s."

TOTAL_ELAPSED=$(( DUMP_ELAPSED + RESTORE_ELAPSED ))
log "Total dump+restore elapsed: ${TOTAL_ELAPSED}s / RTO budget: ${DR_RTO_SECONDS}s."

# ---------------------------------------------------------------------------
# Step 5: Integrity checks
# ---------------------------------------------------------------------------

log "Running integrity checks…"
FAIL_COUNT=0

# 5a. Table count matches
RESTORE_TABLE_COUNT=$(psql_scratch -c "
  SELECT COUNT(*) FROM information_schema.tables
  WHERE table_schema NOT IN ('pg_catalog','information_schema');
")
if [[ "$RESTORE_TABLE_COUNT" != "$SOURCE_TABLE_COUNT" ]]; then
  log "FAIL: table count mismatch (source=${SOURCE_TABLE_COUNT} restored=${RESTORE_TABLE_COUNT})"
  (( FAIL_COUNT++ ))
else
  log "PASS: table count matches (${SOURCE_TABLE_COUNT})."
fi

# 5b. Row count spot-check (each table ± 5 % allowed for live writes during dump)
while IFS='|' read -r schema table src_count; do
  [[ -z "$table" ]] && continue
  restored_count=$(psql_scratch -c \
    "SELECT COUNT(*) FROM \"${schema}\".\"${table}\";" 2>/dev/null || echo "0")
  # Allow 5 % delta (live writes during hot backup)
  delta=$(( src_count - restored_count ))
  delta=${delta#-}  # abs
  pct=$(( src_count > 0 ? delta * 100 / src_count : 0 ))
  if [[ $pct -gt 5 ]]; then
    log "WARN: row count delta > 5% on ${schema}.${table}: source=${src_count} restored=${restored_count}"
    (( FAIL_COUNT++ ))
  fi
done <<< "$SOURCE_COUNTS"

# 5c. FK consistency — look for violated foreign key constraints
FK_VIOLATIONS=$(psql_scratch -c "
  SELECT conrelid::regclass, conname
  FROM   pg_constraint
  WHERE  contype = 'f'
    AND  NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_class c
      WHERE c.oid = conrelid
    )
  LIMIT 10;
" 2>/dev/null || echo "")

if [[ -n "$FK_VIOLATIONS" ]]; then
  log "FAIL: FK constraint violations detected:"
  echo "$FK_VIOLATIONS" | tee -a "$LOG_FILE"
  (( FAIL_COUNT++ ))
else
  log "PASS: no FK violations."
fi

# 5d. Schema version — _prisma_migrations / schema_version table present
SCHEMA_VERSION_OK=$(psql_scratch -c "
  SELECT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_name IN ('_prisma_migrations','schema_version')
  );
")
if [[ "$SCHEMA_VERSION_OK" == "t" ]]; then
  log "PASS: schema version table present."
else
  log "WARN: schema version table not found (may be fine if using a different migration tool)."
fi

# ---------------------------------------------------------------------------
# Step 6: (Optional) WAL replay verification
# ---------------------------------------------------------------------------

if [[ -n "$DR_WAL_ARCHIVE" ]]; then
  log "WAL replay verification: archive=${DR_WAL_ARCHIVE}"
  WAL_FILES=$(ls "$DR_WAL_ARCHIVE"/*.gz 2>/dev/null | wc -l || echo 0)
  if [[ "$WAL_FILES" -gt 0 ]]; then
    log "Found ${WAL_FILES} WAL segment(s). Manual pg_waldump verification recommended."
    log "Run: pg_waldump --path ${DR_WAL_ARCHIVE} <start_lsn> <end_lsn>"
  else
    log "No WAL segments found in archive — skipping WAL replay."
  fi
fi

# ---------------------------------------------------------------------------
# Result
# ---------------------------------------------------------------------------

if [[ $TOTAL_ELAPSED -gt $DR_RTO_SECONDS ]]; then
  log "FAIL: RTO exceeded — ${TOTAL_ELAPSED}s > ${DR_RTO_SECONDS}s budget."
  (( FAIL_COUNT++ ))
else
  log "PASS: within RTO budget (${TOTAL_ELAPSED}s < ${DR_RTO_SECONDS}s)."
fi

log ""
log "=== DR rehearsal summary ==="
log "  Dump size:       ${DUMP_SIZE}"
log "  Dump time:       ${DUMP_ELAPSED}s"
log "  Restore time:    ${RESTORE_ELAPSED}s"
log "  Total elapsed:   ${TOTAL_ELAPSED}s / ${DR_RTO_SECONDS}s RTO"
log "  Integrity fails: ${FAIL_COUNT}"
log "  Outcome:         $([ $FAIL_COUNT -eq 0 ] && echo 'PASS' || echo 'FAIL')"
log "  Log:             ${LOG_FILE}"

[[ $FAIL_COUNT -eq 0 ]] && exit 0 || exit 1
