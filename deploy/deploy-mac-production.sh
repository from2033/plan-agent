#!/usr/bin/env bash
set -Eeuo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
project_root="$(cd "$script_dir/.." && pwd)"
runtime_root="${PA_RUNTIME_ROOT:-${HOME}/.5656ai-runtime/production/personal-assistant}"
docker_cmd="${PA_DOCKER_CMD:-${HOME}/.5656ai-runtime/docker.sh}"
compose_file="$script_dir/mac-production/compose.yml"
dockerfile="$script_dir/mac-production/Dockerfile"
container_name="personal-assistant-mac-app-1"
project_name="personal-assistant-mac"
public_health_url="${PA_PUBLIC_HEALTH_URL:-https://assistant.5656ai.com/api/health}"
dry_run=false
skip_checks=false
allow_dirty=false

usage() {
  printf 'Usage: %s [--dry-run] [--skip-checks] [--allow-dirty]\n' "$0"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) dry_run=true ;;
    --skip-checks) skip_checks=true ;;
    --allow-dirty) allow_dirty=true ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
  shift
done

[[ "$(uname -s)" == Darwin ]] || { printf 'Mac production deployment must run on macOS.\n' >&2; exit 1; }
[[ -x "$docker_cmd" ]] || { printf 'Missing managed Docker wrapper: %s\n' "$docker_cmd" >&2; exit 1; }
[[ -f "$runtime_root/secrets/server.env" ]] || { printf 'Missing protected runtime environment.\n' >&2; exit 1; }
[[ -f "$compose_file" && -f "$dockerfile" ]] || { printf 'Missing Mac production deployment assets.\n' >&2; exit 1; }

release_id="$(date -u +%Y%m%dT%H%M%SZ)-$(git -C "$project_root" rev-parse --short HEAD 2>/dev/null || printf local)"
image="5656ai/personal-assistant:mac-$release_id"
release_dir="$runtime_root/releases/$release_id"
backup_dir="$runtime_root/backups/$release_id"
state_dir="$runtime_root/deploy-state"

if [[ "$dry_run" == true ]]; then
  printf 'release=%s\nimage=%s\nruntime=%s\nbackup=%s\n' "$release_id" "$image" "$runtime_root" "$backup_dir"
  printf 'plan=check,build,stop,backup,recreate,verify,rollback-on-failure\n'
  exit 0
fi

if [[ "$allow_dirty" != true && -n "$(git -C "$project_root" status --porcelain)" ]]; then
  printf 'Refusing to deploy a dirty working tree. Commit the release or pass --allow-dirty explicitly.\n' >&2
  exit 1
fi
if grep -Eq '^CORS_ORIGIN=[[:space:]]*\*[[:space:]]*$' "$runtime_root/secrets/server.env"; then
  printf 'Production CORS_ORIGIN must be empty or an explicit allow-list, not *.\n' >&2
  exit 1
fi

if [[ "$skip_checks" != true ]]; then
  (cd "$project_root" && npm run check)
fi
(cd "$project_root" && npm run build && npm --prefix server run build)

stage_dir="$(mktemp -d)"
cleanup() { rm -rf "$stage_dir"; }
trap cleanup EXIT
mkdir -p "$stage_dir/dist" "$stage_dir/web-dist"
cp "$project_root/server/package.json" "$project_root/server/package-lock.json" "$stage_dir/"
cp -R "$project_root/server/dist/." "$stage_dir/dist/"
cp -R "$project_root/dist/." "$stage_dir/web-dist/"

"$docker_cmd" build --platform linux/arm64 --file "$dockerfile" --tag "$image" "$stage_dir"

previous_image_id="$("$docker_cmd" inspect "$container_name" --format '{{.Image}}')"
rollback_image="5656ai/personal-assistant:rollback-$release_id"
"$docker_cmd" image tag "$previous_image_id" "$rollback_image"

mkdir -p "$backup_dir/data" "$release_dir" "$state_dir"
cp -R "$stage_dir/." "$release_dir/"
printf '%s\n' "$rollback_image" > "$state_dir/previous-image"
printf '%s\n' "$image" > "$state_dir/pending-image"

old_stopped=false
switched=false
rollback_on_error() {
  status=$?
  trap - ERR
  if [[ "${switched:-false}" == true ]]; then
    printf 'Deployment failed; restoring previous image %s.\n' "$rollback_image" >&2
    PA_RUNTIME_ROOT="$runtime_root" PA_IMAGE="$rollback_image" \
      "$docker_cmd" compose --project-name "$project_name" --file "$compose_file" up -d --force-recreate >/dev/null || true
  elif [[ "${old_stopped:-false}" == true ]]; then
    "$docker_cmd" start "$container_name" >/dev/null 2>&1 || true
  fi
  exit "$status"
}
trap rollback_on_error ERR

"$docker_cmd" stop --time 60 "$container_name" >/dev/null
old_stopped=true
"$docker_cmd" cp "$container_name:/data/." "$backup_dir/data"
"$docker_cmd" inspect "$container_name" > "$backup_dir/container-inspect.json"

switched=true
PA_RUNTIME_ROOT="$runtime_root" PA_IMAGE="$image" \
  "$docker_cmd" compose --project-name "$project_name" --file "$compose_file" up -d --force-recreate

healthy=false
for _ in $(seq 1 60); do
  status="$("$docker_cmd" inspect "$container_name" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' 2>/dev/null || true)"
  if [[ "$status" == healthy ]]; then healthy=true; break; fi
  [[ "$status" == exited || "$status" == dead ]] && break
  sleep 2
done
[[ "$healthy" == true ]] || { "$docker_cmd" logs "$container_name" --tail 100 >&2 || true; false; }

curl --fail --silent --show-error --max-time 15 http://127.0.0.1:13020/api/health | grep -q '"ok":true'
curl --fail --silent --show-error --max-time 20 "$public_health_url" | grep -q '"ok":true'

printf '%s\n' "$image" > "$state_dir/current-image"
rm -f "$state_dir/pending-image"
ln -sfn "$release_dir" "$runtime_root/current-release"
trap - ERR

worker_target="gui/$(id -u)/com.5656ai.personal-assistant-codex-worker"
if launchctl print "$worker_target" >/dev/null 2>&1; then
  launchctl kickstart -k "$worker_target"
fi

printf 'deployed=%s backup=%s rollback=%s\n' "$image" "$backup_dir" "$rollback_image"
