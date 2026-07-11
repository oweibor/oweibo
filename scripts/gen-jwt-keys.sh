#!/usr/bin/env bash
# gen-jwt-keys.sh — generate an RS256 keypair for the identity service and
# write it into the dev env file (default .env.dev), replacing any existing
# JWT_PRIVATE_KEY / JWT_PUBLIC_KEY lines.
#
# Identity's initKeys() un-escapes "\n" back into real newlines, so the PEMs
# are stored single-line with literal \n separators.
#
# Usage:  bash scripts/gen-jwt-keys.sh [env-file]     (or: pnpm gen:keys)
set -euo pipefail

cd "$(dirname "$0")/.."
ENV_FILE="${1:-.env.dev}"

if [ ! -f "$ENV_FILE" ]; then
  echo "[gen:keys] $ENV_FILE not found. Copy the template first:"
  echo "           cp .env.dev.example .env.dev"
  exit 1
fi

command -v openssl >/dev/null 2>&1 || { echo "[gen:keys] openssl not found on PATH."; exit 1; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$TMP/priv.pem" 2>/dev/null
openssl rsa -in "$TMP/priv.pem" -pubout -out "$TMP/pub.pem" 2>/dev/null

# Collapse each PEM to one line with literal \n between rows.
PRIV="$(awk 'BEGIN{ORS="\\n"}{print}' "$TMP/priv.pem")"
PUB="$(awk 'BEGIN{ORS="\\n"}{print}' "$TMP/pub.pem")"

# Rewrite the env file: drop old key lines, append fresh ones.
grep -vE '^(JWT_PRIVATE_KEY|JWT_PUBLIC_KEY)=' "$ENV_FILE" > "$TMP/env.new" || true
{
  printf 'JWT_PRIVATE_KEY=%s\n' "$PRIV"
  printf 'JWT_PUBLIC_KEY=%s\n'  "$PUB"
} >> "$TMP/env.new"
mv "$TMP/env.new" "$ENV_FILE"

echo "[gen:keys] Wrote RS256 JWT_PRIVATE_KEY + JWT_PUBLIC_KEY to $ENV_FILE"
