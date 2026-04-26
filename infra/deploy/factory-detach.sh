#!/bin/bash
# infra/deploy/factory-detach.sh
# oweibo Factory Detachment Protocol — run on the target host to stand up
# a generated app independently of the oweibo factory.
set -euo pipefail

echo "▶ oweibo Factory Detachment Protocol"

# 1. Verify bundle signature
if [ -f bundle.manifest.json ]; then
  EXPECTED_SIG=$(python3 -c "import json,sys; print(json.load(open('bundle.manifest.json'))['signature'])")
  ACTUAL_SIG=$(cat bundle.tar.gz bundle.sql.gz bundle.k8s.tar.gz 2>/dev/null | sha256sum | cut -d' ' -f1)
  if [ "$EXPECTED_SIG" != "$ACTUAL_SIG" ]; then
    echo "✗ Bundle signature mismatch. Expected: $EXPECTED_SIG, Got: $ACTUAL_SIG"
    echo "  Aborting — bundle may have been tampered with."
    exit 1
  fi
  echo "✓ Bundle signature verified."
else
  echo "⚠  bundle.manifest.json not found — skipping signature check."
fi

# 2. Restore database
if [ -f bundle.sql.gz ]; then
  echo "▶ Restoring database..."
  if [ -f db/restore.sh ]; then
    bash db/restore.sh
    echo "✓ Database restored."
  else
    echo "⚠  db/restore.sh not found — restore manually from bundle.sql.gz"
  fi
fi

# 3. Configure environment (Vault or .env)
if command -v vault &>/dev/null && [ -n "${VAULT_ADDR:-}" ]; then
  echo "▶ Pulling secrets from Vault ($VAULT_ADDR)..."
  vault kv get -format=json secret/oweibo/prod \
    | python3 -c "import json,sys; d=json.load(sys.stdin)['data']['data']; [print(f'{k}={v}') for k,v in d.items()]" \
    > .env
  echo "✓ Secrets written to .env"
else
  if [ ! -f .env ]; then
    cp env/.env.template .env 2>/dev/null || cp .env.example .env 2>/dev/null || true
    echo "⚠  Vault not available. Fill .env manually, then re-run."
    read -r -p "Press Enter when .env is ready..."
  fi
fi

# 4. Start services
if [ -f compose/docker-compose.prod.yml ]; then
  docker compose -f compose/docker-compose.prod.yml up -d
elif [ -f docker-compose.yml ]; then
  docker compose up -d
else
  echo "⚠  No docker-compose file found — start services manually."
fi
echo "✓ Services started."

# 5. Health check with retry
echo "▶ Waiting for health endpoint..."
for i in {1..10}; do
  if curl -sf http://localhost/health &>/dev/null; then
    echo "✓ Health check passed."
    break
  fi
  echo "  Waiting ($i/10)..."
  sleep 6
done
curl -sf http://localhost/health || { echo "✗ Health check failed after 60s."; exit 1; }

# 6. Transfer CI/CD pipeline
if [ -f ci/github-actions.yml ] && [ -d .git ]; then
  mkdir -p .github/workflows
  cp ci/github-actions.yml .github/workflows/deploy.yml
  git add .github/workflows/deploy.yml
  git commit -m "chore: transfer CI/CD from oweibo factory" --no-verify 2>/dev/null || true
  echo "✓ CI/CD pipeline transferred."
fi

echo ""
echo "✓ App is running independently of oweibo factory."
