#!/usr/bin/env bash
# Deploy one app into one environment with the Helm CLI.
#
#   scripts/deploy.sh <environment> <app> [extra helm args...]
#   scripts/deploy.sh example wikijs
#   scripts/deploy.sh example wikijs --dry-run
#
# The same chart and the same values file are what ArgoCD and Flux consume —
# see gitops/. This script is the no-controller path, not a separate one.
set -euo pipefail

ENV_NAME="${1:?usage: deploy.sh <environment> <app> [helm args...]}"
APP="${2:?usage: deploy.sh <environment> <app> [helm args...]}"
shift 2

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHART="$ROOT/charts/$APP"
VALUES="$ROOT/environments/$ENV_NAME/$APP.yaml"

[ -d "$CHART" ]  || { echo "no chart: charts/$APP"; exit 1; }
[ -f "$VALUES" ] || { echo "no values: environments/$ENV_NAME/$APP.yaml"; exit 1; }

# Namespace defaults to the app name; override with NAMESPACE=.
NS="${NAMESPACE:-$APP}"
RELEASE="${RELEASE:-$APP}"

echo "==> chart      $CHART"
echo "==> values     $VALUES"
echo "==> namespace  $NS"
echo "==> release    $RELEASE"

helm dependency update "$CHART" >/dev/null

helm upgrade --install "$RELEASE" "$CHART" \
  --namespace "$NS" --create-namespace \
  --values "$VALUES" \
  --wait --timeout "${TIMEOUT:-15m}" \
  "$@"
