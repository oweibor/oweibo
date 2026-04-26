#!/usr/bin/env bash
# infra/zitadel/scripts/bootstrap.sh
# Post-install initialisation for self-hosted Zitadel.
#
# Responsibilities:
#   1. Create the 'identity' namespace if absent
#   2. Pull required secrets from Vault and create K8s secrets
#   3. Install/upgrade the Zitadel Helm release
#   4. Apply the ingress manifest (with domain substituted)
#   5. Wait for Zitadel to become healthy
#   6. Apply the machine-user CRD to provision the oweibo service account
#   7. Read generated credentials from the K8s secret and push to Vault
#
# Prerequisites:
#   - kubectl, helm, vault, jq installed and on PATH
#   - VAULT_ADDR and VAULT_TOKEN set in environment
#   - Helm repos added:
#       helm repo add zitadel https://charts.zitadel.com
#       helm repo add bitnami https://charts.bitnami.com/bitnami
#       helm repo update
#
# Usage:
#   export VAULT_ADDR=https://vault.internal:8200
#   export VAULT_TOKEN=<root-or-admin-token>
#   bash infra/zitadel/scripts/bootstrap.sh
#
# Idempotent: safe to re-run. Helm upgrade --install is used throughout.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
HELM_DIR="${REPO_ROOT}/infra/zitadel/helm"
INGRESS_TEMPLATE="${REPO_ROOT}/infra/zitadel/ingress/ingress.yaml"
CRD_FILE="${REPO_ROOT}/infra/zitadel/crds/machine-user.yaml"
NAMESPACE="identity"
RELEASE_NAME="zitadel"

# ── 1. Namespace ──────────────────────────────────────────────────────────────
echo "→ [1/7] Ensuring namespace '${NAMESPACE}'..."
kubectl create namespace "${NAMESPACE}" --dry-run=client -o yaml | kubectl apply -f -

# ── 2. Pull secrets from Vault ────────────────────────────────────────────────
echo "→ [2/7] Reading secrets from Vault..."

ZITADEL_DOMAIN="$(vault kv get -field=ZITADEL_DOMAIN oweibo/infra/zitadel)"
ZITADEL_MASTERKEY="$(vault kv get -field=ZITADEL_MASTERKEY oweibo/infra/zitadel)"
ZITADEL_DB_PASSWORD="$(vault kv get -field=ZITADEL_DB_PASSWORD oweibo/infra/zitadel)"

if [[ -z "${ZITADEL_DOMAIN}" || -z "${ZITADEL_MASTERKEY}" || -z "${ZITADEL_DB_PASSWORD}" ]]; then
  echo "✗ One or more required Vault keys are missing. Expected at 'oweibo/infra/zitadel':"
  echo "    ZITADEL_DOMAIN, ZITADEL_MASTERKEY, ZITADEL_DB_PASSWORD"
  exit 1
fi

# Create masterkey K8s secret (used by Zitadel Helm chart)
kubectl create secret generic zitadel-masterkey \
  --namespace "${NAMESPACE}" \
  --from-literal=masterkey="${ZITADEL_MASTERKEY}" \
  --dry-run=client -o yaml | kubectl apply -f -

# ── 3. Helm install/upgrade ───────────────────────────────────────────────────
echo "→ [3/7] Installing/upgrading Zitadel Helm release '${RELEASE_NAME}'..."
helm dependency update "${HELM_DIR}"
helm upgrade --install "${RELEASE_NAME}" "${HELM_DIR}" \
  --namespace "${NAMESPACE}" \
  --values "${HELM_DIR}/values.yaml" \
  --set zitadel.zitadel.masterKey="${ZITADEL_MASTERKEY}" \
  --set postgresql.auth.password="${ZITADEL_DB_PASSWORD}" \
  --set "zitadel.zitadel.configmapConfig.ExternalDomain=${ZITADEL_DOMAIN}" \
  --timeout 10m \
  --wait

# ── 4. Apply ingress (domain substituted) ────────────────────────────────────
echo "→ [4/7] Applying ingress for domain '${ZITADEL_DOMAIN}'..."
ZITADEL_EXTERNALDOMAIN="${ZITADEL_DOMAIN}" \
  envsubst < "${INGRESS_TEMPLATE}" | kubectl apply -f -

# ── 5. Wait for Zitadel healthcheck ──────────────────────────────────────────
echo "→ [5/7] Waiting for Zitadel pods to be Ready..."
kubectl rollout status deployment/"${RELEASE_NAME}" \
  --namespace "${NAMESPACE}" \
  --timeout=300s

echo "→    Probing /debug/healthz..."
HEALTH_URL="https://${ZITADEL_DOMAIN}/debug/healthz"
for i in $(seq 1 30); do
  STATUS=$(curl -sk -o /dev/null -w "%{http_code}" "${HEALTH_URL}" || true)
  if [[ "${STATUS}" == "200" ]]; then
    echo "→    Zitadel is healthy (attempt ${i})."
    break
  fi
  echo "→    Waiting for Zitadel health (attempt ${i}/30, status ${STATUS})..."
  sleep 10
done
if [[ "${STATUS}" != "200" ]]; then
  echo "✗ Zitadel did not become healthy within 5 minutes."
  exit 1
fi

# ── 6. Apply machine-user CRD ────────────────────────────────────────────────
echo "→ [6/7] Provisioning oweibo service account via Zitadel operator..."
kubectl apply -f "${CRD_FILE}"

# Wait for the credentials secret to be populated by the operator
echo "→    Waiting for credentials secret 'zitadel-oweibo-sa-credentials'..."
for i in $(seq 1 30); do
  SECRET_EXISTS=$(kubectl get secret zitadel-oweibo-sa-credentials \
    --namespace "${NAMESPACE}" --ignore-not-found -o jsonpath='{.metadata.name}' 2>/dev/null || true)
  if [[ -n "${SECRET_EXISTS}" ]]; then
    echo "→    Credentials secret exists (attempt ${i})."
    break
  fi
  echo "→    Waiting for operator to create credentials (attempt ${i}/30)..."
  sleep 10
done
if [[ -z "${SECRET_EXISTS:-}" ]]; then
  echo "✗ Credentials secret not created within 5 minutes. Check Zitadel operator logs."
  exit 1
fi

# ── 7. Push credentials to Vault ─────────────────────────────────────────────
echo "→ [7/7] Writing oweibo service account credentials to Vault..."
CLIENT_ID="$(kubectl get secret zitadel-oweibo-sa-credentials \
  --namespace "${NAMESPACE}" -o jsonpath='{.data.client_id}' | base64 -d)"
PRIVATE_KEY_PEM="$(kubectl get secret zitadel-oweibo-sa-credentials \
  --namespace "${NAMESPACE}" -o jsonpath='{.data.private_key_pem}' | base64 -d)"

vault kv put oweibo/infra/zitadel \
  ZITADEL_DOMAIN="${ZITADEL_DOMAIN}" \
  ZITADEL_MASTERKEY="${ZITADEL_MASTERKEY}" \
  ZITADEL_DB_PASSWORD="${ZITADEL_DB_PASSWORD}" \
  ZITADEL_CLIENT_ID="${CLIENT_ID}" \
  ZITADEL_PRIVATE_KEY_PEM="${PRIVATE_KEY_PEM}"

echo ""
echo "✓ Zitadel bootstrap complete."
echo "  External domain : https://${ZITADEL_DOMAIN}"
echo "  Client ID       : ${CLIENT_ID}"
echo "  Vault path      : oweibo/infra/zitadel"
echo ""
echo "  Next: verify the admin console at https://${ZITADEL_DOMAIN}/ui/console"
