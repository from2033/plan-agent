#!/usr/bin/env bash
set -euo pipefail

registry="${ACR_REGISTRY:-crpi-x3ikv33wcxmeq4c0.cn-hongkong.personal.cr.aliyuncs.com}"
namespace="${ACR_NAMESPACE:-5656ai}"
repository="${ACR_REPOSITORY:-personal-assistant}"
acr_username="${ACR_USERNAME:-sniper_2020}"
keychain_service="${ACR_KEYCHAIN_SERVICE:-acr-personal-5656ai}"
platform="${IMAGE_PLATFORM:-linux/amd64}"
server="${DEPLOY_SERVER:-root@8.217.244.181}"
ssh_key="${DEPLOY_SSH_KEY:-$HOME/.ssh/briefings_deploy}"
tag="${IMAGE_TAG:-$(date -u +%Y%m%dT%H%M%SZ)-$(git rev-parse --short HEAD 2>/dev/null || printf local)}"
image="$registry/$namespace/$repository:$tag"
root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

docker info >/dev/null 2>&1 || { command -v colima >/dev/null && colima start; }
docker info >/dev/null || { echo "Docker engine is not running" >&2; exit 1; }
docker buildx version >/dev/null || { echo "docker buildx is required" >&2; exit 1; }
docker buildx build --platform "$platform" --file "$root_dir/deploy/server.Dockerfile" \
  --tag "$image" --provenance=false --push "$root_dir"

acr_password() {
  if [[ -n "${ACR_PASSWORD:-}" ]]; then printf '%s' "$ACR_PASSWORD"
  elif command -v security >/dev/null; then security find-generic-password -a "$acr_username" -s "$keychain_service" -w
  else echo "Set ACR_PASSWORD or configure macOS Keychain service $keychain_service" >&2; return 1
  fi
}
acr_password | ssh -i "$ssh_key" "$server" "docker login --username '$acr_username' --password-stdin '$registry'" >/dev/null
logout_registry() { ssh -i "$ssh_key" "$server" "docker logout '$registry'" >/dev/null 2>&1 || true; }
trap logout_registry EXIT
ssh -i "$ssh_key" "$server" 'mkdir -p /opt/personal-assistant/deploy-blue-green/router'
scp -i "$ssh_key" "$root_dir/deploy/switch-blue-green.sh" "$root_dir/deploy/rollback-blue-green.sh" \
  "$server:/opt/personal-assistant/deploy-blue-green/"
scp -i "$ssh_key" "$root_dir/deploy/router/default.conf.template" \
  "$server:/opt/personal-assistant/deploy-blue-green/router/default.conf.template"
ssh -i "$ssh_key" "$server" \
  "chmod 0755 /opt/personal-assistant/deploy-blue-green/*.sh && /opt/personal-assistant/deploy-blue-green/switch-blue-green.sh '$image'"
logout_registry
trap - EXIT
printf 'deployed=%s\n' "$image"
