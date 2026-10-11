#!/usr/bin/env bash
set -euo pipefail

registry="${ACR_REGISTRY:-crpi-x3ikv33wcxmeq4c0.cn-hongkong.personal.cr.aliyuncs.com}"
namespace="${ACR_NAMESPACE:-5656ai}"
repository="${ACR_REPOSITORY:-personal-assistant}"
acr_username="${ACR_USERNAME:-sniper_2020}"
keychain_service="${ACR_KEYCHAIN_SERVICE:-acr-personal-5656ai}"
platform="${IMAGE_PLATFORM:-linux/amd64}"
server="${DEPLOY_SERVER:-}"
ssh_key="${DEPLOY_SSH_KEY:-$HOME/.ssh/briefings_deploy}"
tag="${IMAGE_TAG:-$(date -u +%Y%m%dT%H%M%SZ)-$(git rev-parse --short HEAD 2>/dev/null || printf local)}"
image="$registry/$namespace/$repository:$tag"
root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ -z "$server" ]]; then
  echo "DEPLOY_SERVER is required. This legacy remote-host deploy script has no default target." >&2
  echo "Production application containers run on the Mac mini; follow ~/.codex/AGENTS.md and the Mac production workflow." >&2
  exit 2
fi

deploy_host="${server##*@}"
deploy_host="${deploy_host%%:*}"
case "$deploy_host" in
  8.217.244.181)
    echo "Refusing to deploy to retired host 8.217.244.181." >&2
    exit 2
    ;;
  47.243.128.151)
    echo "Refusing to deploy application containers to the ingress-only host 47.243.128.151." >&2
    exit 2
    ;;
esac

acr_password() {
  if [[ -n "${ACR_PASSWORD:-}" ]]; then printf '%s' "$ACR_PASSWORD"
  elif command -v security >/dev/null; then security find-generic-password -a "$acr_username" -s "$keychain_service" -w
  else echo "Set ACR_PASSWORD or configure macOS Keychain service $keychain_service" >&2; return 1
  fi
}

local_docker_available=no
if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  local_docker_available=yes
elif command -v colima >/dev/null 2>&1 && colima start >/dev/null 2>&1 \
  && command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  local_docker_available=yes
fi

if [[ "$local_docker_available" == yes ]]; then
  docker buildx version >/dev/null || { echo "docker buildx is required" >&2; exit 1; }
  docker buildx build --platform "$platform" --file "$root_dir/deploy/server.Dockerfile" \
    --tag "$image" --provenance=false --push "$root_dir"
else
  remote_build_dir="/opt/personal-assistant/builds/$tag"
  echo "Local Docker is unavailable; building on $server"
  ssh -i "$ssh_key" "$server" "mkdir -p '$remote_build_dir'"
  git -C "$root_dir" archive HEAD \
    | ssh -i "$ssh_key" "$server" "tar -x -C '$remote_build_dir'"
  acr_password | ssh -i "$ssh_key" "$server" \
    "docker login --username '$acr_username' --password-stdin '$registry' >/dev/null"
  ssh -i "$ssh_key" "$server" \
    "docker build --platform '$platform' --file '$remote_build_dir/deploy/server.Dockerfile' \
      --tag '$image' '$remote_build_dir' && docker push '$image'"
fi

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

# The inference worker runs locally under launchd and loads its prompts only at
# process start. Restart it after a successful server deployment so prompt and
# policy changes take effect together with the API release.
worker_label="com.5656ai.personal-assistant-codex-worker"
worker_target="gui/$(id -u)/$worker_label"
if command -v launchctl >/dev/null 2>&1 && launchctl print "$worker_target" >/dev/null 2>&1; then
  launchctl kickstart -k "$worker_target"
  printf 'restarted_worker=%s\n' "$worker_label"
fi
printf 'deployed=%s\n' "$image"
